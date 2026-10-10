import { describe, expect, it, vi } from 'vitest';
import { OptimizerError } from '../src/errors.js';
import { OpenAIAdapter } from '../src/providers/openai.js';
import type { OpenAIClient, OpenAIRequest, OpenAIResponse } from '../src/providers/openai.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import type {
  AnthropicClient,
  AnthropicRequest,
  AnthropicResponse,
} from '../src/providers/anthropic.js';
import { GoogleAdapter } from '../src/providers/google.js';
import type { GoogleClient, GoogleRequest, GoogleResponse } from '../src/providers/google.js';

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const openAIResponse = {
  id: 'response',
  usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } },
} as OpenAIResponse;
const anthropicResponse = {
  id: 'message',
  content: [{ type: 'text', text: 'answer' }],
  usage: {
    input_tokens: 20,
    output_tokens: 4,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
  },
} as AnthropicResponse;
const googleResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 4,
    cachedContentTokenCount: 7,
    thoughtsTokenCount: 3,
    toolUsePromptTokenCount: 2,
  },
} as GoogleResponse;

function openAIClient(): OpenAIClient {
  return {
    responses: {
      create: vi.fn(async () => openAIResponse),
      inputTokens: {
        count: vi.fn(async () => ({ input_tokens: 20, object: 'response.input_tokens' as const })),
      },
    },
  };
}
function anthropicClient(): AnthropicClient {
  return {
    messages: {
      create: vi.fn(async () => anthropicResponse),
      countTokens: vi.fn(async () => ({ input_tokens: 20 })),
    },
  };
}
function googleClient(): GoogleClient {
  return { models: { generateContent: vi.fn(async () => googleResponse) } };
}

