import OpenAI from 'openai';
import type {
  InputTokenCountParams,
  InputTokenCountResponse,
} from 'openai/resources/responses/input-tokens';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import { OptimizerError } from '../errors.js';
import { estimateRequestTokens } from '../tokenization.js';
import type { ProviderAdapter, ProviderUsage, TokenCount } from '../types.js';
import {
  cloneNative,
  providerCount,
  record,
  sanitizedOperation,
  unsupported,
  validateEnvelope,
  validUsageCount,
} from './common.js';
import type { SDKRequestOptions } from './common.js';

export type OpenAIRequest = ResponseCreateParamsNonStreaming;
export type OpenAIResponse = Response;

export interface OpenAIClient {
  responses: {
    create(request: OpenAIRequest, options?: SDKRequestOptions): Promise<OpenAIResponse>;
    inputTokens?: {
      count(
        request: InputTokenCountParams,
        options?: SDKRequestOptions,
      ): Promise<InputTokenCountResponse>;
    };
  };
}

export interface OpenAIAdapterOptions {
  client?: OpenAIClient;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** OpenAI Responses API, preserving native requests and native responses. */
export class OpenAIAdapter implements ProviderAdapter<OpenAIRequest, OpenAIResponse> {
  readonly name = 'openai' as const;
  readonly #client: OpenAIClient;

  constructor(options: OpenAIAdapterOptions) {
    if (!options.client && !options.apiKey) {
      throw new OptimizerError('INVALID_INPUT', 'Provide an OpenAI API key or SDK client.');
    }
    this.#client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: options.maxRetries,
        logLevel: 'off',
      });
  }

  validate(request: OpenAIRequest): void {
    validateEnvelope(request);
  }

  attachContext(request: OpenAIRequest, context: string): OpenAIRequest {
    if (!context) return request;
    this.validate(request);
    if (
      request.previous_response_id ||
      request.conversation ||
      request.prompt ||
      request.context_management?.length
    ) {
      unsupported(
        'Supply explicit conversation input without server-managed state before attaching context.',
      );
    }
    const copy = cloneNative(request);
    if (typeof copy.input === 'string') {
      copy.input = [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: copy.input },
            { type: 'input_text', text: `\n\n${context}` },
          ],
        },
      ];
      return copy;
    }
    if (!Array.isArray(copy.input) || copy.input.length === 0) {
      unsupported('Attaching context requires a final explicit user message.');
    }
    if (
      copy.input.some((item) => {
        const value = record(item);
        return (
          !value || (value.type !== undefined && value.type !== 'message') || !('role' in value)
        );
      })
    ) {
      unsupported(
        'Attach context outside tool-output, reasoning, or server-reference input sequences.',
      );
    }
    const last = record(copy.input.at(-1));
    if (!last || last.role !== 'user') {
      unsupported('Attaching context requires the final input item to be a user message.');
    }
    if (typeof last.content === 'string') {
      last.content = [
        { type: 'input_text', text: last.content },
        { type: 'input_text', text: `\n\n${context}` },
      ];
    } else if (Array.isArray(last.content)) {
      last.content.push({ type: 'input_text', text: `\n\n${context}` });
    } else {
      unsupported('The final user message must contain native text or content blocks.');
    }
    return copy;
  }

  estimateTokens(request: OpenAIRequest): TokenCount {
    return estimateRequestTokens(request);
  }

  async countTokens(request: OpenAIRequest, signal?: AbortSignal): Promise<TokenCount> {
    this.validate(request);
    const counter = this.#client.responses.inputTokens;
    if (!counter || request.prompt || request.context_management?.length) {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Full OpenAI input counting is unavailable for this request or client.',
      );
    }
    // Official input-count fields include all input-bearing fields supported by
    // this pinned API. Generation-only settings remain untouched on dispatch.
    const countRequest: InputTokenCountParams = {};
    const fields = [
      'conversation',
      'input',
      'instructions',
      'model',
      'parallel_tool_calls',
      'personality',
      'previous_response_id',
      'reasoning',
      'text',
      'tool_choice',
      'tools',
      'truncation',
    ] as const;
    const source = record(cloneNative(request))!;
    const target = record(countRequest)!;
    for (const field of fields) {
      if (source[field] !== undefined) target[field] = source[field];
    }
    return sanitizedOperation(async () => {
      const result = await counter.count(countRequest, { signal });
      return providerCount(result.input_tokens, 'exact');
    }, signal);
  }

  async send(request: OpenAIRequest, signal?: AbortSignal): Promise<OpenAIResponse> {
    this.validate(request);
    return sanitizedOperation(
      () => this.#client.responses.create(cloneNative(request), { signal }),
      signal,
    );
  }

  usage(response: OpenAIResponse): ProviderUsage | undefined {
    const usage = response.usage;
    if (!usage || !validUsageCount(usage.input_tokens) || !validUsageCount(usage.output_tokens))
      return undefined;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(validUsageCount(usage.input_tokens_details?.cached_tokens)
        ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
        : {}),
    };
  }
}
