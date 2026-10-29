import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelRun, retryRun } from "@/app/actions/runs";
import { AutoRefresh } from "@/components/auto-refresh";
import { Flash } from "@/components/flash";
import { Rail } from "@/components/rail";
import { Button, Card, CategoryTag, Empty, ExternalLink, KeyValues, Notice, PageHeader, RunStatus, Score, Table, statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { duration, formatInZone } from "@/lib/dashboard/time";
import { ACTIVE_STATUSES, PIPELINE, railStates, stageDurations } from "@/lib/dashboard/stages";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const LEVEL_COLOR: Record<string, string> = { failed: "var(--bad)", warning: "var(--warn)", decision: "var(--live)", succeeded: "var(--ink)", info: "var(--rule-strong)", skipped: "var(--rule-strong)" };

function Detail({ detail }: { detail: Record<string, unknown> }) {
  const keys = Object.keys(detail ?? {});
  if (keys.length === 0) return null;
  const urls = [...new Set(JSON.stringify(detail).match(/https?:\/\/[^"\s\\]+/g) ?? [])];
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink-2">Details{urls.length ? `, ${urls.length} link${urls.length > 1 ? "s" : ""}` : ""}</summary>
      {urls.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px]">
          {urls.slice(0, 12).map((u) => <li key={u} className="truncate"><ExternalLink href={u}>{u}</ExternalLink></li>)}
        </ul>
      )}
      <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg bg-[var(--sunken)] p-3 font-mono text-[12px] leading-relaxed text-ink-2">{JSON.stringify(detail, null, 2)}</pre>
    </details>
  );
}

export default async function RunDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const { sb, membership } = await currentWorkspace();
  const { data: run } = await sb.from("runs").select("*").eq("id", id).eq("workspace_id", membership.workspace_id).maybeSingle();
  if (!run) notFound();
  const { data: settings } = await sb.from("workspace_settings").select("timezone").eq("workspace_id", run.workspace_id).single();
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const [logs, candidates, usage, articles] = await Promise.all([
    sb.from("run_stage_logs").select("*").eq("run_id", id).order("id"),
    sb.from("topic_candidates").select("id,headline,category,overall_score,status,decision_reason,rank,research_round").eq("run_id", id).order("research_round").order("rank"),
    sb.from("usage_events").select("action,model,cost_usd,cost_source,success,is_retry,input_tokens,output_tokens").eq("run_id", id),
    sb.from("articles").select("id,headline,status,wp_url,category").eq("run_id", id),
  ]);
  const active = ACTIVE_STATUSES.includes(run.status);
  const L = logs.data ?? [];
  const visible = L.filter((l) => l.level !== "started");
  // Group consecutive entries by stage so retries and candidate loops read as separate passes.
  const groups: { stage: string; items: typeof visible }[] = [];
  for (const l of visible) {
    const g = groups.at(-1);
    if (g && g.stage === l.stage) g.items.push(l);
    else groups.push({ stage: l.stage, items: [l] });
  }
  const u = usage.data ?? [];
  const cost = u.reduce((a, x) => a + (x.cost_usd === null ? 0 : Number(x.cost_usd)), 0);
  const unknownCost = u.filter((x) => x.cost_usd === null).length;
  const canEdit = membership.role !== "viewer";
  const stageName = (k: string) => PIPELINE.find((p) => p.key === k)?.label ?? statusLabel(k).replace(/^./, (c) => c.toUpperCase());

  return (
    <>
      <PageHeader
        kicker={<Link href="/activity" className="hover:text-ink">Runs</Link>}
        title={run.trigger === "schedule" ? `${run.slot_key?.slice(11)} scheduled run` : "Manual run"}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <RunStatus status={run.status} />
            <span>{statusLabel(run.publishing_mode)}</span>
            <span className="text-ink-3">Started {formatInZone(run.started_at, tz)}, took {duration(run.started_at, run.completed_at)}</span>
          </span>
        }
        actions={
          <>
            <AutoRefresh active={active} />
            {canEdit && run.status === "failed" && run.resume_stage && (
              <form action={retryRun}><input type="hidden" name="run_id" value={run.id} /><Button>Retry from {stageName(run.resume_stage).toLowerCase()}</Button></form>
            )}
            {canEdit && ["queued", "retry_scheduled"].includes(run.status) && (
              <form action={cancelRun}><input type="hidden" name="run_id" value={run.id} /><Button variant="danger">Cancel run</Button></form>
            )}
          </>
        }
      />
      <Flash searchParams={searchParams} />

      <Card className="mb-6">
        <Rail states={railStates(run, L)} durations={stageDurations(L)} />
        {(run.error_message || run.outcome_reason) && (
          <div className="mt-5">
            {run.error_message ? (
              <Notice tone="bad" title={`Stopped at ${stageName(run.resume_stage ?? "").toLowerCase() || "an unknown stage"}`}>
                <p>{run.error_message}</p>
                <p className="mt-1 text-[12px] text-ink-3">Error code {run.error_code}, attempt {run.stage_attempt}{run.next_attempt_at ? `. Next attempt ${formatInZone(run.next_attempt_at, tz)}` : ""}</p>
              </Notice>
            ) : (
              <Notice tone={run.status === "failed" ? "bad" : run.status === "needs_review" ? "warn" : "good"} title="Outcome">{run.outcome_reason}</Notice>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="Stage timeline" subtitle="What each stage recorded, in order. Stage start markers are hidden.">
          {groups.length === 0 ? <Empty title="Waiting for the first stage">The scheduler tick or the manual trigger starts this run shortly.</Empty> : (
            <ol className="space-y-5">
              {groups.map((g, gi) => (
                <li key={gi}>
                  <h3 className="mb-2 text-[13px] font-semibold text-ink">{stageName(g.stage)}</h3>
                  <ol className="space-y-2.5 border-l border-[var(--rule)] pl-4">
                    {g.items.map((l) => (
                      <li key={l.id} className="relative">
                        <span aria-hidden className="absolute -left-[21px] top-[7px] h-[9px] w-[9px] rounded-full border-2 border-[var(--surface)]" style={{ background: LEVEL_COLOR[l.level] ?? "var(--ink-3)" }} />
                        <div className={`text-[14px] leading-snug ${l.level === "failed" ? "text-[var(--bad)]" : "text-ink"}`}>{l.message}</div>
                        <div className="mt-0.5 text-[12px] text-ink-3">
                          {formatInZone(l.started_at, tz, false)}
                          {l.level !== "info" && <>, {l.level === "succeeded" ? "completed" : l.level}</>}
                          {l.attempt > 1 && <>, attempt {l.attempt}</>}
                          {l.duration_ms !== null && <>, {(l.duration_ms / 1000).toFixed(1)}s</>}
                        </div>
                        <Detail detail={l.detail} />
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Article">
            {(articles.data ?? []).length === 0 ? <p className="text-[14px] text-ink-3">This run didn&apos;t produce an article.</p> : (
              <ul className="space-y-3">
                {(articles.data ?? []).map((a) => (
                  <li key={a.id}>
                    <CategoryTag category={a.category} />
                    <Link href={`/articles/${a.id}`} className="mt-1 block text-[15px] font-semibold leading-snug text-ink hover:underline">{a.headline}</Link>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]"><RunStatus status={a.status} />{a.wp_url && <ExternalLink href={a.wp_url}>View on WordPress</ExternalLink>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Cost of this run">
            <div className="figure text-[32px]">{u.length ? formatUsd(cost) : "—"}</div>
            <div className="mt-4">
              <KeyValues rows={[["AI calls", u.length], ["Retries", u.filter((x) => x.is_retry).length], ["Failed calls", u.filter((x) => !x.success).length], ...(unknownCost ? [["Without reported cost", unknownCost] as [string, number]] : [])]} />
            </div>
          </Card>
        </div>
      </div>

      <Card title="Stories considered" className="mt-6" subtitle="Ranked by the scoring model, with the reason each was picked or passed over.">
        <Table head={["Rank", "Story", "Score", "Outcome", "Reason"]} empty={(candidates.data ?? []).length === 0} emptyText="Research hasn't returned any stories for this run.">
          {(candidates.data ?? []).map((c) => (
            <tr key={c.id}>
              <td className="text-[13px] tabular-nums text-ink-3">{c.research_round + 1}.{c.rank}</td>
              <td className="max-w-[320px]"><CategoryTag category={c.category} /><div className="mt-0.5 text-[14px] leading-snug">{c.headline}</div></td>
              <td><Score value={c.overall_score === null ? null : Number(c.overall_score)} /></td>
              <td><RunStatus status={c.status} /></td>
              <td className="max-w-[360px] text-[13px] text-ink-2">{c.decision_reason}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
