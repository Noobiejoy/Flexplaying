import Link from "next/link";
import { submitFeedback } from "@/app/actions/feedback";
import { Flash } from "@/components/flash";
import { Badge, Card, Empty, ExternalLink, PageHeader, RunStatus, Score } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { ago } from "@/lib/dashboard/time";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "selected", "published", "drafted", "ranked", "below_threshold", "duplicate", "needs_review", "insufficient_evidence", "rejected"];
const VERDICTS = [
  { v: "interesting", label: "Interesting" },
  { v: "irrelevant", label: "Irrelevant" },
  { v: "already_covered", label: "Already covered" },
  { v: "needs_research", label: "Needs research" },
] as const;

type Cand = {
  id: string; headline: string; topic: string; category: string; summary: string; status: string; decision_reason: string | null;
  overall_score: number | null; scores: Record<string, number | string[]>; latest_source_at: string | null; created_at: string; run_id: string;
  duplicate_of: { title?: string; link?: string; score?: number } | null; entities: string[];
  candidate_sources: { origin: string; sources: { url: string; title: string | null; domain: string; quality_tier: string } | null }[];
  topic_feedback: { verdict: string; user_id: string }[];
};

export default async function Research({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { sb, membership, user } = await currentWorkspace();
  const ws = membership.workspace_id;
  const cat = ["anime", "gaming", "esports"].includes(sp.category ?? "") ? sp.category! : "all";
  const status = STATUSES.includes(sp.status ?? "") ? sp.status! : "all";
  const q = (sp.q ?? "").trim().slice(0, 80);

  let query = sb
    .from("topic_candidates")
    .select("id,headline,topic,category,summary,status,decision_reason,overall_score,scores,latest_source_at,created_at,run_id,duplicate_of,entities, candidate_sources(origin, sources(url,title,domain,quality_tier)), topic_feedback(verdict,user_id)")
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(60);
  if (cat !== "all") query = query.eq("category", cat);
  if (status !== "all") query = query.eq("status", status);
  if (q) query = query.ilike("headline", `%${q.replace(/[%_]/g, "")}%`);
  const { data } = await query;
  const rows = (data ?? []) as unknown as Cand[];
  const back = `/research?category=${cat}&status=${status}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const canEdit = membership.role !== "viewer";

  return (
    <>
      <PageHeader title="Research & topic intelligence" description="Every story the agent discovered, how it scored, and why it was selected or rejected. Your feedback adjusts future scoring (see Learning)." />
      <Flash searchParams={searchParams} />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/research">
        <input className="field !w-64" name="q" placeholder="Search headlines" defaultValue={q} />
        <select className="field !w-auto" name="category" defaultValue={cat}>{["all", "anime", "gaming", "esports"].map((c) => <option key={c}>{c}</option>)}</select>
        <select className="field !w-auto" name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
        <button className="glass-strong rounded-full px-3.5 py-1.5 text-sm">Filter</button>
      </form>
      {rows.length === 0 ? (
        <Card><Empty title="No topics yet">Topics appear after the first research stage runs.</Empty></Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {rows.map((c) => {
            const mine = c.topic_feedback.find((f) => f.user_id === user.id)?.verdict;
            const s = c.scores ?? {};
            return (
              <Card key={c.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5"><Badge>{c.category}</Badge><RunStatus status={c.status} /><span className="text-[11px] text-ink-3">found {ago(c.created_at)} · newest source {ago(c.latest_source_at)}</span></div>
                    <h3 className="text-[15px] font-semibold leading-snug">{c.headline}</h3>
                    <p className="mt-1 text-sm text-ink-2">{c.summary}</p>
                  </div>
                  <Score value={c.overall_score === null ? null : Number(c.overall_score)} />
                </div>
                <div className="mt-3 grid grid-cols-5 gap-1.5 text-center text-[10px] text-ink-3">
                  {(["recency", "source_quality", "relevance", "originality", "corroboration"] as const).map((k) => (
                    <div key={k} className="rounded-lg bg-[var(--hairline)] px-1 py-1.5"><div className="text-[13px] font-semibold tabular-nums text-ink">{typeof s[k] === "number" ? (s[k] as number).toFixed(2) : "—"}</div>{k.replace("_", " ")}</div>
                  ))}
                </div>
                {c.decision_reason && <p className="mt-3 text-xs text-ink-2"><span className="font-medium text-ink">Decision:</span> {c.decision_reason}</p>}
                {c.duplicate_of?.title && (
                  <p className="mt-1 text-xs text-ink-2"><span className="font-medium text-ink">Matched existing:</span> {c.duplicate_of.link ? <ExternalLink href={c.duplicate_of.link}>{c.duplicate_of.title}</ExternalLink> : c.duplicate_of.title} {c.duplicate_of.score !== undefined && `(similarity ${c.duplicate_of.score})`}</p>
                )}
                {c.candidate_sources.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {c.candidate_sources.filter((x) => x.sources).slice(0, 6).map((x) => (
                      <li key={x.sources!.url} className="flex items-center gap-1.5 truncate"><Badge tone={x.sources!.quality_tier === "official" ? "good" : x.sources!.quality_tier === "established" ? "info" : "neutral"}>{x.sources!.quality_tier}</Badge><ExternalLink href={x.sources!.url}>{x.sources!.title ?? x.sources!.domain}</ExternalLink></li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/activity/${c.run_id}`} className="text-[11px] text-[var(--accent)]">Run trace →</Link>
                  {canEdit && (
                    <form action={submitFeedback} className="flex flex-wrap gap-1">
                      <input type="hidden" name="workspace_id" value={ws} />
                      <input type="hidden" name="candidate_id" value={c.id} />
                      <input type="hidden" name="back" value={back} />
                      {VERDICTS.map((v) => (
                        <button key={v.v} name="verdict" value={v.v} className={`rounded-full px-2.5 py-1 text-[11px] ${mine === v.v ? "bg-[var(--accent)] text-white" : "bg-[var(--hairline)] text-ink-2 hover:text-ink"}`}>{v.label}</button>
                      ))}
                    </form>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
