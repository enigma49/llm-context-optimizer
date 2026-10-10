import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming,
  MessageTokensCount,
} from '@anthropic-ai/sdk/resources/messages';
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

export type AnthropicRequest = MessageCreateParamsNonStreaming;
export type AnthropicResponse = Message;

export interface AnthropicClient {
  messages: {
    create(request: AnthropicRequest, options?: SDKRequestOptions): Promise<AnthropicResponse>;
    countTokens?(
      request: MessageCountTokensParams,
      options?: SDKRequestOptions,
    ): Promise<MessageTokensCount>;
  };
}

export interface AnthropicAdapterOptions {
  client?: AnthropicClient;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AnthropicAdapter implements ProviderAdapter<AnthropicRequest, AnthropicResponse> {
  readonly name = 'anthropic' as const;
  readonly #client: AnthropicClient;

  constructor(options: AnthropicAdapterOptions) {
    if (!options.client && !options.apiKey) {
      throw new OptimizerError('INVALID_INPUT', 'Provide an Anthropic API key or SDK client.');
    }
    this.#client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: options.maxRetries,
        logLevel: 'off',
      });
  }

  validate(request: AnthropicRequest): void {
    validateEnvelope(request);
    if (
      !Number.isSafeInteger(request.max_tokens) ||
      request.max_tokens <= 0 ||
      !Array.isArray(request.messages) ||
      request.messages.length === 0
    ) {
      throw new OptimizerError(
        'INVALID_INPUT',
        'Anthropic requires messages and a positive max_tokens value.',
      );
    }
  }

  attachContext(request: AnthropicRequest, context: string): AnthropicRequest {
    if (!context) return request;
    this.validate(request);
    const envelope = record(request)!;
    if (envelope.container || envelope.context_management || envelope.mcp_servers) {
      unsupported('Attach context only with explicit input and without server-managed context.');
    }
    const pending = new Set<string>();
    const ids = new Set<string>();
    for (const message of request.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const value = record(block)!;
        if (
          value.type === 'server_tool_use' ||
          (typeof value.type === 'string' &&
            value.type.endsWith('_tool_result') &&
            value.type !== 'tool_result')
        ) {
          unsupported('Attach context outside server-tool result sequences.');
        }
        if (value.type === 'tool_use' && typeof value.id === 'string') {
          if (ids.has(value.id))
            unsupported('Tool calls must have unique IDs before attaching context.');
          ids.add(value.id);
          pending.add(value.id);
        }
        if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') {
          if (!pending.delete(value.tool_use_id))
            unsupported('Each tool result must match an earlier call before attaching context.');
        }
      }
    }
    const last = request.messages.at(-1);
    if (
      !last ||
      last.role !== 'user' ||
      pending.size > 0 ||
      (Array.isArray(last.content) && last.content.some((block) => block.type === 'tool_result'))
    ) {
      unsupported(
        'Attaching context requires a final user message outside a pending tool interaction.',
      );
    }
    const copy = cloneNative(request);
    const target = copy.messages.at(-1)!;
    target.content =
      typeof target.content === 'string'
        ? [
            { type: 'text', text: target.content },
            { type: 'text', text: `\n\n${context}` },
          ]
        : [...target.content, { type: 'text', text: `\n\n${context}` }];
    return copy;
  }

  estimateTokens(request: AnthropicRequest): TokenCount {
    return estimateRequestTokens(request);
  }

  async countTokens(request: AnthropicRequest, signal?: AbortSignal): Promise<TokenCount> {
    this.validate(request);
    const envelope = record(request)!;
    if (envelope.container || envelope.context_management || envelope.mcp_servers) {
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'Server-managed Anthropic context cannot be counted completely.',
      );
    }
    const counter = this.#client.messages.countTokens;
    if (!counter)
      throw new OptimizerError(
        'COUNT_UNAVAILABLE',
        'This Anthropic client has no token-counting method.',
      );
    const countRequest: MessageCountTokensParams = {
      model: request.model,
      messages: cloneNative(request.messages),
    };
    const fields = [
      'cache_control',
      'output_config',
      'system',
      'thinking',
      'tool_choice',
      'tools',
    ] as const;
    const source = record(cloneNative(request))!;
    const target = record(countRequest)!;
    for (const field of fields) {
      if (source[field] !== undefined) target[field] = source[field];
    }
    return sanitizedOperation(async () => {
      const result = await counter.call(this.#client.messages, countRequest, { signal });
      return providerCount(result.input_tokens, 'estimate');
    }, signal);
  }

  async send(request: AnthropicRequest, signal?: AbortSignal): Promise<AnthropicResponse> {
    this.validate(request);
    return sanitizedOperation(
      () => this.#client.messages.create(cloneNative(request), { signal }),
      signal,
    );
  }

  usage(response: AnthropicResponse): ProviderUsage | undefined {
    const usage = response.usage;
    if (!usage || !validUsageCount(usage.input_tokens) || !validUsageCount(usage.output_tokens))
      return undefined;
    const read = usage.cache_read_input_tokens ?? 0;
    const write = usage.cache_creation_input_tokens ?? 0;
    if (!validUsageCount(read) || !validUsageCount(write)) return undefined;
    const total = usage.input_tokens + read + write;
    if (!validUsageCount(total)) return undefined;
    return {
      inputTokens: total,
      outputTokens: usage.output_tokens,
      cachedInputTokens: read,
      cacheWriteTokens: write,
    };
  }
}
