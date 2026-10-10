# Provider adapters

Adapters use native official SDK request and response types. Import only the
provider subpath you need; the core package does not load provider SDKs. Install
the corresponding optional peer dependency yourself. The pinned compatibility
targets are `openai ~7.31.0`, `@anthropic-ai/sdk ~0.132.1`, and
`@google/genai ~2.28.0`. This project runs on Node.js 24 or later.

```ts
import { Optimizer } from 'llm-context-optimizer';
import { OpenAIAdapter } from 'llm-context-optimizer/providers/openai';

const adapter = new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY });
const result = await new Optimizer().chat(
  adapter,
  { model: process.env.OPENAI_MODEL!, input: 'Answer using the supplied evidence.' },
  {
    task: 'Find the answer in the supplied evidence.',
    context: [{ id: 'evidence', text: 'Your application evidence goes here.', protected: true }],
  },
);
```

Every adapter also accepts `{ client }` with a narrow SDK-compatible interface,
which makes credential-free tests possible. Keep keys on the adapter or SDK
client. Credentials in Gemini native HTTP authentication headers are rejected
because `prepare()` returns the native request. Adapter credentials and client
references are runtime private fields, absent from prepared requests and JSON
serialization. SDK clients constructed by the OpenAI/Anthropic adapters have
logging disabled. Logging on injected SDK clients is controlled by the caller.

## Context insertion and preservation

Only documents supplied through `RequestOptions.context` enter selection.
Existing native conversation content is immutable. The adapter appends one text
block to the final user turn, preserving previous messages, media, instructions,
tool schemas, structured output formats, signatures, IDs, and native options.
String shorthand is normalized into its existing implied user turn with native
text blocks. Media is never stringified into text. Empty context returns the
original request unchanged. SDK dispatch and provider counting receive copies
so SDK parameter normalization cannot mutate the caller's request.

Explicit context requires a safe final user turn. Otherwise the adapter raises
`UNSUPPORTED_REQUEST`; callers should place the documents in a suitable native
user message themselves or resume the pending interaction before retrying.
Supplied documents cannot be silently discarded. In particular:

- OpenAI context insertion rejects server conversation IDs, reusable prompt
  references, context-management settings, and nonmessage input items such as
  function outputs or reasoning items. Native Responses requests with no
  additional documents can still pass through the SDK.
- Anthropic context insertion rejects pending calls, a final tool-result turn,
  server-tool sequences, and opaque server-managed context. Resolved client tool
  pairs and previous signed thinking remain unchanged. Mid-conversation system
  messages are retained in their original positions.
- Gemini context insertion rejects cached-content/continuation references,
  pending calls, a final function-result turn, server tool parts, final signed
  parts, and HTTP body overrides. Full `Content[]` history preserves roles and
  signatures. Do not mix Content objects with shorthand Part arrays.

All three adapters require an explicit nonempty model name and reject streaming.
OpenAI uses the Responses API; Anthropic uses nonstreaming Messages; Google uses
`generateContent`, not Live or Interactions. Responses retain native finish
reasons, refusals, safety feedback, tool calls, and all raw usage fields. The
optimizer does not execute client tools itself. An injected SDK client may have
its own automatic execution behavior; configure that client accordingly.

## Token accounting

Local counting is a UTF-8 byte estimate with `accuracy: 'estimate'` and
`completeness: 'unknown'`. It is neither a tokenizer nor a guaranteed upper bound
and is especially unsuitable for media, cached input, and opaque server state.
Hard whole-request budgets require complete provider counting.

| Provider  | Counting facility                                                                            | Accuracy label | Limits                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | `responses.inputTokens.count`                                                                | `exact`        | Includes native input, instructions, tools, output schema, reasoning, and countable server conversation references. Reusable prompts and context-management options are rejected for counting because the pinned count method does not accept them.                                                                                                                                                             |
| Anthropic | `messages.countTokens`                                                                       | `estimate`     | Includes messages, system, tools, thinking, output configuration, and cache controls. The provider rejects unsupported server tools/MCP and URL/file media sources; this SDK preserves those inputs and surfaces a sanitized count failure. Opaque server context is rejected locally. Counting does not simulate cache hits.                                                                                   |
| Gemini    | Official REST `countTokens` with full `generateContentRequest`, or injected `count` callback | `estimate`     | Built-in counting targets Gemini Developer API `v1beta`. It includes explicit contents, system instruction, tool declarations/config, safety settings, supported generation settings and JSON schema fields. Cached/continuation state is refused. Unknown config options, SDK-transformed schemas, executable SDK tools, custom HTTP body/headers/transport/endpoint/version require an injected full counter. |

