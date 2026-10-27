import { extractJson } from "@/lib/ai/json";
import { CATEGORY_LABEL } from "@/lib/editorial/categories";
import { comparePost, DUPLICATE_THRESHOLD, slugify } from "@/lib/editorial/dedupe";
import { domainOf } from "@/lib/editorial/domains";
import { assessEvidence } from "@/lib/editorial/evidence";
import { reviewOriginality, type OriginalityReport } from "@/lib/editorial/originality";
import { escapeHtml, plainText, sanitizeArticleHtml } from "@/lib/editorial/sanitize";
import { buildNewsArticle, validateNewsArticle } from "@/lib/editorial/schema";
import { validateSeo, type SeoReport } from "@/lib/editorial/seo";
import { stripHtml } from "@/lib/editorial/text";
import type { StageContext, StageResult } from "../context";
import { StageError } from "../context";
import { articleJsonSchema, articleSchema, writerPrompt, type ArticleOutput, type WriterInput } from "../prompts";
import type { ClaimRecord, SourceRecord } from "../types";

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[,;:\s]+$/, "") + "…";
}

export interface ComposedArticle {
  headline: string;
  seoTitle: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  entities: string[];
  tags: string[];
  bodyHtml: string;
  faq: { question: string; answer: string }[];
  imageAlt: string;
  imageBrief: string;
  internalLinks: string[];
  externalLinks: string[];
  removedLinks: string[];
  seo: SeoReport;
  originality: OriginalityReport;
}

/** Deterministic post-processing of the writer output into publishable fields. */
export function composeArticle(
  out: ArticleOutput,
  ctx: {
    sources: { n: number; title: string; url: string; domain: string }[];
    internal: { title: string; url: string }[];
    takenSlugs: Set<string>;
    minWords: number;
    maxWords: number;
    sourceTexts: { label: string; text: string }[];
    existingTexts: { label: string; text: string }[];
  },
): ComposedArticle {
  const clean = sanitizeArticleHtml(out.body_html, {
    allowedExternal: ctx.sources.map((s) => s.url),
    allowedInternal: ctx.internal.map((l) => l.url),
  });
  let slug = slugify(out.slug.replace(/-/g, " ")) || slugify(out.headline);
  if (ctx.takenSlugs.has(slug)) {
    let i = 2;
    while (ctx.takenSlugs.has(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }
  const faq = out.faq
    .map((q) => ({ question: plainText(q.question, 200), answer: plainText(q.answer, 700) }))
    .filter((q) => q.question.endsWith("?") && q.answer.length > 20)
    .slice(0, 4);

  let body = clean.html.trim();
  if (faq.length) {
    body += `\n<h2>Frequently asked questions</h2>\n${faq.map((q) => `<h3>${escapeHtml(q.question)}</h3>\n<p>${escapeHtml(q.answer)}</p>`).join("\n")}`;
  }
  if (ctx.sources.length) {
    body += `\n<h2>Sources</h2>\n<ul>\n${ctx.sources
      .map((s) => `<li><a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title || s.domain)}</a> — ${escapeHtml(s.domain)}</li>`)
      .join("\n")}\n</ul>`;
  }

  const headline = plainText(out.headline, 110);
  const tags = [...new Map(out.tags.map((t) => [plainText(t, 50).toLowerCase(), plainText(t, 50)])).values()].filter(Boolean).slice(0, 6);
  const imageAlt = plainText(out.image_alt, 160);
  const composed = {
    headline,
    seoTitle: truncateAtWord(plainText(out.seo_title, 90), 65),
    slug,
    metaDescription: truncateAtWord(plainText(out.meta_description, 220), 158),
    excerpt: plainText(out.excerpt, 400),
    primaryKeyword: plainText(out.primary_keyword, 80),
    secondaryKeywords: out.secondary_keywords.map((k) => plainText(k, 80)).filter(Boolean).slice(0, 8),
    entities: out.entities.map((e) => plainText(e, 80)).filter(Boolean).slice(0, 12),
    tags,
    bodyHtml: body,
    faq,
    imageAlt,
    imageBrief: plainText(out.image_brief, 600),
    internalLinks: clean.internalLinks,
    externalLinks: [...new Set([...clean.externalLinks, ...ctx.sources.map((s) => s.url)])],
    removedLinks: clean.removedLinks,
  };
  const seo = validateSeo(
    {
      headline: composed.headline,
      seoTitle: composed.seoTitle,
      slug: composed.slug,
      metaDescription: composed.metaDescription,
      excerpt: composed.excerpt,
      primaryKeyword: composed.primaryKeyword,
      secondaryKeywords: composed.secondaryKeywords,
      tags: composed.tags,
      bodyHtml: clean.html,
      faq,
      imageAlt,
      internalLinks: clean.internalLinks.length,
      externalLinks: composed.externalLinks.length,
    },
    { minWords: ctx.minWords, maxWords: ctx.maxWords },
  );
  const originality = reviewOriginality(clean.html, ctx.sourceTexts, ctx.existingTexts);
  return { ...composed, seo, originality };
}

