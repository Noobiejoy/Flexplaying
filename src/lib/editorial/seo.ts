import { normalize, stripHtml, tokens, wordCount } from "./text";

export interface SeoFields {
  headline: string;
  seoTitle: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  tags: string[];
  bodyHtml: string;
  faq: { question: string; answer: string }[];
  imageAlt: string | null;
  internalLinks: number;
  externalLinks: number;
}

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface SeoReport {
  checks: Check[];
  errors: number;
  warnings: number;
  score: number;
  wordCount: number;
}

function containsKeyword(text: string, keyword: string): boolean {
  const kt = tokens(keyword);
  if (kt.length === 0) return false;
  const ht = new Set(tokens(text));
  const hits = kt.filter((t) => ht.has(t)).length;
  return hits / kt.length >= 0.75;
}

function keywordDensity(text: string, keyword: string): number {
  const words = normalize(text).split(" ").filter(Boolean);
  const phrase = normalize(keyword);
  if (!phrase || words.length === 0) return 0;
  const hay = ` ${words.join(" ")} `;
  let count = 0;
  let idx = hay.indexOf(` ${phrase} `);
  while (idx >= 0) {
    count++;
    idx = hay.indexOf(` ${phrase} `, idx + phrase.length);
  }
  return (count * phrase.split(" ").length) / words.length;
}

export function validateSeo(f: SeoFields, opts: { minWords: number; maxWords: number }): SeoReport {
  const text = stripHtml(f.bodyHtml);
  const words = wordCount(text);
  const first150 = text.split(/\s+/).slice(0, 150).join(" ");
  const h2 = (f.bodyHtml.match(/<h2[\s>]/gi) ?? []).length;
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean, severity: "error" | "warning", detail: string) =>
    checks.push({ id, label, pass, severity, detail });

  add("headline", "Headline length", f.headline.length >= 20 && f.headline.length <= 110, "error", `${f.headline.length} chars (20–110)`);
  add("seo_title", "SEO title length", f.seoTitle.length >= 30 && f.seoTitle.length <= 65, f.seoTitle.length < 15 || f.seoTitle.length > 75 ? "error" : "warning", `${f.seoTitle.length} chars (30–65)`);
  add("meta", "Meta description length", f.metaDescription.length >= 70 && f.metaDescription.length <= 160, f.metaDescription.length < 40 || f.metaDescription.length > 200 ? "error" : "warning", `${f.metaDescription.length} chars (70–160)`);
  add("slug", "URL slug format", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(f.slug) && f.slug.length <= 75 && f.slug.split("-").length <= 10, "error", f.slug);
  add("kw_title", "Primary keyword in SEO title", containsKeyword(f.seoTitle, f.primaryKeyword), "warning", f.primaryKeyword);
  add("kw_intro", "Primary keyword in opening", containsKeyword(first150, f.primaryKeyword), "warning", "first 150 words");
  add("kw_meta", "Primary keyword in meta description", containsKeyword(f.metaDescription, f.primaryKeyword), "warning", "");
  const density = keywordDensity(text, f.primaryKeyword);
  add("kw_density", "No keyword stuffing", density <= 0.03, density > 0.05 ? "error" : "warning", `${(density * 100).toFixed(1)}% (≤3%)`);
  add("no_h1", "No H1 inside body (title is the H1)", !/<h1[\s>]/i.test(f.bodyHtml), "error", "");
  add("headings", "Descriptive section headings", words < 450 || h2 >= 2, "warning", `${h2} H2 headings`);
  add("length_min", "Article not too thin", words >= 250, "error", `${words} words (≥250)`);
  add("length_range", "Within target length", words >= opts.minWords && words <= opts.maxWords, "warning", `${words} words (${opts.minWords}–${opts.maxWords}); shorter is fine for brief updates`);
  const exWords = wordCount(f.excerpt);
  add("excerpt", "Excerpt length", exWords >= 12 && exWords <= 60, "warning", `${exWords} words`);
  add("tags", "Tags", f.tags.length >= 2 && f.tags.length <= 8, "warning", `${f.tags.length} tags`);
  add("faq_size", "FAQ is concise", f.faq.length <= 5 && f.faq.every((q) => q.question.trim().endsWith("?") && wordCount(q.answer) <= 90), "warning", `${f.faq.length} questions`);
  add("external_links", "Links to verified sources", f.externalLinks >= 1, "error", `${f.externalLinks} source link(s)`);
  add("internal_links", "Internal links", f.internalLinks >= 1, "warning", `${f.internalLinks} internal link(s)`);
  add("alt", "Featured image alt text", Boolean(f.imageAlt && f.imageAlt.length >= 10 && f.imageAlt.length <= 160), "warning", f.imageAlt ?? "missing");

  const errors = checks.filter((c) => !c.pass && c.severity === "error").length;
  const warnings = checks.filter((c) => !c.pass && c.severity === "warning").length;
  const score = Math.max(0, Math.round((1 - errors * 0.2 - warnings * 0.04) * 1000) / 1000);
  return { checks, errors, warnings, score, wordCount: words };
}
