import type { StageContext, StageResult } from "../context";
import type { RunRecord, WorkspaceSettings } from "../types";

/** 0 normal search, 1 wider search (last 7 days, more rounds), 2 feature/explainer fallback. */
export const MAX_ESCALATION = 2;

/** A run for one category or one topic (not a legacy all-category run). */
export function isTargeted(run: Pick<RunRecord, "category" | "topic_id">): boolean {
  return Boolean(run.category || run.topic_id);
}

/**
 * Research rounds and candidate checks allowed so far. Counters keep running
 * across effort levels, so each level adds to the previous allowance.
 */
export function effortLimits(settings: Pick<WorkspaceSettings, "max_research_rounds" | "max_candidates_per_run">, run: Pick<RunRecord, "category" | "topic_id" | "escalation">) {
  if (!isTargeted(run)) return { rounds: settings.max_research_rounds, candidates: settings.max_candidates_per_run };
  const e = run.escalation;
  return {
    rounds: settings.max_research_rounds + (e >= 1 ? 2 : 0) + (e >= 2 ? 2 : 0),
    candidates: settings.max_candidates_per_run + (e >= 1 ? 5 : 0) + (e >= 2 ? 4 : 0),
  };
}

export interface SearchPlan {
  /** How far back news may go. */
  windowDays: number;
  mode: "news" | "feature";
  /** Minimum recency score, so older-but-uncovered stories can still rank. */
  recencyFloor: number;
  /** Topic runs: accept any well-sourced aspect, not only news. */
  broaden: boolean;
}

export function searchPlan(run: Pick<RunRecord, "topic_id" | "escalation">): SearchPlan {
  if (run.topic_id) return { windowDays: 7, mode: "news", recencyFloor: 0.6, broaden: run.escalation >= 1 };
  if (run.escalation >= 2) return { windowDays: 14, mode: "feature", recencyFloor: 0.6, broaden: true };
  if (run.escalation === 1) return { windowDays: 7, mode: "news", recencyFloor: 0.5, broaden: true };
  return { windowDays: 2, mode: "news", recencyFloor: 0, broaden: false };
}

const NEXT_STEP: Record<number, { category: string; topic: string }> = {
  1: { category: "widening the search to the last 7 days, with more rounds", topic: "more rounds, accepting any well-sourced aspect of the topic" },
  2: { category: "looking for a sourced feature or explainer instead of breaking news", topic: "a last pass over background, history and what to expect" },
};

/**
 * A targeted run that has run out of candidates does not give up: it researches
 * again while rounds remain, then raises its effort level. Returns null once
 * every level is used up (or for legacy runs, which keep the old behaviour).
 * The fact-check and duplicate rules stay exactly as strict at every level.
 */
export function tryHarder(sc: StageContext, why: string, checked: number): StageResult | null {
  const { run, ws } = sc;
  if (!isTargeted(run) || run.articles_produced > 0) return null;
  const lim = effortLimits(ws.settings, run);
  if (run.research_round + 1 < lim.rounds && checked < lim.candidates) {
    return {
      next: "researching",
      patch: { research_round: run.research_round + 1, candidates_checked: checked, selected_candidate_id: null },
      message: `${why}; researching again with new queries (round ${run.research_round + 2})`,
    };
  }
  if (run.escalation < MAX_ESCALATION) {
    const level = run.escalation + 1;
    const step = NEXT_STEP[level]!;
    return {
      next: "researching",
      patch: { escalation: level, research_round: run.research_round + 1, candidates_checked: checked, selected_candidate_id: null },
      message: `${why}. Trying harder: ${run.topic_id ? step.topic : step.category}`,
    };
  }
  return null;
}

/** Final outcome once a targeted run has used every effort level. */
export async function gaveUp(sc: StageContext, status: "skipped" | "duplicate", checked: number, detail?: Record<string, unknown>): Promise<StageResult> {
  const what = sc.run.topic_id ? "this topic" : `the ${sc.run.category} desk`;
  const reason = `Nothing for ${what} passed the evidence and duplicate checks after a normal search, a wider 7-day search and a feature fallback (${checked} candidate(s) checked)`;
  await sc.deps.store.notify(sc.ws.workspaceId, sc.run.id, "warning", "No article for this slot", reason);
  return { next: status, patch: { candidates_checked: checked, outcome_reason: reason }, message: reason, detail };
}