function revisionNotes(a: ComposedArticle): string[] {
  const notes = a.seo.checks.filter((c) => !c.pass && c.severity === "error").map((c) => `${c.label}: ${c.detail}`);
  if (!a.originality.pass) {
    notes.push(`Too close to source wording (overlap ${a.originality.maxSourceOverlap}). Rewrite these passages in original words: ${a.originality.flaggedPassages.slice(0, 3).map((p) => `"${p.passage}"`).join(" ")}`);
  }
  if (a.removedLinks.length) notes.push(`Only link to the listed SOURCES or EXISTING SITE ARTICLES; these links were removed: ${a.removedLinks.slice(0, 5).join(", ")}`);
  return notes;
}

export async function writeStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  if (!run.selected_candidate_id) throw new StageError("no_candidate", "No selected candidate to write", false);
  const cand = await deps.store.getCandidate(run.selected_candidate_id);
  if (!cand) throw new StageError("no_candidate", "Selected candidate not found", false);
  await sc.ensureModel(sc.models.text, "text");

  const claims: ClaimRecord[] = await deps.store.getClaims(cand.id);
  const assessment = assessEvidence(claims.map((c) => ({ ...c, sources: c.sources.map((s) => ({ url: s.url, tier: s.quality_tier })), conflicting: c.status === "conflicting" })));
  const used = new Map<string, SourceRecord>();
  for (const i of [...assessment.usableClaims, ...assessment.hedgedClaims]) for (const s of claims[i]!.sources) used.set(s.id, s);
  const sourceList = [...used.values()].slice(0, 12).map((s, i) => ({ n: i + 1, title: s.title ?? s.domain, url: s.url, domain: s.domain || domainOf(s.url), publishedAt: s.published_at }));
  const nOf = (id: string) => sourceList.find((x) => x.url === used.get(id)?.url)?.n;

  const cache = await deps.store.listWpPosts(ws.workspaceId, 1000);
  const dc = { headline: cand.headline, topic: cand.topic, entities: cand.entities, sourceUrls: sourceList.map((s) => s.url) };
  const internal = cache
    .filter((p) => p.status === "publish" && p.link)
    .map((p) => ({ p, score: comparePost(dc, p).score }))
    .filter((x) => x.score >= 0.12 && x.score < DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => ({ title: x.p.title, url: x.p.link }));

  const writerInput: WriterInput = {
    category: cand.category,
    headline: cand.headline,
    summary: cand.summary,
    format: cand.suggested_format,
    confirmed: assessment.usableClaims.map((i, k) => ({ n: k + 1, text: claims[i]!.text, sources: claims[i]!.sources.map((s) => nOf(s.id)).filter((n): n is number => Boolean(n)) })),
    attributed: assessment.hedgedClaims.map((i, k) => ({ n: k + 1, text: claims[i]!.text, kind: claims[i]!.kind, status: claims[i]!.status, sources: claims[i]!.sources.map((s) => nOf(s.id)).filter((n): n is number => Boolean(n)) })),
    sources: sourceList,
    internalLinks: internal,
    minWords: ws.settings.target_words_min,
    maxWords: ws.settings.target_words_max,
    siteName: ws.workspaceName,
  };
  const composeCtx = {
    sources: sourceList,
    internal,
    takenSlugs: new Set(cache.map((p) => p.slug)),
    minWords: ws.settings.target_words_min,
    maxWords: ws.settings.target_words_max,
    sourceTexts: [...used.values()].filter((s) => s.excerpt).map((s) => ({ label: s.url, text: s.excerpt! })),
    existingTexts: cache.slice(0, 300).map((p) => ({ label: p.link || p.title, text: `${p.title}. ${p.excerpt}` })),
  };

  const existing = await deps.store.findArticleForCandidate(run.id, cand.id);
  const callWriter = async (notes?: string[]) => {
    const p = writerPrompt({ ...writerInput, revisionNotes: notes });
    const res = await sc.tracked("write", sc.models.text, existing?.id ?? null, () =>
      deps.ai.complete({ model: sc.models.text, system: p.system, prompt: p.prompt, temperature: 0.6, jsonSchema: { name: "article", schema: articleJsonSchema } }),
    );
    return extractJson(res.text, articleSchema);
  };

  const first = composeArticle(await callWriter(), composeCtx);
  let final = first;
  let revised = false;
  const notes = revisionNotes(first);
  if (notes.length) {
    await sc.log("warning", `Draft needs revision: ${notes.length} issue(s)`, { notes });
    final = composeArticle(await callWriter(notes), composeCtx);
    revised = true;
  }

  const nowIso = deps.now().toISOString();
  const jsonLd = buildNewsArticle({
    headline: final.headline,
    description: final.metaDescription,
    url: null,
    imageUrl: null,
    datePublished: nowIso,
    dateModified: nowIso,
    authorName: ws.workspaceName,
    publisherName: ws.workspaceName,
    section: CATEGORY_LABEL[cand.category],
    keywords: [final.primaryKeyword, ...final.secondaryKeywords],
  });
  const schemaErrors = validateNewsArticle(jsonLd, final.headline);

  const fields = {
    workspace_id: ws.workspaceId,
    run_id: run.id,
    candidate_id: cand.id,
    category: cand.category,
    status: "ready" as const,
    publishing_mode: run.publishing_mode,
    draft_headline: first.headline,
    headline: final.headline,
    seo_title: final.seoTitle,
    slug: final.slug,
    meta_description: final.metaDescription,
    excerpt: final.excerpt,
    primary_keyword: final.primaryKeyword,
    secondary_keywords: final.secondaryKeywords,
    entities: final.entities,
    tags: final.tags,
    body_html: final.bodyHtml,
    faq: final.faq,
    json_ld: jsonLd,
    word_count: final.seo.wordCount,
    seo_report: { ...final.seo, schemaErrors, internalLinks: final.internalLinks, externalLinks: final.externalLinks, removedLinks: final.removedLinks },
    originality_report: { ...final.originality },
  };
  let articleId: string;
  if (existing) {
    await deps.store.updateArticle(existing.id, fields);
    articleId = existing.id;
  } else {
    articleId = (await deps.store.createArticle(fields)).id;
  }
  await deps.store.addRevision(articleId, ws.workspaceId, "writer", first.headline, first.bodyHtml, "Initial draft");
  if (revised) {
    await deps.store.addRevision(articleId, ws.workspaceId, "revision", final.headline, final.bodyHtml, `Revised to address: ${notes.join("; ").slice(0, 900)}`);
  }
  await deps.store.upsertImage(articleId, ws.workspaceId, { prompt: final.imageBrief, model: sc.models.image, alt_text: final.imageAlt, title: final.headline, status: "pending" });

  return {
    next: "quality_check",
    patch: { article_id: articleId },
    message: `Drafted "${final.headline}" (${final.seo.wordCount} words${revised ? ", revised once" : ""})`,
    detail: { seo_errors: final.seo.errors, seo_warnings: final.seo.warnings, originality: final.originality.maxSourceOverlap, internal_links: final.internalLinks.length, removed_links: final.removedLinks, text: stripHtml(final.bodyHtml).slice(0, 280) },
  };
}
