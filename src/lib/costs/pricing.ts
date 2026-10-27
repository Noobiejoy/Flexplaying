import type { AiUsage } from "@/lib/ai/types";

export interface PricingRow {
  id: string;
  model: string;
  version: number;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  per_web_search: number | null;
  per_image: number | null;
}

export interface CostEstimate {
  costUsd: number | null;
  source: "provider_reported" | "estimated" | "unavailable";
  pricingId: string | null;
}

/**
 * Cost attribution: prefer the cost OpenRouter reports in the response; fall
 * back to the workspace's versioned pricing table; otherwise "unavailable".
 * Never invents a number.
 */
export function costFor(usage: AiUsage, pricing: PricingRow | null): CostEstimate {
  if (usage.costUsd !== null) return { costUsd: round6(usage.costUsd), source: "provider_reported", pricingId: null };
  if (!pricing) return { costUsd: null, source: "unavailable", pricingId: null };
  let total = 0;
  let parts = 0;
  if (usage.inputTokens !== null && pricing.input_per_mtok !== null) {
    total += (usage.inputTokens / 1e6) * Number(pricing.input_per_mtok);
    parts++;
  }
  if (usage.outputTokens !== null && pricing.output_per_mtok !== null) {
    total += ((usage.outputTokens + (usage.reasoningTokens ?? 0)) / 1e6) * Number(pricing.output_per_mtok);
    parts++;
  }
  if (usage.webSearches && pricing.per_web_search !== null) {
    total += usage.webSearches * Number(pricing.per_web_search);
    parts++;
  }
  if (usage.images && pricing.per_image !== null) {
    total += usage.images * Number(pricing.per_image);
    parts++;
  }
  if (parts === 0) return { costUsd: null, source: "unavailable", pricingId: pricing.id };
  return { costUsd: round6(total), source: "estimated", pricingId: pricing.id };
}

function round6(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

export function formatUsd(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(v >= 1 ? 2 : digits)}`;
}
