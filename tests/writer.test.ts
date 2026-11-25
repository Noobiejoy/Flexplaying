import { describe, expect, it } from "vitest";
import { stripHtml } from "@/lib/editorial/text";
import { THIN_CONTENT_MIN_WORDS } from "@/lib/editorial/seo";
import { factCheckPrompt, WRITER_MIN_WORDS, writerPrompt, type ArticleOutput, type WriterInput } from "@/lib/pipeline/prompts";
import { composeArticle, MAX_RELATED_LINKS, revisionNotes, withoutRelatedSection } from "@/lib/pipeline/stages/write";

const writer: WriterInput = {
  category: "anime",
  headline: "Akane-banashi Season 2 Sets January 9 Premiere",
  summary: "The second season premieres on January 9, 2027.",
  format: "news",
  confirmed: [{ n: 1, text: "Akane-banashi season 2 premieres on January 9, 2027.", sources: [1] }],
  attributed: [],
  sources: [{ n: 1, title: "Announcement", url: "https://www.crunchyroll.com/news/a", domain: "crunchyroll.com", publishedAt: null }],
  minWords: 600,
  maxWords: 1200,
  siteName: "FlexPlaying",
};

function output(words: number): ArticleOutput {
  return {
    headline: "Akane-banashi Season 2 Sets January 9 Premiere",
    seo_title: "Akane-banashi Season 2 Premieres January 9, 2027",
    slug: "akane-banashi-season-2-january-premiere",
    meta_description: "Akane-banashi season 2 premieres on January 9, 2027. Here is everything confirmed so far about the return of the rakugo anime series.",
    excerpt: "Akane-banashi season 2 premieres on January 9, 2027, the production confirmed.",
    primary_keyword: "Akane-banashi season 2",
    secondary_keywords: [],
    entities: ["Akane-banashi"],
    tags: ["Akane-banashi", "Anime"],
    body_html: `<p>Akane-banashi season 2 premieres on <a href="https://www.crunchyroll.com/news/a">January 9, 2027</a>.</p><h2>Details</h2><p>${"word ".repeat(words)}</p>`,
    faq: [],
    image_alt: "A storyteller on a stage",
    image_brief: "A rakugo performer on a lit stage",
  };
}

const internal = [
  { title: "Phantom Busters TV Anime Unveils Teaser Visual", url: "https://flexplaying.com/phantom-busters/" },
  { title: "Tsugumi Project Anime Sets 2027 Debut", url: "https://flexplaying.com/tsugumi-project/" },
  { title: "Shin Oishinbo Main Trailer", url: "https://flexplaying.com/shin-oishinbo/" },
  { title: "Bride of the Barrier Master Premiere", url: "https://flexplaying.com/bride/" },
];
const ctx = (links = internal) => ({
  sources: writer.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, domain: s.domain })),
  internal: links,
  takenSlugs: new Set<string>(),
  minWords: 600,
  maxWords: 1200,
  sourceTexts: [],
  existingTexts: [],
});

describe("writer prompt", () => {
  const p = writerPrompt(writer);
  it("forbids unsupported context about other titles and invented premises", () => {
    expect(p.system).toMatch(/Never mention another anime, game, team, event or release that the claims do not name/);
    expect(p.system).toMatch(/joins a growing slate/);
    expect(p.system).toMatch(/plot, premise, characters/);
  });
  it("sets a hard minimum above the thin-content limit", () => {
    expect(WRITER_MIN_WORDS).toBeGreaterThan(THIN_CONTENT_MIN_WORDS);
    expect(p.prompt).toContain(`at least ${WRITER_MIN_WORDS} words`);
    expect(p.prompt).not.toMatch(/shorter is fine/);
  });
  it("no longer hands the writer other site articles to weave in", () => {
    expect(p.prompt).not.toMatch(/EXISTING SITE ARTICLES/);
    expect(p.prompt).toMatch(/Do NOT add links to other site articles/);
  });
});

describe("fact-check prompt", () => {
  it("asks for sourced background claims without raising the search budget", () => {
    const p = factCheckPrompt({ headline: "h", summary: "s", category: "anime", sourceUrls: [] }, "2026-11-25T00:00:00Z").prompt;
    expect(p).toMatch(/BACKGROUND claims/);
    expect(p).toMatch(/Aim for 10-16 claims/);
    expect(p).toMatch(/at most 3 searches/);
  });
});

describe("related coverage", () => {
  it("is appended by the app, capped, counted as internal links and placed before sources", () => {
    const a = composeArticle(output(320), ctx());
    expect(a.bodyHtml).toContain("<h2>Related coverage</h2>");
    expect(a.internalLinks).toHaveLength(MAX_RELATED_LINKS);
    expect(a.seo.checks.find((c) => c.id === "internal_links")?.pass).toBe(true);
    expect(a.bodyHtml.indexOf("Related coverage")).toBeLessThan(a.bodyHtml.indexOf("<h2>Sources</h2>"));
  });
  it("does not count towards the word count and is hidden from the reviewer", () => {
    const withLinks = composeArticle(output(320), ctx());
    const without = composeArticle(output(320), ctx([]));
    expect(withLinks.seo.wordCount).toBe(without.seo.wordCount);
    const reviewed = stripHtml(withoutRelatedSection(withLinks.bodyHtml));
    expect(reviewed).not.toMatch(/Phantom Busters|Related coverage/);
    expect(reviewed).toMatch(/Sources/);
  });
  it("leaves an article without the section unchanged", () => {
    expect(withoutRelatedSection("<p>Hello</p>")).toBe("<p>Hello</p>");
  });
});

describe("revision notes", () => {
  it("tells a thin draft how to grow without inventing facts", () => {
    const thin = composeArticle(output(150), ctx());
    expect(thin.seo.checks.find((c) => c.id === "length_min")?.pass).toBe(false);
    const notes = revisionNotes(thin);
    const note = notes.find((n) => n.startsWith("Too short"));
    expect(note).toContain(`at least ${WRITER_MIN_WORDS}`);
    expect(note).toMatch(/Cover every CONFIRMED and ATTRIBUTED claim/);
    expect(note).toMatch(/Do not add facts/);
  });
  it("adds no length note when the draft is long enough", () => {
    expect(revisionNotes(composeArticle(output(320), ctx())).some((n) => n.startsWith("Too short"))).toBe(false);
  });
});
