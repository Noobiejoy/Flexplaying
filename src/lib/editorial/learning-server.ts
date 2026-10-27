import "server-only";
import { adminClient } from "@/lib/supabase/admin";
import { learnPreferences, parsePreferences, type FeedbackSignal, type OutcomeSignal } from "./preferences";
import { isCategory } from "./categories";

/**
 * Builds a new preference version from feedback and outcomes logged since the
 * active version was created. Returns the new version number, or null if the
 * signals produced no change.
 */
export async function recomputePreferences(workspaceId: string, userId: string | null): Promise<number | null> {
  const db = adminClient();
  const { data: active } = await db.from("editorial_preferences").select("*").eq("workspace_id", workspaceId).eq("active", true).single();
  if (!active) return null;
  const since = active.created_at as string;
  const { data: fb } = await db
    .from("topic_feedback")
    .select("verdict, created_at, topic_candidates(category, entities)")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since);
  const { data: cands } = await db.from("topic_candidates").select("category, entities, status").eq("workspace_id", workspaceId).gte("created_at", since).in("status", ["duplicate", "published", "drafted"]);
  const { data: failedArticles } = await db.from("articles").select("category, entities").eq("workspace_id", workspaceId).gte("created_at", since).eq("status", "needs_review");

  const feedback: FeedbackSignal[] = ((fb ?? []) as unknown as { verdict: FeedbackSignal["verdict"]; created_at: string; topic_candidates: { category: string; entities: string[] } | null }[])
    .filter((f) => f.topic_candidates && isCategory(f.topic_candidates.category))
    .map((f) => ({ verdict: f.verdict, createdAt: f.created_at, category: f.topic_candidates!.category as FeedbackSignal["category"], entities: f.topic_candidates!.entities ?? [] }));
  const outcomes: OutcomeSignal[] = [
    ...((cands ?? []) as { category: string; entities: string[]; status: string }[]).filter((c) => isCategory(c.category)).map((c) => ({
      category: c.category as OutcomeSignal["category"],
      entities: c.entities ?? [],
      outcome: (c.status === "duplicate" ? "duplicate" : c.status === "published" ? "published" : "drafted") as OutcomeSignal["outcome"],
    })),
    ...((failedArticles ?? []) as { category: string; entities: string[] }[]).filter((a) => isCategory(a.category)).map((a) => ({ category: a.category as OutcomeSignal["category"], entities: a.entities ?? [], outcome: "quality_failed" as const })),
  ];
  const result = learnPreferences(parsePreferences(active), feedback, outcomes);
  if (result.changes.length === 0) return null;

  const version = (active.version as number) + 1;
  await db.from("editorial_preferences").update({ active: false }).eq("workspace_id", workspaceId).eq("active", true);
  const { error } = await db.from("editorial_preferences").insert({
    workspace_id: workspaceId,
    version,
    active: true,
    source: "learning",
    scoring_weights: result.next.scoringWeights,
    category_weights: result.next.categoryWeights,
    entity_adjustments: result.next.entityAdjustments,
    blocked_terms: result.next.blockedTerms,
    change_summary: result.changes.slice(0, 20).join("; "),
    signals: result.signals,
    created_by: userId,
  });
  if (error) {
    await db.from("editorial_preferences").update({ active: true }).eq("id", active.id);
    throw new Error(`Database error: ${error.message}`);
  }
  return version;
}
