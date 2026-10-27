import sharp from "sharp";
import { MockAiProvider, mockText } from "@/lib/ai/mock";
import { emptyUsage, type ImageResult, type TextResult } from "@/lib/ai/types";
import { createDomainRegistry } from "@/lib/editorial/domains";
import { composeThumbnail } from "@/lib/image/compose";
import type { PipelineDeps } from "@/lib/pipeline/context";
import { MemoryStore } from "@/lib/pipeline/memory-store";
import { MockWordPress } from "@/lib/wordpress/mock";

export const NOW = new Date("2026-10-27T03:35:00Z"); // 09:05 IST

export const ANN = "https://www.animenewsnetwork.com/news/2026-10-26/frieren-season-3-announced/.1";
export const CR = "https://www.crunchyroll.com/news/announcements/2026/10/26/frieren-season-3";
export const IGN = "https://www.ign.com/articles/frieren-season-3-release-window";

export function discoveryJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    candidates: [
      {
        headline: "Frieren: Beyond Journey's End Season 3 Announced for 2027",
        topic: "Frieren season 3 announcement",
        category: "anime",
        summary: "Studio Madhouse and Crunchyroll confirmed a third season of Frieren: Beyond Journey's End, targeting a 2027 premiere.",
        evidence: "Crunchyroll's announcement and Anime News Network report the season and window.",
        event_date: "2026-10-26",
        entities: ["Frieren", "Madhouse", "Crunchyroll"],
        sources: [
          { url: ANN, title: "Frieren Season 3 Announced", published_at: "2026-10-26T22:00:00Z" },
          { url: CR, title: "Frieren Season 3 Is Coming", published_at: "2026-10-26T21:30:00Z" },
          { url: "https://fabricated-news.example/fake", title: "Fake", published_at: null },
        ],
        relevance: 0.9,
        originality: 0.7,
        confidence: "high",
        duplicate_risk: "medium",
        suggested_format: "news",
        ...overrides,
      },
    ],
    queries_used: ["Frieren season 3", "Madhouse announcement"],
  });
}

export function factCheckJson() {
  return JSON.stringify({
    claims: [
      { text: "Frieren: Beyond Journey's End will receive a third season.", kind: "fact", importance: "high", source_urls: [ANN, CR], conflicting: false },
      { text: "Madhouse is returning to animate the third season.", kind: "fact", importance: "high", source_urls: [ANN, IGN], conflicting: false },
      { text: "The season targets a 2027 premiere.", kind: "fact", importance: "high", source_urls: [CR], conflicting: false },
      { text: "Fans expect a winter 2027 slot.", kind: "prediction", importance: "normal", source_urls: [IGN], conflicting: false },
    ],
    open_questions: ["Exact premiere date"],
  });
}

const PARA =
  "The announcement gives fans of the fantasy series a clear sign that the adaptation will continue, and it places Frieren among the few recent anime with three consecutive seasons. ";

export function articleJson(overrides: Record<string, unknown> = {}) {
  const body =
    `<p>Frieren season 3 is officially in production, with <a href="${CR}">Crunchyroll confirming</a> a 2027 premiere window.</p>` +
    `<h2>What was announced</h2><p>${PARA.repeat(6)}</p>` +
    `<h2>Why it matters</h2><p>${"Madhouse returning means the visual style and pacing that defined the first seasons should carry over. ".repeat(8)}</p>` +
    `<h2>What happens next</h2><p>${"Further details such as a trailer, cast confirmations and an exact date are expected in the coming months. ".repeat(8)}</p>` +
    `<p>Read our <a href="https://evil.example/phish">exclusive</a> take.</p><script>alert(1)</script>`;
  return JSON.stringify({
    headline: "Frieren Season 3 Confirmed With 2027 Premiere Window",
    seo_title: "Frieren Season 3 Confirmed for 2027 Premiere Window",
    slug: "frieren-season-3-confirmed-2027",
    meta_description: "Frieren season 3 is official: Madhouse returns and Crunchyroll confirms a 2027 premiere window. Here is what was announced and what comes next.",
    excerpt: "Frieren season 3 is official, with Madhouse returning and a 2027 premiere window confirmed by Crunchyroll.",
    primary_keyword: "Frieren season 3",
    secondary_keywords: ["Madhouse", "Crunchyroll"],
    entities: ["Frieren", "Madhouse", "Crunchyroll"],
    tags: ["Frieren", "Madhouse", "Crunchyroll", "Anime"],
    body_html: body,
    faq: [{ question: "When does Frieren season 3 premiere?", answer: "Crunchyroll has confirmed a 2027 premiere window; an exact date has not been announced." }],
    image_alt: "Illustration of an elf mage overlooking a misty valley at dawn",
    image_brief: "An elf mage on a cliff overlooking a misty fantasy valley at dawn",
    ...overrides,
  });
}

