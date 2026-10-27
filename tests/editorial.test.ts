import { describe, expect, it } from "vitest";
import { comparePost, findMatches, slugify } from "@/lib/editorial/dedupe";
import { createDomainRegistry, type SourceTier } from "@/lib/editorial/domains";
import { assessEvidence, claimStatus } from "@/lib/editorial/evidence";
import { reviewOriginality } from "@/lib/editorial/originality";
import { DEFAULT_PREFERENCES, learnPreferences } from "@/lib/editorial/preferences";
import { sanitizeArticleHtml } from "@/lib/editorial/sanitize";
import { buildNewsArticle, jsonLdScript, validateNewsArticle } from "@/lib/editorial/schema";
import { scoreCandidate } from "@/lib/editorial/scoring";
import { validateSeo } from "@/lib/editorial/seo";

const reg = createDomainRegistry();
const now = new Date("2026-10-27T06:00:00Z");

describe("source tiers", () => {
  it("classifies official, established, social and unknown domains", () => {
    expect(reg.tierFor("https://www.crunchyroll.com/news/x")).toBe("official");
    expect(reg.tierFor("https://www.hltv.org/news/1")).toBe("established");
    expect(reg.tierFor("https://reddit.com/r/anime")).toBe("standard");
    expect(reg.tierFor("https://someblog.blogspot.com/p")).toBe("low");
    expect(reg.tierFor("https://random-site.xyz/a")).toBe("unknown");
  });
});

describe("topic scoring", () => {
  const base = {
    category: "gaming",
    headline: "Hollow Knight Silksong patch adds new boss",
    topic: "Silksong patch",
    entities: ["Hollow Knight Silksong", "Team Cherry"],
    sources: [
      { url: "https://www.ign.com/a", tier: "established" as const, publishedAt: "2026-10-27T03:00:00Z" },
      { url: "https://www.pcgamer.com/b", tier: "established" as const, publishedAt: "2026-10-27T02:00:00Z" },
    ],
    modelRelevance: 0.8,
    modelOriginality: 0.6,
    confidence: "high" as const,
  };
  const ctx = { now, prefs: DEFAULT_PREFERENCES, enabledCategories: ["anime", "gaming", "esports"] as ("anime" | "gaming" | "esports")[], recentCategoryCounts: {} };

  it("produces transparent component scores", () => {
    const r = scoreCandidate(base, ctx);
    expect(r.rejection).toBeNull();
    expect(r.components.recency).toBeGreaterThan(0.85);
    expect(r.components.corroboration).toBe(0.7);
    expect(r.overall).toBeGreaterThan(0.6);
  });

  it("enforces categories and blocked terms", () => {
    expect(scoreCandidate({ ...base, category: "politics" }, ctx).rejection).toMatch(/not enabled/);
    expect(scoreCandidate(base, { ...ctx, enabledCategories: ["anime"] }).overall).toBe(0);
    expect(scoreCandidate(base, { ...ctx, prefs: { ...DEFAULT_PREFERENCES, blockedTerms: ["silksong"] } }).rejection).toMatch(/blocked/);
  });

  it("older and single-source stories score lower; diversity penalises repeated categories", () => {
    const fresh = scoreCandidate(base, ctx).overall;
    const stale = scoreCandidate({ ...base, sources: base.sources.map((s) => ({ ...s, publishedAt: "2026-10-23T00:00:00Z" })) }, ctx).overall;
    const single = scoreCandidate({ ...base, sources: [base.sources[0]!] }, ctx).overall;
    const repeated = scoreCandidate(base, { ...ctx, recentCategoryCounts: { gaming: 3 } }).overall;
    expect(stale).toBeLessThan(fresh);
    expect(single).toBeLessThan(fresh);
    expect(repeated).toBeLessThan(fresh);
  });

  it("rejects candidates with no verifiable sources", () => {
    expect(scoreCandidate({ ...base, sources: [] }, ctx).rejection).toMatch(/No verifiable sources/);
  });
});

