# Contributing

Use Node.js 24 LTS and npm. Install with `npm ci`, then run `npm run check`. The check runs strict TypeScript checking, ESLint, formatting, tests, and the package build. `npm run benchmark` runs the offline evidence-retention fixtures. No provider credentials are needed for these checks.

Keep the dependency footprint small. The core must not import provider SDKs, perform network requests, or require credentials. Provider SDKs belong behind their optional adapter subpaths. Backend results must be validated before their scores affect selection. Preserve native request fields and reject unsupported behavior explicitly.

For a bug report, provide the package/runtime versions, a minimal redacted reproduction, the expected behavior, and the observed behavior. Do not include credentials or private prompts. Report vulnerabilities using [SECURITY.md](SECURITY.md).

For a change:

1. Explain the concrete problem and proposed resulting behavior.
2. Add or update focused tests when behavior changes, especially preservation, malformed backend results, aborts, timeout/fallback, hard budgets, and provider request reconstruction.
3. Update documentation and examples for public API changes. Examples are typechecked by `npm run typecheck`.
4. Run `npm run check` and the offline benchmark when selection or accounting changes.
5. Include the checks you ran and any limits in the pull request. Do not imply that mocked provider tests are live integration tests.

Use `npm exec prettier -- --write <changed-files>` for targeted formatting. `npm run format` reformats the whole repository; avoid unrelated churn. Tests run with `npm test`; `npm run test:watch` is available during development.

Benchmark fixtures must be redistributable, reproducible, and annotated with the document IDs necessary to answer the task. Include failures and difficult cases. Do not infer answer quality from evidence recall or report net dollar savings without the complete request, measured backend charges, actual prices, and a stated evaluation protocol.

Live provider experiments are opt-in. Keep secrets in your environment or an ignored `.env` file, and state the model, date, pricing assumptions, prompt set, and evaluation method with any results. Never add an uncredentialed live call to ordinary tests or CI.
