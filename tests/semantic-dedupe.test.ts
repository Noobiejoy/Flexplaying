import { describe, expect, it } from "vitest";
import { mockText } from "@/lib/ai/mock";
import { comparePost } from "@/lib/editorial/dedupe";
import { articleJson, harness, newRun, reviewJson, runToEnd } from "./helpers/fixtures";

const BORDERLINE = { title: "Madhouse confirms another Frieren anime season", excerpt: "The studio will return for more Frieren." };

function withVerdict(verdict: string, confidence = 0.9) {
  return (name: string) => {
    if (name === "dedupe_verdict") return mockText(JSON.stringify({ verdict, confidence, reason: "model comparison" }));
    if (name === "article") return mockText(articleJson());
    return mockText(reviewJson());
  };
}

describe("semantic duplicate checks for borderline matches", () => {
  it("fixture is genuinely borderline for the deterministic matcher", () => {
    const m = comparePost(
      { headline: "Frieren: Beyond Journey's End Season 3 Announced for 2027", topic: "Frieren season 3 announcement", entities: ["Frieren", "Madhouse", "Crunchyroll"], sourceUrls: [] },
      { id: 1, slug: "madhouse-confirms-another-frieren-anime-season", link: "", status: "publish", origin: "wordpress", ...BORDERLINE },
    );
    expect(m.verdict).toBe("borderline");
  });

  it("same_story verdict rejects the candidate as a duplicate", async () => {
    const h = await harness({ complete: withVerdict("same_story") });
    h.wp.seedPost(BORDERLINE);
    const final = await runToEnd(h, (await newRun(h)).id);
    expect(final.status).toBe("duplicate");
    expect(h.store.candidates[0]!.duplicate_of).toMatchObject({ method: "semantic", verdict: "same_story" });
  });

  it("new_development verdict allows a follow-up article", async () => {
    const h = await harness({ complete: withVerdict("new_development") });
    h.wp.seedPost(BORDERLINE);
    expect((await runToEnd(h, (await newRun(h)).id)).status).toBe("drafted");
  });

  it("uncertain verdict holds the candidate for review instead of publishing a near-duplicate", async () => {
    const h = await harness({ complete: withVerdict("uncertain", 0.4) });
    h.wp.seedPost(BORDERLINE);
    const final = await runToEnd(h, (await newRun(h)).id);
    expect(final.status).toBe("skipped");
    expect(h.store.candidates[0]!.status).toBe("needs_review");
    expect(h.wp.posts).toHaveLength(1);
  });
});
