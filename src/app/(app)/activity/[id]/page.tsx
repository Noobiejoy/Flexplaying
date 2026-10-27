import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelRun, retryRun } from "@/app/actions/runs";
import { AutoRefresh } from "@/components/auto-refresh";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Empty, ExternalLink, PageHeader, RunStatus, Score, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { duration, formatInZone } from "@/lib/dashboard/time";
import { ACTIVE_STATUSES, PIPELINE } from "@/lib/dashboard/stages";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function Detail({ detail }: { detail: Record<string, unknown> }) {
  const keys = Object.keys(detail ?? {});
  if (keys.length === 0) return null;
  const urls = JSON.stringify(detail).match(/https?:\/\/[^"\s\\]+/g) ?? [];
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-ink-3">Details{urls.length ? ` · ${new Set(urls).size} link(s)` : ""}</summary>
      {urls.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px]">
          {[...new Set(urls)].slice(0, 12).map((u) => <li key={u} className="truncate"><ExternalLink href={u}>{u}</ExternalLink></li>)}
        </ul>
      )}
      <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-[var(--hairline)] p-2 text-[11px] leading-relaxed text-ink-2">{JSON.stringify(detail, null, 2)}</pre>
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
    sb.from("articles").select("id,headline,status,wp_url").eq("run_id", id),
  ]);
  const active = ACTIVE_STATUSES.includes(run.status);
  const L = logs.data ?? [];
  const stageState = (key: string) => {
    const s = L.filter((l) => l.stage === key);
    if (s.length === 0) return "pending";
    if (run.status === key || (run.status === "retry_scheduled" && run.resume_stage === key)) return "current";
    if (s.some((l) => l.level === "succeeded")) return s.at(-1)?.level === "failed" ? "failed" : "done";
    if (s.some((l) => l.level === "failed")) return "failed";
    return "current";
  };
  const u = usage.data ?? [];
  const cost = u.reduce((a, x) => a + (x.cost_usd === null ? 0 : Number(x.cost_usd)), 0);
  const unknownCost = u.filter((x) => x.cost_usd === null).length;
  const canEdit = membership.role !== "viewer";

  return (
    <>
      <PageHeader
        title={run.trigger === "schedule" ? `Scheduled run ${run.slot_key}` : "Manual run"}
        description={<span className="inline-flex flex-wrap items-center gap-2"><RunStatus status={run.status} /> <Badge>{run.publishing_mode.replace("_", " ")}</Badge> <span>Started {formatInZone(run.started_at, tz)} · {duration(run.started_at, run.completed_at)}</span></span>}
        actions={
          <>
            <AutoRefresh active={active} />
            {canEdit && run.status === "failed" && run.resume_stage && (
              <form action={retryRun}><input type="hidden" name="run_id" value={run.id} /><Button>Retry from {run.resume_stage.replace("_", " ")}</Button></form>
            )}
            {canEdit && ["queued", "retry_scheduled"].includes(run.status) && (
              <form action={cancelRun}><input type="hidden" name="run_id" value={run.id} /><Button variant="danger">Cancel</Button></form>
            )}
          </>
        }
      />
      <Flash searchParams={searchParams} />
      {run.error_message && <div className="mb-4"><Card title="Error"><p className="text-sm text-[var(--bad)]">{run.error_message}</p><p className="mt-1 text-xs text-ink-3">Code {run.error_code} · stage {run.resume_stage} · attempt {run.stage_attempt}{run.next_attempt_at ? ` · next attempt ${formatInZone(run.next_attempt_at, tz)}` : ""}</p></Card></div>}
      {run.outcome_reason && !run.error_message && <div className="mb-4"><Card title="Outcome"><p className="text-sm text-ink-2">{run.outcome_reason}</p></Card></div>}

      <Card title="Pipeline" className="mb-4">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {PIPELINE.map((p) => {
            const st = stageState(p.key);
            const cls = st === "done" ? "bg-[var(--good-bg)] text-[var(--good)]" : st === "current" ? "bg-[var(--info-bg)] text-[var(--accent)]" : st === "failed" ? "bg-[var(--bad-bg)] text-[var(--bad)]" : "bg-[var(--hairline)] text-ink-3";
            return (
              <li key={p.key} className={`rounded-xl px-3 py-2 text-xs ${cls}`}>
                <div className="font-medium">{p.label}</div>
                <div className="text-[10px] opacity-80">{st}</div>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Stage timeline" subtitle="Structured operational trace recorded by each stage">
          {L.length === 0 ? <Empty title="Waiting for the first stage">The scheduler tick or the manual trigger will start this run shortly.</Empty> : (
            <ol className="space-y-3">
              {L.map((l) => (
                <li key={l.id} className="border-l-2 pl-3" style={{ borderColor: l.level === "failed" ? "var(--bad)" : l.level === "warning" ? "var(--warn)" : l.level === "decision" ? "var(--accent)" : "var(--hairline)" }}>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                    <span className="font-medium text-ink-2">{l.stage.replace("_", " ")}</span>
                    <span>{l.level}</span>
                    {l.attempt > 1 && <span>attempt {l.attempt}</span>}
                    <span>{formatInZone(l.started_at, tz)}</span>
                    {l.duration_ms !== null && <span>{(l.duration_ms / 1000).toFixed(1)}s</span>}
                  </div>
                  <div className="text-sm text-ink">{l.message}</div>
                  <Detail detail={l.detail} />
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Article">
            {(articles.data ?? []).length === 0 ? <p className="text-sm text-ink-3">No article for this run.</p> : (
              <ul className="space-y-2">
                {(articles.data ?? []).map((a) => (
                  <li key={a.id} className="text-sm">
                    <Link href={`/articles/${a.id}`} className="font-medium text-[var(--accent)]">{a.headline}</Link>
                    <div className="mt-1 flex items-center gap-2"><RunStatus status={a.status} />{a.wp_url && <ExternalLink href={a.wp_url}>WordPress ↗</ExternalLink>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Cost of this run">
            <div className="text-2xl font-semibold tabular-nums">{u.length ? formatUsd(cost) : "—"}</div>
            <p className="text-xs text-ink-3">{u.length} AI call(s){unknownCost ? `, ${unknownCost} without reported cost` : ""}; {u.filter((x) => x.is_retry).length} retries; {u.filter((x) => !x.success).length} failed.</p>
          </Card>
        </div>
      </div>

      <Card title="Candidates considered" className="mt-4" subtitle="Ranked by the transparent scoring model; why the selected story beat the alternatives">
        <Table head={["#", "Headline", "Category", "Score", "Outcome", "Reason"]} empty={(candidates.data ?? []).length === 0}>
          {(candidates.data ?? []).map((c) => (
            <tr key={c.id}>
              <td className="text-xs text-ink-3">{c.research_round + 1}.{c.rank}</td>
              <td className="max-w-[280px] text-sm">{c.headline}</td>
              <td><Badge>{c.category}</Badge></td>
              <td><Score value={c.overall_score === null ? null : Number(c.overall_score)} /></td>
              <td><RunStatus status={c.status} /></td>
              <td className="max-w-[360px] text-xs text-ink-2">{c.decision_reason}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
