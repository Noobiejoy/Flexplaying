import { extractJson } from "@/lib/ai/json";
import { AiError, type Citation } from "@/lib/ai/types";
import { isCategory, type Category } from "@/lib/editorial/categories";
import { domainOf, TIER_SCORE } from "@/lib/editorial/domains";
import { scoreCandidate } from "@/lib/editorial/scoring";
import { canonicalUrl } from "@/lib/editorial/text";
import { startOfLocalDay } from "@/lib/schedule/slots";
import { isSafePublicHttpUrl } from "@/lib/wordpress/url";
import type { StageContext, StageResult } from "../context";
import { discoveryPrompt, discoverySchema, type DiscoveryOutput } from "../prompts";
import type { CandidateInput, SourceInput } from "../types";

const MAX_PAGE_CHECKS = 14;

function parseDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface VerifiedSource extends SourceInput {
  origin: "citation" | "model_claimed";
  /** The URL as originally claimed (before redirects). */
  requested: string;
}

/**
 * Turns model-claimed source URLs into verified sources. A URL counts only if
 * it appeared in the search tool's citations or it resolves to a real page;
 * anything else is dropped as potentially fabricated.
 */
export async function verifySources(
  sc: StageContext,
  claimed: { url: string; title?: string | null; published_at?: string | null }[],
  citations: Map<string, Citation>,
  budget: { remaining: number },
): Promise<{ verified: VerifiedSource[]; dropped: string[] }> {
  const verified: VerifiedSource[] = [];
  const dropped: string[] = [];
  for (const s of claimed) {
    if (!isSafePublicHttpUrl(s.url)) {
      dropped.push(s.url);
      continue;
    }
    const key = canonicalUrl(s.url);
    const cited = citations.get(key);
    let url = s.url;
    let title = s.title ?? cited?.title ?? null;
    let publishedAt = parseDate(s.published_at);
    let origin: VerifiedSource["origin"] = "citation";
    if (!cited || !publishedAt) {
      if (budget.remaining <= 0) {
        if (!cited) dropped.push(s.url);
        if (!cited) continue;
      } else {
        budget.remaining--;
        const meta = await sc.deps.fetchPage(s.url);
        if (!meta.ok && !cited) {
          dropped.push(s.url);
          continue;
        }
        if (meta.ok) {
          url = meta.finalUrl;
          title = title ?? meta.title;
          publishedAt = publishedAt ?? meta.publishedAt;
        }
        if (!cited) origin = "model_claimed";
      }
    }
    const tier = sc.deps.domains.tierFor(url);
    verified.push({
      url,
      domain: domainOf(url),
      title: title?.slice(0, 300) ?? null,
      excerpt: cited?.snippet?.slice(0, 2000) ?? null,
      published_at: publishedAt,
      quality_tier: tier,
      quality_score: TIER_SCORE[tier],
      origin,
      requested: s.url,
    });
  }
  const seen = new Set<string>();
  return {
    verified: verified.filter((v) => {
      const k = canonicalUrl(v.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    dropped,
  };
}

export async function researchStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  const now = deps.now();
  const settings = ws.settings;

  if (run.research_round === 0 && run.articles_produced === 0) {
    const produced = await deps.store.countProducedSince(ws.workspaceId, startOfLocalDay(now, settings.timezone).toISOString());
    if (produced >= settings.daily_article_limit) {
      return {
        next: "skipped",
        patch: { outcome_reason: `Daily article limit reached (${produced}/${settings.daily_article_limit})` },
        message: `Skipped: daily article limit of ${settings.daily_article_limit} already reached`,
      };
    }
  }

  await sc.ensureModel(sc.models.research, "text");
  const exclude = await deps.store.recentHeadlines(ws.workspaceId, new Date(now.getTime() - 3 * 86_400_000).toISOString());
  const categories = settings.enabled_categories;
  const budget = { remaining: MAX_PAGE_CHECKS };
  const raw: { cat: Category; out: DiscoveryOutput; citations: Map<string, Citation> }[] = [];
  const failures: string[] = [];

  for (const cat of categories) {
    const p = discoveryPrompt(cat, now.toISOString(), exclude);
    try {
      const res = await sc.tracked("research", sc.models.research, null, () =>
        deps.ai.research({ model: sc.models.research, system: p.system, prompt: p.prompt }),
      );
      const out = extractJson(res.text, discoverySchema);
      const citations = new Map(res.citations.map((c) => [canonicalUrl(c.url), c]));
      raw.push({ cat, out, citations });
      await sc.log("info", `${cat}: ${out.candidates.length} candidate(s), ${res.citations.length} search citation(s)`, {
        category: cat,
        queries: out.queries_used,
        citations: res.citations.slice(0, 12).map((c) => ({ url: c.url, title: c.title })),
      });
    } catch (e) {
      if (e instanceof AiError && !e.transient && e.kind !== "parse") throw e;
      failures.push(`${cat}: ${(e as Error).message}`);
      await sc.log("warning", `Research for ${cat} failed: ${(e as Error).message}`);
    }
  }
  if (raw.length === 0) {
    throw new AiError("server", `All research calls failed (${failures.join("; ")})`);
  }

  const recentCounts = await deps.store.recentCategoryCounts(ws.workspaceId, new Date(now.getTime() - 86_400_000).toISOString());
  const scored: { input: CandidateInput; sources: VerifiedSource[]; dropped: string[] }[] = [];

  for (const { cat, out, citations } of raw) {
    for (const c of out.candidates) {
      const category = isCategory(c.category) ? c.category : null;
      const { verified, dropped } = await verifySources(sc, c.sources, citations, budget);
      const scoreSources = verified.map((v) => ({ url: v.url, tier: v.quality_tier, publishedAt: v.published_at }));
      const result = scoreCandidate(
        {
          category: category ?? `invalid:${c.category}`,
          headline: c.headline,
          topic: c.topic,
          entities: c.entities,
          sources: scoreSources,
          modelRelevance: c.relevance,
          modelOriginality: c.originality,
          confidence: c.confidence,
        },
        { now, prefs: ws.prefs, enabledCategories: settings.enabled_categories, recentCategoryCounts: recentCounts },
      );
      const latest = scoreSources.map((s) => s.publishedAt).filter(Boolean).sort().at(-1) ?? null;
      const status = result.rejection ? "rejected" : result.overall >= settings.min_candidate_score ? "ranked" : "below_threshold";
      const reasonParts = [
        result.rejection ?? (status === "ranked" ? `Score ${result.overall} meets threshold ${settings.min_candidate_score}` : `Score ${result.overall} below threshold ${settings.min_candidate_score}`),
        ...result.reasons,
        dropped.length ? `${dropped.length} unverifiable source URL(s) discarded` : "",
      ].filter(Boolean);
      scored.push({
        input: {
          category: category ?? cat,
          headline: c.headline,
          topic: c.topic,
          summary: c.summary,
          evidence_summary: c.evidence,
          event_date: c.event_date && /^\d{4}-\d{2}-\d{2}$/.test(c.event_date) ? c.event_date : null,
          latest_source_at: latest,
          entities: c.entities,
          suggested_format: c.suggested_format ?? null,
          confidence: c.confidence,
          duplicate_risk: c.duplicate_risk,
          scores: { ...result.components, model_relevance: c.relevance, model_originality: c.originality, reasons: result.reasons },
          overall_score: result.overall,
          rank: 0,
          status,
          decision_reason: reasonParts.join(". "),
        },
        sources: verified,
        dropped,
      });
    }
  }

  scored.sort((a, b) => b.input.overall_score - a.input.overall_score);
  scored.forEach((s, i) => (s.input.rank = i + 1));
  const records = await deps.store.insertCandidates(run.id, ws.workspaceId, run.research_round, scored.map((s) => s.input));
  for (let i = 0; i < records.length; i++) {
    const srcs = scored[i]!.sources;
    if (srcs.length === 0) continue;
    const saved = await deps.store.upsertSources(ws.workspaceId, srcs.map(({ origin: _o, requested: _r, ...rest }) => rest));
    const byOrigin = new Map<string, string[]>();
    saved.forEach((s, j) => {
      const o = srcs[j]!.origin;
      byOrigin.set(o, [...(byOrigin.get(o) ?? []), s.id]);
    });
    for (const [origin, ids] of byOrigin) {
      await deps.store.linkCandidateSources(records[i]!.id, ws.workspaceId, ids, origin as "citation" | "model_claimed");
    }
  }

  const ranked = scored.filter((s) => s.input.status === "ranked");
  await sc.log("decision", `Ranked ${scored.length} candidate(s); ${ranked.length} meet the editorial threshold`, {
    top: scored.slice(0, 8).map((s) => ({ rank: s.input.rank, headline: s.input.headline, category: s.input.category, score: s.input.overall_score, status: s.input.status })),
  });

  if (ranked.length === 0) {
    return {
      next: run.articles_produced > 0 ? (await finalStatusForProduced(sc)) : "skipped",
      patch: { outcome_reason: run.articles_produced > 0 ? "No further candidates met the threshold" : "No candidate met the minimum editorial quality and evidence threshold" },
      message: "No candidate met the editorial threshold; nothing will be published this run",
    };
  }
  return { next: "deduplicating", message: `${ranked.length} candidate(s) proceed to duplicate checking` };
}

/** Terminal status for a run that already produced at least one article (best outcome wins). */
export async function finalStatusForProduced(sc: StageContext): Promise<"published" | "drafted" | "needs_review" | "dry_run_completed"> {
  if (sc.run.publishing_mode === "dry_run") return "dry_run_completed";
  const statuses = await sc.deps.store.runArticleStatuses(sc.run.id);
  if (statuses.includes("published")) return "published";
  if (statuses.includes("drafted")) return "drafted";
  return "needs_review";
}
