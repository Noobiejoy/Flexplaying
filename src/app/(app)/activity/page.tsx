import Link from "next/link";
import { triggerRun } from "@/app/actions/runs";
import { AutoRefresh } from "@/components/auto-refresh";
import { Flash } from "@/components/flash";
import { MiniRail } from "@/components/rail";
import { Button, Empty, PageHeader, RunStatus, statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { duration, formatInZone } from "@/lib/dashboard/time";
import { ACTIVE_STATUSES, railStates } from "@/lib/dashboard/stages";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const FILTERS = ["all", "active", "published", "drafted", "needs_review", "skipped", "duplicate", "failed", "missed"];

export default async function Activity({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: settings } = await sb.from("workspace_settings").select("timezone").eq("workspace_id", ws).single();
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const filter = FILTERS.includes(sp.status ?? "") ? sp.status! : "all";
  let q = sb.from("runs").select("id,trigger,status,publishing_mode,scheduled_for,started_at,completed_at,created_at,outcome_reason,error_message,stage_attempt,slot_key,resume_stage").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(60);
  if (filter === "active") q = q.in("status", ACTIVE_STATUSES);
  else if (filter !== "all") q = q.eq("status", filter);
  const { data: runs } = await q;
  const rows = runs ?? [];
  const ids = rows.map((r) => r.id);
  const { data: stageLogs } = ids.length ? await sb.from("run_stage_logs").select("run_id,stage,level").in("run_id", ids).in("level", ["succeeded", "failed"]).limit(1000) : { data: [] };
  const anyActive = rows.some((r) => ACTIVE_STATUSES.includes(r.status));

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every run of the desk, stage by stage, from the job ledger."
        actions={
          <>
            <AutoRefresh active={anyActive} />
            {membership.role !== "viewer" && (
              <form action={triggerRun}>
                <input type="hidden" name="workspace_id" value={ws} />
                <input type="hidden" name="back" value="/activity" />
                <input type="hidden" name="mode" value="dry_run" />
                <Button variant="secondary">Start a dry run</Button>
              </form>
            )}
          </>
        }
      />
      <Flash searchParams={searchParams} />
      <nav aria-label="Filter runs" className="scroll-fade mb-4 overflow-x-auto">
        <ul className="flex gap-1">
          {FILTERS.map((f) => (
            <li key={f} className="shrink-0">
              <Link href={`/activity?status=${f}`} aria-current={f === filter ? "page" : undefined} className={`block rounded-lg px-3 py-1.5 text-[13px] ${f === filter ? "bg-[var(--ink)] font-medium text-[var(--on-ink)]" : "text-ink-2 hover:bg-[var(--sunken)]"}`}>
                {f === "all" ? "All" : f === "active" ? "Running" : statusLabel(f).replace(/^./, (c) => c.toUpperCase())}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {rows.length === 0 ? (
        <Empty title={filter === "all" ? "No runs yet" : "No runs match this filter"}>{filter === "all" ? "Start a dry run to watch the desk research, fact-check and write without touching WordPress." : "Choose another filter above."}</Empty>
      ) : (
        <ol className="panel divide-y divide-[var(--rule)] rounded-xl">
          {rows.map((r) => {
            const logs = (stageLogs ?? []).filter((l) => l.run_id === r.id);
            return (
              <li key={r.id}>
                <Link href={`/activity/${r.id}`} className="grid gap-x-6 gap-y-2 px-4 py-4 hover:bg-[var(--surface-2)] sm:px-5 md:grid-cols-[200px_180px_minmax(0,1fr)] md:items-center">
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-ink">{r.trigger === "schedule" ? `${r.slot_key?.slice(11)} scheduled run` : "Manual run"}</div>
                    <div className="text-[12px] text-ink-3">{formatInZone(r.started_at ?? r.scheduled_for ?? r.created_at, tz)}, {duration(r.started_at, r.completed_at)}</div>
                  </div>
                  <div className="flex items-center gap-3 md:block">
                    <MiniRail states={railStates(r, logs)} />
                    <div className="md:mt-2"><RunStatus status={r.status} /></div>
                  </div>
                  <div className="min-w-0">
                    <p className={`line-clamp-2 text-[13px] ${r.error_message ? "text-[var(--bad)]" : "text-ink-2"}`}>{r.error_message ?? r.outcome_reason ?? "In progress"}</p>
                    <p className="mt-0.5 text-[12px] text-ink-3">{statusLabel(r.publishing_mode)}{r.stage_attempt > 1 ? `, attempt ${r.stage_attempt}` : ""}</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
