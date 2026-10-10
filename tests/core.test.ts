import { describe, expect, it, vi } from 'vitest';
import {
  Optimizer,
  OptimizerError,
  chunkDocuments,
  renderContext,
  estimateCosts,
} from '../src/index.js';
import { selectUnderBudget } from '../src/selection.js';
import type {
  BackendInput,
  ContextChunk,
  ContextOptimizerBackend,
  ProviderAdapter,
  TelemetryEvent,
} from '../src/types.js';

const documents = [
  { id: 'answer', text: 'Mercury has no natural moons. '.repeat(8), source: 'catalog' },
  { id: 'noise', text: 'Garden plants need periodic watering. '.repeat(8) },
];
const selectAll: ContextOptimizerBackend = {
  name: 'test',
  external: false,
  async optimize(input) {
    return { decisions: input.chunks.map((chunk) => ({ id: chunk.id, score: 1 })) };
  },
};

function chunk(id: string, tokens: number): ContextChunk {
  return { id, text: id, documentId: id, index: 0, tokens };
}

describe('structural chunking', () => {
  it('retains code, JSON, protected evidence and long identifiers as atomic units', () => {
    for (const text of [
      '```ts\nconst x = 2;\n```\n\nprose',
      '{"x": [1,2,3]}',
      'identifier'.repeat(100),
    ]) {
      expect(
        chunkDocuments([{ id: 'x', text }], { strategy: 'paragraph', maxTokens: 4 }),
      ).toHaveLength(1);
    }
    expect(
      chunkDocuments([{ id: 'x', text: 'first\n\nsecond', protected: true }], {
        strategy: 'paragraph',
      }),
    ).toHaveLength(1);
  });

  it('keeps plain-text bytes and stable source mappings across splitting', () => {
    const text = 'First paragraph.\n\n  Next paragraph has words.\n\nThird.';
    const chunks = chunkDocuments([{ id: 'x', source: 'ref', text }], {
      strategy: 'paragraph',
      maxTokens: 8,
    });
    expect(chunks.map((entry) => entry.text).join('')).toBe(text);
    expect(chunks.every((entry) => entry.documentId === 'x' && entry.source === 'ref')).toBe(true);
    expect(
      chunkDocuments([{ id: 'x', source: 'ref', text }], { strategy: 'paragraph', maxTokens: 8 }),
    ).toEqual(chunks);
    for (const line of renderContext(chunks).split('\n\n'))
      expect(JSON.parse(line).source).toBe('ref');
  });

  it('rejects duplicate document IDs and invalid metadata without echoing content', () => {
    expect(() => chunkDocuments([...documents, documents[0]!])).toThrow(OptimizerError);
    expect(() =>
      chunkDocuments([{ id: 'secret', text: 'api-key-secret', importance: NaN }]),
    ).toThrow('valid metadata');
  });
});

describe('budget selection', () => {
  it('accounts for utility per token instead of blindly taking highest scores', () => {
    const selected = selectUnderBudget(
      [
        { chunk: chunk('large', 10), score: 0.9 },
        { chunk: chunk('small1', 5), score: 0.6 },
        { chunk: chunk('small2', 5), score: 0.6 },
      ],
      10,
    );
    expect([...selected]).toEqual(['small1', 'small2']);
  });

  it('matches exhaustive utility optima across different small budgets', () => {
    const candidates = [3, 8, 4, 2, 10, 7].map((tokens, i) => ({
      chunk: chunk(`${i}`, tokens),
      score: [0.4, 0.8, 0.5, 0.3, 0.9, 0.6][i]!,
    }));
    for (let budget = 0; budget <= 35; budget++) {
      let optimum = 0;
      for (let mask = 0; mask < 1 << candidates.length; mask++) {
        const subset = candidates.filter((_, i) => (mask & (1 << i)) !== 0);
        if (subset.reduce((n, entry) => n + entry.chunk.tokens, 0) <= budget)
          optimum = Math.max(
            optimum,
            subset.reduce((n, entry) => n + entry.score, 0),
          );
      }
      const selected = selectUnderBudget(candidates, budget);
      expect(
        candidates
          .filter((entry) => selected.has(entry.chunk.id))
          .reduce((n, entry) => n + entry.score, 0),
      ).toBeCloseTo(optimum);
    }
  });

  it('uses deterministic bounded greedy selection for large sets', () => {
    const candidates = Array.from({ length: 70 }, (_, i) => ({
      chunk: chunk(`${i}`, 10),
      score: 0.5,
    }));
    expect([...selectUnderBudget(candidates, 25)]).toEqual(['0', '1']);
  });

  it('finds a feasible preservation floor when a high-utility chunk blocks greedy repair', () => {
    expect([
      ...selectUnderBudget(
        [
          { chunk: chunk('large', 70), score: 1 },
          { chunk: chunk('small1', 40), score: 0 },
          { chunk: chunk('small2', 40), score: 0 },
        ],
        100,
        80,
      ),
    ]).toEqual(['small1', 'small2']);
  });
});