describe('native reconstruction', () => {
  it('retains OpenAI instructions, native history, media, tools and schema without mutation', () => {
    const request = freeze<OpenAIRequest>({
      model: 'test-model',
      instructions: 'immutable instructions',
      input: [
        { role: 'developer', content: 'immutable developer message' },
        { role: 'assistant', content: 'recent answer' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'current question' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA=', detail: 'low' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'result',
          schema: { type: 'object', additionalProperties: false },
          strict: true,
        },
      },
      metadata: { app: 'test' },
      max_output_tokens: 32,
    });
    const before = structuredClone(request);
    const prepared = new OpenAIAdapter({ client: openAIClient() }).attachContext(
      request,
      'evidence',
    );
    expect(request).toEqual(before);
    expect(prepared).toMatchObject({
      instructions: request.instructions,
      tools: request.tools,
      text: request.text,
      metadata: request.metadata,
      max_output_tokens: 32,
    });
    expect(prepared.input).toEqual([
      ...request.input!.slice(0, -1),
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'current question' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA=', detail: 'low' },
          { type: 'input_text', text: '\n\nevidence' },
        ],
      },
    ]);
  });

  it('normalizes shorthand into its existing implied user turn', () => {
    const request: OpenAIRequest = { model: 'test-model', input: 'question' };
    expect(
      new OpenAIAdapter({ client: openAIClient() }).attachContext(request, 'evidence').input,
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'question' },
          { type: 'input_text', text: '\n\nevidence' },
        ],
      },
    ]);
    const google: GoogleRequest = {
      model: 'test-model',
      contents: [{ text: 'question' }, { inlineData: { mimeType: 'image/png', data: 'AAA=' } }],
    };
    expect(
      new GoogleAdapter({ client: googleClient() }).attachContext(google, 'evidence').contents,
    ).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'question' },
          { inlineData: { mimeType: 'image/png', data: 'AAA=' } },
          { text: '\n\nevidence' },
        ],
      },
    ]);
  });

  it('preserves Anthropic signed thinking, resolved tool pairs, system messages and caches', () => {
    const request = freeze<AnthropicRequest>({
      model: 'test-model',
      max_tokens: 32,
      system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral', ttl: '1h' },
      messages: [
        { role: 'user', content: 'earlier question' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'signed text', signature: 'opaque-signature' },
            { type: 'tool_use', id: 'toolu_test', name: 'lookup', input: { key: 'value' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: 'tool output' }],
        },
        { role: 'system', content: 'operator instruction after results' },
        { role: 'assistant', content: 'recent answer' },
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'AAA=', media_type: 'image/png' } },
            { type: 'text', text: 'question', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    });
    const prepared = new AnthropicAdapter({ client: anthropicClient() }).attachContext(
      request,
      'evidence',
    );
    expect(prepared.messages.slice(0, -1)).toEqual(request.messages.slice(0, -1));
    expect(prepared.messages.at(-1)!.content).toEqual([
      ...(request.messages.at(-1)!.content as object[]),
      { type: 'text', text: '\n\nevidence' },
    ]);
    expect(prepared.system).toEqual(request.system);
    expect(prepared.cache_control).toEqual(request.cache_control);
    expect(request.messages.at(-1)!.content).toHaveLength(2);
  });

  it('retains Gemini part signatures, native role, modalities and media without flattening', () => {
    const request = freeze<GoogleRequest>({
      model: 'test-model',
      contents: [
        { role: 'model', parts: [{ text: 'recent answer', thoughtSignature: 'opaque' }] },
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: 'gs://bucket/audio.wav', mimeType: 'audio/wav' } },
            { text: 'question' },
          ],
        },
      ],
      config: {
        systemInstruction: 'rules',
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        tools: [
          { functionDeclarations: [{ name: 'lookup', parametersJsonSchema: { type: 'object' } }] },
        ],
        maxOutputTokens: 32,
      },
    });
    const prepared = new GoogleAdapter({ client: googleClient() }).attachContext(
      request,
      'evidence',
    );
    expect(prepared.config).toEqual(request.config);
    expect(prepared.contents).toEqual([
      { role: 'model', parts: [{ text: 'recent answer', thoughtSignature: 'opaque' }] },
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: 'gs://bucket/audio.wav', mimeType: 'audio/wav' } },
          { text: 'question' },
          { text: '\n\nevidence' },
        ],
      },
    ]);
    expect(request.contents).not.toEqual(prepared.contents);
  });

  it('rejects unsafe insertion rather than inventing a new conversation turn', () => {
    const openai = new OpenAIAdapter({ client: openAIClient() });
    const anthropic = new AnthropicAdapter({ client: anthropicClient() });
    const google = new GoogleAdapter({ client: googleClient() });
    const unsafe = [
      () =>
        openai.attachContext(
          { model: 'test-model', input: [{ role: 'assistant', content: 'prefill' }] },
          'evidence',
        ),
      () =>
        openai.attachContext(
          { model: 'test-model', input: 'question', previous_response_id: 'opaque' },
          'evidence',
        ),
      () =>
        openai.attachContext(
          {
            model: 'test-model',
            input: [{ type: 'function_call_output', call_id: 'call', output: 'result' }],
          },
          'evidence',
        ),
      () =>
        anthropic.attachContext(
          {
            model: 'test-model',
            max_tokens: 32,
            messages: [
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }],
              },
            ],
          },
          'evidence',
        ),
      () =>
        anthropic.attachContext(
          {
            model: 'test-model',
            max_tokens: 32,
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }],
              },
              { role: 'user', content: 'question' },
            ],
          },
          'evidence',
        ),
      () =>
        google.attachContext(
          {
            model: 'test-model',
            contents: 'question',
            config: { cachedContent: 'cachedContents/opaque' },
          },
          'evidence',
        ),
      () =>
        google.attachContext(
          {
            model: 'test-model',
            contents: [
              { role: 'model', parts: [{ functionCall: { name: 'lookup' } }] },
              { role: 'user', parts: [{ text: 'question' }] },
            ],
          },
          'evidence',
        ),
      () =>
        google.attachContext(
          {
            model: 'test-model',
            contents: [
              { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: {} } }] },
            ],
          },
          'evidence',
        ),
    ];
    for (const operation of unsafe)
      expect(operation).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REQUEST' }));
    const native: OpenAIRequest = {
      model: 'test-model',
      input: [{ type: 'function_call_output', call_id: 'call', output: 'result' }],
    };
    expect(openai.attachContext(native, '')).toBe(native);
  });

  it('keeps each parallel Gemini call pending until its individual result arrives', () => {
    const adapter = new GoogleAdapter({ client: googleClient() });
    const request: GoogleRequest = {
      model: 'test-model',
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'lookup', args: { key: 'one' } } },
            { functionCall: { name: 'lookup', args: { key: 'two' } } },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'lookup', response: { key: 'one' } } }],
        },
        { role: 'user', parts: [{ text: 'next question' }] },
      ],
    };
    expect(() => adapter.attachContext(request, 'evidence')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_REQUEST' }),
    );
    const resolved: GoogleRequest = {
      ...request,
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'lookup', args: { key: 'one' } } },
            { functionCall: { name: 'lookup', args: { key: 'two' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'lookup', response: { key: 'one' } } },
            { functionResponse: { name: 'lookup', response: { key: 'two' } } },
          ],
        },
        { role: 'model', parts: [{ text: 'both results received' }] },
        { role: 'user', parts: [{ text: 'next question' }] },
      ],
    };
    expect(adapter.attachContext(resolved, 'evidence').contents).toHaveLength(4);
  });
});

