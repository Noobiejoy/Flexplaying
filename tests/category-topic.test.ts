import { describe, expect, it } from "vitest";
import { mockText } from "@/lib/ai/mock";
import { comparePost } from "@/lib/editorial/dedupe";
import { discoveryPrompt, topicPrompt } from "@/lib/pipeline/prompts";
import { effortLimits, searchPlan } from "@/lib/pipeline/stages/effort";
import { baseSlotKey, runLabel, slotTargets, targetSlotKey } from "@/lib/pipeline/targets";
import { runTick } from "@/lib/scheduler/tick";
import { ANN, CR, IGN, discoveryJson, factCheckJson, harness, runToEnd, NOW } from "./helpers/fixtures";

const citations = [ANN, CR, IGN].map((url) => ({ url, title: "t", snippet: "Crunchyroll announced the third season.", startIndex: null, endIndex: null }));

function categoryRun(h: Awaited<ReturnType<typeof harness>>, category: "anime" | "gaming" | "esports", topicId: string | null = null) {
  return h.store.createRun({ workspace_id: h.ws, trigger: "manual", slot_key: null, scheduled_for: null, status: "queued", publishing_mode: "draft_only", triggered_by: null, category, topic_id: topicId }).then((r) => r!);
}

describe("run targets", () => {
  it("builds per-target slot keys and labels", () => {
    expect(targetSlotKey("2026-11-26T12:00", { kind: "category", category: "gaming" })).toBe("2026-11-26T12:00#gaming");
    expect(baseSlotKey("2026-11-26T12:00#topic:abc")).toBe("2026-11-26T12:00");
    expect(runLabel({ category: "esports", topic_id: null })).toBe("Esports");
    expect(runLabel({ category: "anime", topic_id: "x" }, "JJK Season 3")).toBe("Topic: JJK Season 3");
    expect(runLabel({ category: null, topic_id: null })).toBe("All categories");
  });
  it("lists enabled categories, then shared-slot topics that are still running", () => {
    const ws = {
      categories: ["esports", "anime"] as ("anime" | "esports")[],
      topics: [
        { id: "a", category: "anime" as const, local_time: null, end_date: "2026-11-30", created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
        { id: "b", category: "gaming" as const, local_time: "18:00", end_date: "2026-11-30", created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
        { id: "c", category: "gaming" as const, local_time: null, end_date: "2026-11-25", created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
      ],
    };
    expect(slotTargets(ws, "2026-11-26").map((t) => (t.kind === "topic" ? t.topicId : t.category))).toEqual(["anime", "esports", "a"]);
    expect(slotTargets(ws, "2026-11-25").map((t) => (t.kind === "topic" ? t.topicId : t.category))).toEqual(["anime", "esports", "a", "c"]);
  });
});

describe("trying harder", () => {
  it("each effort level adds rounds and candidates; legacy runs keep the settings", () => {
    const s = { max_research_rounds: 2, max_candidates_per_run: 5 };
    expect(effortLimits(s, { category: null, topic_id: null, escalation: 0 })).toEqual({ rounds: 2, candidates: 5 });
    expect(effortLimits(s, { category: "anime", topic_id: null, escalation: 1 })).toEqual({ rounds: 4, candidates: 10 });
    expect(effortLimits(s, { category: "anime", topic_id: null, escalation: 2 })).toEqual({ rounds: 6, candidates: 14 });
    expect(searchPlan({ topic_id: null, escalation: 1 }).windowDays).toBe(7);
    expect(searchPlan({ topic_id: null, escalation: 2 }).mode).toBe("feature");
  });

  it("discovery prompts widen the window and switch to features", () => {
    expect(discoveryPrompt("gaming", NOW.toISOString(), []).prompt).toMatch(/last 48 hours/);
    expect(discoveryPrompt("gaming", NOW.toISOString(), [], { windowDays: 7 }).prompt).toMatch(/last 7 days/);
    expect(discoveryPrompt("gaming", NOW.toISOString(), [], { mode: "feature" }).prompt).toMatch(/FEATURE articles/);
  });

  it("a category with no fresh news falls back to a sourced feature and still produces an article", async () => {
    const h = await harness({
      research: (prompt) => {
        if (prompt.includes("Category: Gaming") && prompt.includes("FEATURE")) {
          return mockText(discoveryJson({ category: "gaming", headline: "Everything We Know About Frieren's Upcoming Game Adaptation", suggested_format: "explainer" }), { citations: citations.slice(0, 2) });
        }
        if (prompt.includes("Category: Gaming")) return mockText(JSON.stringify({ candidates: [] }));
        return mockText(factCheckJson(), { citations });
      },
    });
    const run = await categoryRun(h, "gaming");
    const final = await runToEnd(h, run.id, 30);
    expect(final.escalation).toBe(2);
    expect(final.status).toBe("drafted");
    expect(h.store.articles[0]!.category).toBe("gaming");
    expect(h.store.logs.some((l) => l.message.includes("Trying harder"))).toBe(true);
  });

  it("a category run rejects stories research filed under another category", async () => {
    const h = await harness();
    const run = await categoryRun(h, "esports");
    // The default mock only returns the anime story; an esports run must not write it.
    const final = await runToEnd(h, run.id, 30);
    expect(final.status).toBe("skipped");
    expect(h.store.articles).toHaveLength(0);
  });
});

describe("editorial topics", () => {
  const topicCandidate = () =>
    discoveryJson({ headline: "Frieren Season 3 Voice Cast and Staff Guide", topic: "Frieren season 3: cast and staff" });

  function topicHarness() {
    return harness({
      research: (prompt) => {
        if (prompt.includes("TOPIC:")) return mockText(topicCandidate(), { citations: citations.slice(0, 2) });
        if (prompt.includes("Category: Anime")) return mockText(discoveryJson(), { citations: citations.slice(0, 2) });
        if (prompt.includes("Category:")) return mockText(JSON.stringify({ candidates: [] }));
        return mockText(factCheckJson(), { citations });
      },
    });
  }

  it("writes the day's article for a topic, filed under its category and linked to the topic", async () => {
    const h = await topicHarness();
    const topic = h.store.addTopic(h.ws, { title: "Frieren Season 3", category: "anime", end_date: "2026-11-30", notes: "Focus on the anime, not the manga" });
    const run = await categoryRun(h, "anime", topic.id);
    const final = await runToEnd(h, run.id, 30);
    expect(final.status).toBe("drafted");
    const a = h.store.articles[0]!;
    expect(a.topic_id).toBe(topic.id);
    expect(a.category).toBe("anime");
    const p = h.ai.calls.find((c) => c.prompt.includes("TOPIC:"))!.prompt;
    expect(p).toContain("Frieren Season 3");
    expect(p).toContain("Focus on the anime, not the manga");
    expect(p).toContain("This is the first article in the series");
  });

  it("allows only one article per topic per day", async () => {
    const h = await topicHarness();
    const topic = h.store.addTopic(h.ws, { title: "Frieren Season 3", category: "anime", end_date: "2026-11-30" });
    await runToEnd(h, (await categoryRun(h, "anime", topic.id)).id, 30);
    const second = await runToEnd(h, (await categoryRun(h, "anime", topic.id)).id, 30);
    expect(second.status).toBe("skipped");
    expect(second.outcome_reason).toMatch(/already has today's article/);
  });

  it("skips a topic that has ended or is paused", async () => {
    const h = await topicHarness();
    const ended = h.store.addTopic(h.ws, { title: "Old topic", category: "anime", end_date: "2026-10-26" });
    expect((await runToEnd(h, (await categoryRun(h, "anime", ended.id)).id)).outcome_reason).toMatch(/ended on 2026-10-26/);
    const paused = h.store.addTopic(h.ws, { title: "Paused topic", category: "anime", end_date: "2026-11-30", enabled: false });
    expect((await runToEnd(h, (await categoryRun(h, "anime", paused.id)).id)).outcome_reason).toMatch(/paused/);
  });

  it("the tick adds topic runs after the category runs, and own-time topics get their own slot", async () => {
    const h = await topicHarness();
    h.store.settings.get(h.ws)!.automation_changed_at = "2026-10-27T00:00:00Z";
    h.store.settings.get(h.ws)!.enabled_categories = ["anime"];
    h.store.now = () => new Date("2026-10-26T00:00:00Z");
    const shared = h.store.addTopic(h.ws, { title: "Frieren Season 3", category: "anime", end_date: "2026-11-30" });
    const own = h.store.addTopic(h.ws, { title: "Worlds 2026", category: "esports", end_date: "2026-11-30", local_time: "09:00" });
    h.store.addTopic(h.ws, { title: "Over", category: "gaming", end_date: "2026-10-26" });
    h.store.now = () => NOW;
    const t = await runTick(h.deps, { owner: "t", budgetMs: 1 });
    expect(t.created).toBe(3);
    const keys = h.store.runs.map((r) => r.slot_key);
    expect(keys).toEqual(["2026-10-27T09:00#anime", `2026-10-27T09:00#topic:${shared.id}`, `2026-10-27T09:00#topic:${own.id}`]);
    expect(h.store.runs[2]!.category).toBe("esports");
  });

  it("the next day's research lists the angles already covered", () => {
    const p = topicPrompt({ title: "JJK Season 3", category: "anime", notes: "", endDate: "2026-12-01" }, NOW.toISOString(), ["JJK Season 3 Release Date Confirmed"], []).prompt;
    expect(p).toContain("do NOT repeat their angle");
    expect(p).toContain("JJK Season 3 Release Date Confirmed");
  });

  it("series dedupe ignores shared official sources and only auto-rejects near-identical parts", () => {
    const post = { id: 1, title: "Frieren Season 3 Confirmed for 2027", slug: "frieren-season-3-confirmed-2027", link: "", status: "publish", excerpt: "Frieren Madhouse Crunchyroll", content: `<a href="${CR}">x</a>`, origin: "wordpress" as const };
    const c = { headline: "Frieren Season 3 Voice Cast and Staff Guide", topic: "cast", entities: ["Frieren", "Madhouse"], sourceUrls: [CR] };
    expect(comparePost(c, post).verdict).toBe("duplicate");
    expect(comparePost(c, post, { ignoreSourceUrl: true, duplicateAt: 0.9 }).verdict).toBe("borderline");
  });
});
