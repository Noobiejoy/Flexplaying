import { extractJson } from "@/lib/ai/json";
import { findMatches, searchTerms, type DuplicateMatch, type ExistingPost } from "@/lib/editorial/dedupe";
import { WpError, type WpPostSummary } from "@/lib/wordpress/types";
import type { StageContext, StageResult } from "../context";
import { dedupeJsonSchema, dedupePrompt, dedupeSchema } from "../prompts";
import type { CandidateRecord } from "../types";
import { finalStatusForProduced } from "./research";

const ALL_STATUSES = ["publish", "future", "draft", "pending", "private"];

export function toExisting(p: WpPostSummary): ExistingPost {
  return { id: p.id, title: p.title, slug: p.slug, link: p.link, status: p.status, excerpt: p.excerpt, content: p.content, dateGmt: p.dateGmt, origin: "wordpress" };
}

/** Refresh the local cache of the live site (published, scheduled, drafts and pending). */
export async function syncWordPressPosts(sc: StageContext): Promise<{ count: number; ok: boolean }> {
  const { deps, ws, run } = sc;
  try {
    const wp = await sc.wp();
    const after = new Date(deps.now().getTime() - 180 * 86_400_000).toISOString();
    const posts = await wp.listPosts({ statuses: ALL_STATUSES, after, perPage: 100, maxPages: 5 });
    await deps.store.upsertWpPosts(ws.workspaceId, posts.map(toExisting));
    await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: null, action: "sync_posts", status: "ok", wp_id: null, detail: { count: posts.length, after } });
    return { count: posts.length, ok: true };
  } catch (e) {
    await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: null, action: "sync_posts", status: "error", wp_id: null, detail: { error: (e as Error).message } });
    throw e;
  }
}

async function semanticCheck(sc: StageContext, cand: CandidateRecord, m: DuplicateMatch) {
  const p = dedupePrompt({ headline: cand.headline, summary: cand.summary }, { title: m.post.title, excerpt: m.post.excerpt, date: m.post.dateGmt ?? null });
  const res = await sc.tracked("dedupe_semantic", sc.models.text, null, () =>
    sc.deps.ai.complete({ model: sc.models.text, system: p.system, prompt: p.prompt, temperature: 0, jsonSchema: { name: "dedupe_verdict", schema: dedupeJsonSchema } }),
  );
  return extractJson(res.text, dedupeSchema);
}