describe('dispatch, credentials and cancellation', () => {
  it('clones before SDK dispatch, passes cancellation, and returns the untouched native response', async () => {
    const signal = new AbortController().signal;
    const native: OpenAIRequest = {
      model: 'test-model',
      input: [{ role: 'user', content: 'question' }],
      metadata: { stable: 'yes' },
    };
    const client = openAIClient();
    client.responses.create = vi.fn(async (request, options) => {
      expect(options?.signal).toBe(signal);
      request.metadata!.stable = 'SDK mutation';
      return openAIResponse;
    });
    expect(await new OpenAIAdapter({ client }).send(freeze(native), signal)).toBe(openAIResponse);
    expect(native.metadata!.stable).toBe('yes');
    const anthropic = anthropicClient();
    anthropic.messages.create = vi.fn(async (request, options) => {
      expect(options?.signal).toBe(signal);
      request.messages[0]!.content = 'SDK mutation';
      return anthropicResponse;
    });
    const original = freeze<AnthropicRequest>({
      model: 'test-model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'question' }],
    });
    expect(await new AnthropicAdapter({ client: anthropic }).send(original, signal)).toBe(
      anthropicResponse,
    );
    expect(original.messages[0]!.content).toBe('question');
    const google = googleClient();
    google.models.generateContent = vi.fn(async (request) => {
      expect(request.config?.abortSignal).toBe(signal);
      request.config!.responseJsonSchema = { sdk: 'mutation' };
      return googleResponse;
    });
    const gemini = freeze<GoogleRequest>({
      model: 'test-model',
      contents: 'question',
      config: { responseJsonSchema: { type: 'object' } },
    });
    expect(await new GoogleAdapter({ client: google }).send(gemini, signal)).toBe(googleResponse);
    expect(gemini.config!.responseJsonSchema).toEqual({ type: 'object' });
  });

  it('honors both caller and native Gemini AbortSignals', async () => {
    const native = new AbortController();
    const caller = new AbortController();
    const client = googleClient();
    client.models.generateContent = vi.fn(async (request) => {
      expect(request.config?.abortSignal).not.toBe(native.signal);
      native.abort();
      expect(request.config?.abortSignal?.aborted).toBe(true);
      return googleResponse;
    });
    await expect(
      new GoogleAdapter({ client }).send(
        { model: 'test-model', contents: 'question', config: { abortSignal: native.signal } },
        caller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects pre-cancelled operations before contacting SDKs', async () => {
    const client = openAIClient();
    const signal = AbortSignal.abort();
    await expect(
      new OpenAIAdapter({ client }).send({ model: 'test-model', input: 'question' }, signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(client.responses.create).not.toHaveBeenCalled();
  });

  it('sanitizes vendor errors and removes message, request, headers and cause', async () => {
    const secret = 'sk-test-sensitive';
    const client = openAIClient();
    client.responses.create = vi.fn(async () => {
      throw Object.assign(new Error(`credential ${secret}`), {
        status: 429,
        headers: { authorization: secret },
        request: { apiKey: secret },
      });
    });
    const adapter = new OpenAIAdapter({ client });
    try {
      await adapter.send({ model: 'test-model', input: 'question' });
      throw new Error('Expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OptimizerError);
      expect(error).toMatchObject({
        code: 'PROVIDER_FAILED',
        status: 429,
        message: 'Provider request failed.',
      });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('headers');
    }
    const configured = new GoogleAdapter({ client: googleClient(), apiKey: secret });
    expect(Object.keys(configured)).toEqual(['name']);
    expect(JSON.stringify(configured)).not.toContain(secret);
  });

  it('rejects streaming requests', () => {
    const adapter = new OpenAIAdapter({ client: openAIClient() });
    expect(() =>
      adapter.validate({
        model: 'test-model',
        input: 'question',
        stream: true,
      } as unknown as OpenAIRequest),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REQUEST' }));
    const anthropic = new AnthropicAdapter({ client: anthropicClient() });
    expect(() =>
      anthropic.validate({
        model: 'test-model',
        messages: [{ role: 'user', content: 'question' }],
        max_tokens: 32,
        stream: true,
      } as unknown as AnthropicRequest),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REQUEST' }));
  });

  it('uses Developer API despite ambient enterprise flags and shields requests from real SDK normalization', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'offline response' }] } }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      const request = freeze<GoogleRequest>({
        model: 'test-model',
        contents: 'question',
        config: {
          responseSchema: { type: 'object', properties: { answer: { type: ['string', 'null'] } } },
          httpOptions: { fetch },
        },
      });
      const adapter = new GoogleAdapter({ apiKey: 'private-key' });
      expect((await adapter.send(request)).text).toBe('offline response');
      expect(String(fetch.mock.calls[0]![0])).toContain(
        'generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
      );
      expect(request.config!.responseSchema).toEqual({
        type: 'object',
        properties: { answer: { type: ['string', 'null'] } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('token counts and native usage', () => {
  it('sends all countable OpenAI input fields, with no mutation or generation-only params', async () => {
    const client = openAIClient();
    const signal = new AbortController().signal;
    const request = freeze<OpenAIRequest>({
      model: 'test-model',
      input: 'question',
      instructions: 'rules',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: false }],
      text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' } } },
      max_output_tokens: 32,
    });
    const adapter = new OpenAIAdapter({ client });
    const count = await adapter.countTokens(request, signal);
    expect(count).toEqual({
      tokens: 20,
      method: 'provider',
      accuracy: 'exact',
      completeness: 'complete',
    });
    expect(client.responses.inputTokens!.count).toHaveBeenCalledWith(
      {
        model: request.model,
        input: request.input,
        instructions: request.instructions,
        tools: request.tools,
        text: request.text,
      },
      { signal },
    );
    expect(adapter.estimateTokens(request)).toMatchObject({
      accuracy: 'estimate',
      completeness: 'unknown',
    });
    expect(adapter.usage(openAIResponse)).toEqual({
      inputTokens: 20,
      outputTokens: 4,
      cachedInputTokens: 7,
    });
  });

  it('labels Anthropic provider counts estimates, includes schemas/cache and sums cache usage', async () => {
    const client = anthropicClient();
    const adapter = new AnthropicAdapter({ client });
    const request: AnthropicRequest = {
      model: 'test-model',
      max_tokens: 32,
      system: 'rules',
      messages: [{ role: 'user', content: 'question' }],
      cache_control: { type: 'ephemeral' },
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    };
    expect(await adapter.countTokens(request)).toMatchObject({
      tokens: 20,
      accuracy: 'estimate',
      completeness: 'complete',
    });
    expect(client.messages.countTokens).toHaveBeenCalledWith(
      {
        model: request.model,
        messages: request.messages,
        system: request.system,
        cache_control: request.cache_control,
        output_config: request.output_config,
      },
      { signal: undefined },
    );
    expect(adapter.usage(anthropicResponse)).toEqual({
      inputTokens: 30,
      outputTokens: 4,
      cachedInputTokens: 7,
      cacheWriteTokens: 3,
    });
  });

  it('uses the complete Gemini REST request including instructions, tools and schema', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ totalTokens: 25 }), { status: 200 }),
    );
    const signal = new AbortController().signal;
    const request = freeze<GoogleRequest>({
      model: 'models/test-model',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'question' }, { inlineData: { mimeType: 'image/png', data: 'AAA=' } }],
        },
      ],
      config: {
        systemInstruction: 'rules',
        tools: [
          { functionDeclarations: [{ name: 'lookup', parametersJsonSchema: { type: 'object' } }] },
        ],
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        maxOutputTokens: 32,
      },
    });
    const adapter = new GoogleAdapter({
      client: googleClient(),
      clientApi: 'developer',
      apiKey: 'private-key',
      fetch,
    });
    expect(await adapter.countTokens(request, signal)).toMatchObject({
      tokens: 25,
      method: 'provider',
      accuracy: 'estimate',
      completeness: 'complete',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:countTokens',
    );
    expect(url).not.toContain('private-key');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'private-key' });
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(init!.body as string)).toEqual({
      generateContentRequest: {
        model: 'models/test-model',
        contents: request.contents,
        systemInstruction: { role: 'user', parts: [{ text: 'rules' }] },
        tools: request.config!.tools,
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object' },
          maxOutputTokens: 32,
        },
      },
    });
    expect(adapter.usage(googleResponse)).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      cachedInputTokens: 7,
    });
  });

  it('uses an injected full counter with copies and cancellation rather than contents-only SDK counts', async () => {
    const signal = new AbortController().signal;
    const request = freeze<GoogleRequest>({
      model: 'test-model',
      contents: 'question',
      config: { systemInstruction: 'rules' },
    });
    const count = vi.fn(async (value: GoogleRequest, abort?: AbortSignal) => {
      expect(abort).toBe(signal);
      expect(value).toEqual(request);
      value.config!.systemInstruction = 'counter mutation';
      return 20;
    });
    const adapter = new GoogleAdapter({ client: googleClient(), count });
    expect(await adapter.countTokens(request, signal)).toMatchObject({
      tokens: 20,
      completeness: 'complete',
    });
    expect(request.config!.systemInstruction).toBe('rules');
  });

  it('refuses incomplete or malformed counts before budget enforcement', async () => {
    const request: GoogleRequest = { model: 'test-model', contents: 'question' };
    await expect(
      new GoogleAdapter({ client: googleClient() }).countTokens(request),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ totalTokens: -1 })),
    );
    const adapter = new GoogleAdapter({
      client: googleClient(),
      clientApi: 'developer',
      apiKey: 'private-key',
      fetch,
    });
    await expect(adapter.countTokens(request)).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    await expect(
      adapter.countTokens({ ...request, config: { cachedContent: 'cachedContents/opaque' } }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    await expect(
      adapter.countTokens({ ...request, config: { audioTranscriptionConfig: {} } }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    const openai = openAIClient();
    openai.responses.inputTokens!.count = vi.fn(async () => ({
      input_tokens: NaN,
      object: 'response.input_tokens' as const,
    }));
    await expect(
      new OpenAIAdapter({ client: openai }).countTokens({ model: 'test-model', input: 'question' }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
  });

  it('never exposes Gemini REST error bodies containing secrets', async () => {
    const body = 'provider says private-key';
    const response = new Response(body, { status: 403 });
    const read = vi.spyOn(response, 'text');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    const adapter = new GoogleAdapter({
      client: googleClient(),
      clientApi: 'developer',
      apiKey: 'private-key',
      fetch,
    });
    await expect(
      adapter.countTokens({ model: 'test-model', contents: 'question' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 403,
      message: 'Provider token-count request failed.',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects HTTP body replacements and mismatched counting transports', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ totalTokens: 1 })),
    );
    const adapter = new GoogleAdapter({
      client: googleClient(),
      clientApi: 'developer',
      apiKey: 'private-key',
      fetch,
    });
    const override: GoogleRequest = {
      model: 'test-model',
      contents: 'question',
      config: {
        httpOptions: { extraBody: { contents: [{ parts: [{ text: 'replace everything' }] }] } },
      },
    };
    expect(() => adapter.attachContext(override, 'evidence')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_REQUEST' }),
    );
    await expect(adapter.countTokens(override)).rejects.toMatchObject({
      code: 'COUNT_UNAVAILABLE',
    });
    await expect(
      adapter.countTokens({
        model: 'test-model',
        contents: 'question',
        config: { httpOptions: { apiVersion: 'v1alpha' } },
      }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    await expect(
      adapter.countTokens({
        model: 'test-model',
        contents: 'question',
        config: { httpOptions: { baseUrl: 'https://example.test' } },
      }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      adapter.validate({
        model: 'test-model',
        contents: 'question',
        config: { httpOptions: { headers: { 'X-Goog-Api-Key': 'secret' } } },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('requires an explicit Developer client assertion and refuses SDK-transformed schema counts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ totalTokens: 1 })),
    );
    const request: GoogleRequest = { model: 'test-model', contents: 'question' };
    await expect(
      new GoogleAdapter({ client: googleClient(), apiKey: 'private-key', fetch }).countTokens(
        request,
      ),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    const adapter = new GoogleAdapter({
      client: googleClient(),
      clientApi: 'developer',
      apiKey: 'private-key',
      fetch,
    });
    await expect(
      adapter.countTokens({ ...request, config: { responseSchema: { type: 'object' } } }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    await expect(
      adapter.countTokens({
        ...request,
        config: { tools: [{ functionDeclarations: [{ name: 'lookup', parameters: {} }] }] },
      }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    await expect(
      adapter.countTokens({
        ...request,
        config: { tools: [{ functionDeclarations: [{ name: 'lookup', response: {} }] }] },
      }),
    ).rejects.toMatchObject({ code: 'COUNT_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