Google's JS SDK contents-only count method cannot count full Developer API
requests containing system instructions or tools: its converter rejects these
count options. The adapter therefore uses the official REST endpoint with the
API key in an HTTP header, never a query parameter. The REST mapping rejects
unmapped settings rather than claiming complete coverage. When injecting a
client alongside an API key, inject your own full counter or explicitly assert
`clientApi: 'developer'` for a client targeting the same Developer API `v1beta`
endpoint without hidden body overrides. Constructed clients explicitly disable
Enterprise/Vertex mode regardless of ambient environment flags. Built-in counts
require `responseJsonSchema` and function declaration `parametersJsonSchema` /
`responseJsonSchema` fields instead of SDK-transformed `responseSchema`,
`parameters`, or `response` fields. The `count(request, signal)`
callback must count the entire native request; it receives a copy and must
return a nonnegative integer. It is trusted application code, not a contents-only
tokenizer. Neither provider-count path counts individual chunks over the network.

Normalized usage is an allowlist of numeric counters:

- OpenAI input includes cached input; cached tokens are a separate subset.
- Anthropic input totals uncached input plus cache reads plus cache writes.
- Gemini input includes prompt tokens plus separately reported tool-use prompt
  tokens. Prompt tokens already include cached tokens. Output includes candidates
  plus separately reported thoughts. Cached tokens are never added twice.

Keep `result.response` for the authoritative native breakdown. Optional missing
usage stays missing. Malformed counters are not converted into zero. Prices and
model context limits are supplied by the application, not hardcoded here.

## Cancellation, errors, and running examples

The engine bounds operations with a deadline and forwards `AbortSignal` to SDKs.
Google combines that signal with any signal already in the native request.
Provider construction accepts an optional `timeoutMs`; OpenAI and Anthropic also
accept `maxRetries` for their SDK retry policy. Retrying is not duplicated by the
optimizer. Cancellation cannot guarantee the provider stops processing or bills
nothing. Vendor error text, bodies, headers, request payloads, credentials, and
raw causes are excluded from thrown errors; numeric HTTP status may remain.

The examples require explicit credentials and model environment variables. They
make billable network requests only when you choose to run them:

```sh
npm run build
# Set the selected service's key and model through your environment/secret store.
node examples/openai.ts       # OPENAI_API_KEY, OPENAI_MODEL
node examples/anthropic.ts    # ANTHROPIC_API_KEY, ANTHROPIC_MODEL
node examples/google.ts       # GEMINI_API_KEY, GEMINI_MODEL
```

These examples use the local heuristic backend. No optimizer key or telemetry
configuration is required. Unit tests use injected clients and fetch mocks;
passing them does not establish live provider compatibility or semantic quality.

## Verified primary references

Reviewed October 9, 2026; APIs can change. Reverify when updating peer ranges.

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
  and [official token-count guide](https://developers.openai.com/api/docs/guides/token-counting).
- [Anthropic TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript),
  [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting),
  [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
  and [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).
- [Google official SDK](https://github.com/googleapis/js-genai),
  [REST counting](https://ai.google.dev/api/tokens),
  [generation request and usage metadata](https://ai.google.dev/api/generate-content),
  and [SDK converter implementing Developer API count limitations](https://github.com/googleapis/js-genai/blob/main/src/converters/_models_converters.ts).

The installed OpenAI and Google SDKs are Apache-2.0 licensed; Anthropic's SDK is MIT licensed.
Retain applicable third-party license notices when redistributing dependencies.
See the [OpenAI license](https://github.com/openai/openai-node/blob/master/LICENSE),
[Anthropic license](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/LICENSE),
and [Google license](https://github.com/googleapis/js-genai/blob/main/LICENSE).
