import { chunkDocuments, renderContext } from './chunking.js';
import { HeuristicBackend } from './backends/heuristic.js';
import { OptimizerError, providerError, throwIfAborted, withDeadline } from './errors.js';
import { selectUnderBudget } from './selection.js';
import type {
  BackendOutput,
  ChatResult,
  ContextChunk,
  ContextDocument,
  ContextOptimizerBackend,
  OptimizationMetrics,
  OptimizationPolicy,
  OptimizationResult,
  PreparedRequest,
  ProviderAdapter,
  ProviderUsage,
  RequestOptions,
  TelemetrySink,
  TokenCount,
} from './types.js';

const defaults = {
  mode: 'conservative',
  maxReduction: 0.25,
  minContextTokens: 0,
  fallback: 'passthrough',
  timeoutMs: 10_000,
  chunking: 'document',
  maxChunkTokens: 1024,
} as const;

function resolvePolicy(policy: OptimizationPolicy) {
  const resolved = { ...defaults, ...policy };
  if (
    !['off', 'conservative', 'balanced', 'aggressive'].includes(resolved.mode) ||
    !['passthrough', 'error'].includes(resolved.fallback) ||
    !['document', 'paragraph'].includes(resolved.chunking) ||
    !Number.isFinite(resolved.maxReduction) ||
    resolved.maxReduction < 0 ||
    resolved.maxReduction > 1 ||
    !Number.isSafeInteger(resolved.minContextTokens) ||
    resolved.minContextTokens < 0 ||
    !Number.isSafeInteger(resolved.timeoutMs) ||
    resolved.timeoutMs < 1 ||
    resolved.timeoutMs > 2_147_483_647 ||
    (resolved.targetTokens !== undefined &&
      (!Number.isSafeInteger(resolved.targetTokens) || resolved.targetTokens < 0)) ||
    (resolved.minScore !== undefined &&
      (!Number.isFinite(resolved.minScore) || resolved.minScore < 0 || resolved.minScore > 1))
  ) {
    throw new OptimizerError('INVALID_INPUT', 'Invalid optimization policy.');
  }
  return {
    ...resolved,
    minScore:
      resolved.minScore ??
      { conservative: 0.5, balanced: 0.2, aggressive: 0, off: 1 }[resolved.mode],
  };
}

function sumTokens(chunks: readonly ContextChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
}

function normalizedUsage(usage?: ProviderUsage): ProviderUsage | undefined {
  if (
    !usage ||
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
    ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens
  )
    return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}

function validateBackend(output: BackendOutput, chunks: readonly ContextChunk[]): void {
  if (!output || !Array.isArray(output.decisions) || output.decisions.length !== chunks.length) {
    throw new OptimizerError('BACKEND_FAILED', 'Invalid optimization backend response.');
  }
  const ids = new Set(chunks.map((chunk) => chunk.id));
  for (const decision of output.decisions) {
    if (
      !decision ||
      !ids.delete(decision.id) ||
      !Number.isFinite(decision.score) ||
      decision.score < 0 ||
      decision.score > 1 ||
      (decision.confidence !== undefined &&
        (!Number.isFinite(decision.confidence) ||
          decision.confidence < 0 ||
          decision.confidence > 1))
    ) {
      throw new OptimizerError('BACKEND_FAILED', 'Invalid optimization backend decision.');
    }
  }
  const usage = output.usage;
  if (
    usage &&
    (!Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)))
  ) {
    throw new OptimizerError('BACKEND_FAILED', 'Invalid optimization backend usage.');
  }
}

export class Optimizer {
  private readonly backend: ContextOptimizerBackend;
  private readonly policy: OptimizationPolicy;
  private readonly telemetry?: TelemetrySink;

