import { OptimizerError } from './errors.js';
import { estimateTextTokens } from './tokenization.js';
import type { ContextChunk, ContextDocument } from './types.js';

export function renderChunk(
  chunk: Pick<ContextChunk, 'id' | 'documentId' | 'source' | 'text'>,
): string {
  return JSON.stringify({
    source: chunk.source ?? chunk.documentId,
    chunk: chunk.id,
    text: chunk.text,
  });
}

/** JSON escapes boundaries; every retained passage keeps its original source. */
export function renderContext(chunks: readonly ContextChunk[]): string {
  return chunks.map(renderChunk).join('\n\n');
}

function splitPlainText(text: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  let current = '';
  // Keep whitespace and identifiers intact. A single oversized word stays atomic.
  for (const word of text.match(/\S+\s*|\s+/gu) ?? []) {
    if (current && estimateTextTokens(current + word) > maxTokens) {
      pieces.push(current);
      current = '';
    }
    current += word;
  }
  if (current) pieces.push(current);
  return pieces;
}

export function chunkDocuments(
  documents: readonly ContextDocument[],
  options: { strategy?: 'document' | 'paragraph'; maxTokens?: number } = {},
): ContextChunk[] {
  const maxTokens = options.maxTokens ?? 1024;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new OptimizerError('INVALID_INPUT', 'Chunk size must be a positive integer.');
  }
  const ids = new Set<string>();
  return documents.flatMap((document) => {
    if (
      typeof document.id !== 'string' ||
      !document.id ||
      ids.has(document.id) ||
      typeof document.text !== 'string' ||
      !document.text.trim() ||
      (document.importance !== undefined &&
        (!Number.isFinite(document.importance) ||
          document.importance < 0 ||
          document.importance > 1)) ||
      (document.source !== undefined && typeof document.source !== 'string') ||
      (document.protected !== undefined && typeof document.protected !== 'boolean') ||
      (document.atomic !== undefined && typeof document.atomic !== 'boolean')
    ) {
      throw new OptimizerError(
        'INVALID_INPUT',
        'Context requires unique IDs, nonempty text, and valid metadata.',
      );
    }
    ids.add(document.id);
    const structured = /```|~~~|^\s*(?:\{|\[)/u.test(document.text);
    const parts =
      options.strategy !== 'paragraph' || document.atomic || document.protected || structured
        ? [document.text]
        : document.text.split(/(?<=\n\n)/u).flatMap((part) => splitPlainText(part, maxTokens));
    return parts.map((text, index) => {
      const chunk = {
        ...document,
        text,
        documentId: document.id,
        id: `${document.id.length}:${document.id}:${index}`,
        index,
      };
      return { ...chunk, tokens: estimateTextTokens(renderChunk(chunk) + '\n\n') };
    });
  });
}
