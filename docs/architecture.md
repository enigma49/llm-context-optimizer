# Architecture and API behavior

The core selects explicitly supplied context documents and leaves native provider requests under the provider adapter's ownership. It does not extract text from conversation history, rewrite native messages, or normalize provider requests into a shared lowest-common-denominator schema.

## Public boundaries

- `Optimizer.optimize({ task, context, policy?, signal? })` returns selected chunks and optimization metrics. It performs no provider dispatch.
- `Optimizer.prepare(adapter, nativeRequest, options)` optimizes `options.context`, attaches the rendered selection, counts and validates the reconstructed request, and returns `{ request, optimization }`.
- `Optimizer.chat(adapter, nativeRequest, options)` prepares and dispatches the request, returning `{ request, optimization, response, usage? }`. Request and response types come from the native SDK.
- `ContextOptimizerBackend` provides `name`, `external`, and `optimize(input, signal?)`. `BackendInput` contains the task, eligible chunks, and target context budget. A result supplies one relevance score in `[0, 1]` for every candidate chunk, plus optional native confidence and measured backend usage. Native confidence is not an answer-correctness probability. The core rejects missing, duplicate, foreign, nonfinite, and out-of-range decisions.
- `ProviderAdapter<Request, Response>` validates and copies native requests, attaches context, estimates or optionally counts tokens, dispatches, and extracts usage.

The core root export does not load provider SDKs. `providers/openai`, `providers/anthropic`, `providers/google`, and `backends/jev` are optional package subpaths. Their official SDKs are optional peers with narrow compatible ranges. Injected narrow clients support deterministic tests without network access.

## Pipeline

1. Validate task, document IDs, policy ranges, and cancellation.
2. Split eligible documents at structural boundaries when configured. Atomic documents remain whole. Chunks retain a document ID, stable chunk ID, index, source, and original ordering.
3. Estimate the rendered original context, including source wrappers.
4. Preserve protected chunks and calculate the effective budget under token and reduction limits.
5. Ask the chosen backend to score unprotected candidates. The local heuristic is deterministic lexical ranking; the Jev adapter makes an explicit external call.
6. Validate all backend decisions before applying them. Select candidates under the budget with an exact knapsack algorithm for at most 64 candidates and budgets up to 50,000 local tokens; larger inputs use stable utility-per-token greedy selection. Apply the preservation floor and retain original ordering. The floor can force low-scoring chunks to remain.
7. Return unchanged chunk text and rendered source references. Selection never generates summaries or changes a retained chunk's factual content.
8. For provider preparation, reconstruct the native request, preserve original fields, and validate any full input budget with a complete provider count before dispatch. Local estimates cannot enforce a full-request cap.

The selection policy is deterministic for identical documents, scores, and policy. Its relevance scores do not establish whether evidence can be safely omitted. Dependency between documents, contradictory sources, synonyms, prompt injections, and multiple-hop reasoning can defeat lexical ranking. Pin known dependencies or retain all context when the required evidence is uncertain. For sets beyond the exact-knapsack limits, greedy selection can fail to find a feasible subset even when one exists; the engine conservatively passes through if allowed, or raises a budget conflict.

## Default policy

| Setting            | Default                | Meaning                                                                       |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `mode`             | `conservative`         | Score threshold `0.5`; balanced uses `0.2`, aggressive uses `0`.              |
| `maxReduction`     | `0.25`                 | Keep at least 75% of original locally estimated context tokens in every mode. |
| `minContextTokens` | `0`                    | Additional retained-token floor.                                              |
| `targetTokens`     | Original context count | No smaller context cap unless supplied.                                       |
| `fallback`         | `passthrough`          | Retain original context on backend failure when it fits the cap.              |
| `timeoutMs`        | `10000`                | Deadline for backend work and provider operations.                            |
| `chunking`         | `document`             | Keep each document whole. Paragraph mode splits unprotected plain text.       |
| `maxChunkTokens`   | `1024`                 | Approximate plain-text splitting target in paragraph mode.                    |

Constructor policy is merged with per-operation policy. `minScore` overrides a mode's threshold. `maxChunkTokens` is not a universal hard chunk cap: protected/atomic documents, detected code or JSON, and indivisible oversized identifiers stay whole. There is no overlap setting in this release.

## Preservation and budgets

`protected: true` retains all chunks originating from a document. `atomic: true` prevents splitting; it does not protect that document from selection. Use both for an essential interdependent record. Document and chunk identifiers are unique and traceable; source wrappers are included in local context counts.