describe("duplicate detection", () => {
  const cand = { headline: "Frieren Season 3 Officially Announced for 2027", topic: "Frieren season 3", entities: ["Frieren", "Madhouse"], sourceUrls: ["https://www.crunchyroll.com/news/frieren-s3"] };
  const post = (title: string, extra: Partial<Parameters<typeof comparePost>[1]> = {}) => ({ id: 1, title, slug: slugify(title), link: "https://site/x", status: "publish", excerpt: "", origin: "wordpress" as const, ...extra });

  it("flags exact and reworded headlines as duplicates", () => {
    expect(comparePost(cand, post("Frieren Season 3 Officially Announced for 2027")).verdict).toBe("duplicate");
    expect(comparePost(cand, post("Madhouse confirms Frieren season 3 is coming in 2027", { excerpt: "Frieren Madhouse" })).verdict).not.toBe("distinct");
  });

  it("flags a post citing the same canonical source URL", () => {
    expect(comparePost(cand, post("Big anime news roundup", { content: '<a href="https://crunchyroll.com/news/frieren-s3?utm_source=x">link</a>' })).verdict).toBe("duplicate");
  });

  it("treats unrelated posts as distinct", () => {
    expect(findMatches(cand, [post("Valorant Champions 2026 final results")])).toEqual([]);
  });

  it("slugify produces clean slugs", () => {
    expect(slugify("Frieren: Season 3 — Announced! (2027)")).toBe("frieren-season-3-announced-2027");
  });
});

describe("evidence policy", () => {
  const off = { url: "https://www.crunchyroll.com/n", tier: "official" as const };
  const a = { url: "https://www.ign.com/n", tier: "established" as const };
  const b = { url: "https://www.polygon.com/n", tier: "established" as const };
  it("classifies claim support", () => {
    expect(claimStatus({ text: "", kind: "fact", importance: "high", sources: [off], conflicting: false })).toBe("primary_confirmed");
    expect(claimStatus({ text: "", kind: "fact", importance: "high", sources: [a, b], conflicting: false })).toBe("confirmed");
    expect(claimStatus({ text: "", kind: "fact", importance: "high", sources: [a], conflicting: false })).toBe("single_source");
    expect(claimStatus({ text: "", kind: "fact", importance: "high", sources: [{ url: "https://reddit.com/x", tier: "standard" }], conflicting: false })).toBe("unverified");
    expect(claimStatus({ text: "", kind: "fact", importance: "high", sources: [a, b], conflicting: true })).toBe("conflicting");
  });
  it("passes well-supported stories and rejects thin ones", () => {
    const mk = (sources: { url: string; tier: SourceTier }[], importance: "high" | "normal" = "high") => {
      const c = { text: "x", kind: "fact" as const, importance, sources, conflicting: false };
      return { ...c, status: claimStatus(c) };
    };
    expect(assessEvidence([mk([off]), mk([a, b]), mk([a], "normal")]).pass).toBe(true);
    const thin = assessEvidence([mk([a]), mk([])]);
    expect(thin.pass).toBe(false);
    expect(thin.excludedClaims).toEqual([1]);
  });
});

describe("HTML sanitisation", () => {
  it("strips scripts, handlers and unverified links; keeps verified sources and internal links", () => {
    const r = sanitizeArticleHtml(
      '<h1>T</h1><p onclick="x()">Hi <a href="https://www.ign.com/a?utm_source=z">IGN</a> <a href="javascript:alert(1)">bad</a> <a href="https://evil.example">evil</a> <a href="https://site.example/old-post/">old</a></p><script>alert(1)</script><img src=x onerror=alert(1)>',
      { allowedExternal: ["https://www.ign.com/a"], allowedInternal: ["https://site.example/old-post/"] },
    );
    expect(r.html).not.toMatch(/script|onclick|onerror|javascript:|evil\.example|<img|<h1/);
    expect(r.html).toContain('href="https://www.ign.com/a"');
    expect(r.html).toContain('href="https://site.example/old-post/"');
    expect(r.removedLinks).toContain("https://evil.example");
    expect(r.internalLinks).toHaveLength(1);
  });
});

