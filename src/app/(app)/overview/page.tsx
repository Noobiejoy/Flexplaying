import { nowMs } from "@/lib/dashboard/time";
import Link from "next/link";
import { setAutomation } from "@/app/actions/settings";
import { resolveNotification, triggerRun } from "@/app/actions/runs";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Empty, PageHeader, RunStatus, Stat } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { ago, formatInZone } from "@/lib/dashboard/time";
import { nextSlot, normalizeHHMM, startOfLocalDay, startOfLocalMonth } from "@/lib/schedule/slots";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: settings } = await sb.from("workspace_settings").select("*").eq("workspace_id", ws).single();
  const tz: string = settings?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const dayStart = startOfLocalDay(now, tz).toISOString();
  const monthStart = startOfLocalMonth(now, tz).toISOString();

  const [schedules, lastRun, articlesMonth, review, dups, failed, usage, logs, notes, wp] = await Promise.all([
    sb.from("schedules").select("local_time").eq("workspace_id", ws).eq("enabled", true),
    sb.from("runs").select("id,status,trigger,scheduled_for,started_at,completed_at,outcome_reason,created_at").eq("workspace_id", ws).neq("status", "missed").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("articles").select("status,created_at").eq("workspace_id", ws).gte("created_at", monthStart).in("status", ["published", "drafted", "needs_review"]),
    sb.from("articles").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ["needs_review", "drafted"]),
    sb.from("topic_candidates").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "duplicate").gte("created_at", monthStart),
    sb.from("runs").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "failed").gte("created_at", new Date(nowMs() - 7 * 86400_000).toISOString()),
    sb.from("usage_events").select("cost_usd,cost_source,created_at").eq("workspace_id", ws).gte("created_at", monthStart).limit(10000),
    sb.from("run_stage_logs").select("id,run_id,stage,level,message,started_at").eq("workspace_id", ws).in("level", ["decision", "succeeded", "failed", "warning", "skipped"]).order("id", { ascending: false }).limit(14),
    sb.from("notifications").select("id,level,title,body,created_at").eq("workspace_id", ws).is("resolved_at", null).order("created_at", { ascending: false }).limit(6),
    sb.from("wordpress_connections").select("status,site_url").eq("workspace_id", ws).maybeSingle(),
  ]);

  const times = (schedules.data ?? []).map((s) => normalizeHHMM(s.local_time as string));
  const next = settings?.automation_enabled ? nextSlot(now, tz, times) : null;
  const arts = articlesMonth.data ?? [];
  const publishedToday = arts.filter((a) => a.status === "published" && a.created_at >= dayStart).length;
  const publishedMonth = arts.filter((a) => a.status === "published").length;
  const draftedMonth = arts.filter((a) => a.status !== "published").length;
  const u = usage.data ?? [];
  const known = (from: string) => u.filter((x) => x.created_at >= from && x.cost_usd !== null).reduce((s, x) => s + Number(x.cost_usd), 0);
  const unknown = (from: string) => u.filter((x) => x.created_at >= from && x.cost_usd === null).length;
  const spendToday = known(dayStart);
  const spendMonth = known(monthStart);
  const produced = publishedMonth + draftedMonth;
  const canEdit = membership.role !== "viewer";
  const isOwner = membership.role === "owner";

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Editorial agent status for ${membership.name}. Times shown in ${tz}.`}
        actions={
          canEdit && (
            <form action={triggerRun} className="flex items-center gap-2">
              <input type="hidden" name="workspace_id" value={ws} />
              <input type="hidden" name="back" value="/overview" />
              <select name="mode" className="field !w-auto !rounded-full !py-1.5 !text-xs" defaultValue="workspace" aria-label="Run mode">
                <option value="workspace">Workspace mode ({settings?.publishing_mode?.replace("_", " ")})</option>
                <option value="dry_run">Dry run</option>
                <option value="draft_only">Draft only</option>
              </select>
              <Button>Run now</Button>
            </form>
          )
        }
      />
      <Flash searchParams={searchParams} />
      {!wp.data && (
        <div className="mb-5"><Card title="Connect WordPress to start"><p className="text-sm text-ink-2">No WordPress site is connected. Dry runs work without it; drafts and publishing need a connection. <Link className="text-[var(--accent)]" href="/settings#wordpress">Connect your site →</Link></p></Card></div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Automation" value={settings?.automation_enabled ? "Running" : "Paused"} hint={next ? `Next run ${formatInZone(next.scheduledFor, tz)}` : settings?.automation_enabled ? "No enabled schedule" : "Scheduled runs are off"} tone={settings?.automation_enabled ? undefined : "warn"} />
        <Stat label="Published today / month" value={`${publishedToday} / ${publishedMonth}`} hint={`${draftedMonth} draft(s) this month`} />
        <Stat label="Awaiting review" value={review.count ?? 0} hint="Drafts and flagged articles" tone={(review.count ?? 0) > 0 ? "warn" : undefined} />
        <Stat label="Failed runs (7 days)" value={failed.count ?? 0} hint={`${notes.data?.length ?? 0} unresolved alert(s)`} tone={(failed.count ?? 0) > 0 ? "bad" : undefined} />
        <Stat label="Spend today" value={u.length ? formatUsd(spendToday) : "—"} hint={unknown(dayStart) ? `+${unknown(dayStart)} call(s) with unknown cost` : "OpenRouter-reported"} />
        <Stat label="Spend this month" value={u.length ? formatUsd(spendMonth) : "—"} hint={unknown(monthStart) ? `+${unknown(monthStart)} call(s) with unknown cost` : "Billed to the OpenRouter key owner"} />
        <Stat label="Cost per article (month)" value={produced ? formatUsd(spendMonth / produced) : "—"} hint={produced ? `${produced} published or drafted` : "No articles yet"} />
        <Stat label="Duplicates rejected (month)" value={dups.count ?? 0} hint="Candidates already covered on the site" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Recent activity" action={<Link href="/activity" className="text-xs text-[var(--accent)]">All runs →</Link>}>
          {(logs.data ?? []).length === 0 ? (
            <Empty title="No activity yet">Runs appear here once the scheduler or a manual run starts.</Empty>
          ) : (
            <ol className="space-y-3">
              {(logs.data ?? []).map((l) => (
                <li key={l.id} className="flex gap-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${l.level === "failed" ? "bg-[var(--bad)]" : l.level === "warning" ? "bg-[var(--warn)]" : l.level === "decision" ? "bg-[var(--accent)]" : "bg-[var(--good)]"}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link href={`/activity/${l.run_id}`} className="block text-sm text-ink hover:underline">{l.message}</Link>
                    <div className="text-[11px] text-ink-3">{l.stage.replace("_", " ")} · {l.level} · {ago(l.started_at)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Last run">
            {lastRun.data ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between"><RunStatus status={lastRun.data.status} /><span className="text-xs text-ink-3">{lastRun.data.trigger}</span></div>
                <div className="text-ink-2">{lastRun.data.outcome_reason ?? "In progress"}</div>
                <div className="text-xs text-ink-3">Started {formatInZone(lastRun.data.started_at ?? lastRun.data.created_at, tz)}</div>
                <Link className="text-xs text-[var(--accent)]" href={`/activity/${lastRun.data.id}`}>View trace →</Link>
              </div>
            ) : (
              <Empty title="No runs yet" />
            )}
          </Card>
          <Card title="Schedule">
            <div className="flex flex-wrap gap-1.5">{times.length ? times.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-sm text-ink-3">No times configured</span>}</div>
            {isOwner && (
              <form action={setAutomation} className="mt-3">
                <input type="hidden" name="workspace_id" value={ws} />
                <input type="hidden" name="enabled" value={settings?.automation_enabled ? "false" : "true"} />
                <Button variant={settings?.automation_enabled ? "secondary" : "primary"}>{settings?.automation_enabled ? "Pause automation" : "Resume automation"}</Button>
              </form>
            )}
          </Card>
          <Card title="Alerts">
            {(notes.data ?? []).length === 0 ? (
              <p className="text-sm text-ink-3">No unresolved alerts.</p>
            ) : (
              <ul className="space-y-3">
                {(notes.data ?? []).map((n) => (
                  <li key={n.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2"><Badge tone={n.level === "error" ? "bad" : n.level === "warning" ? "warn" : "info"} icon>{n.title}</Badge><span className="text-[11px] text-ink-3">{ago(n.created_at)}</span></div>
                    <p className="mt-1 text-xs text-ink-2">{n.body}</p>
                    {canEdit && (
                      <form action={resolveNotification}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="workspace_id" value={ws} /><button className="mt-1 text-[11px] text-[var(--accent)]">Mark resolved</button></form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
