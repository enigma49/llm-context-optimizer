import { TypeSafeClient } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevBackend } from '../src/backends/jev.js';
import type { JevClient, JevScoringRequest } from '../src/backends/jev.js';
import { OptimizerError } from '../src/errors.js';
import type { BackendInput } from '../src/types.js';

function input(count = 2): BackendInput {
  return {
    task: 'Find the error code in the supplied source.',
    targetTokens: 100,
    chunks: Array.from({ length: count }, (_, index) => ({
      id: `chunk-${index}`,
      documentId: `document-${index}`,
      index: 0,
      text: `Source ${index}: error code E42.`,
      source: `source-${index}`,
      tokens: 15,
    })),
  };
}

function fixture(score = 3, inputTokens = 100, outputTokens = 10): Record<string, unknown> {
  const lower = Math.floor(score);
  const upper = Math.ceil(score);
  return {
    model: 'jev-1.13.0',
    answers: {
      relevance: {
        type: 'score',
        score,
        confidence: 0.8,
        probabilities: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            String(index),
            lower === upper
              ? Number(index === lower)
              : index === lower
                ? upper - score
                : index === upper
                  ? score - lower
                  : 0,
          ]),
        ),
        legend: {
          '0': 'unrelated',
          '1': 'tangential',
          '2': 'supporting',
          '3': 'useful',
          '4': 'essential',
        },
      },
    },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('JevBackend', () => {
  it('maps real SDK HTTP score responses to relevance and measured usage', async () => {
    const requests: JevScoringRequest[] = [];
    const client = new TypeSafeClient({
      apiKey: 'test-credential',
      logLevel: 'off',
      retry: { maxRetries: 0 },
      fetch: async (url, init) => {
        expect(url).toBe('https://api.typesafe.ai/v1/systemone');
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-credential');
        requests.push(JSON.parse(String(init?.body)) as JevScoringRequest);
        return new Response(JSON.stringify(fixture(2.5)), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await new JevBackend({ client }).optimize(input());
    expect(result.decisions).toEqual([
      { id: 'chunk-0', score: 0.625, confidence: 0.8 },
      { id: 'chunk-1', score: 0.625, confidence: 0.8 },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    expect(result.usage?.costUsd).toBeCloseTo(0.0000084, 12);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.model).toBe('jev-1.13.0');
    expect(requests[0]?.state.chunk.id).toBe('chunk-0');
    expect(requests[0]?.questions.relevance.criteria).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('test-credential');
    expect(result.decisions[0]?.confidence).toBe(0.8);
  });

  it('bounds concurrency and preserves candidate order after out-of-order completion', async () => {
    let active = 0;
    let maximum = 0;
    const client: JevClient = {
      systemOne: async (request) => {
        active++;
        maximum = Math.max(maximum, active);
        const index = Number(request.state.chunk.id.slice(6));
        await new Promise((resolve) => setTimeout(resolve, index % 2 === 0 ? 3 : 1));
        active--;
        return fixture(index);
      },
    };
    const result = await new JevBackend({ client, concurrency: 2 }).optimize(input(5));
    expect(maximum).toBe(2);
    expect(result.decisions).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        id: `chunk-${index}`,
        score: index / 4,
        confidence: 0.8,
      })),
    );
  });

  it('supports dated configurable input and output pricing', async () => {
    const client: JevClient = { systemOne: async () => fixture(4, 1_000_000, 500_000) };
    const result = await new JevBackend({
      client,
      inputPricePerMillion: 0.05,
      outputPricePerMillion: 0.02,
    }).optimize(input(1));
    expect(result.usage?.costUsd).toBe(0.06);
  });

  it('requires no credential to construct or score an empty candidate set', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect(await new JevBackend().optimize(input(0))).toEqual({
      decisions: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
  });

  it('sanitizes missing credentials without leaking context', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    await expect(new JevBackend().optimize(input(1))).rejects.toMatchObject({
      code: 'BACKEND_FAILED',
      message: 'Jev scoring request failed.',
    });
  });

  it('preflights all byte caps before sending any candidate', async () => {
    const systemOne = vi.fn(async () => fixture());
    const value = input();
    value.chunks[1]!.text = 'x'.repeat(25_000);
    await expect(new JevBackend({ client: { systemOne } }).optimize(value)).rejects.toMatchObject({
      code: 'BACKEND_FAILED',
    });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('rejects duplicate candidate IDs before sending', async () => {
    const systemOne = vi.fn(async () => fixture());
    const value = input();
    value.chunks[1]!.id = value.chunks[0]!.id;
    await expect(new JevBackend({ client: { systemOne } }).optimize(value)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it.each([
    ['missing model', { ...fixture(), model: undefined }],
    ['unknown answer ID', { ...fixture(), answers: { unrelated: {} } }],
    ['extra answer ID', { ...fixture(), answers: { relevance: {}, extra: {} } }],
    ['missing usage', { ...fixture(), usage: undefined }],
    ['fractional token usage', { ...fixture(), usage: { input_tokens: 1.2, output_tokens: 2 } }],
    ['negative token usage', { ...fixture(), usage: { input_tokens: -1, output_tokens: 2 } }],
    ['wrong answer type', { ...fixture(), answers: { relevance: { type: 'noul', noul: 0.8 } } }],
    ['out of range score', fixture(5)],
    ['non-finite score', fixture(Number.NaN)],
    ['malformed JSON response', 'private upstream response'],
  ])('rejects %s safely', async (_description, response) => {
    const client: JevClient = { systemOne: async () => response };
    await expect(new JevBackend({ client }).optimize(input(1))).rejects.toMatchObject({
      code: 'BACKEND_FAILED',
      message: 'Jev scoring response could not be validated.',
    });
  });

  it('rejects invalid confidence and distributions', async () => {
    const responses = [
      { type: 'score', score: 3, confidence: 9, legend: {}, probabilities: {} },
      {
        type: 'score',
        score: 3,
        confidence: 0.8,
        legend: { '0': '', '1': '', '2': '', '3': '', '4': '' },
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 0.5, '4': 0 },
      },
      {
        type: 'score',
        score: 3,
        confidence: 0.8,
        legend: { '0': '', '1': '', '2': '', '3': '', '4': '' },
        probabilities: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 },
      },
    ];
    for (const response of responses) {
      const client: JevClient = {
        systemOne: async () => ({ ...fixture(), answers: { relevance: response } }),
      };
      await expect(new JevBackend({ client }).optimize(input(1))).rejects.toMatchObject({
        code: 'BACKEND_FAILED',
      });
    }
  });

  it('sanitizes SDK rate-limit errors and preserves only status', async () => {
    const client = new TypeSafeClient({
      apiKey: 'secret-api-key',
      logLevel: 'off',
      retry: { maxRetries: 0 },
      fetch: async () =>
        new Response(JSON.stringify({ message: 'private text secret-api-key' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const failure = await new JevBackend({ client })
      .optimize(input(1))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OptimizerError);
    expect(failure).toMatchObject({ code: 'BACKEND_FAILED', status: 429 });
    expect(String(failure)).not.toContain('private text');
    expect(String(failure)).not.toContain('secret-api-key');
    expect(failure).not.toHaveProperty('cause');
  });

  it('sanitizes even an injected OptimizerError message', async () => {
    const client: JevClient = {
      systemOne: async () => {
        throw new OptimizerError('BACKEND_FAILED', 'secret-api-key');
      },
    };
    await expect(new JevBackend({ client }).optimize(input(1))).rejects.toMatchObject({
      message: 'Jev scoring response could not be validated.',
    });
  });

  it('rejects pre-cancelled calls without sending or exposing the cancellation reason', async () => {
    const controller = new AbortController();
    controller.abort('secret cancellation reason');
    const systemOne = vi.fn(async () => fixture());
    await expect(
      new JevBackend({ client: { systemOne } }).optimize(input(1), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED', message: 'Operation cancelled.' });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('cancels running work and does not start later candidates', async () => {
    const controller = new AbortController();
    const aborted = vi.fn();
    const systemOne = vi.fn(
      (_request: JevScoringRequest, options: Parameters<JevClient['systemOne']>[1]) => {
        options.signal.addEventListener('abort', aborted, { once: true });
        controller.abort('secret cancellation reason');
        return new Promise<unknown>(() => {});
      },
    );
    const client: JevClient = { systemOne };
    await expect(
      new JevBackend({ client, concurrency: 1 }).optimize(input(), controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledOnce();
  });

  it('bounds clients that ignore cancellation with a per-call deadline', async () => {
    vi.useFakeTimers();
    const client: JevClient = { systemOne: () => new Promise<unknown>(() => {}) };
    const assertion = expect(
      new JevBackend({ client, timeoutMs: 10 }).optimize(input(1)),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('rejects a timer duration that would overflow Node timers', () => {
    expect(() => new JevBackend({ timeoutMs: 2_147_483_648 })).toThrow(OptimizerError);
  });
});