describe('optimization preservation and failure modes', () => {
  it('reduces explicit irrelevant context, retaining ordering and sources', async () => {
    const optimizer = new Optimizer({ policy: { maxReduction: 1 } });
    const result = await optimizer.optimize({ task: 'Mercury moons', context: documents });
    expect(result.chunks.map((entry) => entry.documentId)).toEqual(['answer']);
    expect(result.metrics.reason).toBe('selected');
    expect(result.metrics.optimizedContextTokens).toBeLessThan(
      result.metrics.originalContextTokens,
    );
    expect(result.chunks[0]?.source).toBe('catalog');
  });

  it('pins evidence and never exposes protected text to the backend', async () => {
    const optimize = vi.fn(selectAll.optimize);
    const optimizer = new Optimizer({
      backend: { ...selectAll, optimize },
      policy: { maxReduction: 1 },
    });
    const result = await optimizer.optimize({
      task: 'moons',
      context: [{ ...documents[0]!, protected: true }, documents[1]!],
    });
    expect(result.chunks[0]?.documentId).toBe('answer');
    expect(optimize.mock.calls[0]?.[0].chunks.map((entry) => entry.documentId)).toEqual(['noise']);
  });

  it('passes through a malformed or failed backend, without echoing its secrets', async () => {
    for (const optimize of [
      async () => {
        throw new Error('secret credential');
      },
      async () => ({ decisions: [{ id: 'unknown', score: 1 }] }),
      async (input: BackendInput) => ({
        decisions: input.chunks.map((entry) => ({ id: entry.id, score: NaN })),
      }),
    ]) {
      const result = await new Optimizer({ backend: { ...selectAll, optimize } }).optimize({
        task: 'moons',
        context: documents,
      });
      expect(result.metrics.reason).toBe('backend-failure');
      expect(result.chunks).toHaveLength(2);
      expect(JSON.stringify(result.metrics)).not.toContain('secret credential');
    }
  });

  it('rejects duplicate backend decisions even with the expected count', async () => {
    const backend = {
      ...selectAll,
      async optimize(input: BackendInput) {
        return { decisions: input.chunks.map(() => ({ id: input.chunks[0]!.id, score: 1 })) };
      },
    };
    const result = await new Optimizer({ backend }).optimize({ task: 'moons', context: documents });
    expect(result.metrics.reason).toBe('backend-failure');
  });

  it('isolates candidate mutation by an injected backend', async () => {
    const backend = {
      ...selectAll,
      async optimize(input: BackendInput) {
        input.chunks[0]!.text = 'changed';
        return selectAll.optimize(input);
      },
    };
    const result = await new Optimizer({ backend }).optimize({ task: 'moons', context: documents });
    expect(result.chunks[0]?.text).toBe(documents[0]?.text);
  });

  it('strips unexpected fields from backend usage', async () => {
    const backend = {
      ...selectAll,
      async optimize(input: BackendInput) {
        return {
          ...(await selectAll.optimize(input)),
          usage: { inputTokens: 1, outputTokens: 0, apiKey: 'secret' },
        };
      },
    };
    const result = await new Optimizer({ backend }).optimize({ task: 'moons', context: documents });
    expect(result.metrics.backendUsage).toEqual({ inputTokens: 1, outputTokens: 0 });
    expect(JSON.stringify(result.metrics)).not.toContain('secret');
  });

  it('supports fail-closed errors and refuses fallback above an explicit budget', async () => {
    const backend = {
      ...selectAll,
      async optimize() {
        throw new Error('secret');
      },
    };
    await expect(
      new Optimizer({ backend, policy: { fallback: 'error' } }).optimize({
        task: 'moons',
        context: documents,
      }),
    ).rejects.toMatchObject({ code: 'BACKEND_FAILED', message: 'Optimization backend failed.' });
    await expect(
      new Optimizer({ backend, policy: { maxReduction: 1, targetTokens: 10 } }).optimize({
        task: 'moons',
        context: documents,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
  });

  it('reports preservation and protected-content budget conflicts', async () => {
    await expect(
      new Optimizer().optimize({ task: 'moons', context: documents, policy: { targetTokens: 1 } }),
    ).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await expect(
      new Optimizer({ policy: { maxReduction: 1 } }).optimize({
        task: 'moons',
        context: documents.map((entry) => ({ ...entry, protected: true })),
        policy: { targetTokens: 1 },
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
  });

  it('preserves the configured floor even if scores are all zero', async () => {
    const result = await new Optimizer().optimize({
      task: 'extraterrestrial topic',
      context: documents,
    });
    expect(result.metrics.optimizedContextTokens).toBeGreaterThanOrEqual(
      Math.ceil(result.metrics.originalContextTokens * 0.75),
    );
  });

  it('bypasses off mode without contacting the backend', async () => {
    const optimize = vi.fn(selectAll.optimize);
    const result = await new Optimizer({ backend: { ...selectAll, optimize } }).optimize({
      task: 'moons',
      context: documents,
      policy: { mode: 'off' },
    });
    expect(result.metrics.reason).toBe('off');
    expect(optimize).not.toHaveBeenCalled();
  });

  it('bounds a noncooperative backend timeout and cancellation', async () => {
    const backend = { ...selectAll, optimize: () => new Promise<never>(() => undefined) };
    const optimizer = new Optimizer({ backend, policy: { timeoutMs: 10 } });
    expect((await optimizer.optimize({ task: 'moons', context: documents })).metrics.reason).toBe(
      'backend-failure',
    );
    const controller = new AbortController();
    const operation = optimizer.optimize({
      task: 'moons',
      context: documents,
      signal: controller.signal,
    });
    controller.abort('secret abort reason');
    await expect(operation).rejects.toMatchObject({
      code: 'ABORTED',
      message: 'Operation cancelled.',
    });
  });

  it('emits only opt-in numeric metrics and ignores sink failures', async () => {
    const emit = vi.fn<(event: TelemetryEvent) => Promise<void>>(() =>
      Promise.reject(new Error('sink unavailable')),
    );
    const result = await new Optimizer({ telemetry: { emit } }).optimize({
      task: 'secret question',
      context: documents,
    });
    expect(Object.keys(emit.mock.calls[0]![0])).toEqual([
      'mode',
      'reason',
      'originalContextTokens',
      'optimizedContextTokens',
      'durationMs',
    ]);
    expect(result.chunks.length).toBeGreaterThan(0);
    await Promise.resolve();
  });
});

function fakeAdapter(): ProviderAdapter<{ native: string; context?: string }, { ok: true }> {
  return {
    name: 'openai',
    validate: () => undefined,
    attachContext: (request, context) => (context ? { ...request, context } : request),
    estimateTokens: (request) => ({
      tokens: request.context ? 100 : 10,
      method: 'local-estimate',
      accuracy: 'estimate',
      completeness: 'unknown',
    }),
    countTokens: async (request) => ({
      tokens: request.context ? 100 : 10,
      method: 'provider',
      accuracy: 'exact',
      completeness: 'complete',
    }),
    send: vi.fn(async () => ({ ok: true as const })),
    usage: () => ({ inputTokens: 100, outputTokens: 1 }),
  };
}

describe('native dispatch budgets', () => {
  it('counts full requests and preserves native request without mutation', async () => {
    const adapter = fakeAdapter();
    const request = { native: 'original' };
    const result = await new Optimizer().chat(adapter, request, {
      task: 'moons',
      context: documents,
      tokenCounting: 'provider',
    });
    expect(request).toEqual({ native: 'original' });
    expect(result.request.native).toBe('original');
    expect(result.usage?.inputTokens).toBe(100);
    expect(adapter.send).toHaveBeenCalledWith(result.request, expect.any(AbortSignal));
  });

  it('requires a full count for hard request budgets', async () => {
    const adapter = fakeAdapter();
    await expect(
      new Optimizer().chat(
        adapter,
        { native: 'x' },
        { task: 'moons', context: documents, hardInputTokens: 1000 },
      ),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('accepts an already-fitting full count even if local chunk estimates are larger', async () => {
    const adapter = fakeAdapter();
    const result = await new Optimizer().chat(
      adapter,
      { native: 'x' },
      { task: 'moons', context: documents, hardInputTokens: 120, tokenCounting: 'provider' },
    );
    expect(result.optimization.optimizedRequestTokens?.tokens).toBeLessThanOrEqual(120);
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it('strips unexpected metadata from injected token counts', async () => {
    const adapter = fakeAdapter();
    adapter.countTokens = async () => ({
      tokens: 100,
      method: 'provider',
      accuracy: 'exact',
      completeness: 'complete',
      apiKey: 'secret',
    });
    const result = await new Optimizer().prepare(
      adapter,
      { native: 'x' },
      { task: 'moons', context: documents, tokenCounting: 'provider' },
    );
    expect(Object.keys(result.optimization.originalRequestTokens!)).toEqual([
      'tokens',
      'method',
      'accuracy',
      'completeness',
    ]);
    expect(JSON.stringify(result.optimization)).not.toContain('secret');
  });

  it('strips unexpected credential metadata from normalized provider usage', async () => {
    const adapter = fakeAdapter();
    adapter.usage = () => ({ inputTokens: 100, outputTokens: 1, apiKey: 'secret' });
    const result = await new Optimizer().chat(
      adapter,
      { native: 'x' },
      { task: 'moons', context: [] },
    );
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 1 });
  });

  it('never dispatches protected native requests beyond the budget', async () => {
    const adapter = fakeAdapter();
    await expect(
      new Optimizer().chat(
        adapter,
        { native: 'x' },
        { task: 'moons', context: [], hardInputTokens: 9, tokenCounting: 'provider' },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('rechecks final reconstructed counts and refuses hidden overhead', async () => {
    const adapter = fakeAdapter();
    adapter.countTokens = async (request) => ({
      tokens: request.context ? 10_000 : 10,
      method: 'provider',
      accuracy: 'exact',
      completeness: 'complete',
    });
    await expect(
      new Optimizer({ policy: { maxReduction: 1 } }).chat(
        adapter,
        { native: 'x' },
        {
          task: 'Mercury moons',
          context: documents,
          hardInputTokens: 1000,
          tokenCounting: 'provider',
        },
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('sanitizes raw provider errors, distinguishing them from optimization failures', async () => {
    const adapter = fakeAdapter();
    adapter.send = async () => {
      throw Object.assign(new Error('credential and request text'), { status: 429 });
    };
    await expect(
      new Optimizer().chat(adapter, { native: 'x' }, { task: 'moons', context: [] }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 429,
      message: 'Provider request failed.',
    });
  });
});

describe('cost accounting', () => {
  const pricing = {
    inputPerMillion: 10,
    outputPerMillion: 20,
    cachedInputPerMillion: 1,
    cacheWritePerMillion: 12,
  };
  it('includes cache reads/writes, output and backend charges', () => {
    const result = estimateCosts({
      baseline: { pricing, usage: { inputTokens: 1000, outputTokens: 100 } },
      optimized: {
        pricing,
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 100,
          cacheWriteTokens: 100,
        },
      },
      backendCostUsd: 0.001,
    });
    expect(result.baselineProviderUsd).toBeCloseTo(0.012);
    expect(result.optimizedTotalUsd).toBeCloseTo(0.0073);
    expect(result.netSavingsUsd).toBeCloseTo(0.0047);
  });
  it('does not fabricate economic savings from unknown backend or cache prices', () => {
    const scenario = {
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 2 },
    };
    const result = estimateCosts({ baseline: scenario, optimized: scenario });
    expect(result.netSavingsUsd).toBeUndefined();
    expect(result.missing).toContain('backendCostUsd');
    expect(result.missing).toContain('optimized.cachedInputPerMillion');
  });
  it('rejects invalid cache accounting and negative prices', () => {
    const scenario = { pricing, usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 } };
    expect(() => estimateCosts({ baseline: scenario, optimized: scenario })).toThrow(
      OptimizerError,
    );
  });
});
