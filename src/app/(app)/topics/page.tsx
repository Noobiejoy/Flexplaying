import Link from "next/link";
import { runTopicNow } from "@/app/actions/runs";
import { createTopic, deleteTopic, endTopic, setTopicEnabled, updateTopic } from "@/app/actions/topics";
import { AutoRefresh } from "@/components/auto-refresh";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, CategoryTag, Empty, Field, PageHeader, RunStatus, Section } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { ACTIVE_STATUSES } from "@/lib/dashboard/stages";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/editorial/categories";
import { topicActiveOn } from "@/lib/pipeline/targets";
import { formatInZone, formatLocalDate, localDateOf, nextSlot, normalizeHHMM, startOfLocalDay } from "@/lib/schedule/slots";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Topic = { id: string; title: string; category: string; notes: string; end_date: string; local_time: string | null; enabled: boolean; created_at: string };
type Art = { id: string; headline: string; status: string; topic_id: string; created_at: string };
type Run = { id: string; status: string; topic_id: string; created_at: string; outcome_reason: string | null; error_message: string | null };

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function prettyDate(d: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
}

function TopicFields({ t, today }: { t?: Topic; today: string }) {
  return (
    <>
      <Field label="Topic">
        <input className="field" name="title" required minLength={3} maxLength={160} defaultValue={t?.title} placeholder="e.g. Jujutsu Kaisen Season 3" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category" hint="WordPress category the articles go in">
          <select className="field" name="category" defaultValue={t?.category ?? "anime"}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </Field>
        <Field label="End date" hint="Last day it gets an article">
          <input className="field" type="date" name="end_date" required min={t ? undefined : today} defaultValue={t?.end_date} />
        </Field>
      </div>
      <Field label="Angle or notes (optional)" hint="What to focus on or avoid. Guidance only: every fact still has to come from sources.">
        <textarea className="field min-h-[72px]" name="notes" maxLength={600} defaultValue={t?.notes} placeholder="e.g. Focus on the anime, not manga spoilers" />
      </Field>
      <Field label="Own daily time (optional)" hint="Leave empty to run with the daily schedule, after the category articles">
        <input className="field" type="time" name="local_time" defaultValue={t?.local_time ?? ""} />
      </Field>
    </>
  );
}

