export type OptimizationMode = 'off' | 'conservative' | 'balanced' | 'aggressive';

/** Supplying context is an explicit opt-in to selection. Pin essential evidence. */
export interface ContextDocument {
  id: string;
  text: string;
  source?: string;
  protected?: boolean;
  importance?: number;
  /** Atomic documents are never split (use for JSON, code, or interdependent facts). */
  atomic?: boolean;
}

export interface ContextChunk extends ContextDocument {
  documentId: string;
  index: number;
  tokens: number;
}

export interface BackendInput {
  task: string;
  chunks: readonly ContextChunk[];
  targetTokens: number;
}

export interface BackendUsage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated charge, from configured dated prices; absent means unknown. */
  costUsd?: number;
}

export interface BackendOutput {
  /** Exactly one finite [0,1] relevance score per eligible chunk. */
  decisions: { id: string; score: number; confidence?: number }[];
  usage?: BackendUsage;
}

export interface ContextOptimizerBackend {
  readonly name: string;
  readonly external: boolean;
  optimize(input: BackendInput, signal?: AbortSignal): Promise<BackendOutput>;
}

export interface OptimizationPolicy {
  mode?: OptimizationMode;
  /** Context budget in the low-level API; never overrides preservation floors. */
  targetTokens?: number;
  maxReduction?: number;
  minContextTokens?: number;
  minScore?: number;
  fallback?: 'passthrough' | 'error';
  timeoutMs?: number;
  chunking?: 'document' | 'paragraph';
  maxChunkTokens?: number;
}

export interface TokenCount {
  tokens: number;
  method: 'local-estimate' | 'provider';
  accuracy: 'estimate' | 'exact';
  completeness: 'complete' | 'unknown';
}

export type OptimizationReason =
  | 'selected'
  | 'off'
  | 'no-context'
  | 'backend-failure'
  | 'no-safe-reduction'
  | 'unsupported-insertion';

export interface OptimizationMetrics {
  backend: string;
  mode: OptimizationMode;
  reason: OptimizationReason;
  originalContextTokens: number;
  optimizedContextTokens: number;
  selectedChunkIds: string[];
  rejectedChunkIds: string[];
  /** IDs/scores reveal metadata; telemetry receives neither. */
  scores: { id: string; score: number; confidence?: number }[];
  tokenCounting: 'local-estimate';
  durationMs: number;
  backendUsage?: BackendUsage;
  originalRequestTokens?: TokenCount;
  optimizedRequestTokens?: TokenCount;
}

export interface OptimizationResult {
  chunks: ContextChunk[];
  metrics: OptimizationMetrics;
}

/** No text, sources, identifiers, model names, errors, or credentials are emitted. */
export interface TelemetryEvent {
  mode: OptimizationMode;
  reason: OptimizationReason;
  originalContextTokens: number;
  optimizedContextTokens: number;
  durationMs: number;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

export interface ProviderUsage {
  /** Total prompt input, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/** Native request/response types stay in adapters; the engine imports no SDKs. */
export interface ProviderAdapter<Request, Response> {
  readonly name: 'openai' | 'anthropic' | 'google';
  validate(request: Request): void;
  /** Return a copy; never mutate the original request. Empty context returns it. */
  attachContext(request: Request, context: string): Request;
  estimateTokens(request: Request): TokenCount;
  countTokens?(request: Request, signal?: AbortSignal): Promise<TokenCount>;
  send(request: Request, signal?: AbortSignal): Promise<Response>;
  usage(response: Response): ProviderUsage | undefined;
}

export interface RequestOptions {
  task: string;
  context: readonly ContextDocument[];
  policy?: OptimizationPolicy;
  signal?: AbortSignal;
  tokenCounting?: 'local' | 'provider';
  /** Full input budget. Limits are checked again after native reconstruction. */
  hardInputTokens?: number;
  /** Caller-maintained model context window; no stale hardcoded model catalog. */
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
}

export interface PreparedRequest<Request> {
  request: Request;
  optimization: OptimizationMetrics;
}

export interface ChatResult<Request, Response> extends PreparedRequest<Request> {
  response: Response;
  usage?: ProviderUsage;
}
