import { describe, expect, it } from "vitest";
import { AiError } from "@/lib/ai/types";
import { WpError } from "@/lib/wordpress/types";
import { mockText } from "@/lib/ai/mock";
import { ANN, CR, IGN, articleJson, discoveryJson, factCheckJson, harness, newRun, reviewJson, runToEnd } from "./helpers/fixtures";

describe("editorial pipeline (mock providers)", () => {
  it("draft-only: researches, fact-checks, writes, generates image and creates a verified WordPress draft", async () => {
    const h = await harness();
    const run = await newRun(h, "draft_only");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("drafted");
    expect(h.wp.posts).toHaveLength(1);
    const post = h.wp.posts[0]!;
    expect(post.status).toBe("draft");
    expect(post.featuredMedia).toBeGreaterThan(0);
    expect(post.categories).toEqual([11]);
    expect(post.content).toContain("editorialos:");
    // sanitisation: script removed, unverified link unwrapped, verified source link kept
    expect(post.content).not.toContain("<script");
    expect(post.content).not.toContain("evil.example");
    expect(post.content).toContain("crunchyroll.com");
    const article = h.store.articles[0]!;
    expect(article.status).toBe("drafted");
    expect(article.wp_post_id).toBe(post.id);
    expect(article.seo_sync.plugin).toBe("yoast");
    // fabricated source URL dropped
    expect(h.store.sources.some((s) => s.url.includes("fabricated"))).toBe(false);
    // usage recorded for every AI call, with provider-reported cost
    expect(h.store.usage.length).toBe(h.ai.calls.length);
    expect(h.store.usage.every((u) => u.cost_source === "provider_reported")).toBe(true);
    // stage logs present for every stage
    const stages = new Set(h.store.logs.map((l) => l.stage));
    for (const s of ["researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing"]) expect(stages.has(s)).toBe(true);
  });

  it("dry run never touches WordPress write endpoints", async () => {
    const h = await harness();
    const run = await newRun(h, "dry_run");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("dry_run_completed");
    expect(h.wp.posts).toHaveLength(0);
    expect(h.wp.calls.filter((c) => ["createPost", "updatePost", "uploadMedia", "ensureTag"].includes(c))).toHaveLength(0);
    expect(h.store.articles[0]!.status).toBe("dry_run");
  });

  it("auto-publish publishes only when every gate passes", async () => {
    const h = await harness({ settings: { publishing_mode: "auto_publish" } });
    const run = await newRun(h, "auto_publish");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("published");
    expect(h.wp.posts[0]!.status).toBe("publish");
  });

  it("auto-publish falls back to a review draft when the quality gate fails", async () => {
    const h = await harness({
      complete: (name) => {
        if (name === "article") return mockText(articleJson());
        if (name === "review") return mockText(reviewJson({ unsupported_statements: ["a", "b"], scores: { accuracy: 0.3, headline_accuracy: 0.9, clarity: 0.8, grammar: 0.9, originality: 0.5, usefulness: 0.5 } }));
        return mockText(JSON.stringify({ verdict: "unrelated", confidence: 0.9, reason: "" }));
      },
    });
    const run = await newRun(h, "auto_publish");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("needs_review");
    expect(h.wp.posts[0]!.status).toBe("draft");
    expect(h.store.articles[0]!.quality_report.pass).toBe(false);
  });

  it("rejects a duplicate of an existing WordPress post and skips publishing", async () => {
    const h = await harness();
    h.wp.seedPost({ title: "Frieren: Beyond Journey's End Season 3 Announced for 2027", excerpt: "Madhouse and Crunchyroll confirmed Frieren season 3." });
    const run = await newRun(h, "draft_only");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("duplicate");
    expect(h.store.candidates.some((c) => c.status === "duplicate" && c.duplicate_of)).toBe(true);
    expect(h.wp.posts).toHaveLength(1);
  });

  it("replaces a duplicate with the next-best candidate", async () => {
    const h = await harness({
      research: (prompt) => {
        if (prompt.includes("Category: Anime")) {
          const a = JSON.parse(discoveryJson());
          const b = JSON.parse(discoveryJson({ headline: "Chainsaw Man Assassin Arc Film Dated for Summer 2027", topic: "Chainsaw Man film", entities: ["Chainsaw Man", "MAPPA"], relevance: 0.7 }));
          return mockText(JSON.stringify({ candidates: [...a.candidates, ...b.candidates] }), {
            citations: [{ url: "https://www.animenewsnetwork.com/news/2026-10-26/frieren-season-3-announced/.1", title: null, snippet: null, startIndex: null, endIndex: null }],
          });
        }
        if (prompt.includes("Story (")) return mockText(factCheckJson(), { citations: [ANN, CR, IGN].map((url) => ({ url, title: null, snippet: null, startIndex: null, endIndex: null })) });
        return mockText(JSON.stringify({ candidates: [] }));
      },
    });
    h.wp.seedPost({ title: "Frieren: Beyond Journey's End Season 3 Announced for 2027" });
    const run = await newRun(h, "draft_only");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("drafted");
    const selected = h.store.candidates.find((c) => c.id === final.selected_candidate_id);
    expect(selected?.headline).toContain("Chainsaw Man");
  });

  it("handles one existing post matching several search terms (regression: duplicate upsert keys)", async () => {
    const h = await harness();
    // Matches both the "Frieren" and "Madhouse" searches, so it is returned more than once.
    h.wp.seedPost({ title: "Madhouse studio profile", excerpt: "A look at the studio behind Frieren and other series." });
    const final = await runToEnd(h, (await newRun(h)).id);
    expect(final.status).toBe("drafted");
    expect(h.store.wpPosts.filter((p) => p.id === h.wp.posts[0]!.id)).toHaveLength(1);
  });

  it("completes when the fact-check model names the claim field differently (regression)", async () => {
    const renamed = JSON.stringify({
      claims: (JSON.parse(factCheckJson()) as { claims: { text: string }[] }).claims.map(({ text, ...rest }) => ({ claim: text, ...rest })),
    });
    const h = await harness({
      research: (prompt) => {
        if (prompt.includes("Story (")) return mockText(renamed, { citations: [ANN, CR, IGN].map((url) => ({ url, title: null, snippet: null, startIndex: null, endIndex: null })) });
        if (prompt.includes("Category: Anime")) return mockText(discoveryJson(), { citations: [] });
        return mockText(JSON.stringify({ candidates: [] }));
      },
    });
    expect((await runToEnd(h, (await newRun(h)).id)).status).toBe("drafted");
  });

  it("skips publishing when no candidate meets the threshold", async () => {
    const h = await harness({ settings: { min_candidate_score: 0.99 } });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("skipped");
    expect(h.store.articles).toHaveLength(0);
  });

  it("enforces categories: out-of-scope stories are rejected", async () => {
    const h = await harness({
      research: (prompt) => (prompt.includes("Category: Anime") ? mockText(discoveryJson({ category: "politics" })) : mockText(JSON.stringify({ candidates: [] }))),
    });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("skipped");
    expect(h.store.candidates[0]!.status).toBe("rejected");
  });

  it("transient failures are retried and resume at the failed stage without repeating earlier stages", async () => {
    let fails = 1;
    const h = await harness({
      complete: (name) => {
        if (name === "article" && fails-- > 0) throw new AiError("server", "provider 503", 503);
        if (name === "article") return mockText(articleJson());
        if (name === "review") return mockText(reviewJson());
        return mockText(JSON.stringify({ verdict: "unrelated", confidence: 0.9, reason: "" }));
      },
    });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("drafted");
    expect(h.ai.calls.filter((c) => c.kind === "research").length).toBe(4); // 3 discovery + 1 fact-check, not repeated
    expect(h.store.logs.some((l) => l.level === "failed" && l.stage === "writing" && l.message.includes("retry"))).toBe(true);
    expect(h.store.usage.some((u) => !u.success)).toBe(true);
  });

  it("permanent errors fail the run without retry and raise a notification", async () => {
    const h = await harness({
      research: () => {
        throw new AiError("credits", "OpenRouter account is out of credits (402)", 402);
      },
    });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("failed");
    expect(final.error_code).toBe("ai_credits");
    expect(final.resume_stage).toBe("researching");
    expect(h.store.notifications).toHaveLength(1);
  });

  it("image failure after retries saves a draft without a broken image reference", async () => {
    const h = await harness({ image: () => { throw new AiError("server", "image backend down", 500); } });
    const run = await newRun(h, "auto_publish");
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("needs_review");
    expect(h.wp.posts[0]!.status).toBe("draft");
    expect(h.wp.posts[0]!.featuredMedia).toBe(0);
    expect(h.wp.media).toHaveLength(0);
    expect(h.store.images[0]!.status).toBe("failed");
  });

  it("image failure with policy=fail fails the run", async () => {
    const h = await harness({ settings: { image_failure_policy: "fail" }, image: () => { throw new AiError("bad_request", "unsupported", 400); } });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("failed");
    expect(h.wp.posts).toHaveLength(0);
  });

  it("reconciles a post whose create response was lost instead of creating a duplicate", async () => {
    const h = await harness();
    h.wp.failNext("createPost", new WpError("network", "socket hang up"), true);
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("drafted");
    expect(h.wp.posts).toHaveLength(1);
    expect(h.store.articles[0]!.wp_post_id).toBe(h.wp.posts[0]!.id);
    expect(h.store.wpSync.some((e) => e.action === "reconcile")).toBe(true);
  });

  it("reconciles a lost media upload response", async () => {
    const h = await harness();
    h.wp.failNext("uploadMedia", new WpError("server", "502"), true);
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("drafted");
    expect(h.wp.media).toHaveLength(1);
  });

  it("respects the daily article limit", async () => {
    const h = await harness({ settings: { daily_article_limit: 1 } });
    const r1 = await newRun(h);
    expect((await runToEnd(h, r1.id)).status).toBe("drafted");
    const r2 = await newRun(h);
    const final = await runToEnd(h, r2.id);
    expect(final.status).toBe("skipped");
    expect(final.outcome_reason).toContain("Daily article limit");
  });

  it("insufficient evidence rejects the candidate", async () => {
    const h = await harness({
      research: (prompt) => {
        if (prompt.includes("Category: Anime")) return mockText(discoveryJson(), { citations: [] });
        if (prompt.includes("Story (")) return mockText(JSON.stringify({ claims: [{ text: "A single unverified claim.", kind: "fact", importance: "high", source_urls: [], conflicting: false }] }));
        return mockText(JSON.stringify({ candidates: [] }));
      },
    });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(["skipped", "duplicate"]).toContain(final.status);
    expect(h.store.candidates.some((c) => c.status === "insufficient_evidence")).toBe(true);
    expect(h.wp.posts).toHaveLength(0);
  });

  it("a concurrent second process cannot claim a leased run", async () => {
    const h = await harness();
    const run = await newRun(h);
    expect(await h.store.claimRun(run.id, "a", 300)).toBe(true);
    expect(await h.store.claimRun(run.id, "b", 300)).toBe(false);
  });

  it("refuses non-Google models", async () => {
    const h = await harness({ settings: { text_model: "openai/gpt-x" } });
    const run = await newRun(h);
    const final = await runToEnd(h, run.id);
    expect(final.status).toBe("failed");
  });
});