  constructor(
    options: {
      backend?: ContextOptimizerBackend;
      policy?: OptimizationPolicy;
      telemetry?: TelemetrySink;
    } = {},
  ) {
    this.backend = options.backend ?? new HeuristicBackend();
    this.policy = { ...options.policy };
    resolvePolicy(this.policy);
    this.telemetry = options.telemetry;
  }

  async optimize(input: {
    task: string;
    context: readonly ContextDocument[];
    policy?: OptimizationPolicy;
    signal?: AbortSignal;
  }): Promise<OptimizationResult> {
    return this.optimizeInternal(input, true);
  }

  private async optimizeInternal(
    input: {
      task: string;
      context: readonly ContextDocument[];
      policy?: OptimizationPolicy;
      signal?: AbortSignal;
    },
    emit: boolean,
  ): Promise<OptimizationResult> {
    const started = performance.now();
    throwIfAborted(input.signal);
    if (typeof input.task !== 'string' || !input.task.trim() || !Array.isArray(input.context)) {
      throw new OptimizerError('INVALID_INPUT', 'Provide a nonempty task and a context array.');
    }
    const policy = resolvePolicy({ ...this.policy, ...input.policy });
    const chunks = chunkDocuments(input.context, {
      strategy: policy.chunking,
      maxTokens: policy.maxChunkTokens,
    });
    const original = sumTokens(chunks);
    const floor = Math.max(
      Math.ceil(original * (1 - policy.maxReduction)),
      policy.minContextTokens,
    );
    const budget = policy.targetTokens ?? original;
    if (
      budget < floor ||
      floor > original ||
      sumTokens(chunks.filter((chunk) => chunk.protected)) > budget
    ) {
      throw new OptimizerError(
        'BUDGET_CONFLICT',
        'Token budget conflicts with protected context or preservation limits.',
      );
    }
    const metrics: OptimizationMetrics = {
      backend: this.backend.name,
      mode: policy.mode,
      reason: 'selected',
      originalContextTokens: original,
      optimizedContextTokens: original,
      selectedChunkIds: chunks.map((chunk) => chunk.id),
      rejectedChunkIds: [],
      scores: [],
      tokenCounting: 'local-estimate',
      durationMs: 0,
    };
    const finish = (
      selected: ContextChunk[],
      reason: OptimizationMetrics['reason'],
    ): OptimizationResult => {
      metrics.reason = reason;
      metrics.optimizedContextTokens = sumTokens(selected);
      metrics.selectedChunkIds = selected.map((chunk) => chunk.id);
      const ids = new Set(metrics.selectedChunkIds);
      metrics.rejectedChunkIds = chunks
        .filter((chunk) => !ids.has(chunk.id))
        .map((chunk) => chunk.id);
      metrics.durationMs = performance.now() - started;
      if (emit) this.emit(metrics);
      return { chunks: selected, metrics };
    };
    const passthrough = (reason: OptimizationMetrics['reason']) => {
      if (original > budget)
        throw new OptimizerError(
          'BUDGET_CONFLICT',
          'Original context exceeds budget; pass-through is unsafe.',
        );
      return finish(chunks, reason);
    };
    if (!chunks.length) return finish(chunks, 'no-context');
    if (policy.mode === 'off') return passthrough('off');
    const eligible = chunks.filter((chunk) => !chunk.protected);
    if (!eligible.length) return passthrough('no-safe-reduction');
    let output: BackendOutput;
    try {
      output = await withDeadline(
        (signal) =>
          this.backend.optimize(
            { task: input.task, chunks: structuredClone(eligible), targetTokens: budget },
            signal,
          ),
        policy.timeoutMs,
        input.signal,
      );
      validateBackend(output, eligible);
    } catch {
      throwIfAborted(input.signal);
      if (policy.fallback === 'error') {
        throw new OptimizerError('BACKEND_FAILED', 'Optimization backend failed.');
      }
      return passthrough('backend-failure');
    }
    metrics.scores = output.decisions.map(({ id, score, confidence }) => ({
      id,
      score,
      ...(confidence === undefined ? {} : { confidence }),
    }));
    if (output.usage)
      metrics.backendUsage = {
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        ...(output.usage.costUsd === undefined ? {} : { costUsd: output.usage.costUsd }),
      };
    const scores = new Map(metrics.scores.map((entry) => [entry.id, entry.score]));
    const pinned = chunks.filter((chunk) => chunk.protected);
    const selectedIds = selectUnderBudget(
      eligible
        .filter((chunk) => scores.get(chunk.id)! >= policy.minScore)
        .map((chunk) => ({ chunk, score: scores.get(chunk.id)! + 1e-9 })),
      budget - sumTokens(pinned),
    );
    pinned.forEach((chunk) => selectedIds.add(chunk.id));
    // Retain low-scored context when required by the floor, never exceed the budget.
    let selected = chunks.filter((chunk) => selectedIds.has(chunk.id));
    const rejected = chunks
      .filter((chunk) => !selectedIds.has(chunk.id))
      .sort((a, b) => (scores.get(b.id) ?? 1) - (scores.get(a.id) ?? 1));
    for (const chunk of rejected) {
      if (sumTokens(selected) >= floor && selected.length) break;
      if (sumTokens(selected) + chunk.tokens <= budget) {
        selectedIds.add(chunk.id);
        selected.push(chunk);
      }
    }
    selected = chunks.filter((chunk) => selectedIds.has(chunk.id));
    if (sumTokens(selected) < floor || !selected.length) {
      // Reconsider the whole subset when a high-scoring large chunk blocks the
      // floor. For small sets this finds feasible alternatives exactly.
      const alternate = selectUnderBudget(
        eligible.map((chunk) => ({ chunk, score: scores.get(chunk.id)! + 1e-9 })),
        budget - sumTokens(pinned),
        Math.max(0, floor - sumTokens(pinned)),
      );
      pinned.forEach((chunk) => alternate.add(chunk.id));
      selected = chunks.filter((chunk) => alternate.has(chunk.id));
    }
    if (sumTokens(selected) < floor || !selected.length) return passthrough('no-safe-reduction');
    return finish(selected, selected.length === chunks.length ? 'no-safe-reduction' : 'selected');
  }

