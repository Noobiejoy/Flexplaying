import { nowMs } from "@/lib/dashboard/time";
import { checkModels, disconnectWordPress, saveWebhook, saveWordPressConnection, testWordPressConnection, updateCategoryMap, updateEditorial, updateGeneral, updateModels, updatePublishingMode, updateSchedule } from "@/app/actions/settings";
import { createInvitation, revokeInvitation, updateMember } from "@/app/actions/members";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Field, Notice, PageHeader, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatInZone, ago } from "@/lib/dashboard/time";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/editorial/categories";
import { env, integrationHealth } from "@/lib/env";
import { normalizeHHMM } from "@/lib/schedule/slots";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-6">
      <Card title={title} subtitle={subtitle}>{children}</Card>
    </div>
  );
}

function Hidden({ ws }: { ws: string }) {
  return <input type="hidden" name="workspace_id" value={ws} />;
}

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership, user } = await currentWorkspace();
  const ws = membership.workspace_id;
  const isOwner = membership.role === "owner";
  const [{ data: s }, { data: schedules }, { data: conn }, { data: members }, { data: invites }] = await Promise.all([
    sb.from("workspace_settings").select("*").eq("workspace_id", ws).single(),
    sb.from("schedules").select("local_time").eq("workspace_id", ws).order("local_time"),
    sb.from("wordpress_connections").select("*").eq("workspace_id", ws).maybeSingle(),
    sb.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", ws),
    isOwner ? sb.from("workspace_invitations").select("id,email,role,expires_at,accepted_at,revoked_at,created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
  ]);
  const health = integrationHealth();
  const e = env();
  let lastTick: string | null = null;
  let hasSecret = false;
  let hasWebhook = false;
  let dbOk = false;
  try {
    const admin = adminClient();
    const [t, sec, hook] = await Promise.all([
      admin.from("scheduler_invocations").select("received_at").order("received_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("workspace_secrets").select("updated_at").eq("workspace_id", ws).eq("kind", "wordpress_app_password").maybeSingle(),
      admin.from("workspace_secrets").select("updated_at").eq("workspace_id", ws).eq("kind", "notification_webhook").maybeSingle(),
    ]);
    dbOk = !t.error;
    lastTick = t.data?.received_at ?? null;
    hasSecret = Boolean(sec.data);
    hasWebhook = Boolean(hook.data);
  } catch {
    dbOk = false;
  }
  const { data: profiles } = await adminClient().from("profiles").select("id, display_name").in("id", (members ?? []).map((m) => m.user_id));
  const tz = s?.timezone ?? "Asia/Kolkata";
  const times = (schedules ?? []).map((x) => normalizeHHMM(x.local_time as string)).join(", ");
  const caps = (conn?.capabilities ?? {}) as { categories?: { id: number; name: string; slug: string }[]; publish_posts?: boolean; roles?: string[]; site_name?: string };
  const map = (conn?.category_map ?? {}) as Record<string, number>;
  const tickHealthy = lastTick ? nowMs() - Date.parse(lastTick) < 20 * 60_000 : false;
  const dis = !isOwner;

  return (
    <>
      <PageHeader title="Settings & integrations" description={isOwner ? "Only owners can change these settings. Every change is checked on the server and enforced by database policies." : "You can view these settings. Changing them requires the owner role."} />
      <Flash searchParams={searchParams} />
      <div className="space-y-4">
        <Section id="health" title="Integration health">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "Database", ok: dbOk && health.supabaseServer, detail: dbOk ? "Supabase reachable" : "Server key missing or database unreachable" },
              { name: "WordPress", ok: conn?.status === "ok" && hasSecret, detail: conn ? `${conn.status} · tested ${ago(conn.last_tested_at)}${conn.last_error ? ` · ${conn.last_error}` : ""}` : "Not connected" },
              { name: "OpenRouter (Google models)", ok: health.openrouter, detail: health.openrouter ? `Key configured · text ${e.OPENROUTER_TEXT_MODEL}` : "OPENROUTER_API_KEY missing" },
              { name: "Scheduler", ok: health.scheduler && tickHealthy, detail: !health.scheduler ? "CRON_SECRET missing" : lastTick ? `Last signed tick ${ago(lastTick)}` : "No tick received yet. Set up Supabase Cron (README)" },
            ].map((h) => (
              <div key={h.name} className="rounded-xl bg-[var(--hairline)] p-3">
                <div className="flex items-center justify-between"><span className="text-sm font-medium">{h.name}</span><Badge tone={h.ok ? "good" : "warn"} icon>{h.ok ? "healthy" : "attention"}</Badge></div>
                <p className="mt-1 text-[11px] text-ink-3">{h.detail}</p>
              </div>
            ))}
          </div>
          {!health.encryption && <div className="mt-3"><Notice tone="warn">CREDENTIALS_ENCRYPTION_KEY is not set, so WordPress credentials can&apos;t be saved.</Notice></div>}
          {health.mock && <div className="mt-3"><Notice tone="warn">Mock WordPress mode is on (development only). Nothing is sent to your real site.</Notice></div>}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section id="general" title="Workspace">
            <form action={updateGeneral} className="space-y-3">
              <Hidden ws={ws} />
              <Field label="Name"><input className="field" name="name" defaultValue={membership.name} disabled={dis} /></Field>
              <Field label="Timezone (IANA)" hint="All schedule times and dashboard times use this zone."><input className="field" name="timezone" defaultValue={tz} disabled={dis} /></Field>
              {isOwner && <Button>Save</Button>}
            </form>
          </Section>
          <Section id="schedule" title="Schedule" subtitle={`Automation is ${s?.automation_enabled ? "on" : "paused"} (pause or resume it on the Overview page).`}>
            <form action={updateSchedule} className="space-y-3">
              <Hidden ws={ws} />
              <Field label={`Daily run times (${tz}, 24h, comma separated)`} hint="Defaults: 09:00, 13:00, 19:00. Supabase Cron ticks every 5 minutes and starts each slot exactly once."><input className="field" name="times" defaultValue={times} disabled={dis} /></Field>
              {isOwner && <Button>Save schedule</Button>}
            </form>
          </Section>
        </div>

        <Section id="publishing" title="Publishing mode" subtitle="New workspaces start in Draft only.">
          <div className="mb-3 flex items-center gap-2 text-sm">Current mode: <Badge tone={s?.publishing_mode === "auto_publish" ? "info" : "neutral"}>{s?.publishing_mode?.replace("_", " ")}</Badge>{s?.auto_publish_confirmed_at && s.publishing_mode === "auto_publish" && <span className="text-xs text-ink-3">enabled {formatInZone(s.auto_publish_confirmed_at, tz)}</span>}</div>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { mode: "dry_run", title: "Dry run", text: "Research, score, deduplicate, write and generate images. WordPress is never modified." },
              { mode: "draft_only", title: "Draft only", text: "Create WordPress drafts for you to review and publish manually." },
              { mode: "auto_publish", title: "Auto-publish", text: "Publish automatically, but only articles that pass every check. Anything that fails a check becomes a draft." },
            ].map((m) => (
              <form key={m.mode} action={updatePublishingMode} className={`rounded-xl p-3 ${s?.publishing_mode === m.mode ? "glass-strong ring-2 ring-[var(--accent)]" : "bg-[var(--hairline)]"}`}>
                <Hidden ws={ws} />
                <input type="hidden" name="mode" value={m.mode} />
                <div className="text-sm font-medium">{m.title}</div>
                <p className="mt-1 text-xs text-ink-2">{m.text}</p>
                {m.mode === "auto_publish" && isOwner && s?.publishing_mode !== "auto_publish" && (
                  <div className="mt-2"><Field label='Type "AUTO-PUBLISH" to confirm'><input className="field" name="confirm" autoComplete="off" /></Field></div>
                )}
                {isOwner && s?.publishing_mode !== m.mode && <Button variant={m.mode === "auto_publish" ? "primary" : "secondary"} className="mt-2">Use {m.title.toLowerCase()}</Button>}
              </form>
            ))}
          </div>
        </Section>

        <Section id="editorial" title="Editorial rules & quality thresholds">
          <form action={updateEditorial} className="grid gap-3 md:grid-cols-3">
            <Hidden ws={ws} />
            <div className="md:col-span-3">
              <span className="mb-1 block text-xs font-medium text-ink-2">Categories</span>
              <div className="flex flex-wrap gap-3">
                {CATEGORIES.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="enabled_categories" value={c} defaultChecked={s?.enabled_categories?.includes(c)} disabled={dis} />{CATEGORY_LABEL[c]}</label>
                ))}
              </div>
            </div>
            <Field label="Min candidate score (0–1)" hint="Below this, the run skips rather than inventing a story"><input className="field" name="min_candidate_score" type="number" step="0.01" min="0" max="1" defaultValue={s?.min_candidate_score} disabled={dis} /></Field>
            <Field label="Min quality score (0–1)"><input className="field" name="min_quality_score" type="number" step="0.01" min="0" max="1" defaultValue={s?.min_quality_score} disabled={dis} /></Field>
            <Field label="Articles per run"><input className="field" name="max_articles_per_run" type="number" min="1" max="3" defaultValue={s?.max_articles_per_run} disabled={dis} /></Field>
            <Field label="Daily article limit"><input className="field" name="daily_article_limit" type="number" min="0" max="24" defaultValue={s?.daily_article_limit} disabled={dis} /></Field>
            <Field label="Target words (min)"><input className="field" name="target_words_min" type="number" defaultValue={s?.target_words_min} disabled={dis} /></Field>
            <Field label="Target words (max)"><input className="field" name="target_words_max" type="number" defaultValue={s?.target_words_max} disabled={dis} /></Field>
            <Field label="Research rounds per run" hint="Re-research if every candidate is a duplicate"><input className="field" name="max_research_rounds" type="number" min="1" max="4" defaultValue={s?.max_research_rounds} disabled={dis} /></Field>
            <Field label="Max candidates checked per run"><input className="field" name="max_candidates_per_run" type="number" min="1" max="12" defaultValue={s?.max_candidates_per_run} disabled={dis} /></Field>
            <Field label="Missed-run grace (minutes)"><input className="field" name="missed_run_grace_minutes" type="number" min="10" max="360" defaultValue={s?.missed_run_grace_minutes} disabled={dis} /></Field>
            <Field label="If the quality gate fails"><select className="field" name="quality_fail_policy" defaultValue={s?.quality_fail_policy} disabled={dis}><option value="draft">Save as WordPress draft for review</option><option value="fail">Stop; don&apos;t touch WordPress</option></select></Field>
            <Field label="If thumbnail generation fails (after retries)"><select className="field" name="image_failure_policy" defaultValue={s?.image_failure_policy} disabled={dis}><option value="draft">Save as draft without an image</option><option value="fail">Fail the run</option></select></Field>
            <div className="space-y-1.5 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="thumbnail_text_overlay" defaultChecked={s?.thumbnail_text_overlay} disabled={dis} />Overlay headline on thumbnail</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="inject_json_ld" defaultChecked={s?.inject_json_ld} disabled={dis} />Inject NewsArticle JSON-LD (only when no SEO plugin is active)</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="notify_on_failure" defaultChecked={s?.notify_on_failure} disabled={dis} />Alert on failed runs</label>
            </div>
            {isOwner && <div className="md:col-span-3"><Button>Save editorial settings</Button></div>}
          </form>
        </Section>

        <Section id="wordpress" title="WordPress connection" subtitle="Uses a WordPress Application Password over HTTPS. Never use your main admin password.">
          {conn && (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={conn.status === "ok" ? "good" : conn.status === "error" ? "bad" : "neutral"} icon>{conn.status}</Badge>
              <span>{caps.site_name ?? conn.site_url}</span>
              <span className="text-xs text-ink-3">as {conn.username} ({caps.roles?.join(", ")}) · SEO plugin: {conn.seo_plugin} · credential v{conn.credential_version} · password {hasSecret ? "stored encrypted" : "missing"}</span>
              {caps.publish_posts === false && <Badge tone="warn">user cannot publish</Badge>}
            </div>
          )}
          {conn?.seo_plugin === "yoast" && <div className="mb-4"><Notice>Yoast SEO detected. By default Yoast&apos;s meta title and description fields can&apos;t be written through the REST API. EditorialOS attempts the write, checks the result, and reports it on each article. See docs/WORDPRESS.md for an optional snippet that enables these fields. Yoast already outputs Article schema, so no JSON-LD is injected.</Notice></div>}
          {isOwner ? (
            <form action={saveWordPressConnection} className="grid gap-3 md:grid-cols-3">
              <Hidden ws={ws} />
              <Field label="Site URL (https)"><input className="field" name="site_url" defaultValue={conn?.site_url ?? "https://flexplaying.com"} required /></Field>
              <Field label="WordPress username"><input className="field" name="username" defaultValue={conn?.username ?? ""} required autoComplete="off" /></Field>
              <Field label={conn ? "New application password (leave blank to keep)" : "Application password"} hint="WordPress → Users → Profile → Application Passwords"><input className="field" name="app_password" type="password" autoComplete="new-password" required={!conn} /></Field>
              <div className="flex flex-wrap gap-2 md:col-span-3">
                <Button>{conn ? "Save & re-test (rotate credential)" : "Connect & test"}</Button>
              </div>
            </form>
          ) : null}
          {conn && (
            <div className="mt-4 flex flex-wrap gap-2">
              {membership.role !== "viewer" && <form action={testWordPressConnection}><Hidden ws={ws} /><Button variant="secondary">Test connection</Button></form>}
              {isOwner && <form action={disconnectWordPress}><Hidden ws={ws} /><Button variant="danger">Disconnect & delete credentials</Button></form>}
            </div>
          )}
          {conn && (
            <form action={updateCategoryMap} className="mt-5 grid gap-3 md:grid-cols-4">
              <Hidden ws={ws} />
              {CATEGORIES.map((c) => (
                <Field key={c} label={`${CATEGORY_LABEL[c]} → WordPress category`}>
                  <select className="field" name={`cat_${c}`} defaultValue={map[c] ?? ""} disabled={dis}>
                    <option value="">(not mapped)</option>
                    {(caps.categories ?? []).map((wc) => <option key={wc.id} value={wc.id}>{wc.name}</option>)}
                  </select>
                </Field>
              ))}
              {isOwner && <div className="flex items-end"><Button variant="secondary">Save mapping</Button></div>}
            </form>
          )}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section id="models" title="AI models (OpenRouter → Google only)" subtitle="Server defaults come from environment variables. Overrides apply to this workspace and are checked against OpenRouter's model list.">
            <dl className="mb-3 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-ink-3">Text default</dt><dd className="font-mono">{e.OPENROUTER_TEXT_MODEL}</dd></div>
              <div><dt className="text-ink-3">Research default</dt><dd className="font-mono">{e.OPENROUTER_RESEARCH_MODEL}</dd></div>
              <div><dt className="text-ink-3">Image default</dt><dd className="font-mono">{e.OPENROUTER_IMAGE_MODEL}</dd></div>
            </dl>
            <p className="mb-3 text-xs text-ink-3">Every request goes only to Google&apos;s own infrastructure (provider: {e.OPENROUTER_PROVIDER_ONLY}, fallbacks off). Web search uses OpenRouter&apos;s {e.OPENROUTER_WEB_SEARCH_MODE === "server_tool" ? "openrouter:web_search server tool" : "web plugin"}. If a model is unavailable, the run fails with a clear error. It never silently switches to another model.</p>
            <form action={updateModels} className="grid gap-3 md:grid-cols-3">
              <Hidden ws={ws} />
              <Field label="Text override"><input className="field" name="text_model" placeholder={e.OPENROUTER_TEXT_MODEL} defaultValue={s?.text_model ?? ""} disabled={dis} /></Field>
              <Field label="Research override"><input className="field" name="research_model" placeholder={e.OPENROUTER_RESEARCH_MODEL} defaultValue={s?.research_model ?? ""} disabled={dis} /></Field>
              <Field label="Image override"><input className="field" name="image_model" placeholder={e.OPENROUTER_IMAGE_MODEL} defaultValue={s?.image_model ?? ""} disabled={dis} /></Field>
              {isOwner && <div className="flex gap-2 md:col-span-3"><Button>Save overrides</Button></div>}
            </form>
            {isOwner && <form action={checkModels} className="mt-2"><Hidden ws={ws} /><Button variant="secondary">Check default models now</Button></form>}
            <p className="mt-3 text-xs text-ink-3">All usage is billed to the owner of the server&apos;s OpenRouter key, whichever workspace uses it. Usage is broken down per workspace on the Costs page for visibility only.</p>
          </Section>
          <Section id="notifications" title="Notifications" subtitle="Failures and missed runs always appear as in-app alerts. Optionally, also post them to a webhook (Slack, Discord or similar).">
            <form action={saveWebhook} className="space-y-3">
              <Hidden ws={ws} />
              <Field label="Failure webhook URL (https)" hint={hasWebhook ? "A webhook is saved (stored encrypted, not shown). Submit blank to remove it." : "Optional"}><input className="field" name="webhook_url" type="url" placeholder={hasWebhook ? "•••••••• (saved)" : "https://hooks.example.com/..."} disabled={dis} /></Field>
              {isOwner && <Button>Save webhook</Button>}
            </form>
          </Section>
        </div>

        <Section id="members" title="Members & invitations" subtitle="Owners manage settings and credentials; editors can trigger runs and give feedback; viewers can only read.">
          <Table head={["Member", "Role", "Joined", ""]}>
            {(members ?? []).map((m) => (
              <tr key={m.user_id}>
                <td className="text-sm">{profiles?.find((p) => p.id === m.user_id)?.display_name ?? m.user_id.slice(0, 8)}{m.user_id === user.id && <Badge tone="info">you</Badge>}</td>
                <td><Badge>{m.role}</Badge></td>
                <td className="text-xs text-ink-3">{formatInZone(m.created_at, tz)}</td>
                <td>
                  {isOwner && m.user_id !== user.id && (
                    <form action={updateMember} className="flex gap-1">
                      <Hidden ws={ws} />
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <select name="role" className="field !w-auto !py-1 !text-xs" defaultValue={m.role}><option>owner</option><option>editor</option><option>viewer</option></select>
                      <Button variant="ghost" name="action" value="role">Update</Button>
                      <Button variant="danger" name="action" value="remove">Remove</Button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          {isOwner && (
            <>
              <form action={createInvitation} className="mt-4 flex flex-wrap items-end gap-2">
                <Hidden ws={ws} />
                <Field label="Invite by email"><input className="field !w-64" name="email" type="email" required /></Field>
                <Field label="Role"><select className="field !w-auto" name="role"><option>editor</option><option>viewer</option></select></Field>
                <Button>Create invite link</Button>
              </form>
              <p className="mt-2 text-xs text-ink-3">No email is sent. Copy the one-time link from the confirmation message and share it yourself. Invited people need their own account. They never see this workspace&apos;s credentials.</p>
              {(invites ?? []).length > 0 && (
                <div className="mt-3"><Table head={["Email", "Role", "Status", "Expires", ""]}>
                  {(invites ?? []).map((i) => (
                    <tr key={i.id}>
                      <td className="text-sm">{i.email}</td><td><Badge>{i.role}</Badge></td>
                      <td>{i.accepted_at ? <Badge tone="good">accepted</Badge> : i.revoked_at ? <Badge>revoked</Badge> : Date.parse(i.expires_at) < nowMs() ? <Badge tone="warn">expired</Badge> : <Badge tone="info">pending</Badge>}</td>
                      <td className="text-xs text-ink-3">{formatInZone(i.expires_at, tz)}</td>
                      <td>{!i.accepted_at && !i.revoked_at && <form action={revokeInvitation}><Hidden ws={ws} /><input type="hidden" name="id" value={i.id} /><Button variant="ghost">Revoke</Button></form>}</td>
                    </tr>
                  ))}
                </Table></div>
              )}
            </>
          )}
        </Section>
      </div>
    </>
  );
}