describe("SEO validation", () => {
  const body = `<p>Frieren season 3 is coming in 2027, and here is what was confirmed.</p><h2>Details</h2><p>${"word ".repeat(400)}</p><h2>Next</h2><p>${"more ".repeat(200)}</p>`;
  const fields = {
    headline: "Frieren Season 3 Confirmed for 2027",
    seoTitle: "Frieren Season 3 Confirmed for a 2027 Premiere",
    slug: "frieren-season-3-confirmed-2027",
    metaDescription: "Frieren season 3 is official with a 2027 window. Here is what Crunchyroll and Madhouse confirmed, and what comes next for the series.",
    excerpt: "Frieren season 3 is official, with a 2027 premiere window confirmed by Crunchyroll.",
    primaryKeyword: "Frieren season 3",
    secondaryKeywords: [],
    tags: ["Frieren", "Anime"],
    bodyHtml: body,
    faq: [],
    imageAlt: "An elf mage overlooking a valley",
    internalLinks: 1,
    externalLinks: 2,
  };
  it("passes a well-formed article", () => {
    const r = validateSeo(fields, { minWords: 500, maxWords: 1200 });
    expect(r.errors).toBe(0);
  });
  it("catches bad slugs, missing sources, h1 in body and keyword stuffing", () => {
    const r = validateSeo({ ...fields, slug: "Bad Slug!", externalLinks: 0, bodyHtml: `<h1>x</h1><p>${"frieren season 3 ".repeat(100)}</p>` }, { minWords: 500, maxWords: 1200 });
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["slug", "external_links", "no_h1", "kw_density"]));
    expect(r.errors).toBeGreaterThanOrEqual(4);
  });
});

describe("structured data", () => {
  it("builds valid NewsArticle JSON-LD and escapes the script payload", () => {
    const doc = buildNewsArticle({ headline: "Frieren Season 3 Confirmed", description: "d", url: "https://s/x", imageUrl: "https://s/i.jpg", datePublished: "2026-10-27T00:00:00Z", dateModified: "2026-10-27T01:00:00Z", authorName: "FlexPlaying", publisherName: "FlexPlaying", section: "Anime", keywords: ["a"] });
    expect(validateNewsArticle(doc, "Frieren Season 3 Confirmed")).toEqual([]);
    expect(validateNewsArticle({ ...doc, dateModified: "2020-01-01" }, "Frieren Season 3 Confirmed")).toContain("dateModified is earlier than datePublished");
    expect(jsonLdScript({ x: "</script><script>alert(1)" })).not.toContain("</script><script>");
  });
});

describe("originality review", () => {
  it("flags copied passages and passes original prose", () => {
    const src = "Crunchyroll announced on Sunday that the third season of the acclaimed fantasy anime will premiere in January 2027 with Madhouse returning.";
    const copied = reviewOriginality(`<p>${src}</p><p>Something else entirely different here for the reader.</p>`, [{ label: "cr", text: src }], []);
    expect(copied.pass).toBe(false);
    expect(copied.flaggedPassages.length).toBeGreaterThan(0);
    const original = reviewOriginality("<p>The fantasy series returns next year, and the studio behind the first two seasons is back.</p>", [{ label: "cr", text: src }], []);
    expect(original.pass).toBe(true);
  });
});

describe("preference learning", () => {
  it("applies bounded, explainable updates from feedback", () => {
    const r = learnPreferences(DEFAULT_PREFERENCES, [
      { verdict: "interesting", category: "esports", entities: ["Valorant"], createdAt: "" },
      { verdict: "irrelevant", category: "anime", entities: ["Gacha Spam"], createdAt: "" },
    ], []);
    expect(r.next.categoryWeights.esports).toBeGreaterThan(1);
    expect(r.next.categoryWeights.anime).toBeLessThan(1);
    expect(r.next.entityAdjustments.valorant).toBeGreaterThan(0);
    expect(r.next.entityAdjustments["gacha spam"]).toBeLessThan(0);
    expect(r.changes.length).toBe(4);
    const many = learnPreferences(DEFAULT_PREFERENCES, Array.from({ length: 100 }, () => ({ verdict: "interesting" as const, category: "gaming" as const, entities: ["Xeno"], createdAt: "" })), []);
    expect(many.next.categoryWeights.gaming).toBe(1.4);
    expect(many.next.entityAdjustments.xeno).toBe(0.3);
  });
  it("records no change when there are no signals", () => {
    expect(learnPreferences(DEFAULT_PREFERENCES, [], []).changes).toEqual([]);
  });
});
