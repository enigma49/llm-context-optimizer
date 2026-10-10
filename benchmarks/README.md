# Offline evidence-retention benchmark

Run `npm ci` once, then `npm run benchmark`. The script builds the SDK and writes `benchmarks/reports/latest.json`. Use `npm run benchmark -- --output /path/to/report.json` to choose a different report path. No API credentials or network calls are used by the runner; installing dependencies can require network access.

The fixtures are original synthetic documents distributed under the repository's MIT license. Every fixture declares the source-document IDs necessary to answer its task and explains the annotation. All documents are atomic, and the runner checks that retained document text is unchanged before assigning recall credit. Cases cover direct lexical matching, synonyms, a three-document reasoning chain, conflicting policy sources, code with a rollback, and adversarial untrusted text.

## What is measured

`evidenceDocumentRecall` is the number of retained necessary documents divided by the number annotated necessary. `completeEvidenceRetention` is true only if every necessary document remains. These measure selection coverage against manual annotations. They do not measure whether a generated answer is correct, whether the model resists malicious content, or whether the annotations are exhaustive.

`localContextReduction` is `1 - optimizedContextTokens / originalContextTokens`. Context tokens are the SDK's approximate `ceil(UTF-8 bytes / 3)` estimates, including rendered JSON source wrappers and conservative separator overhead per chunk. This measures the supplied document context, not the entire provider request or actual billed input. There are no provider or optimizer service charges, generated model answers, quality-parity claims, or dollar-savings results in this benchmark.

Summaries are grouped by scenario. Recall is weighted by necessary-document count; reduction is weighted by original local context tokens. Complete evidence retention is a per-case fraction. Expected rejected requests are counted separately and excluded from these denominators; they are never scored as zero-token successes. Full per-case rows list retained and missing document IDs, policy, reason, and local token estimates.

## Scenarios

- `off` keeps all supplied context and provides the baseline.
- `heuristic-balanced` uses lexical scoring, `maxReduction: 0.8`, and each fixture's target budget fraction. This intentionally exposes synonym, dependency, and adversarial failures. The fixture budgets are authored stress conditions, not tuned production settings or the conservative default.
- `pinned-necessary-evidence` uses the annotations as an oracle to protect required documents. Its budget is raised if needed to fit them. It verifies pin preservation; it does not show that the system can discover necessary evidence automatically.
- `backend-outage-passthrough` uses a local backend that throws. With no restrictive target cap, the engine retains all context and reports `backend-failure`.
- `backend-outage-budget-conflict` simulates the same outage under a cap smaller than the original context. The expected outcome is `BUDGET_CONFLICT`, so pass-through never silently violates the configured context cap.

The adversarial case contains an instruction attempt as document text. The runner does not execute it or send it to an LLM. Retaining or dropping that document is visible, but injection resistance is not evaluated.

## Reproducibility and limits

Files are sorted before loading. The report records a SHA-256 fingerprint of filenames and fixture bytes, the Node version, policies, and outcomes. Wall-clock time and timestamps are intentionally omitted. Repeated runs with the same code, runtime, and fixtures should produce byte-identical JSON. The CI workflow uploads its report as a build artifact.

This small authored suite is a regression and failure demonstration, not representative production research. It cannot establish latency, broad retrieval quality, semantic correctness, Jev performance, or economic value. A live comparison would need explicit credentials, a fixed and licensed task set, model/version/date records, provider-reported usage, complete optimizer charges, current caller-supplied prices, blinded answer evaluation, and disclosed failures. No live run is performed here.

To add a fixture, provide a unique ID, task, tags, a budget fraction strictly between `0.2` and `1`, nonempty atomic documents with unique IDs, necessary IDs that exist, and an annotation explaining why each required source is needed. Commit fixture data and methodology, not generated reports containing real application context.
