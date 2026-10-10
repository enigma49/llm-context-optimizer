import { throwIfAborted } from '../errors.js';
import type { BackendInput, BackendOutput, ContextOptimizerBackend } from '../types.js';

const stopwords = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'and',
  'or',
  'in',
  'is',
  'for',
  'with',
  'what',
  'how',
  'using',
  'from',
]);
function words(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
      (word) => !stopwords.has(word),
    ),
  );
}

/** Local lexical baseline. Scores are heuristics, not calibrated confidence. */
export class HeuristicBackend implements ContextOptimizerBackend {
  readonly name = 'heuristic';
  readonly external = false;

  async optimize(input: BackendInput, signal?: AbortSignal): Promise<BackendOutput> {
    throwIfAborted(signal);
    const taskWords = words(input.task);
    return {
      decisions: input.chunks.map((chunk) => {
        const chunkWords = words(chunk.text);
        const overlap = [...taskWords].filter((word) => chunkWords.has(word)).length;
        const lexical = taskWords.size ? overlap / taskWords.size : 0;
        return { id: chunk.id, score: Math.min(1, lexical * 0.9 + (chunk.importance ?? 0) * 0.1) };
      }),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}
