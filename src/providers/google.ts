import { GoogleGenAI } from '@google/genai';
import type {
  Content,
  ContentListUnion,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import { OptimizerError } from '../errors.js';
import { estimateRequestTokens } from '../tokenization.js';
import type { ProviderAdapter, ProviderUsage, TokenCount } from '../types.js';
import {
  cloneNative,
  combinedSignal,
  providerCount,
  record,
  sanitizedOperation,
  unsupported,
  validateEnvelope,
  validUsageCount,
} from './common.js';

export type GoogleRequest = GenerateContentParameters;
export type GoogleResponse = GenerateContentResponse;

export interface GoogleClient {
  models: {
    generateContent(request: GoogleRequest): Promise<GoogleResponse>;
  };
}

/** Must count the complete native request, including instructions and tools. */
export type GoogleFullTokenCounter = (
  request: GoogleRequest,
  signal?: AbortSignal,
) => Promise<number>;

export interface GoogleAdapterOptions {
  client?: GoogleClient;
  /** Explicitly attest an injected client uses Developer API v1beta without hidden body overrides. */
  clientApi?: 'developer';
  apiKey?: string;
  timeoutMs?: number;
  /** Supply this for Vertex/Enterprise or native options outside the REST mapping. */
  count?: GoogleFullTokenCounter;
  fetch?: typeof globalThis.fetch;
}

function part(value: unknown): Part {
  if (typeof value === 'string') return { text: value };
  if (!record(value) || Array.isArray(value)) {
    unsupported('Provide explicit Gemini Content objects for nested or unsupported shorthand.');
  }
  return value as Part;
}

function isContent(value: unknown): value is Content {
  return Array.isArray(record(value)?.parts);
}

/** Match documented SDK shorthand; never serialize or flatten native media. */
function contents(value: ContentListUnion): Content[] {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  if (items.length === 0) unsupported('Gemini requires nonempty contents.');
  if (items.every(isContent)) return items.map((item) => cloneNative(item));
  if (items.some(isContent)) unsupported('Do not mix Gemini Content objects and part shorthand.');
  const parts = items.map(part);
  if (
    parts.some(
      (item) => item.functionCall || item.functionResponse || item.toolCall || item.toolResponse,
    )
  ) {
    unsupported('Wrap Gemini tool parts in explicit Content objects with their native role.');
  }
  return [{ role: 'user', parts: cloneNative(parts) }];
}

const rootConfigFields = new Set([
  'systemInstruction',
  'tools',
  'toolConfig',
  'safetySettings',
  'labels',
  'serviceTier',
]);
const generationConfigFields = new Set([
  'temperature',
  'topP',
  'topK',
  'candidateCount',
  'maxOutputTokens',
  'stopSequences',
  'responseLogprobs',
  'logprobs',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
  'responseMimeType',
  'responseJsonSchema',
  'responseModalities',
  'thinkingConfig',
  'mediaResolution',
  'speechConfig',
  'imageConfig',
  'audioTimestamp',
]);

function restCountRequest(request: GoogleRequest): Record<string, unknown> {
  const model = request.model.replace(/^models\//, '');
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new OptimizerError(
      'COUNT_UNAVAILABLE',
      'Use an injected full counter for non-Developer-API model names.',
    );
  }
  const result: Record<string, unknown> = {
    model: `models/${model}`,
    contents: contents(request.contents),
  };
  const generationConfig: Record<string, unknown> = {};
  if (request.config?.responseSchema !== undefined) {
    throw new OptimizerError(
      'COUNT_UNAVAILABLE',
      'Use responseJsonSchema or an injected full counter for SDK-transformed response schemas.',
    );
  }
  for (const [key, value] of Object.entries(request.config ?? {})) {
    if (value === undefined || key === 'abortSignal' || key === 'httpOptions') continue;
    if (key === 'automaticFunctionCalling') {
      // Only the explicitly disabled SDK feature has no extra input semantics.
      if (record(value)?.disable === true) continue;
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Disable automatic function execution or provide a full counter.',
      );
    }
    if (rootConfigFields.has(key)) {
      if (key === 'systemInstruction') {
        const instruction = contents(value as ContentListUnion);
        if (instruction.length !== 1)
          throw new OptimizerError(
            'COUNT_UNAVAILABLE',
            'System instructions require one Content object.',
          );
        result[key] = instruction[0];
      } else {
        result[key] = cloneNative(value);
      }
    } else if (generationConfigFields.has(key)) {
      if (key === 'speechConfig' && typeof value === 'string') {
        throw new OptimizerError(
          'COUNT_UNAVAILABLE',
          'Use an explicit speechConfig object or an injected full counter.',
        );
      }
      generationConfig[key] = cloneNative(value);
    } else {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'A native Gemini option is outside the complete REST token-count mapping; supply a full counter.',
      );
    }
  }
  if (
    Array.isArray(result.tools) &&
    result.tools.some((tool) => {
      const value = record(tool);
      return (
        !value ||
        typeof value.callTool === 'function' ||
        typeof value.tool === 'function' ||
        (Array.isArray(value.functionDeclarations) &&
          value.functionDeclarations.some((declaration) => {
            const schema = record(declaration);
            return schema?.parameters !== undefined || schema?.response !== undefined;
          }))
      );
    })
  ) {
    throw new OptimizerError(
      'COUNT_UNAVAILABLE',
      'Use JSON-schema tool fields or an injected full counter for transformed or executable SDK tools.',
    );
  }
  if (Object.keys(generationConfig).length) result.generationConfig = generationConfig;
  return result;
}

