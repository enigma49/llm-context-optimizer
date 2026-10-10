export type ErrorCode =
  | 'INVALID_INPUT'
  | 'BUDGET_CONFLICT'
  | 'BACKEND_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'PROVIDER_FAILED'
  | 'COUNT_UNAVAILABLE'
  | 'UNSUPPORTED_REQUEST';

/** Sanitized errors deliberately exclude raw causes/vendor messages. */
export class OptimizerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OptimizerError';
  }
}

export function providerError(error: unknown): OptimizerError {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    Number.isSafeInteger(error.status)
      ? error.status
      : undefined;
  return new OptimizerError('PROVIDER_FAILED', 'Provider request failed.', status);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OptimizerError('ABORTED', 'Operation cancelled.');
}

/** Bound even backends that ignore AbortSignal; remove listeners on completion. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new OptimizerError('ABORTED', 'Operation cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new OptimizerError('TIMEOUT', 'Operation timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