export default async function Topics({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const canEdit = membership.role !== "viewer";
  const [{ data: settings }, { data: schedules }, { data: topicRows }] = await Promise.all([
    sb.from("workspace_settings").select("timezone,automation_enabled").eq("workspace_id", ws).single(),
    sb.from("schedules").select("local_time").eq("workspace_id", ws).eq("enabled", true),
    sb.from("editorial_topics").select("id,title,category,notes,end_date,local_time,enabled,created_at").eq("workspace_id", ws).order("end_date", { ascending: false }).limit(100),
  ]);
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const today = formatLocalDate(localDateOf(now, tz));
  const dayStart = startOfLocalDay(now, tz).toISOString();
  const topics = ((topicRows ?? []) as Topic[]).map((t) => ({ ...t, local_time: t.local_time ? normalizeHHMM(t.local_time) : null }));
  const ids = topics.map((t) => t.id);
  const [{ data: artRows }, { data: runRows }] = ids.length
    ? await Promise.all([
        sb.from("articles").select("id,headline,status,topic_id,created_at").in("topic_id", ids).in("status", ["drafted", "published", "needs_review"]).order("created_at", { ascending: false }).limit(500),
        sb.from("runs").select("id,status,topic_id,created_at,outcome_reason,error_message").in("topic_id", ids).order("created_at", { ascending: false }).limit(300),
      ])
    : [{ data: [] }, { data: [] }];
  const arts = (artRows ?? []) as Art[];
  const runs = (runRows ?? []) as Run[];
  const times = (schedules ?? []).map((s) => normalizeHHMM(s.local_time as string)).sort();
  const on = Boolean(settings?.automation_enabled);
  const active = topics.filter((t) => topicActiveOn(t, today));
  const finished = topics.filter((t) => !topicActiveOn(t, today));
  const anyRunning = runs.some((r) => ACTIVE_STATUSES.includes(r.status));

  const form = canEdit && (
    <Card title="Add a topic" subtitle="One article a day, each on a different aspect, until the end date.">
      <form action={createTopic} className="space-y-3">
        <input type="hidden" name="workspace_id" value={ws} />
        <TopicFields today={today} />
        <Button>Add topic</Button>
      </form>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Topics"
        description="Name a subject and the desk writes one article about it every day until the end date, choosing a new angle each time: fresh news first, otherwise a sourced aspect not yet covered. Topic articles come on top of the daily category articles and go through the same fact-check, duplicate check and quality gate."
        actions={<AutoRefresh active={anyRunning} />}
      />
      <Flash searchParams={searchParams} />
      {!on && <p className="mb-4 rounded-lg bg-[var(--sunken)] px-4 py-3 text-[14px] text-ink-2">Automation is paused, so topics only run when you press Run now.</p>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-8">
          <Section title={`Running (${active.length})`}>
            {active.length === 0 ? (
              <Empty title="No topics yet">Add one to give a subject daily coverage, for example a season that&apos;s airing or a tournament that&apos;s on.</Empty>
            ) : (
              <ul className="space-y-4">
                {active.map((t) => {
                  const mine = arts.filter((a) => a.topic_id === t.id);
                  const doneToday = mine.find((a) => a.created_at >= dayStart);
                  const runNow = runs.find((r) => r.topic_id === t.id && ACTIVE_STATUSES.includes(r.status));
                  const lastToday = runs.find((r) => r.topic_id === t.id && r.created_at >= dayStart);
                  const left = daysBetween(today, t.end_date);
                  const next = t.enabled && on ? nextSlot(now, tz, t.local_time ? [t.local_time] : times) : null;
                  return (
                    <li key={t.id} className="panel rounded-xl p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <CategoryTag category={t.category} />
                            {!t.enabled && <Badge tone="warn">paused</Badge>}
                          </div>
                          <h3 className="mt-1 text-[17px] font-semibold leading-snug text-ink">{t.title}</h3>
                          <p className="mt-1 text-[13px] text-ink-3">
                            Until {prettyDate(t.end_date)} ({left === 0 ? "last day today" : `${left} day${left === 1 ? "" : "s"} left`}) · {t.local_time ? `own time ${t.local_time}` : `with the ${times.join(", ") || "daily"} schedule`} · {mine.length} article{mine.length === 1 ? "" : "s"} so far
                          </p>
                          {t.notes && <p className="mt-2 text-[14px] text-ink-2">{t.notes}</p>}
                        </div>
                        {canEdit && t.enabled && !doneToday && !runNow && (
                          <form action={runTopicNow}>
                            <input type="hidden" name="topic_id" value={t.id} />
                            <Button>Run now</Button>
                          </form>
                        )}
                      </div>

                      <div className="mt-3 rounded-lg bg-[var(--sunken)] px-3 py-2 text-[13px] text-ink-2">
                        <span className="font-semibold text-ink">Today: </span>
                        {doneToday ? (
                          <>written, <Link className="text-[var(--link)] hover:underline" href={`/articles/${doneToday.id}`}>{doneToday.headline}</Link></>
                        ) : runNow ? (
                          <span className="inline-flex items-center gap-2"><RunStatus status={runNow.status} /><Link className="text-[var(--link)] hover:underline" href={`/activity/${runNow.id}`}>Open run</Link></span>
                        ) : lastToday ? (
                          <span>
                            <RunStatus status={lastToday.status} /> {lastToday.error_message ?? lastToday.outcome_reason} <Link className="text-[var(--link)] hover:underline" href={`/activity/${lastToday.id}`}>Open run</Link>
                          </span>
                        ) : !t.enabled ? (
                          "paused"
                        ) : next ? (
                          `next run ${formatInZone(next.scheduledFor, tz)}`
                        ) : (
                          "no run scheduled; use Run now"
                        )}
                      </div>

                      {mine.length > 0 && (
                        <ol className="mt-3 space-y-1.5">
                          {mine.slice(0, 5).map((a) => (
                            <li key={a.id} className="flex items-baseline gap-2 text-[14px]">
                              <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{formatInZone(a.created_at, tz).split(",")[0]}</span>
                              <Link href={`/articles/${a.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">{a.headline}</Link>
                              <RunStatus status={a.status} />
                            </li>
                          ))}
                        </ol>
                      )}

                      {canEdit && (
                        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--rule)] pt-3">
                          <form action={setTopicEnabled}>
                            <input type="hidden" name="topic_id" value={t.id} />
                            <input type="hidden" name="enabled" value={t.enabled ? "false" : "true"} />
                            <Button variant="secondary">{t.enabled ? "Pause" : "Resume"}</Button>
                          </form>
                          {left > 0 && (
                            <form action={endTopic}>
                              <input type="hidden" name="topic_id" value={t.id} />
                              <Button variant="ghost">End today</Button>
                            </form>
                          )}
                          <details className="group w-full">
                            <summary className="cursor-pointer list-none text-[13px] font-medium text-[var(--link)] hover:underline">Edit topic</summary>
                            <form action={updateTopic} className="mt-3 space-y-3">
                              <input type="hidden" name="topic_id" value={t.id} />
                              <TopicFields t={t} today={today} />
                              <div className="flex flex-wrap gap-2">
                                <Button>Save changes</Button>
                                <Button variant="danger" formAction={deleteTopic}>Delete topic</Button>
                              </div>
                              <p className="text-[12px] text-ink-3">Deleting keeps the articles already written; it only removes the topic and cancels queued runs.</p>
                            </form>
                          </details>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {finished.length > 0 && (
            <Section title={`Ended (${finished.length})`}>
              <ul className="panel divide-y divide-[var(--rule)] rounded-xl">
                {finished.map((t) => {
                  const n = arts.filter((a) => a.topic_id === t.id).length;
                  return (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <CategoryTag category={t.category} />
                        <div className="text-[14px] font-medium text-ink">{t.title}</div>
                        <div className="text-[12px] text-ink-3">{t.enabled ? `Ended ${prettyDate(t.end_date)}` : `Paused, ended ${prettyDate(t.end_date)}`} · {n} article{n === 1 ? "" : "s"}</div>
                      </div>
                      {canEdit && (
                        <details>
                          <summary className="cursor-pointer list-none text-[13px] font-medium text-[var(--link)] hover:underline">Extend or delete</summary>
                          <form action={updateTopic} className="mt-3 w-[300px] max-w-full space-y-3">
                            <input type="hidden" name="topic_id" value={t.id} />
                            <TopicFields t={t} today={today} />
                            <div className="flex flex-wrap gap-2">
                              <Button>Save</Button>
                              <Button variant="danger" formAction={deleteTopic}>Delete</Button>
                            </div>
                          </form>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
        <div className="order-first lg:order-none">{form}</div>
      </div>
    </>
  );
}
