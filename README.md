# LLM Context Optimizer

A TypeScript SDK for selecting explicit document context before an OpenAI, Anthropic, or Google Gemini request. Provider requests keep their native SDK types and fields. The core runs locally with a deterministic heuristic; TypeSafe's Jev is an optional backend.

This is an initial source release. Selection can discard necessary evidence. Pin essential documents, review metrics, and evaluate your own workload before enabling it in an application.

## Run the repository

Use Node.js 24 LTS and npm. From this checkout:

```sh
npm ci
npm run check
npm run benchmark
```

The package is ESM. `npm run build` produces JavaScript and declarations in `dist/`; `npm pack` produces an installable archive. These instructions do not imply that an npm registry release exists.

To use it from another application, run `npm pack` in this checkout, then install the resulting file from that application's directory:

```sh
npm install /absolute/path/to/llm-context-optimizer-0.1.0.tgz
```

## Optimize context locally

```ts
import { Optimizer, renderContext } from 'llm-context-optimizer';

const optimizer = new Optimizer();
const result = await optimizer.optimize({
  task: 'What is the support escalation deadline?',
  context: [
    {
      id: 'support-policy',
      source: 'policy/support',
      text: 'Escalate unresolved support cases within four hours.',
      protected: true,
      atomic: true,
    },
    {
      id: 'cafeteria',
      source: 'office/cafeteria',
      text: 'The cafeteria closes at 18:00. Menus rotate every week.',
    },
  ],
  policy: { mode: 'balanced', maxReduction: 0.5 },
});

console.log(renderContext(result.chunks));
console.log(result.metrics);
```

`protected: true` keeps every chunk of a document. `atomic: true` prevents splitting a document; use it for JSON, code, or evidence whose pieces must stay together. Neither flag makes unprotected evidence safe to remove. A score measures backend relevance, not confidence that the final answer will be correct.

The runnable [local example](examples/local.ts) also shows a custom backend, bypass mode, and fallback: run `npm run example:local`. It builds the package and executes TypeScript through Node.js 24's native type stripping. There is no API key, network access, or telemetry required for the core.

## Use a provider

Install the official SDK for the adapter you use. Import adapters through their dedicated subpaths so local optimization does not load provider SDKs.

```sh
npm install openai@~7.31.0
# Alternatives: @anthropic-ai/sdk@~0.132.1 or @google/genai@~2.28.0
```

```ts
import { Optimizer } from 'llm-context-optimizer';
import { OpenAIAdapter } from 'llm-context-optimizer/providers/openai';

const adapter = new OpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY });
const optimizer = new Optimizer();
const result = await optimizer.chat(
  adapter,
  {
    model: process.env.OPENAI_MODEL!,
    instructions: 'Answer using the supplied evidence; cite sources.',
    input: 'What is the escalation deadline?',
    temperature: 0,
  },
  {
    task: 'What is the escalation deadline?',
    context: [
      {
        id: 'support-policy',
        source: 'policy/support',
        text: 'Escalate unresolved support cases within four hours.',
        protected: true,
      },
    ],
  },
);

console.log(result.response); // Native provider response.
console.log(result.optimization);
console.log(result.usage); // Provider-reported usage, when supplied.
```

Choose a model available to your provider account and set `OPENAI_MODEL`; the SDK does not maintain a model catalog. The corresponding classes are `AnthropicAdapter` and `GoogleAdapter`, with native Anthropic Messages and Google `generateContent` request types. See [provider details](docs/providers.md) for typed examples and token-counting limitations.

`prepare(adapter, request, options)` reconstructs and validates a request without dispatching a model request; optional provider token counting can still make network calls. `chat(...)` prepares it, sends it, and returns the native response. Only `options.context` is eligible for selection. The SDK does not mine or rewrite system instructions, conversation history, tools, schemas, or multimodal blocks from the native request. Unsupported insertion is rejected explicitly; requests are never silently flattened into a common message format.

## Jev backend

Jev is the TypeSafe service identified in [TypeSafe's introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev). Its adapter is separate from the core and requires the official `@typesafe-ai/sdk`, credentials, and network access. Review [the verified Jev integration and unresolved service facts](docs/jev.md) before opting in. Local use does not contact Jev.

Context selection remains subject to local preservation and budget checks, including when an external backend supplies scores. Jev's native confidence, when present, is rubric-relative; it does not establish semantic correctness or answer quality.

## Policies, budgets, and failure behavior

- `mode: 'off'` bypasses selection while still attaching the supplied context for provider requests.
- `conservative` is the default. Its score threshold is `0.5`; `balanced` uses `0.2` and `aggressive` uses `0`. The default maximum reduction is `0.25` for every mode; change `maxReduction` explicitly to allow more removal. No mode guarantees semantic preservation.
- `targetTokens` is a context budget. `maxReduction` and `minContextTokens` impose preservation floors. Incompatible constraints raise an explicit budget error.
- `hardInputTokens` caps the reconstructed provider request. `contextWindowTokens` with `reservedOutputTokens` derives an additional input cap. These caps require a provider count with complete request coverage; local estimates raise `COUNT_UNAVAILABLE`. Supply current limits for your model and see adapter counting limitations.
- `fallback: 'passthrough'` is the default for an optimizer failure. It retains the original supplied context if that request satisfies the configured input cap. `fallback: 'error'` surfaces the optimizer failure. A hard budget conflict cannot silently send an over-budget request.
- `signal` supports cancellation; `timeoutMs` bounds backend selection. Cancellation is not converted into a provider dispatch.

See [architecture and API behavior](docs/architecture.md) for the pipeline, defaults, and limitations. This release performs selection only; it has no LLM compression stage or streaming dispatch.

## Counts, costs, and privacy

Context counts use `ceil(UTF-8 bytes / 3)`, including JSON source wrappers and conservative separator overhead per chunk. Native request estimates count their serialized representation and have unknown completeness for provider billing. These are local estimates, not exact tokenizer results. Optional provider counting uses `tokenCounting: 'provider'` and counts the reconstructed whole request where the adapter supports it; that can transmit the request to the provider and add latency. Provider-reported usage is kept separate from estimates.

Generation-provider prices are caller configured; there is no built-in provider model price catalog. The optional Jev backend has dated, configurable price defaults documented in [its integration guide](docs/jev.md). Cost helpers distinguish cache reads and writes, output tokens, and backend charges. Unknown backend charges must remain unknown. An estimated reduction in document context does not establish a reduction in the complete request, dollar savings, or answer quality.

Telemetry is disabled unless you pass a sink. Events contain only mode, reason, local context counts, and duration. No text, sources, chunk identifiers, models, raw errors, or credentials are emitted. The full result includes identifiers and scores for inspection, so treat your own logs accordingly. External backends receive eligible context; provider adapters send the reconstructed request using your own provider credentials. See [security guidance](SECURITY.md).

## Evidence and contribution

`npm run benchmark` runs original synthetic fixtures offline. It reports necessary-document recall, complete evidence retention, locally estimated token reduction, and failure/pass-through cases. It generates no model answers and makes no quality-parity or net-savings claim. See [benchmark methodology](benchmarks/README.md).

Contributions should include meaningful regression coverage, documented limits, and reproducible evidence for performance claims. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
