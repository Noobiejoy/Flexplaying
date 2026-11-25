import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/editorial/categories";
import type { AutomatedWorkspace } from "./types";

/** What one run writes: the day's article for a category, or for an editorial topic. */
export type RunTarget = { kind: "category"; category: Category } | { kind: "topic"; topicId: string; category: Category };

/** Slot keys are per target, e.g. "2026-11-26T12:00#anime" or "2026-11-26T12:00#topic:<id>". */
export function targetSlotKey(base: string, t: RunTarget): string {
  return t.kind === "category" ? `${base}#${t.category}` : `${base}#topic:${t.topicId}`;
}

/** The schedule slot ("2026-11-26T12:00") a slot key belongs to. */
export function baseSlotKey(key: string): string {
  return key.split("#")[0]!;
}

/** Local time ("12:00") of a slot key. */
export function slotTime(key: string | null | undefined): string {
  return key ? baseSlotKey(key).slice(11) : "";
}

/** A topic gets articles from the day it is added through its end date (inclusive), while enabled. */
export function topicActiveOn(t: { end_date: string; enabled?: boolean }, localDay: string): boolean {
  return t.enabled !== false && localDay <= t.end_date;
}

/**
 * Targets for one shared schedule slot: every enabled category (in a fixed
 * order) followed by the topics that run with the shared schedule.
 * `createdBefore` drops topics added after the slot (used for missed slots).
 */
export function slotTargets(ws: Pick<AutomatedWorkspace, "categories" | "topics">, localDay: string, createdBefore?: Date): RunTarget[] {
  const cats: RunTarget[] = CATEGORIES.filter((c) => ws.categories.includes(c)).map((category) => ({ kind: "category", category }));
  const topics: RunTarget[] = ws.topics
    .filter((t) => !t.local_time && topicActiveOn(t, localDay) && (!createdBefore || new Date(t.created_at) <= createdBefore))
    .map((t) => ({ kind: "topic", topicId: t.id, category: t.category }));
  return [...cats, ...topics];
}

/** Short human label for a run: "Anime", "Topic: Jujutsu Kaisen Season 3", or "All categories" (older runs). */
export function runLabel(run: { category: string | null; topic_id: string | null }, topicTitle?: string | null): string {
  if (run.topic_id) return `Topic: ${topicTitle ?? "deleted topic"}`;
  if (run.category) return CATEGORY_LABEL[run.category as Category] ?? run.category;
  return "All categories";
}

export const ESCALATION_LABEL = ["Normal search", "Wider search (last 7 days)", "Feature / explainer fallback"] as const;