export class GoogleAdapter implements ProviderAdapter<GoogleRequest, GoogleResponse> {
  readonly name = 'google' as const;
  readonly #client: GoogleClient;
  readonly #apiKey?: string;
  readonly #fullCounter?: GoogleFullTokenCounter;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs?: number;
  readonly #developerClient: boolean;

  constructor(options: GoogleAdapterOptions) {
    if (!options.client && !options.apiKey) {
      throw new OptimizerError('INVALID_INPUT', 'Provide a Gemini API key or SDK client.');
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new OptimizerError('INVALID_INPUT', 'Provider timeout must be a positive integer.');
    }
    this.#client =
      options.client ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        enterprise: false,
        vertexai: false,
        httpOptions: options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
      });
    this.#apiKey = options.apiKey;
    this.#fullCounter = options.count;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs;
    this.#developerClient = !options.client || options.clientApi === 'developer';
  }

  validate(request: GoogleRequest): void {
    validateEnvelope(request);
    if (
      request.contents === undefined ||
      request.contents === null ||
      (Array.isArray(request.contents) && request.contents.length === 0)
    ) {
      throw new OptimizerError('INVALID_INPUT', 'Gemini requires nonempty contents.');
    }
    const headers = request.config?.httpOptions?.headers;
    if (
      headers &&
      Object.keys(headers).some((key) =>
        ['authorization', 'x-goog-api-key', 'x-api-key', 'cookie'].includes(key.toLowerCase()),
      )
    ) {
      throw new OptimizerError(
        'INVALID_INPUT',
        'Configure credentials on the Gemini adapter or SDK client, outside the native request.',
      );
    }
  }

  attachContext(request: GoogleRequest, context: string): GoogleRequest {
    if (!context) return request;
    this.validate(request);
    if (request.config?.cachedContent || request.config?.continuationToken) {
      unsupported('Attach context without cached content or server continuation state.');
    }
    if (Object.keys(request.config?.httpOptions?.extraBody ?? {}).length) {
      unsupported(
        'Remove HTTP body overrides before attaching context, so evidence cannot be replaced after reconstruction.',
      );
    }
    const copy = cloneNative(request);
    const normalized = contents(copy.contents);
    const pending = new Map<string, number>();
    const ids = new Set<string>();
    for (const message of normalized) {
      for (const item of message.parts ?? []) {
        if (item.toolCall || item.toolResponse)
          unsupported('Attach context outside server-tool input sequences.');
        if (item.functionCall) {
          const call = item.functionCall;
          const key = call.id ? `id:${call.id}` : call.name ? `name:${call.name}` : undefined;
          if (!key || (call.id && ids.has(call.id)))
            unsupported(
              'Tool calls need unique IDs or explicit matching names before attaching context.',
            );
          if (call.id) ids.add(call.id);
          pending.set(key, (pending.get(key) ?? 0) + 1);
        }
        if (item.functionResponse) {
          const response = item.functionResponse;
          const key = response.id
            ? `id:${response.id}`
            : response.name
              ? `name:${response.name}`
              : undefined;
          const remaining = key ? pending.get(key) : undefined;
          if (!key || !remaining)
            unsupported('Each tool result must match an earlier call before attaching context.');
          if (remaining === 1) pending.delete(key);
          else pending.set(key, remaining - 1);
        }
      }
    }
    const last = normalized.at(-1)!;
    if (
      (last.role !== undefined && last.role !== 'user') ||
      pending.size > 0 ||
      (last.parts ?? []).some(
        (item) =>
          item.functionResponse || item.functionCall || item.thought || item.thoughtSignature,
      )
    ) {
      unsupported(
        'Attaching context requires a final user message outside a pending or signed tool interaction.',
      );
    }
    last.parts = [...(last.parts ?? []), { text: `\n\n${context}` }];
    copy.contents = normalized;
    return copy;
  }

  estimateTokens(request: GoogleRequest): TokenCount {
    return estimateRequestTokens(request);
  }

  async countTokens(request: GoogleRequest, signal?: AbortSignal): Promise<TokenCount> {
    this.validate(request);
    if (request.config?.cachedContent || request.config?.continuationToken) {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Opaque Gemini cached or continuation state cannot be counted completely.',
      );
    }
    const activeSignal = combinedSignal(signal, request.config?.abortSignal);
    if (this.#fullCounter) {
      return sanitizedOperation(
        async () =>
          providerCount(await this.#fullCounter!(cloneNative(request), activeSignal), 'estimate'),
        activeSignal,
      );
    }
    if (!this.#apiKey || !this.#developerClient) {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Provide a Gemini API key or an injected complete token counter.',
      );
    }
    const httpOptions = request.config?.httpOptions;
    if (
      httpOptions &&
      (Object.keys(httpOptions.extraBody ?? {}).length ||
        Object.keys(httpOptions.headers ?? {}).length ||
        httpOptions.baseUrl ||
        httpOptions.baseUrlResourceScope !== undefined ||
        httpOptions.fetch ||
        (httpOptions.apiVersion !== undefined && httpOptions.apiVersion !== 'v1beta'))
    ) {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Custom HTTP body, headers, transport, endpoint, or API version requires an injected full Gemini counter.',
      );
    }
    const payload = restCountRequest(request);
    const model = request.model.replace(/^models\//, '');
    const timeout = request.config?.httpOptions?.timeout ?? this.#timeoutMs;
    if (
      timeout !== undefined &&
      (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    ) {
      throw new OptimizerError(
        'INVALID_INPUT',
        'Provider timeout must be a positive supported integer.',
      );
    }
    const fetchSignal = combinedSignal(
      activeSignal,
      timeout === undefined ? undefined : AbortSignal.timeout(timeout),
    );
    return sanitizedOperation(async () => {
      const response = await this.#fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.#apiKey! },
          body: JSON.stringify({ generateContentRequest: payload }),
          signal: fetchSignal,
        },
      );
      if (!response.ok) {
        // Never read or expose provider error bodies, URLs, headers, or credentials.
        throw new OptimizerError(
          'PROVIDER_FAILED',
          'Provider token-count request failed.',
          response.status,
        );
      }
      const result: unknown = await response.json();
      return providerCount(record(result)?.totalTokens, 'estimate');
    }, activeSignal);
  }

  async send(request: GoogleRequest, signal?: AbortSignal): Promise<GoogleResponse> {
    this.validate(request);
    const copy = cloneNative(request);
    const activeSignal = combinedSignal(signal, request.config?.abortSignal);
    if (activeSignal) copy.config = { ...copy.config, abortSignal: activeSignal };
    return sanitizedOperation(() => this.#client.models.generateContent(copy), activeSignal);
  }

  usage(response: GoogleResponse): ProviderUsage | undefined {
    const usage = response.usageMetadata;
    if (
      !usage ||
      !validUsageCount(usage.promptTokenCount) ||
      !validUsageCount(usage.candidatesTokenCount)
    )
      return undefined;
    const thoughts = usage.thoughtsTokenCount ?? 0;
    const toolInput = usage.toolUsePromptTokenCount ?? 0;
    if (!validUsageCount(thoughts) || !validUsageCount(toolInput)) return undefined;
    const input = usage.promptTokenCount + toolInput;
    const output = usage.candidatesTokenCount + thoughts;
    if (!validUsageCount(input) || !validUsageCount(output)) return undefined;
    return {
      inputTokens: input,
      outputTokens: output,
      ...(validUsageCount(usage.cachedContentTokenCount)
        ? { cachedInputTokens: usage.cachedContentTokenCount }
        : {}),
    };
  }
}
