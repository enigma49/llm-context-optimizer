import type { TokenCount } from './types.js';

/** UTF-8 byte estimate: intentionally labeled approximate, not a tokenizer. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

export function estimateRequestTokens(request: unknown): TokenCount {
  return {
    tokens: estimateTextTokens(JSON.stringify(request)),
    method: 'local-estimate',
    accuracy: 'estimate',
    completeness: 'unknown',
  };
}
