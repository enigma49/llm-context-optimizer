# TypeSafe Jev backend

Verified against official sources on **October 9, 2026**. This integration targets TypeSafe AI's Jev, identified by the user's [official launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev). Other websites using the name Jev are not this integration's API authority.

## Verified service contract

| Property                | Verified behavior                                                                                                                           | Official source                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP and authentication | `POST https://api.typesafe.ai/v1/systemone`, JSON body, `Authorization: Bearer <key>`                                                       | [API reference](https://docs.typesafe.ai/api)                                                                                         |
| Request                 | `model`, shared `state`, named `questions`; state can be text, JSON object, or array                                                        | [API reference](https://docs.typesafe.ai/api)                                                                                         |
| Capabilities            | Typed `choice`, rubric `score`, and yes/no probability `noul`. Jev does not generate summaries or rewritten text                            | [Introduction](https://docs.typesafe.ai/introduction), [Coding agents](https://docs.typesafe.ai/introduction/coding-agents)           |
| Response                | Resolved `model`, matching `answers`, `usage.input_tokens`, `usage.output_tokens`                                                           | [API reference](https://docs.typesafe.ai/api)                                                                                         |
| Score                   | Probability-weighted rubric index, potentially fractional; `confidence`, `legend`, and `probabilities` accompany it. Up to 10 rubric levels | [API reference](https://docs.typesafe.ai/api), [Score response](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse) |
| Errors                  | Invalid authentication: 401; invalid body: 422; rate limit: 429; overloaded: 529. Retry transient limits with backoff                       | [API reference](https://docs.typesafe.ai/api)                                                                                         |

The official JavaScript/TypeScript package is [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript), with Node 20+ support. This repository uses the verified **0.6.0** API, available as an optional peer dependency. The SDK exposes `TypeSafeClient.systemOne(request, options)` and accepts cancellation through `options.signal`. Its [tagged types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts) and [package metadata](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/package.json) were checked directly. The SDK's [client source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts) casts parsed responses rather than validating them at runtime; this adapter performs its own checks.

## Enable it explicitly

This initial release is a local package; publication to npm has not been performed. Build a tarball from the repository:

```sh
npm ci
npm pack
```

Then install that tarball and the optional Jev SDK in your application. Replace the example path with the tarball's actual path:

```sh
npm install /path/to/llm-context-optimizer/llm-context-optimizer-0.1.0.tgz @typesafe-ai/sdk@0.6.0
```

Store `TYPESAFE_API_KEY` in your server's environment, or pass a key to the constructor. Keep Jev credentials separate from generation-provider keys.

```ts
import { JevBackend } from 'llm-context-optimizer/backends/jev';

const backend = new JevBackend({
  model: 'jev-1.13.0',
  concurrency: 4,
  timeoutMs: 10_000,
});

const scores = await backend.optimize({
  task: 'Which error code does the documentation specify?',
  targetTokens: 200,
  chunks: [
    {
      id: 'doc-1:0',
      documentId: 'doc-1',
      index: 0,
      text: 'Authentication failures return error E42.',
      source: 'reference.md',
      tokens: 16, // local estimate; not Jev-reported usage
    },
  ],
});
```

Constructing this backend or importing the SDK makes no network call and does not require a key. The first nonempty scoring operation lazily loads the optional SDK and creates its client. Missing keys or missing SDK installation produce a sanitized backend failure, allowing the optimizer's configured fallback to apply.

The production endpoint is fixed to the official TypeSafe host; ambient `TYPESAFE_BASE_URL` does not redirect credentials. Production SDK logging is explicitly disabled, because its debug logging includes unredacted request/response bodies. `client` injection exists for transport tests and deliberately configured integrations; injected clients are responsible for their own logging and credentials.

## Selection mapping and constraints

Each request carries one candidate chunk and the task. It asks a five-level relevance question: unrelated (0), tangential (1), supporting (2), directly useful (3), essential (4). The returned score divided by four is the backend's `[0,1]` **relevance score**. Each decision's separate `confidence` is Jev's actual reported rubric confidence, validated and passed through without invention or recalculation. It reflects certainty within this question and rubric; neither field is a guarantee of semantic correctness, retained-answer quality, or safety when dropping other evidence. The local heuristic does not supply confidence.

This mapping follows the official [RAG passage classification pattern](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), which evaluates query/passage pairs and applies inclusion policy in application code. Token budgets, protected evidence, reconstruction, and arithmetic belong to the core optimizer. This backend does not compress text or make a final keep/drop decision. Only explicitly supplied candidates are scored; native provider messages and credentials are not attached to Jev state.

Before scoring, all serialized UTF-8 request bodies are checked against `maxRequestBytes`, default **24,000 bytes**, including task, metadata, and rubric. This is a defensive payload bound, **not an exact Jev token count or proof that the model's window will fit**. Configure smaller chunk sizes when tasks are large. Oversized requests fail before any candidates are transmitted. A caller can deliberately change the cap; Jev's independent model limits still apply.

Up to `concurrency` calls run together; returned decisions retain candidate order. Candidate IDs must be unique. The backend validates the exact answer key, Score type, finite score and confidence ranges, five-level legend/distribution, rounded distribution sum and weighted score, and nonnegative safe-integer token usage. Missing, unexpected, or malformed decisions fail the entire scoring operation. Upstream messages, bodies, causes, and cancellation reasons are excluded from thrown errors; a numeric HTTP status may be retained.

Each call has a deadline and receives an `AbortSignal`. Cancellation or failure cancels other active calls and prevents later candidates from starting. SDK automatic retries are disabled to avoid stacked retry delays and potentially repeated charges; this release falls back or errors according to the core policy rather than retrying the service. A failed multi-call operation can still incur charges for calls already processed by TypeSafe. No unknown partial spend is fabricated in metrics.

## Limits, economics, and privacy

The [current model card](https://docs.typesafe.ai/models) lists `jev-1.13.0`, with `jev-latest` and `jev-preview` resolving to it. It documents 64k total request tokens and 32k for state plus the longest question. Inputs are text; images/audio/video require separate preprocessing. Published public limits are 100k tokens/second and 80 requests/second, and may change without notice. Aliases may move; pinned versions support reproducible comparisons.

The model card lists **$0.042 per million input tokens** and free output. `inputPricePerMillion` and `outputPricePerMillion` are configurable dated prices, defaulting to those values. Successful-call usage is provider-reported; `costUsd` is an **estimate** calculated from that usage and configured prices, not an invoice or a documented billing response field. Custom model/contract prices must be supplied explicitly. Provider generation cost and any counting/compression costs must also be included before describing the whole pipeline as cheaper.

The [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev) reports 70–500 ms end-to-end latency in vendor examples. That is a vendor claim, not a measured result from this project or an availability guarantee. Tests here use SDK/HTTP fixtures; no live key was supplied, so live latency, decision quality, billing, and availability remain unverified.

The [privacy policy](https://typesafe.ai/legal/privacy-policy) says TypeSafe collects supplied inputs, does not train or fine-tune models on them, and may retain personal data as reasonably necessary. It describes US hosting and disclosure to service providers. The model card mentions enterprise zero-data-retention arrangements; this SDK does **not** assume such an arrangement for ordinary accounts. Enabling Jev explicitly sends each candidate's text, task, ID, token estimate, and optional source to TypeSafe. The local heuristic backend does not do so.

The vendor's [known failure modes](https://docs.typesafe.ai/model-jaggedness/jev-1.13), reviewed October 2, 2026, include distractors in large states, unreliable numeric reasoning, literal reading, and adversarial content influencing decisions. Our narrow scoring requests and local budget arithmetic address some of those architectural concerns, but relevance scoring does not form a security boundary. Pin essential evidence and test representative/adversarial cases with your own expected outcomes.

Node **24** is this package's minimum runtime: the official [release table](https://nodejs.org/en/about/previous-releases) lists Node 24 and 22 as LTS, Node 26 as Current, and Node 20 as EOL on the verification date. The Jev SDK's lower runtime minimum does not override this package's supported-runtime choice. The SDK's package license is MIT, compatible with this project's MIT license.
