import { OptimizerError, providerError, throwIfAborted } from '../errors.js';
import type { TokenCount } from '../types.js';

/** Copy native JSON envelopes without serializing media or opaque SDK objects. */
export function cloneNative<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneNative(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneNative(item)]),
      ) as T;
    }
  }
  return value;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function unsupported(message: string): never {
  throw new OptimizerError('UNSUPPORTED_REQUEST', message);
}

export function validateEnvelope(request: unknown): void {
  const value = record(request);
  if (!value || typeof value.model !== 'string' || !value.model.trim()) {
    throw new OptimizerError('INVALID_INPUT', 'A nonempty provider model is required.');
  }
  if (value.stream === true) unsupported('Streaming is not supported by this adapter.');
}

export function providerCount(tokens: unknown, accuracy: TokenCount['accuracy']): TokenCount {
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new OptimizerError('COUNT_UNAVAILABLE', 'The provider returned an invalid token count.');
  }
  return { tokens, method: 'provider', accuracy, completeness: 'complete' };
}

export async function sanitizedOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof OptimizerError) throw error;
    throw providerError(error);
  }
}

export function combinedSignal(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (first && second && first !== second) return AbortSignal.any([first, second]);
  return first ?? second;
}

export interface SDKRequestOptions {
  signal?: AbortSignal;
}

export function validUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
