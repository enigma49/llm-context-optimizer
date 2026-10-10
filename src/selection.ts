import type { ContextChunk } from './types.js';

export interface ScoredChunk {
  chunk: ContextChunk;
  score: number;
}

/** Exact knapsack for modest budgets, stable utility/token greedy beyond it. */
export function selectUnderBudget(
  candidates: readonly ScoredChunk[],
  budget: number,
  minimumTokens = 0,
): Set<string> {
  if (budget <= 0 || !candidates.length) return new Set();
  if (candidates.length <= 64 && budget <= 50_000) {
    const utilities = new Float64Array(budget + 1).fill(-Infinity);
    utilities[0] = 0;
    const masks: bigint[] = Array<bigint>(budget + 1).fill(0n);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const cost = candidate.chunk.tokens;
      for (let remaining = budget; remaining >= cost; remaining--) {
        const utility = utilities[remaining - cost]! + candidate.score;
        if (utility > utilities[remaining]! + 1e-12) {
          utilities[remaining] = utility;
          masks[remaining] = masks[remaining - cost]! | (1n << BigInt(i));
        }
      }
    }
    let bestSpent = -1;
    let bestUtility = -Infinity;
    for (let spent = minimumTokens; spent <= budget; spent++) {
      if (utilities[spent]! > bestUtility + 1e-12) {
        bestSpent = spent;
        bestUtility = utilities[spent]!;
      }
    }
    const mask = bestSpent < 0 ? 0n : masks[bestSpent]!;
    return new Set(
      candidates.filter((_, i) => (mask & (1n << BigInt(i))) !== 0n).map(({ chunk }) => chunk.id),
    );
  }
  let remaining = budget;
  const selected = new Set<string>();
  const sorted = candidates
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score / b.chunk.tokens - a.score / a.chunk.tokens || a.index - b.index);
  for (const { chunk } of sorted) {
    if (chunk.tokens <= remaining) {
      selected.add(chunk.id);
      remaining -= chunk.tokens;
    }
  }
  return selected;
}