export function reviewJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    scores: { accuracy: 0.92, headline_accuracy: 0.95, clarity: 0.9, grammar: 0.95, originality: 0.8, usefulness: 0.85 },
    unsupported_statements: [],
    invented_quotes: [],
    issues: [],
    ...overrides,
  });
}

export async function pngBuffer(w = 1600, h = 900): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 60, b: 120 } } }).png().toBuffer();
}

export interface Harness {
  store: MemoryStore;
  wp: MockWordPress;
  ai: MockAiProvider;
  deps: PipelineDeps;
  ws: string;
}

export async function harness(opts: {
  research?: (prompt: string, call: number) => TextResult;
  complete?: (schemaName: string, prompt: string, call: number) => TextResult;
  image?: (call: number) => Promise<ImageResult> | ImageResult;
  settings?: Partial<import("@/lib/pipeline/types").WorkspaceSettings>;
  noWp?: boolean;
} = {}): Promise<Harness> {
  const store = new MemoryStore();
  store.now = () => NOW;
  const ws = "11111111-1111-1111-1111-111111111111";
  store.addWorkspace(ws, { settings: opts.settings, wp: opts.noWp ? null : undefined });
  const wp = new MockWordPress();
  const png = await pngBuffer();
  const citations = [ANN, CR, IGN].map((url) => ({ url, title: "t", snippet: "Crunchyroll announced the third season during a livestream on Sunday.", startIndex: null, endIndex: null }));
  const ai = new MockAiProvider({
    research: (req, call) => {
      if (opts.research) return opts.research(req.prompt, call);
      if (req.system.includes("fact-checker")) return mockText(factCheckJson(), { citations });
      if (req.prompt.includes("Category: Anime")) return mockText(discoveryJson(), { citations: citations.slice(0, 2) });
      return mockText(JSON.stringify({ candidates: [] }));
    },
    complete: (req, call) => {
      const name = req.jsonSchema?.name ?? "";
      if (opts.complete) return opts.complete(name, req.prompt, call);
      if (name === "article") return mockText(articleJson());
      if (name === "review") return mockText(reviewJson());
      if (name === "dedupe_verdict") return mockText(JSON.stringify({ verdict: "unrelated", confidence: 0.9, reason: "different" }));
      throw new Error(`unexpected schema ${name}`);
    },
    image: async (_req, call) => {
      if (opts.image) return opts.image(call);
      return { images: [{ mimeType: "image/png", data: png }], text: "", usage: { ...emptyUsage("google/gemini-3.1-flash-image"), images: 1, costUsd: 0.03 }, latencyMs: 5 };
    },
  });
  const deps: PipelineDeps = {
    store,
    ai,
    wordpress: async () => (opts.noWp ? null : wp),
    domains: createDomainRegistry(),
    fetchPage: async (url) => ({
      ok: !url.includes("fabricated"),
      status: url.includes("fabricated") ? 404 : 200,
      finalUrl: url,
      title: "Page",
      publishedAt: "2026-10-26T20:00:00Z",
    }),
    composeImage: composeThumbnail,
    now: () => NOW,
    models: { text: "google/gemini-3.7-flash", research: "google/gemini-3.7-flash", image: "google/gemini-3.1-flash-image" },
    siteName: "FlexPlaying",
  };
  return { store, wp, ai, deps, ws };
}

export async function runToEnd(h: Harness, runId: string, maxTicks = 12) {
  const { processRun } = await import("@/lib/pipeline/engine");
  for (let i = 0; i < maxTicks; i++) {
    const r = await processRun(h.deps, runId, { owner: `test-${i}`, budgetMs: 600_000 });
    const run = (await h.store.getRun(runId))!;
    if (run.status === "retry_scheduled") {
      // fast-forward time past the backoff
      run.next_attempt_at = null;
      await h.store.updateRun(runId, { next_attempt_at: null });
      continue;
    }
    if (r.status !== "retry_scheduled") return run;
  }
  return (await h.store.getRun(runId))!;
}

export async function newRun(h: Harness, mode: "dry_run" | "draft_only" | "auto_publish" = "draft_only") {
  return (await h.store.createRun({ workspace_id: h.ws, trigger: "manual", slot_key: null, scheduled_for: null, status: "queued", publishing_mode: mode, triggered_by: null }))!;
}
