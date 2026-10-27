import { domainOf, isCorroborationEligible, type SourceTier } from "./domains";

export type ClaimKind = "fact" | "rumor" | "prediction" | "opinion" | "quote";
export type ClaimStatus = "confirmed" | "primary_confirmed" | "single_source" | "conflicting" | "unverified";

export interface ClaimInput {
  text: string;
  kind: ClaimKind;
  importance: "high" | "normal";
  sources: { url: string; tier: SourceTier }[];
  conflicting: boolean;
}

export function claimStatus(c: ClaimInput): ClaimStatus {
  if (c.conflicting) return "conflicting";
  const eligible = c.sources.filter((s) => isCorroborationEligible(s.tier, s.url));
  if (eligible.some((s) => s.tier === "official")) return "primary_confirmed";
  const domains = new Set(eligible.map((s) => domainOf(s.url)));
  if (domains.size >= 2) return "confirmed";
  if (domains.size === 1) return "single_source";
  return "unverified";
}

export interface EvidenceAssessment {
  pass: boolean;
  confirmedFacts: number;
  highImportance: number;
  highConfirmed: number;
  issues: string[];
  /** Claims the writer may state as fact. */
  usableClaims: number[];
  /** Claims the writer must attribute or label as unconfirmed. */
  hedgedClaims: number[];
  /** Claims that must not appear. */
  excludedClaims: number[];
}

const isConfirmed = (s: ClaimStatus) => s === "confirmed" || s === "primary_confirmed";

/**
 * Evidence policy: important facts need two independent reliable sources or an
 * official primary source. Single-source facts may be used only with explicit
 * attribution. Unverified claims are excluded. More than one conflicting
 * high-importance claim rejects the story.
 */
export function assessEvidence(claims: (ClaimInput & { status: ClaimStatus })[]): EvidenceAssessment {
  const issues: string[] = [];
  const usable: number[] = [];
  const hedged: number[] = [];
  const excluded: number[] = [];
  let confirmedFacts = 0;
  let high = 0;
  let highConfirmed = 0;
  let highConflicting = 0;

  claims.forEach((c, i) => {
    if (c.importance === "high" && (c.kind === "fact" || c.kind === "quote")) {
      high++;
      if (isConfirmed(c.status)) highConfirmed++;
      if (c.status === "conflicting") highConflicting++;
    }
    if (c.kind === "fact" || c.kind === "quote") {
      if (isConfirmed(c.status)) {
        confirmedFacts++;
        usable.push(i);
      } else if (c.status === "single_source" || c.status === "conflicting") {
        hedged.push(i);
      } else {
        excluded.push(i);
      }
    } else if (c.sources.length > 0) {
      hedged.push(i); // rumors/predictions/opinions only ever appear attributed and labelled
    } else {
      excluded.push(i);
    }
  });

  if (confirmedFacts < 2) issues.push(`Only ${confirmedFacts} independently confirmed fact(s); at least 2 required`);
  if (high === 0) issues.push("Fact-check returned no high-importance factual claims");
  if (high > 0 && highConfirmed / high < 0.75) {
    issues.push(`${highConfirmed}/${high} high-importance facts confirmed; at least 75% required`);
  }
  if (highConflicting > 1) issues.push(`${highConflicting} high-importance claims have conflicting reports`);
  return {
    pass: issues.length === 0,
    confirmedFacts,
    highImportance: high,
    highConfirmed,
    issues,
    usableClaims: usable,
    hedgedClaims: hedged,
    excludedClaims: excluded,
  };
}
