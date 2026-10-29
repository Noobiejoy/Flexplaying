import { nowMs } from "@/lib/dashboard/time";
import Link from "next/link";
import { setAutomation } from "@/app/actions/settings";
import { resolveNotification, triggerRun } from "@/app/actions/runs";
import { Flash } from "@/components/flash";
import { Rail } from "@/components/rail";
import { Button, Card, Empty, LinkButton, Notice, PageHeader, RunStatus, Section, Stat, StatStrip, TextLink, statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { railStates, stageDurations, PIPELINE } from "@/lib/dashboard/stages";
import { ago, formatInZone } from "@/lib/dashboard/time";
import { formatLocalDate, localDateOf, nextSlot, normalizeHHMM, parseHHMM, startOfLocalDay, startOfLocalMonth, zonedParts } from "@/lib/schedule/slots";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const LEVEL_COLOR: Record<string, string> = { failed: "var(--bad)", warning: "var(--warn)", decision: "var(--live)", succeeded: "var(--ink-3)" };

type RunRow = { id: string; status: string; trigger: string; slot_key: string | null; started_at: string | null; completed_at: string | null; created_at: string; outcome_reason: string | null; error_message: string | null; publishing_mode: string; resume_stage: string | null };

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: settings } = await sb.from("workspace_settings").select("*").eq("workspace_id", ws).single();
  const tz: string = settings?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const today = formatLocalDate(localDateOf(now, tz));
  const dayStart = startOfLocalDay(now, tz).toISOString();
  const monthStart = startOfLocalMonth(now, tz).toISOString();
  const runCols = "id,status,trigger,slot_key,started_at,completed_at,created_at,outcome_reason,error_message,publishing_mode,resume_stage";

  const [schedules, lastRun, todayRuns, articlesMonth, review, dups, failed, usage, logs, notes, wp] = await Promise.all([
    sb.from("schedules").select("local_time").eq("workspace_id", ws).eq("enabled", true),
    sb.from("runs").select(runCols).eq("workspace_id", ws).neq("status", "missed").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("runs").select(runCols).eq("workspace_id", ws).gte("created_at", new Date(Date.parse(dayStart) - 6 * 3600_000).toISOString()).order("created_at"),
    sb.from("articles").select("status,created_at").eq("workspace_id", ws).gte("created_at", monthStart).in("status", ["published", "drafted", "needs_review"]),
    sb.from("articles").select("id,headline,status,category,created_at").eq("workspace_id", ws).in("status", ["needs_review", "drafted"]).order("created_at", { ascending: false }).limit(4),
    sb.from("topic_candidates").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "duplicate").gte("created_at", monthStart),
    sb.from("runs").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "failed").gte("created_at", new Date(nowMs() - 7 * 86400_000).toISOString()),
    sb.from("usage_events").select("cost_usd,cost_source,created_at").eq("workspace_id", ws).gte("created_at", monthStart).limit(10000),
    sb.from("run_stage_logs").select("id,run_id,stage,level,message,started_at").eq("workspace_id", ws).in("level", ["decision", "succeeded", "failed", "warning"]).order("id", { ascending: false }).limit(8),
    sb.from("notifications").select("id,level,title,body,created_at").eq("workspace_id", ws).is("resolved_at", null).order("created_at", { ascending: false }).limit(6),
    sb.from("wordpress_connections").select("status,site_url").eq("workspace_id", ws).maybeSingle(),
  ]);
  const last = lastRun.data as RunRow | null;
  const { data: lastLogs } = last ? await sb.from("run_stage_logs").select("stage,level,duration_ms").eq("run_id", last.id).in("level", ["succeeded", "failed"]) : { data: [] };

  const on = Boolean(settings?.automation_enabled);
  const times = (schedules.data ?? []).map((s) => normalizeHHMM(s.local_time as string)).sort();
  const next = on ? nextSlot(now, tz, times) : null;
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
  const reviewItems = review.data ?? [];
  const alerts = notes.data ?? [];
  const failedCount = failed.count ?? 0;

  // Today's band: each configured slot on a 24h track, plus a "now" tick.
  const p = zonedParts(now, tz);
  const nowFrac = (p.hour * 60 + p.minute) / 1440;
  const runsToday = ((todayRuns.data ?? []) as RunRow[]).filter((r) => r.created_at >= dayStart || r.slot_key?.startsWith(today));
  const slots = times.map((t) => {
    const [h, m] = parseHHMM(t);
    const frac = (h * 60 + m) / 1440;
    const run = runsToday.find((r) => r.slot_key === `${today}T${t}`) ?? null;
    return { t, frac, run, past: frac <= nowFrac };
  });
  const manualToday = runsToday.filter((r) => r.trigger !== "schedule");
  const dayLabel = new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <>
      <PageHeader
        kicker={`${dayLabel}, ${tz}`}
        title="Today's desk"
        description={
          on
            ? next
              ? `Automation is on. The next scheduled run starts ${formatInZone(next.scheduledFor, tz, false)}.`
              : "Automation is on, but no run times are set."
            : "Automation is paused. Scheduled runs won't start until you resume it; you can still run the desk by hand."
        }
        actions={
          <>
            {isOwner && (
              <form action={setAutomation}>
                <input type="hidden" name="workspace_id" value={ws} />
                <input type="hidden" name="enabled" value={on ? "false" : "true"} />
                <Button variant="secondary">{on ? "Pause automation" : "Resume automation"}</Button>
              </form>
            )}
            {canEdit && (
              <form action={triggerRun} className="flex items-center gap-2">
                <input type="hidden" name="workspace_id" value={ws} />
                <input type="hidden" name="back" value="/overview" />
                <select name="mode" className="field !w-auto !py-2 !text-[13px]" defaultValue="workspace" aria-label="Run mode">
                  <option value="workspace">Use workspace mode ({statusLabel(settings?.publishing_mode ?? "")})</option>
                  <option value="dry_run">Dry run</option>
                  <option value="draft_only">Draft only</option>
                </select>
                <Button>Run now</Button>
              </form>
            )}
          </>
        }
      />
      <Flash searchParams={searchParams} />
      {!wp.data && (
        <div className="mb-6">
          <Notice tone="warn" title="Connect WordPress to save drafts">
            Dry runs work without a site. Drafts and publishing need a connection. <TextLink href="/settings#wordpress">Connect your site</TextLink>
          </Notice>
        </div>
      )}

      {/* The day at a glance */}
      <Card className="mb-8" flush>
        <div className="px-5 pb-1 pt-5">
          <div className="relative mx-2 h-12" aria-hidden>
            <div className="absolute inset-x-0 top-[30px] h-[2px] rounded-full bg-[var(--rule)]" />
            <div className="absolute left-0 top-[30px] h-[2px] rounded-full bg-[var(--ink-3)]" style={{ width: `${nowFrac * 100}%` }} />
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h} className="absolute top-[38px] -translate-x-1/2 text-[12px] text-ink-3" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}</span>
            ))}
            {slots.map((s) => (
              <span key={s.t} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${s.frac * 100}%` }}>
                <span className="text-[12px] font-semibold text-ink">{s.t}</span>
                <span className={`mt-1 h-3 w-3 rounded-full border-2 ${s.run ? "border-[var(--ink)] bg-[var(--ink)]" : s.past ? "border-[var(--ink-3)] bg-[var(--surface)]" : "border-[var(--ink)] bg-[var(--surface)]"}`} />
              </span>
            ))}
            <span className="absolute top-[22px] h-[18px] w-[2px] -translate-x-1/2 rounded-full bg-[var(--live)]" style={{ left: `${nowFrac * 100}%` }} />
          </div>
        </div>
        <ol className="grid border-t border-[var(--rule)] sm:grid-cols-3 sm:divide-x divide-[var(--rule)]">
          {slots.length === 0 && <li className="px-5 py-4 text-[14px] text-ink-3 sm:col-span-3">No run times are set. Add them in <TextLink href="/settings#schedule">Settings</TextLink>.</li>}
          {slots.map((s) => (
            <li key={s.t} className="border-b border-[var(--rule)] px-5 py-4 last:border-b-0 sm:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <span className="figure text-[24px]">{s.t}</span>
                {s.run ? <RunStatus status={s.run.status} /> : <span className="text-[12px] text-ink-3">{s.past ? (on ? "No run recorded" : "Skipped while paused") : on ? "Scheduled" : "Paused"}</span>}
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] text-ink-2">
                {s.run
                  ? s.run.error_message ?? s.run.outcome_reason ?? "In progress"
                  : s.past
                    ? on
                      ? "The scheduler did not start this slot. Check Settings for scheduler health."
                      : "Automation was paused at this time."
                    : on
                      ? "Research starts at this time."
                      : "Resume automation to run this slot."}
              </p>
              {s.run && <TextLink href={`/activity/${s.run.id}`} className="mt-2 inline-block text-[13px]">Open trace</TextLink>}
            </li>
          ))}
        </ol>
        {manualToday.length > 0 && (
          <div className="border-t border-[var(--rule)] px-5 py-3 text-[13px] text-ink-2">
            {manualToday.length} manual run{manualToday.length > 1 ? "s" : ""} today. <TextLink href="/activity">See runs</TextLink>
          </div>
        )}
      </Card>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          <Section title="Latest run" action={last && <TextLink href={`/activity/${last.id}`} className="text-[13px]">Open trace</TextLink>}>
            {last ? (
              <Card>
                <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <RunStatus status={last.status} />
                  <span className="text-[13px] text-ink-3">{last.trigger === "schedule" ? `Scheduled, ${last.slot_key?.slice(11)}` : "Manual"} run started {formatInZone(last.started_at ?? last.created_at, tz)}</span>
                </div>
                <Rail states={railStates(last, lastLogs ?? [])} durations={stageDurations((lastLogs ?? []) as { stage: string; duration_ms: number | null }[])} />
                <p className="mt-4 border-t border-[var(--rule)] pt-3 text-[14px] text-ink-2">{last.error_message ?? last.outcome_reason ?? "In progress"}</p>
              </Card>
            ) : (
              <Empty title="The desk hasn't run yet" action={canEdit ? <LinkButton href="/activity">Go to runs</LinkButton> : undefined}>Start a dry run to see research, fact-checking and writing without touching WordPress.</Empty>
            )}
          </Section>

          <Section title="Recent decisions" subtitle="What the agent chose, and why" action={<TextLink href="/activity" className="text-[13px]">All runs</TextLink>}>
            {(logs.data ?? []).length === 0 ? (
              <Empty title="No activity yet">Decisions appear here once the scheduler or a manual run starts.</Empty>
            ) : (
              <ol className="panel divide-y divide-[var(--rule)] rounded-xl">
                {(logs.data ?? []).map((l) => (
                  <li key={l.id} className="flex gap-3 px-4 py-3">
                    <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: LEVEL_COLOR[l.level] ?? "var(--ink-3)" }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <Link href={`/activity/${l.run_id}`} className="block text-[14px] leading-snug text-ink hover:underline">{l.message}</Link>
                      <div className="mt-0.5 text-[12px] text-ink-3">
                        {PIPELINE.find((x) => x.key === l.stage)?.label ?? statusLabel(l.stage)}, {l.level === "succeeded" ? "completed" : l.level} {ago(l.started_at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <div className="order-first space-y-8 lg:order-none">
          <Section title="Needs you">
            {reviewItems.length === 0 && alerts.length === 0 && failedCount === 0 ? (
              <p className="panel rounded-xl px-4 py-4 text-[14px] text-ink-3">Nothing needs you right now.</p>
            ) : (
              <div className="panel divide-y divide-[var(--rule)] rounded-xl">
                {reviewItems.map((a) => (
                  <Link key={a.id} href={`/articles/${a.id}`} className="block px-4 py-3 hover:bg-[var(--surface-2)]">
                    <div className="flex items-center gap-2 text-[12px] text-ink-3"><RunStatus status={a.status} /> {ago(a.created_at)}</div>
                    <div className="mt-1 line-clamp-2 text-[14px] font-medium leading-snug text-ink">{a.headline}</div>
                  </Link>
                ))}
                {failedCount > 0 && (
                  <Link href="/activity?status=failed" className="block px-4 py-3 text-[14px] hover:bg-[var(--surface-2)]">
                    <span className="font-semibold text-[var(--bad)]">{failedCount} failed run{failedCount > 1 ? "s" : ""}</span> <span className="text-ink-2">in the last 7 days. Review and retry.</span>
                  </Link>
                )}
                {alerts.map((n) => (
                  <div key={n.id} className="px-4 py-3 text-[14px]">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium" style={{ color: n.level === "error" ? "var(--bad)" : n.level === "warning" ? "var(--warn)" : "var(--ink)" }}>{n.title}</span>
                      <span className="shrink-0 text-[12px] text-ink-3">{ago(n.created_at)}</span>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-2">{n.body}</p>
                    {canEdit && (
                      <form action={resolveNotification}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="workspace_id" value={ws} /><button className="mt-1.5 text-[13px] font-medium text-[var(--link)] hover:underline">Mark resolved</button></form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="This month">
            <StatStrip className="grid-cols-2">
              <Stat label="Published" value={publishedMonth} hint={`${publishedToday} today`} />
              <Stat label="Drafted" value={draftedMonth} hint="Awaiting a person" />
              <Stat label="AI spend" value={u.length ? formatUsd(spendMonth, 2) : "—"} hint={unknown(monthStart) ? `+${unknown(monthStart)} call(s) with unknown cost` : `${formatUsd(spendToday, 2)} today`} />
              <Stat label="Per article" value={produced ? formatUsd(spendMonth / produced, 2) : "—"} hint={produced ? `${produced} produced` : "No articles yet"} />
              <Stat label="Duplicates caught" value={dups.count ?? 0} hint="Already on your site" />
              <Stat label="Failed runs" value={failedCount} hint="Last 7 days" tone={failedCount > 0 ? "bad" : undefined} />
            </StatStrip>
            <div className="mt-2 text-right"><TextLink href="/costs" className="text-[13px]">Cost breakdown</TextLink></div>
          </Section>
        </div>
      </div>
    </>
  );
}
