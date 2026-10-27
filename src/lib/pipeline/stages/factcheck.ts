import { extractJson } from "@/lib/ai/json";
import { assessEvidence, claimStatus } from "@/lib/editorial/evidence";
import { canonicalUrl } from "@/lib/editorial/text";
import type { StageContext, StageResult } from "../context";
import { StageError } from "../context";
import { factCheckPrompt, factCheckSchema } from "../prompts";
import type { ClaimInputRecord, SourceRecord } from "../types";
import type { SourceTier } from "@/lib/editorial/domains";
import { verifySources } from "./research";

export async function factCheckStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  if (!run.selected_candidate_id) throw new StageError("no_candidate", "No selected candidate to fact-check", false);
  const cand = await deps.store.getCandidate(run.selected_candidate_id);
  if (!cand) throw new StageError("no_candidate", "Selected candidate not found", false);
  await sc.ensureModel(sc.models.research, "text");

  const known = await deps.store.getCandidateSources(cand.id);
  const p = factCheckPrompt({ headline: cand.headline, summary: cand.summary, category: cand.category, sourceUrls: known.map((s) => s.url) }, deps.now().toISOString());
  const res = await sc.tracked("fact_check", sc.models.research, null, () => deps.ai.research({ model: sc.models.research, system: p.system, prompt: p.prompt }));
  const out = extractJson(res.text, factCheckSchema);

  // Resolve every URL the claims cite: previously verified sources, search citations, or a live page check.
  const citations = new Map(res.citations.map((c) => [canonicalUrl(c.url), c]));
  const knownByKey = new Map(known.map((s) => [canonicalUrl(s.url), s]));
  const toVerify = new Map<string, { url: string }>();
  for (const c of out.claims) for (const u of c.source_urls) if (!knownByKey.has(canonicalUrl(u))) toVerify.set(canonicalUrl(u), { url: u });
  const { verified, dropped } = await verifySources(sc, [...toVerify.values()], citations, { remaining: 12 });
  const saved = verified.length ? await deps.store.upsertSources(ws.workspaceId, verified.map(({ origin: _o, requested: _r, ...rest }) => rest)) : [];
  if (saved.length) await deps.store.linkCandidateSources(cand.id, ws.workspaceId, saved.map((s) => s.id), "fact_check");
  const resolved = new Map<string, SourceRecord>(known.map((s) => [canonicalUrl(s.url), s]));
  verified.forEach((v, i) => {
    resolved.set(canonicalUrl(v.url), saved[i]!);
    resolved.set(canonicalUrl(v.requested), saved[i]!);
  });

  const claims: (ClaimInputRecord & { sources: { url: string; tier: SourceTier }[]; conflicting: boolean })[] = out.claims.map((c) => {
    const srcs = [...new Set(c.source_urls.map(canonicalUrl))].map((k) => resolved.get(k)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const input = { text: c.text, kind: c.kind, importance: c.importance, sources: srcs.map((s) => ({ url: s.url, tier: s.quality_tier })), conflicting: c.conflicting };
    return { ...input, status: claimStatus(input), notes: c.notes ?? null, sourceIds: srcs.map((s) => s.id) };
  });
  await deps.store.replaceClaims(ws.workspaceId, cand.id, claims.map(({ sources: _s, conflicting: _c, ...rest }) => rest));
  const assessment = assessEvidence(claims);

  const detail = {
    claims: claims.map((c) => ({ text: c.text, kind: c.kind, importance: c.importance, status: c.status, sources: c.sources.map((s) => s.url) })),
    open_questions: out.open_questions,
    dropped_urls: dropped,
    assessment: { ...assessment, usableClaims: undefined, hedgedClaims: undefined, excludedClaims: undefined },
  };
  if (!assessment.pass) {
    await deps.store.updateCandidate(cand.id, { status: "insufficient_evidence", decision_reason: `Evidence insufficient: ${assessment.issues.join("; ")}` });
    await sc.log("decision", `Rejected "${cand.headline}": evidence insufficient`, detail);
    return {
      next: "deduplicating",
      patch: { selected_candidate_id: null },
      message: `Evidence insufficient for "${cand.headline}" (${assessment.issues.join("; ")}); trying the next candidate`,
    };
  }
  await sc.log("decision", `Evidence accepted: ${assessment.confirmedFacts} confirmed fact(s), ${assessment.highConfirmed}/${assessment.highImportance} key facts confirmed`, detail);
  return { next: "writing", message: `Fact-check passed with ${claims.length} claim(s) recorded` };
}
