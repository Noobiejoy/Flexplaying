import { isCorroborationEligible, domainOf, TIER_SCORE, type SourceTier } from "./domains";
import type { Category } from "./categories";
import { normalizeEntity, type EditorialPreferences, type ScoringWeights } from "./preferences";
import { normalize } from "./text";

export interface ScoredSource {
  url: string;
  tier: SourceTier;
  publishedAt: string | null;
}

export interface CandidateForScoring {
  category: string;
  headline: string;
  topic: string;
  entities: string[];
  sources: ScoredSource[];
  modelRelevance: number;
  modelOriginality: number;
  confidence: "low" | "medium" | "high";
}

export interface ScoreResult {
  components: Record<keyof ScoringWeights, number> & { diversity_multiplier: number; preference_adjustment: number };
  overall: number;
  reasons: string[];
  rejection: string | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function recencyScore(latest: string | null, now: Date): number {
  if (!latest) return 0.3;
  const t = new Date(latest).getTime();
  if (!Number.isFinite(t)) return 0.3;
  const ageH = (now.getTime() - t) / 3_600_000;
  if (ageH < -24) return 0.2; // a "publication date" far in the future is suspect
  return clamp01(Math.pow(0.5, Math.max(0, ageH) / 24));
}

export function sourceQualityScore(sources: ScoredSource[]): number {
  if (sources.length === 0) return 0;
  const top = sources.map((s) => TIER_SCORE[s.tier]).sort((a, b) => b - a).slice(0, 3);
  const avg = top.reduce((a, b) => a + b, 0) / top.length;
  const officialBonus = sources.some((s) => s.tier === "official") ? 0.1 : 0;
  return clamp01(avg + officialBonus);
}

export function corroborationScore(sources: ScoredSource[]): number {
  const domains = new Set<string>();
  let official = false;
  for (const s of sources) {
    if (!isCorroborationEligible(s.tier, s.url)) continue;
    domains.add(domainOf(s.url));
    if (s.tier === "official") official = true;
  }
  const n = domains.size + (official ? 1 : 0);
  if (n >= 3) return 1;
  if (n === 2) return 0.7;
  if (n === 1) return 0.35;
  return 0;
}

export function scoreCandidate(
  c: CandidateForScoring,
  ctx: {
    now: Date;
    prefs: EditorialPreferences;
    enabledCategories: Category[];
    recentCategoryCounts: Partial<Record<Category, number>>;
  },
): ScoreResult {
  const reasons: string[] = [];
  let rejection: string | null = null;

  if (!ctx.enabledCategories.includes(c.category as Category)) {
    rejection = `Category "${c.category}" is not enabled for this workspace`;
  }
  const hay = normalize(`${c.headline} ${c.topic} ${c.entities.join(" ")}`);
  const blocked = ctx.prefs.blockedTerms.find((t) => t && hay.includes(normalize(t)));
  if (blocked) rejection = `Matches blocked term "${blocked}"`;

  const latest = c.sources.map((s) => s.publishedAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const recency = recencyScore(latest, ctx.now);
  const source_quality = sourceQualityScore(c.sources);
  const corroboration = corroborationScore(c.sources);
  const catWeight = ctx.prefs.categoryWeights[c.category as Category] ?? 1;
  let prefAdj = 0;
  for (const e of c.entities) prefAdj += ctx.prefs.entityAdjustments[normalizeEntity(e)] ?? 0;
  prefAdj = Math.max(-0.3, Math.min(0.3, prefAdj));
  const relevance = clamp01(clamp01(c.modelRelevance) * catWeight + prefAdj);
  const originality = clamp01(c.modelOriginality);

  const w = ctx.prefs.scoringWeights;
  const totalW = w.recency + w.source_quality + w.relevance + w.originality + w.corroboration || 1;
  let overall =
    (w.recency * recency +
      w.source_quality * source_quality +
      w.relevance * relevance +
      w.originality * originality +
      w.corroboration * corroboration) /
    totalW;

  const recent = ctx.recentCategoryCounts[c.category as Category] ?? 0;
  const diversity = Math.max(0.75, 1 - 0.08 * recent);
  overall *= diversity;
  if (c.confidence === "low") {
    overall *= 0.85;
    reasons.push("Low research confidence (×0.85)");
  }
  if (!latest) reasons.push("No source publication date found");
  if (recent > 0) reasons.push(`${recent} recent ${c.category} article(s): diversity ×${r3(diversity)}`);
  if (prefAdj !== 0) reasons.push(`Learned entity preference ${prefAdj > 0 ? "+" : ""}${r3(prefAdj)}`);
  if (catWeight !== 1) reasons.push(`Category weight ×${r3(catWeight)}`);
  if (c.sources.length === 0) {
    rejection = rejection ?? "No verifiable sources were returned by search";
  }
  if (rejection) overall = 0;

  return {
    components: {
      recency: r3(recency),
      source_quality: r3(source_quality),
      relevance: r3(relevance),
      originality: r3(originality),
      corroboration: r3(corroboration),
      diversity_multiplier: r3(diversity),
      preference_adjustment: r3(prefAdj),
    },
    overall: r3(clamp01(overall)),
    reasons,
    rejection,
  };
}