export async function dedupeStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  const settings = ws.settings;
  const dryRunWithoutWp = run.publishing_mode === "dry_run" && !ws.wp;

  let synced = 0;
  if (dryRunWithoutWp) {
    await sc.log("warning", "Dry run without a WordPress connection: duplicate check uses locally recorded articles only");
  } else {
    synced = (await syncWordPressPosts(sc)).count;
  }
  const cache = await deps.store.listWpPosts(ws.workspaceId, 1000);
  const local = await deps.store.listLocalArticles(ws.workspaceId, 200);

  let checked = run.candidates_checked;
  const outcomes: Record<string, unknown>[] = [];
  const candidates = (await deps.store.listCandidates(run.id)).filter((c) => c.status === "ranked").sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  for (const cand of candidates) {
    if (checked >= settings.max_candidates_per_run) break;
    checked++;
    const sources = await deps.store.getCandidateSources(cand.id);
    const dc = { headline: cand.headline, topic: cand.topic, entities: cand.entities, sourceUrls: sources.map((s) => s.url) };

    // Targeted live search so older or unsynced posts are still considered.
    let searched: ExistingPost[] = [];
    if (!dryRunWithoutWp) {
      const wp = await sc.wp();
      for (const term of searchTerms(dc)) {
        try {
          const found = await wp.listPosts({ statuses: ALL_STATUSES, search: term, perPage: 20, maxPages: 1, includeContent: true });
          searched.push(...found.map(toExisting));
        } catch (e) {
          if (e instanceof WpError && !e.transient) throw e;
          await sc.log("warning", `WordPress search for "${term}" failed: ${(e as Error).message}`);
        }
      }
      await deps.store.upsertWpPosts(ws.workspaceId, searched.map((p) => ({ ...p, content: undefined })));
    }
    const byId = new Map<string, ExistingPost>();
    for (const p of [...cache, ...searched, ...local]) byId.set(`${p.origin}:${p.id}`, { ...byId.get(`${p.origin}:${p.id}`), ...p });
    searched = [];
    const matches = findMatches(dc, [...byId.values()]);

    const hard = matches.find((m) => m.verdict === "duplicate");
    if (hard) {
      const dup = { wp_id: hard.post.origin === "wordpress" ? hard.post.id : null, title: hard.post.title, link: hard.post.link, score: hard.score, signals: hard.signals, method: "deterministic" };
      await deps.store.updateCandidate(cand.id, { status: "duplicate", duplicate_of: dup, decision_reason: `Duplicate of "${hard.post.title}" (similarity ${hard.score})` });
      outcomes.push({ candidate: cand.headline, result: "duplicate", match: dup });
      await sc.log("decision", `Rejected as duplicate: "${cand.headline}"`, { match: dup });
      continue;
    }

    let blocked: { verdict: string; reason: string; match: DuplicateMatch } | null = null;
    for (const m of matches.filter((x) => x.verdict === "borderline").slice(0, 2)) {
      const v = await semanticCheck(sc, cand, m);
      if ((v.verdict === "same_story" && v.confidence >= 0.6) || v.verdict === "uncertain" || ((v.verdict === "same_story" || v.verdict === "new_development") && v.confidence < 0.6)) {
        blocked = { verdict: v.verdict, reason: v.reason, match: m };
        break;
      }
      outcomes.push({ candidate: cand.headline, borderline: m.post.title, semantic: v });
    }
    if (blocked) {
      const dup = { wp_id: blocked.match.post.origin === "wordpress" ? blocked.match.post.id : null, title: blocked.match.post.title, link: blocked.match.post.link, score: blocked.match.score, signals: blocked.match.signals, method: "semantic", verdict: blocked.verdict, reason: blocked.reason };
      const isDup = blocked.verdict === "same_story";
      await deps.store.updateCandidate(cand.id, {
        status: isDup ? "duplicate" : "needs_review",
        duplicate_of: dup,
        decision_reason: isDup ? `Same story as "${blocked.match.post.title}": ${blocked.reason}` : `Possible duplicate could not be ruled out ("${blocked.match.post.title}"): ${blocked.reason}`,
      });
      outcomes.push({ candidate: cand.headline, result: isDup ? "duplicate" : "needs_review", match: dup });
      await sc.log("decision", isDup ? `Rejected as same story: "${cand.headline}"` : `Held for review (duplicate not ruled out): "${cand.headline}"`, { match: dup });
      continue;
    }

    await deps.store.updateCandidate(cand.id, { status: "selected", decision_reason: `${cand.decision_reason ?? ""} Selected: highest-ranked candidate with no duplicate coverage${matches.length ? ` (${matches.length} weak match(es) cleared)` : ""}.`.trim() });
    const alternatives = candidates.filter((c) => c.id !== cand.id).slice(0, 4).map((c) => ({ headline: c.headline, score: c.overall_score }));
    await sc.log("decision", `Selected "${cand.headline}" (score ${cand.overall_score})`, { synced_posts: synced, outcomes, alternatives });
    return { next: "fact_checking", patch: { selected_candidate_id: cand.id, candidates_checked: checked }, message: `Selected "${cand.headline}" after checking ${checked} candidate(s)` };
  }

  // No unique candidate in this round.
  const allDuplicates = outcomes.length > 0 && outcomes.every((o) => o.result === "duplicate");
  if (run.research_round + 1 < settings.max_research_rounds && checked < settings.max_candidates_per_run) {
    return {
      next: "researching",
      patch: { research_round: run.research_round + 1, candidates_checked: checked },
      message: `No unique candidate in round ${run.research_round + 1}; researching again with exclusions`,
      detail: { outcomes },
    };
  }
  if (run.articles_produced > 0) {
    return { next: await finalStatusForProduced(sc), patch: { candidates_checked: checked }, message: "No further unique candidates", detail: { outcomes } };
  }
  return {
    next: allDuplicates ? "duplicate" : "skipped",
    patch: { candidates_checked: checked, outcome_reason: allDuplicates ? "Every viable candidate was already covered on the site" : "No candidate passed duplicate checking" },
    message: allDuplicates ? "All candidates were duplicates of existing coverage" : "No unique candidate found within the retry limit",
    detail: { outcomes },
  };
}
