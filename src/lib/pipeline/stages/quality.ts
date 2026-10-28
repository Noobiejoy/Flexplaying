import { extractJson } from "@/lib/ai/json";
import { isCategory } from "@/lib/editorial/categories";
import { comparePost, DUPLICATE_THRESHOLD } from "@/lib/editorial/dedupe";
import { assessEvidence } from "@/lib/editorial/evidence";
import type { Check } from "@/lib/editorial/seo";
import { normalize, shingles, stripHtml } from "@/lib/editorial/text";
import type { StageContext, StageResult } from "../context";
import { StageError } from "../context";
import { reviewJsonSchema, reviewPrompt, reviewSchema, type ReviewOutput } from "../prompts";
import type { ClaimRecord } from "../types";

/**
 * Quoted passages (4+ words) in the article that the research did not record.
 * A quote counts as recorded if it appears inside any usable claim (a tagline
 * is often stated within a fact claim) or closely matches a recorded quote.
 */
export function unverifiedQuotes(bodyText: string, claims: ClaimRecord[]): string[] {
  const quotes = [...bodyText.matchAll(/[“"]([^”"]{12,400})[”"]/g)].map((m) => m[1]!.trim()).filter((q) => q.split(/\s+/).length >= 4);
  const usable = claims.filter((c) => c.status === "confirmed" || c.status === "primary_confirmed" || c.status === "single_source");
  const usableText = usable.map((c) => normalize(c.text));
  const quoteClaims = usable.filter((c) => c.kind === "quote");
  return quotes.filter((q) => {
    const nq = normalize(q);
    if (nq && usableText.some((t) => t.includes(nq))) return false;
    const qs = shingles(q, 3);
    return !quoteClaims.some((c) => {
      const cs = shingles(c.text, 3);
      let inter = 0;
      for (const x of qs) if (cs.has(x)) inter++;
      return qs.size > 0 && inter / qs.size >= 0.7;
    });
  });
}

export interface QualityOutcome {
  checks: Check[];
  score: number;
  pass: boolean;
  review: ReviewOutput | null;
}

export function evaluateQuality(input: {
  review: ReviewOutput;
  seo: { errors: number; score: number; schemaErrors?: string[] };
  originalityPass: boolean;
  evidencePass: boolean;
  invented: string[];
  category: string;
  tags: string[];
  duplicateScore: number;
  minScore: number;
}): QualityOutcome {
  const r = input.review;
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean, severity: "error" | "warning", detail: string) => checks.push({ id, label, pass, severity, detail });
  add("evidence", "Essential claims supported by evidence", input.evidencePass, "error", input.evidencePass ? "policy met" : "evidence policy not met");
  add("unsupported", "No unsupported factual statements", r.unsupported_statements.length === 0, r.unsupported_statements.length > 1 ? "error" : "warning", r.unsupported_statements.slice(0, 3).join(" | ") || "none");
  const allInvented = [...new Set([...r.invented_quotes, ...input.invented])];
  add("quotes", "No invented quotations", allInvented.length === 0, "error", allInvented.slice(0, 3).join(" | ") || "none");
  add("headline", "Headline reflects the story", r.scores.headline_accuracy >= 0.6, "error", `score ${r.scores.headline_accuracy}`);
  add("originality", "Original wording", input.originalityPass, "error", input.originalityPass ? "below overlap limit" : "too similar to source text");
  add("grammar", "Grammar and readability", r.scores.grammar >= 0.7 && r.scores.clarity >= 0.6, "warning", `grammar ${r.scores.grammar}, clarity ${r.scores.clarity}`);
  add("seo", "Required SEO fields valid", input.seo.errors === 0, "error", `${input.seo.errors} SEO error(s)`);
  add("schema", "Structured data valid", (input.seo.schemaErrors ?? []).length === 0, "warning", (input.seo.schemaErrors ?? []).join("; ") || "valid");
  add("category", "Category in scope", isCategory(input.category), "error", input.category);
  add("tags", "Tags present", input.tags.length >= 2, "warning", `${input.tags.length} tag(s)`);
  add("duplicate", "Not a duplicate of existing site content", input.duplicateScore < DUPLICATE_THRESHOLD, "error", `max similarity ${input.duplicateScore}`);

  const s = r.scores;
  const reviewAvg = (s.accuracy + s.headline_accuracy + s.clarity + s.grammar + s.originality + s.usefulness) / 6;
  const score = Math.round((0.5 * reviewAvg + 0.3 * input.seo.score + 0.2 * (input.originalityPass ? 1 : 0.4)) * 1000) / 1000;
  const hardFail = checks.some((c) => !c.pass && c.severity === "error");
  if (score < input.minScore) add("score", "Editorial quality score", false, "error", `${score} < ${input.minScore}`);
  else add("score", "Editorial quality score", true, "error", `${score} ≥ ${input.minScore}`);
  return { checks, score, pass: !hardFail && score >= input.minScore, review: r };
}

export async function qualityStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  if (!run.article_id || !run.selected_candidate_id) throw new StageError("no_article", "No article to review", false);
  const article = await deps.store.getArticle(run.article_id);
  if (!article) throw new StageError("no_article", "Article not found", false);
  const claims = await deps.store.getClaims(run.selected_candidate_id);
  await sc.ensureModel(sc.models.text, "text");

  const bodyText = stripHtml(article.body_html);
  const sources = await deps.store.getCandidateSources(run.selected_candidate_id);
  const p = reviewPrompt(
    { headline: article.headline, bodyText },
    claims.map((c) => ({ text: c.text, kind: c.kind, status: c.status })),
    sources.map((x) => ({ title: x.title ?? x.domain, domain: x.domain, url: x.url })),
  );
  const res = await sc.tracked("review", sc.models.text, article.id, () =>
    deps.ai.complete({ model: sc.models.text, system: p.system, prompt: p.prompt, temperature: 0, jsonSchema: { name: "review", schema: reviewJsonSchema } }),
  );
  const review = extractJson(res.text, reviewSchema);

  const evidence = assessEvidence(claims.map((c) => ({ ...c, sources: c.sources.map((s) => ({ url: s.url, tier: s.quality_tier })), conflicting: c.status === "conflicting" })));
  const cache = await deps.store.listWpPosts(ws.workspaceId, 1000);
  const dupScore = cache.reduce((m, post) => Math.max(m, comparePost({ headline: article.headline, topic: article.primary_keyword, entities: article.entities, sourceUrls: [] }, post).score), 0);
  const seo = article.seo_report as { errors?: number; score?: number; schemaErrors?: string[] };
  const outcome = evaluateQuality({
    review,
    seo: { errors: seo.errors ?? 0, score: seo.score ?? 0, schemaErrors: seo.schemaErrors },
    originalityPass: Boolean((article.originality_report as { pass?: boolean }).pass),
    evidencePass: evidence.pass,
    invented: unverifiedQuotes(bodyText, claims),
    category: article.category,
    tags: article.tags,
    duplicateScore: Math.round(dupScore * 1000) / 1000,
    minScore: ws.settings.min_quality_score,
  });

  const mode = run.publishing_mode;
  const policy = ws.settings.quality_fail_policy;
  let target: "none" | "draft" | "publish";
  if (mode === "dry_run") target = "none";
  else if (outcome.pass) target = mode === "auto_publish" ? "publish" : "draft";
  else target = policy === "draft" ? "draft" : "none";

  const report = { ...outcome, issues: review.issues, decision: outcome.pass ? "passed" : policy === "draft" && mode !== "dry_run" ? "failed_saved_as_draft" : "failed" };
  await deps.store.updateArticle(article.id, {
    quality_report: report,
    quality_score: outcome.score,
    publish_target: target,
    status: outcome.pass ? "ready" : "needs_review",
  });
  const failed = outcome.checks.filter((c) => !c.pass);
  await sc.log("decision", outcome.pass ? `Quality gate passed (score ${outcome.score})` : `Quality gate failed (score ${outcome.score}): ${failed.map((c) => c.label).join(", ")}`, {
    checks: outcome.checks,
    scores: review.scores,
    target,
  });

  if (!outcome.pass && mode !== "dry_run" && policy === "fail") {
    return {
      next: "failed",
      patch: { error_code: "quality_gate", error_message: `Quality gate failed: ${failed.map((c) => c.label).join(", ")}`, outcome_reason: "Article failed the quality gate" },
      message: "Quality gate failed; policy is to stop without saving to WordPress",
    };
  }
  return { next: "generating_image", message: outcome.pass ? `Quality score ${outcome.score}` : `Quality gate failed; continuing as a draft for review` };
}
