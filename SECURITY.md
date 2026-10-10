# Security and privacy

Do not disclose credentials, private context, customer data, or exploit details in a public issue. Use the repository's private vulnerability-reporting flow if enabled. If no private channel is available, open an issue asking maintainers for one without including sensitive details.

The core local heuristic runs without network access. Provider dispatch sends the prepared native request and supplied context to the selected provider. Opting into an external backend sends the backend's eligible context and task to that service. Opting into provider token counting can also send the complete request. Review each service's current data-handling terms for your application; this repository does not promise those services' retention behavior.

Credentials are supplied to their respective adapter or backend constructors, separate from request options. Do not put keys in documents, source labels, telemetry callbacks, or application logs. Do not commit `.env` files. Full optimization results contain document/chunk identifiers and relevance scores; identifier names themselves may disclose information.

Telemetry is disabled by default. A configured sink receives only mode, reason, local context counts, and duration. Applications control what their sink stores and where it sends those events. This library does not configure a hosted telemetry endpoint.

Context selection is not a prompt-injection defense, content sanitizer, or semantic-correctness guarantee. Source wrappers preserve traceability, but untrusted document text still reaches the final model. Use your own application trust boundaries and instructions. Pin essential context with `protected: true`; use `atomic: true` when a document cannot safely be split. Protected input that conflicts with a hard budget is an explicit error, not permission to remove that input.

Provider and backend failures use safe error categories rather than embedding raw request content or raw SDK errors. Keep that property when contributing changes. Report a suspected leak with a redacted reproduction, affected version, and the smallest relevant error path.
