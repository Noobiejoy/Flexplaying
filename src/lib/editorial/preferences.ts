import { CATEGORIES, type Category } from "./categories";

export interface ScoringWeights {
  recency: number;
  source_quality: number;
  relevance: number;
  originality: number;
  corroboration: number;
}

export interface EditorialPreferences {
  version: number;
  scoringWeights: ScoringWeights;
  categoryWeights: Record<Category, number>;
  /** Normalised entity/keyword -> score adjustment in [-0.3, 0.3]. */
  entityAdjustments: Record<string, number>;
  blockedTerms: string[];
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  recency: 0.25,
  source_quality: 0.25,
  relevance: 0.2,
  originality: 0.15,
  corroboration: 0.15,
};

export const DEFAULT_PREFERENCES: EditorialPreferences = {
  version: 1,
  scoringWeights: DEFAULT_WEIGHTS,
  categoryWeights: { anime: 1, gaming: 1, esports: 1 },
  entityAdjustments: {},
  blockedTerms: [],
};

export type FeedbackVerdict = "interesting" | "irrelevant" | "already_covered" | "needs_research";

export interface FeedbackSignal {
  verdict: FeedbackVerdict;
  category: Category;
  entities: string[];
  createdAt: string;
}

export interface OutcomeSignal {
  category: Category;
  outcome: "published" | "drafted" | "duplicate" | "quality_failed" | "insufficient_evidence";
  entities: string[];
}

export interface LearningResult {
  next: Omit<EditorialPreferences, "version">;
  changes: string[];
  signals: Record<string, unknown>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

export function normalizeEntity(e: string): string {
  return e.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Deterministic, bounded preference update from logged evidence. Each signal
 * nudges category and entity weights by a small step; the result is stored as
 * a new version so its effect can be inspected and reverted.
 */
export function learnPreferences(
  current: EditorialPreferences,
  feedback: FeedbackSignal[],
  outcomes: OutcomeSignal[],
): LearningResult {
  const catDelta: Record<Category, number> = { anime: 0, gaming: 0, esports: 0 };
  const entDelta: Record<string, number> = {};
  const counts = { interesting: 0, irrelevant: 0, already_covered: 0, needs_research: 0, duplicates: 0, quality_failed: 0, published: 0 };

  const bump = (entities: string[], d: number) => {
    for (const raw of entities.slice(0, 6)) {
      const e = normalizeEntity(raw);
      if (e.length < 2) continue;
      entDelta[e] = (entDelta[e] ?? 0) + d;
    }
  };

  for (const f of feedback) {
    counts[f.verdict]++;
    if (f.verdict === "interesting") {
      catDelta[f.category] += 0.03;
      bump(f.entities, 0.05);
    } else if (f.verdict === "irrelevant") {
      catDelta[f.category] -= 0.03;
      bump(f.entities, -0.06);
    } else if (f.verdict === "already_covered") {
      bump(f.entities, -0.02);
    }
  }
  for (const o of outcomes) {
    if (o.outcome === "duplicate") counts.duplicates++;
    if (o.outcome === "quality_failed") {
      counts.quality_failed++;
      catDelta[o.category] -= 0.01;
    }
    if (o.outcome === "published") {
      counts.published++;
      catDelta[o.category] += 0.005;
    }
  }

  const changes: string[] = [];
  const categoryWeights = { ...current.categoryWeights };
  for (const c of CATEGORIES) {
    const nextVal = round(clamp((categoryWeights[c] ?? 1) + catDelta[c], 0.6, 1.4));
    if (nextVal !== round(categoryWeights[c] ?? 1)) changes.push(`Category ${c}: ${round(categoryWeights[c] ?? 1)} → ${nextVal}`);
    categoryWeights[c] = nextVal;
  }
  const entityAdjustments = { ...current.entityAdjustments };
  for (const [e, d] of Object.entries(entDelta)) {
    const before = entityAdjustments[e] ?? 0;
    const after = round(clamp(before + d, -0.3, 0.3));
    if (after === round(before)) continue;
    if (after === 0) delete entityAdjustments[e];
    else entityAdjustments[e] = after;
    changes.push(`Entity "${e}": ${round(before)} → ${after}`);
  }
  return {
    next: {
      scoringWeights: current.scoringWeights,
      categoryWeights,
      entityAdjustments,
      blockedTerms: current.blockedTerms,
    },
    changes,
    signals: { ...counts, feedbackCount: feedback.length, outcomeCount: outcomes.length },
  };
}

export function parsePreferences(row: {
  version: number;
  scoring_weights: unknown;
  category_weights: unknown;
  entity_adjustments: unknown;
  blocked_terms: string[] | null;
}): EditorialPreferences {
  const w = (row.scoring_weights ?? {}) as Partial<ScoringWeights>;
  const c = (row.category_weights ?? {}) as Partial<Record<Category, number>>;
  return {
    version: row.version,
    scoringWeights: { ...DEFAULT_WEIGHTS, ...w },
    categoryWeights: { anime: c.anime ?? 1, gaming: c.gaming ?? 1, esports: c.esports ?? 1 },
    entityAdjustments: (row.entity_adjustments ?? {}) as Record<string, number>,
    blockedTerms: row.blocked_terms ?? [],
  };
}