`targetTokens` limits selected context. `maxReduction` and `minContextTokens` set floors on retained context; protected chunks are also mandatory. A budget that cannot satisfy those constraints raises a budget error. The engine must not remove pinned evidence merely to meet a requested cap.

Full-request controls are `hardInputTokens` and `contextWindowTokens - reservedOutputTokens`. These require `tokenCounting: 'provider'` and an adapter count whose coverage is `complete`; unavailable or incomplete counts raise `COUNT_UNAVAILABLE`. The engine checks the original request with supplied context, the immutable native request, and the reconstructed selection when needed. Native instructions, tools, schemas, and serialization overhead also consume input capacity. Model limits and output reservations are caller configured. A provider count can still be labeled an estimate; complete coverage and exact tokenizer accuracy are distinct properties.

`mode: 'off'` retains all supplied context. It does not skip input validation or permit dispatch beyond a hard cap. Unsupported insertion raises `UNSUPPORTED_REQUEST` instead of dropping supplied context silently.

## Failure and cancellation

The default `fallback: 'passthrough'` retains the original supplied context on a backend failure, malformed result, or backend timeout when that request can proceed under the configured input cap. `fallback: 'error'` surfaces the failure. Protected-content and full-request budget conflicts are explicit errors.

An already-aborted signal, or caller cancellation during optimization or dispatch, rejects the operation. A backend must honor its supplied signal where practical. A local timeout bounds how long the caller waits; it cannot force arbitrary custom backend work to stop. Provider errors remain distinguishable from backend and budget errors.

`OptimizerError.code` is one of `INVALID_INPUT`, `BUDGET_CONFLICT`, `BACKEND_FAILED`, `TIMEOUT`, `ABORTED`, `PROVIDER_FAILED`, `COUNT_UNAVAILABLE`, or `UNSUPPORTED_REQUEST`. Errors omit raw SDK messages and causes. Backend timeout follows the chosen backend fallback; provider timeout rejects. A numeric provider status may be included, without vendor response bodies.

## Accounting

`estimateTextTokens` computes `ceil(UTF-8 byte length / 3)`. This is intentionally approximate. Each context chunk counts its JSON source wrapper and two separator newlines, including a conservative trailing separator for the final chunk. Splitting documents can add wrapper cost. Native request estimates count serialized request fields, label accuracy `estimate`, and label completeness `unknown`; serialization is not a provider tokenizer and may misrepresent multimodal payload cost.

Adapters can optionally count the complete reconstructed provider request through `tokenCounting: 'provider'`. The engine does not make one counting request per chunk. Available counting APIs and completeness differ by provider; see [provider documentation](providers.md). Provider response usage is kept separate from preflight estimates and can include cache reads and writes.

Cost estimates use caller-supplied prices. They must include provider input, output, cache reads/writes, and any measured backend charges before comparing a baseline with an optimized dispatch. Missing backend charges mean unknown economics. There is no built-in model pricing table, profitability claim, or production quality-parity claim.

`estimateCosts({ baseline: { usage, pricing }, optimized: { usage, pricing }, backendCostUsd })` accepts separate scenarios. `pricing` contains USD-per-million `inputPerMillion` and `outputPerMillion`, plus `cachedInputPerMillion` and `cacheWritePerMillion` when those usage components are present. Total input usage includes the cache components; those components are subtracted before regular-input pricing. Its result includes `baselineProviderUsd`, `optimizedProviderUsd`, `backendUsd`, `optimizedTotalUsd`, `netSavingsUsd`, and a `missing` list. Net savings is absent until both provider costs and the backend charge are known; pass `0` only for a backend whose charge is known to be zero.

## Privacy and extension limits

There is no default telemetry sink or hosted endpoint. A configured sink receives only aggregate mode, reason, local context token counts, and duration. Exceptions and telemetry do not include raw document content or provider credentials. Full optimization metrics contain identifiers and scores for application inspection.

Only the external backend receives candidate chunks and the task; providers receive the reconstructed native request. Optional provider token-counting calls also transmit request data. Service retention and billing facts are external dependencies documented separately, not implied library guarantees.

V1 has no streaming provider dispatch, semantic answer evaluator, recursive optimization, or LLM compression. Streaming requests are rejected explicitly. Compression would require a separate opt-in stage with evidence-preservation checks, measured usage, and failure retention; it is not represented as zero-cost selection.
