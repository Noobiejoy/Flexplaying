import Link from "next/link";
import { triggerRun } from "@/app/actions/runs";
import { AutoRefresh } from "@/components/auto-refresh";
import { Flash } from "@/components/flash";
import { Button, Card, PageHeader, RunStatus, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { duration, formatInZone } from "@/lib/dashboard/time";
import { ACTIVE_STATUSES } from "@/lib/dashboard/stages";

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
  let q = sb.from("runs").select("id,trigger,status,publishing_mode,scheduled_for,started_at,completed_at,created_at,outcome_reason,error_message,stage_attempt,slot_key").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(60);
  if (filter === "active") q = q.in("status", ACTIVE_STATUSES);
  else if (filter !== "all") q = q.eq("status", filter);
  const { data: runs } = await q;
  const anyActive = (runs ?? []).some((r) => ACTIVE_STATUSES.includes(r.status));

  return (
    <>
      <PageHeader
        title="Live agent activity"
        description="Every run and every stage, from the durable job ledger."
        actions={
          <>
            <AutoRefresh active={anyActive} />
            {membership.role !== "viewer" && (
              <form action={triggerRun}>
                <input type="hidden" name="workspace_id" value={ws} />
                <input type="hidden" name="back" value="/activity" />
                <input type="hidden" name="mode" value="dry_run" />
                <Button variant="secondary">Start dry run</Button>
              </form>
            )}
          </>
        }
      />
      <Flash searchParams={searchParams} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link key={f} href={`/activity?status=${f}`} className={`rounded-full px-3 py-1 text-xs ${f === filter ? "bg-[var(--accent)] text-white" : "glass text-ink-2"}`}>{f.replace("_", " ")}</Link>
        ))}
      </div>
      <Card>
        <Table head={["Run", "Status", "Mode", "Scheduled", "Started", "Duration", "Outcome"]} empty={(runs ?? []).length === 0}>
          {(runs ?? []).map((r) => (
            <tr key={r.id}>
              <td><Link className="font-medium text-[var(--accent)]" href={`/activity/${r.id}`}>{r.trigger === "schedule" ? r.slot_key : "manual"}</Link></td>
              <td><RunStatus status={r.status} /></td>
              <td className="text-xs text-ink-2">{r.publishing_mode.replace("_", " ")}</td>
              <td className="text-xs text-ink-2">{formatInZone(r.scheduled_for, tz)}</td>
              <td className="text-xs text-ink-2">{formatInZone(r.started_at, tz)}</td>
              <td className="text-xs tabular-nums text-ink-2">{duration(r.started_at, r.completed_at)}</td>
              <td className="max-w-[320px] truncate text-xs text-ink-2" title={r.error_message ?? r.outcome_reason ?? ""}>{r.error_message ?? r.outcome_reason ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