  async prepare<Request, Response>(
    adapter: ProviderAdapter<Request, Response>,
    request: Request,
    options: RequestOptions,
  ): Promise<PreparedRequest<Request>> {
    throwIfAborted(options.signal);
    adapter.validate(request);
    const policy = resolvePolicy({ ...this.policy, ...options.policy });
    for (const value of [
      options.hardInputTokens,
      options.contextWindowTokens,
      options.reservedOutputTokens,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new OptimizerError('INVALID_INPUT', 'Token limits must be nonnegative integers.');
      }
    }
    if (options.reservedOutputTokens !== undefined && options.contextWindowTokens === undefined) {
      throw new OptimizerError('INVALID_INPUT', 'Reserved output tokens require a context window.');
    }
    const windowBudget =
      options.contextWindowTokens === undefined
        ? Infinity
        : options.contextWindowTokens - (options.reservedOutputTokens ?? 0);
    const hardBudget = Math.min(options.hardInputTokens ?? Infinity, windowBudget);
    if (hardBudget < 0)
      throw new OptimizerError('BUDGET_CONFLICT', 'Output reservation exceeds the context window.');
    const count = async (candidate: Request): Promise<TokenCount> => {
      let result: TokenCount;
      try {
        if (options.tokenCounting === 'provider') {
          if (!adapter.countTokens)
            throw new OptimizerError('COUNT_UNAVAILABLE', 'Provider counting is unavailable.');
          result = await withDeadline(
            (signal) => adapter.countTokens!(candidate, signal),
            policy.timeoutMs,
            options.signal,
          );
        } else result = adapter.estimateTokens(candidate);
      } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof OptimizerError) throw error;
        throw new OptimizerError('COUNT_UNAVAILABLE', 'Token counting failed.');
      }
      if (
        !result ||
        !Number.isSafeInteger(result.tokens) ||
        result.tokens < 0 ||
        !['local-estimate', 'provider'].includes(result.method) ||
        !['estimate', 'exact'].includes(result.accuracy) ||
        !['complete', 'unknown'].includes(result.completeness)
      ) {
        throw new OptimizerError('COUNT_UNAVAILABLE', 'Invalid token count.');
      }
      if (Number.isFinite(hardBudget) && result.completeness !== 'complete') {
        throw new OptimizerError(
          'COUNT_UNAVAILABLE',
          'A full provider count is required to enforce a request budget.',
        );
      }
      return {
        tokens: result.tokens,
        method: result.method,
        accuracy: result.accuracy,
        completeness: result.completeness,
      };
    };
    const all = chunkDocuments(options.context, {
      strategy: policy.chunking,
      maxTokens: policy.maxChunkTokens,
    });
    const originalRequest = adapter.attachContext(request, renderContext(all));
    const originalCount = await count(originalRequest);
    const baseCount = Number.isFinite(hardBudget) ? await count(request) : undefined;
    if (baseCount && baseCount.tokens > hardBudget)
      throw new OptimizerError(
        'BUDGET_CONFLICT',
        'Protected native request exceeds the input budget.',
      );
    // Calibrate the local selector to the measured whole-context increment. Mixing
    // raw local estimates with provider tokens would reject requests that already fit.
    const available =
      baseCount && originalCount.tokens > hardBudget
        ? Math.floor(
            (sumTokens(all) * Math.max(0, hardBudget - baseCount.tokens)) /
              Math.max(1, originalCount.tokens - baseCount.tokens),
          )
        : undefined;
    let contextBudget = policy.targetTokens;
    if (available !== undefined) contextBudget = Math.min(contextBudget ?? Infinity, available);
    const optimized = await this.optimizeInternal(
      {
        task: options.task,
        context: options.context,
        policy: { ...policy, targetTokens: contextBudget },
        signal: options.signal,
      },
      false,
    );
    const prepared = adapter.attachContext(request, renderContext(optimized.chunks));
    const optimizedCount =
      optimized.chunks.length === all.length ? originalCount : await count(prepared);
    if (optimizedCount.tokens > hardBudget)
      throw new OptimizerError(
        'BUDGET_CONFLICT',
        'Reconstructed request exceeds the input budget.',
      );
    adapter.validate(prepared);
    optimized.metrics.originalRequestTokens = originalCount;
    optimized.metrics.optimizedRequestTokens = optimizedCount;
    this.emit(optimized.metrics);
    return { request: prepared, optimization: optimized.metrics };
  }

  async chat<Request, Response>(
    adapter: ProviderAdapter<Request, Response>,
    request: Request,
    options: RequestOptions,
  ): Promise<ChatResult<Request, Response>> {
    const prepared = await this.prepare(adapter, request, options);
    const policy = resolvePolicy({ ...this.policy, ...options.policy });
    try {
      const response = await withDeadline(
        (signal) => adapter.send(prepared.request, signal),
        policy.timeoutMs,
        options.signal,
      );
      return { ...prepared, response, usage: normalizedUsage(adapter.usage(response)) };
    } catch (error) {
      throwIfAborted(options.signal);
      if (error instanceof OptimizerError) throw error;
      throw providerError(error);
    }
  }

  private emit(metrics: OptimizationMetrics): void {
    if (!this.telemetry) return;
    try {
      const result = this.telemetry.emit({
        mode: metrics.mode,
        reason: metrics.reason,
        originalContextTokens: metrics.originalContextTokens,
        optimizedContextTokens: metrics.optimizedContextTokens,
        durationMs: metrics.durationMs,
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      /* Optional observability never breaks an application request. */
    }
  }
}
