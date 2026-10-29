import { submitFeedback } from "@/app/actions/feedback";
import { Flash } from "@/components/flash";
import { CategoryTag, Empty, ExternalLink, PageHeader, RunStatus, TextLink, categoryColor, statusLabel } from "@/components/ui";
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

  const scoreParts = [["recency", "Recency"], ["source_quality", "Sources"], ["relevance", "Relevance"], ["originality", "Originality"], ["corroboration", "Corroboration"]] as const;
  const tierColor = (t: string) => (t === "official" ? "var(--good)" : t === "established" ? "var(--ink-2)" : "var(--ink-3)");

  return (
    <>
      <PageHeader title="Research" description="Every story the desk found, how it scored, and why it was picked or passed over. Your verdicts tune future scoring on the Learning page." />
      <Flash searchParams={searchParams} />
      <form className="mb-6 flex flex-wrap items-center gap-2" action="/research" role="search">
        <input className="field !w-full sm:!w-72" name="q" placeholder="Search headlines" defaultValue={q} aria-label="Search headlines" />
        <select className="field !w-auto" name="category" defaultValue={cat} aria-label="Category">{["all", "anime", "gaming", "esports"].map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : c[0]!.toUpperCase() + c.slice(1)}</option>)}</select>
        <select className="field !w-auto" name="status" defaultValue={status} aria-label="Outcome">{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "All outcomes" : statusLabel(s)}</option>)}</select>
        <button className="rounded-lg border border-[var(--rule-strong)] bg-[var(--surface)] px-3.5 py-2 text-[14px] font-medium hover:bg-[var(--sunken)]">Apply filters</button>
      </form>
      {rows.length === 0 ? (
        <Empty title={q || cat !== "all" || status !== "all" ? "No stories match these filters" : "No stories yet"}>{q || cat !== "all" || status !== "all" ? "Clear a filter to see more." : "Stories appear after the first research stage runs."}</Empty>
      ) : (
        <ol className="space-y-3">
          {rows.map((c) => {
            const mine = c.topic_feedback.find((f) => f.user_id === user.id)?.verdict;
            const sc = c.scores ?? {};
            const srcs = c.candidate_sources.filter((x) => x.sources);
            return (
              <li key={c.id} className="panel overflow-hidden rounded-xl" style={{ boxShadow: `inset 3px 0 0 ${categoryColor(c.category)}` }}>
                <div className="grid gap-5 p-5 md:grid-cols-[88px_minmax(0,1fr)_220px]">
                  <div className="flex items-baseline gap-3 md:block">
                    <div className="figure text-[34px]" title="Overall score, 0 to 1">{c.overall_score === null ? "—" : Number(c.overall_score).toFixed(2)}</div>
                    <div className="text-[12px] text-ink-3 md:mt-1">overall score</div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><CategoryTag category={c.category} /><RunStatus status={c.status} /><span className="text-[12px] text-ink-3">Found {ago(c.created_at)}, newest source {ago(c.latest_source_at)}</span></div>
                    <h3 className="mt-1.5 text-[17px] font-semibold leading-snug text-ink">{c.headline}</h3>
                    <p className="mt-1 text-[14px] text-ink-2">{c.summary}</p>
                    {c.decision_reason && <p className="mt-3 text-[13px] text-ink-2"><span className="font-semibold text-ink">Decision.</span> {c.decision_reason}</p>}
                    {c.duplicate_of?.title && (
                      <p className="mt-1 text-[13px] text-ink-2"><span className="font-semibold text-ink">Already on your site.</span> {c.duplicate_of.link ? <ExternalLink href={c.duplicate_of.link}>{c.duplicate_of.title}</ExternalLink> : c.duplicate_of.title}{c.duplicate_of.score !== undefined && ` (similarity ${c.duplicate_of.score})`}</p>
                    )}
                    {srcs.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">{srcs.length} source{srcs.length > 1 ? "s" : ""}</summary>
                        <ul className="mt-2 space-y-1 text-[13px]">
                          {srcs.slice(0, 8).map((x) => (
                            <li key={x.sources!.url} className="flex min-w-0 items-baseline gap-2"><span className="w-[74px] shrink-0 text-[12px]" style={{ color: tierColor(x.sources!.quality_tier) }}>{x.sources!.quality_tier}</span><span className="truncate"><ExternalLink href={x.sources!.url}>{x.sources!.title ?? x.sources!.domain}</ExternalLink></span></li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <dl className="space-y-1.5 self-start text-[12px]">
                    {scoreParts.map(([k, label]) => {
                      const v = typeof sc[k] === "number" ? (sc[k] as number) : null;
                      return (
                        <div key={k} className="grid grid-cols-[84px_minmax(0,1fr)_32px] items-center gap-2">
                          <dt className="text-ink-3">{label}</dt>
                          <dd className="h-1.5 overflow-hidden rounded-full bg-[var(--sunken)]"><span className="block h-full rounded-full bg-[var(--ink-2)]" style={{ width: `${v === null ? 0 : Math.max(3, v * 100)}%` }} /></dd>
                          <dd className="text-right tabular-nums text-ink">{v === null ? "—" : v.toFixed(2)}</dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--rule)] bg-[var(--surface-2)] px-5 py-2.5">
                  <TextLink href={`/activity/${c.run_id}`} className="text-[13px]">Open run trace</TextLink>
                  {canEdit && (
                    <form action={submitFeedback} className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-[12px] text-ink-3">Your verdict</span>
                      <input type="hidden" name="workspace_id" value={ws} />
                      <input type="hidden" name="candidate_id" value={c.id} />
                      <input type="hidden" name="back" value={back} />
                      {VERDICTS.map((v) => (
                        <button key={v.v} name="verdict" value={v.v} aria-pressed={mine === v.v} className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${mine === v.v ? "bg-[var(--ink)] text-[var(--on-ink)]" : "border border-[var(--rule)] bg-[var(--surface)] text-ink-2 hover:text-ink"}`}>{v.label}</button>
                      ))}
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
