import { OptimizerError } from './errors.js';
import type { ProviderUsage } from './types.js';

/** Caller-owned price data in USD per million tokens; no changing price catalog. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface CostScenario {
  usage: ProviderUsage;
  pricing: ModelPricing;
}

export interface CostEstimate {
  baselineProviderUsd?: number;
  optimizedProviderUsd?: number;
  backendUsd?: number;
  optimizedTotalUsd?: number;
  netSavingsUsd?: number;
  missing: string[];
}

function scenarioCost(
  scenario: CostScenario,
  label: string,
  missing: string[],
): number | undefined {
  const { usage, pricing } = scenario;
  for (const tokens of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  ]) {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new OptimizerError(
        'INVALID_INPUT',
        'Usage must contain nonnegative integer token counts.',
      );
  }
  for (const price of Object.values(pricing)) {
    if (price !== undefined && (!Number.isFinite(price) || price < 0))
      throw new OptimizerError('INVALID_INPUT', 'Prices must be finite nonnegative numbers.');
  }
  if (!Number.isFinite(pricing.inputPerMillion) || !Number.isFinite(pricing.outputPerMillion))
    throw new OptimizerError('INVALID_INPUT', 'Input and output prices are required.');
  const read = usage.cachedInputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  if (read + write > usage.inputTokens)
    throw new OptimizerError('INVALID_INPUT', 'Cached tokens exceed total input usage.');
  if (read && pricing.cachedInputPerMillion === undefined)
    missing.push(`${label}.cachedInputPerMillion`);
  if (write && pricing.cacheWritePerMillion === undefined)
    missing.push(`${label}.cacheWritePerMillion`);
  if (missing.some((field) => field.startsWith(`${label}.`))) return undefined;
  return (
    ((usage.inputTokens - read - write) * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion +
      read * (pricing.cachedInputPerMillion ?? 0) +
      write * (pricing.cacheWritePerMillion ?? 0)) /
    1_000_000
  );
}

/** Only reports net savings when both provider scenarios and backend cost are known. */
export function estimateCosts(input: {
  baseline: CostScenario;
  optimized: CostScenario;
  backendCostUsd?: number;
}): CostEstimate {
  if (
    input.backendCostUsd !== undefined &&
    (!Number.isFinite(input.backendCostUsd) || input.backendCostUsd < 0)
  )
    throw new OptimizerError('INVALID_INPUT', 'Backend cost must be finite and nonnegative.');
  const missing: string[] = [];
  const baselineProviderUsd = scenarioCost(input.baseline, 'baseline', missing);
  const optimizedProviderUsd = scenarioCost(input.optimized, 'optimized', missing);
  if (input.backendCostUsd === undefined) missing.push('backendCostUsd');
  const optimizedTotalUsd =
    optimizedProviderUsd !== undefined && input.backendCostUsd !== undefined
      ? optimizedProviderUsd + input.backendCostUsd
      : undefined;
  return {
    baselineProviderUsd,
    optimizedProviderUsd,
    backendUsd: input.backendCostUsd,
    optimizedTotalUsd,
    netSavingsUsd:
      baselineProviderUsd !== undefined && optimizedTotalUsd !== undefined
        ? baselineProviderUsd - optimizedTotalUsd
        : undefined,
    missing,
  };
}
