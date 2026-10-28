import { describe, expect, it } from "vitest";
import { unverifiedQuotes } from "@/lib/pipeline/stages/quality";
import { reviewPrompt } from "@/lib/pipeline/prompts";
import type { ClaimRecord } from "@/lib/pipeline/types";

const claim = (text: string, kind: ClaimRecord["kind"], status: ClaimRecord["status"]): ClaimRecord => ({ id: text.slice(0, 8), text, kind, importance: "normal", status, notes: null, sources: [] });

describe("quote verification", () => {
  const claims = [
    claim("Art director Shinji Kimura illustrated the teaser visual, which features the tagline 'The era of humans is over.'", "fact", "single_source"),
    claim("Masaya Fukunishi stated: 'After the broadcasts of Seasons 1 and 2, we have been able to enjoy the anime together with everyone.'", "quote", "confirmed"),
    claim("The studio said \"we will never make a sequel ever\" at launch.", "fact", "unverified"),
  ];
  it("accepts a quoted tagline that appears inside a usable fact claim", () => {
    expect(unverifiedQuotes('The visual carries the tagline "The era of humans is over." in bold.', claims)).toEqual([]);
  });
  it("accepts a recorded quote even when split or re-punctuated", () => {
    expect(unverifiedQuotes('He said "After the broadcasts of Seasons 1 and 2, we have been able to enjoy the anime together with everyone," and added more.', claims)).toEqual([]);
  });
  it("still flags invented quotes and quotes found only in unverified claims", () => {
    expect(unverifiedQuotes('The director promised "this is the best film we have ever made" to fans.', claims)).toHaveLength(1);
    expect(unverifiedQuotes('The studio said "we will never make a sequel ever" at launch.', claims)).toHaveLength(1);
  });
  it("ignores short quoted terms", () => {
    expect(unverifiedQuotes('The "Final Mission" film arrives in 2027.', claims)).toEqual([]);
  });
});

describe("review prompt", () => {
  it("lists researched sources so attribution is not flagged as unsupported", () => {
    const p = reviewPrompt({ headline: "h", bodyText: "b" }, [{ text: "t", kind: "fact", status: "confirmed" }], [{ title: "Anime News Network", domain: "animenewsnetwork.com", url: "https://www.animenewsnetwork.com/x" }]);
    expect(p.prompt).toContain("https://www.animenewsnetwork.com/x");
    expect(p.prompt).toMatch(/attribution to or links to the researched sources/);
  });
});
