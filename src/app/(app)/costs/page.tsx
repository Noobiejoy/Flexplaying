import { savePricing } from "@/app/actions/settings";
import { BarChart, HBars } from "@/components/charts";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Empty, Field, Notice, PageHeader, Stat, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { addDays, formatLocalDate, localDateOf, startOfLocalDay, startOfLocalMonth } from "@/lib/schedule/slots";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type U = { created_at: string; action: string; model: string; stage: string; cost_usd: number | null; cost_source: string; success: boolean; is_retry: boolean; input_tokens: number | null; output_tokens: number | null; web_searches: number | null; images: number | null; run_id: string | null };

const ACTION_LABEL: Record<string, string> = { research: "Research & search grounding", fact_check: "Fact-checking (search)", dedupe_semantic: "Duplicate review", write: "Article writing", review: "Quality review", image: "Image generation", health_check: "Health checks" };

export default async function Costs({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: settings } = await sb.from("workspace_settings").select("timezone").eq("workspace_id", ws).single();
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const [{ data }, { data: arts }, { data: pricing }] = await Promise.all([
    sb.from("usage_events").select("created_at,action,model,stage,cost_usd,cost_source,success,is_retry,input_tokens,output_tokens,web_searches,images,run_id").eq("workspace_id", ws).gte("created_at", since).order("created_at").limit(20000),
    sb.from("articles").select("status,created_at").eq("workspace_id", ws).gte("created_at", since).in("status", ["published", "drafted", "needs_review"]),
    sb.from("model_pricing").select("*").eq("workspace_id", ws).order("model").order("version", { ascending: false }),
  ]);
  const u = (data ?? []) as U[];
  const sum = (rows: U[]) => rows.reduce((s, r) => s + (r.cost_usd === null ? 0 : Number(r.cost_usd)), 0);
  const unknown = (rows: U[]) => rows.filter((r) => r.cost_usd === null).length;
  const today = startOfLocalDay(now, tz).toISOString();
  const month = startOfLocalMonth(now, tz).toISOString();
  const published = (arts ?? []).filter((a) => a.status === "published").length;
  const produced = (arts ?? []).length;
  const total30 = sum(u);

  const days: { label: string; value: number | null; display: string }[] = [];
  const startDay = localDateOf(new Date(since), tz);
  for (let i = 1; i <= 30; i++) {
    const d = formatLocalDate(addDays(startDay, i));
    const rows = u.filter((r) => formatLocalDate(localDateOf(new Date(r.created_at), tz)) === d);
    const v = sum(rows);
    days.push({ label: d.slice(5), value: rows.length ? v : null, display: rows.length ? `${formatUsd(v)} · ${rows.length} calls${unknown(rows) ? ` (${unknown(rows)} unknown)` : ""}` : "no usage" });
  }
  const group = (key: keyof U, label: (k: string) => string = (k) => k) => {
    const m = new Map<string, U[]>();
    for (const r of u) m.set(String(r[key]), [...(m.get(String(r[key])) ?? []), r]);
    return [...m.entries()].map(([k, rows]) => ({ label: label(k), value: sum(rows), display: `${formatUsd(sum(rows))} · ${rows.length}${unknown(rows) ? ` (${unknown(rows)} unknown)` : ""}`, rows })).sort((a, b) => b.value - a.value);
  };
  const byAction = group("action", (k) => ACTION_LABEL[k] ?? k);
  const byModel = group("model");
  const retries = u.filter((r) => r.is_retry || !r.success);
  const providerReported = u.filter((r) => r.cost_source === "provider_reported").length;
  const e = env();
  const models = [...new Set([e.OPENROUTER_TEXT_MODEL, e.OPENROUTER_RESEARCH_MODEL, e.OPENROUTER_IMAGE_MODEL, ...u.map((r) => r.model)])];

  return (
    <>
      <PageHeader title="Costs & usage" description="AI usage recorded for every call. Costs come from OpenRouter's response when it reports them; otherwise they're estimated from your pricing table, or marked unknown." />
      <Flash searchParams={searchParams} />
      <div className="mb-4"><Notice>All workspaces share the server&apos;s OpenRouter API key, so every charge goes to the owner of that key. This page breaks usage down by workspace for visibility only. It does not create separate billing accounts.</Notice></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Today" value={formatUsd(sum(u.filter((r) => r.created_at >= today)))} hint={`${unknown(u.filter((r) => r.created_at >= today))} call(s) with unknown cost`} />
        <Stat label="This month" value={formatUsd(sum(u.filter((r) => r.created_at >= month)))} hint={`${unknown(u.filter((r) => r.created_at >= month))} call(s) with unknown cost`} />
        <Stat label="Per published article (30d)" value={published ? formatUsd(total30 / published) : "—"} hint={`${published} published`} />
        <Stat label="Per article produced (30d)" value={produced ? formatUsd(total30 / produced) : "—"} hint={`${produced} published, drafted or held for review`} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Daily spend (last 30 days)" subtitle={`${u.length} calls · ${providerReported} with provider-reported cost`}>
          {u.length ? <BarChart data={days} title="Daily AI spend" /> : <Empty title="No usage recorded yet" />}
        </Card>
        <Card title="Retries and failed attempts">
          <div className="text-2xl font-semibold tabular-nums">{formatUsd(sum(retries))}</div>
          <p className="text-xs text-ink-3">{retries.length} call(s) were retries or failed. These are included in the totals.</p>
        </Card>
        <Card title="By action" className="lg:col-span-2">{byAction.length ? <HBars data={byAction} /> : <Empty title="No data" />}</Card>
        <Card title="By model">{byModel.length ? <HBars data={byModel} /> : <Empty title="No data" />}</Card>
      </div>
      <Card title="Token usage by model (30 days)" className="mt-4">
        <Table head={["Model", "Calls", "Input tokens", "Output tokens", "Web searches", "Images", "Cost", "Unknown cost"]} empty={byModel.length === 0}>
          {byModel.map((g) => (
            <tr key={g.label}>
              <td className="font-mono text-xs">{g.label}</td>
              <td className="tabular-nums">{g.rows.length}</td>
              <td className="tabular-nums">{g.rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0).toLocaleString()}</td>
              <td className="tabular-nums">{g.rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0).toLocaleString()}</td>
              <td className="tabular-nums">{g.rows.reduce((s, r) => s + (r.web_searches ?? 0), 0) || "—"}</td>
              <td className="tabular-nums">{g.rows.reduce((s, r) => s + (r.images ?? 0), 0) || "—"}</td>
              <td className="tabular-nums">{formatUsd(g.value)}</td>
              <td className="tabular-nums">{unknown(g.rows)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <div id="pricing" className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Pricing table (fallback estimates)" subtitle="Versioned. Used only when OpenRouter does not report a cost. Check prices at openrouter.ai/models.">
          {(pricing ?? []).length === 0 ? <Empty title="No pricing entered">Without pricing, calls that don&apos;t report a cost show as unknown. That&apos;s intentional: the app never guesses prices.</Empty> : (
            <Table head={["Model", "v", "In / Mtok", "Out / Mtok", "Search", "Image", "Note"]}>
              {(pricing ?? []).map((p) => (
                <tr key={p.id}><td className="font-mono text-xs">{p.model}</td><td>{p.version}{p.active && <Badge tone="good">active</Badge>}</td><td>{p.input_per_mtok ?? "—"}</td><td>{p.output_per_mtok ?? "—"}</td><td>{p.per_web_search ?? "—"}</td><td>{p.per_image ?? "—"}</td><td className="text-xs text-ink-3">{p.source_note}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        {membership.role === "owner" && (
          <Card title="Add pricing version">
            <form action={savePricing} className="grid grid-cols-2 gap-3">
              <input type="hidden" name="workspace_id" value={ws} />
              <div className="col-span-2"><Field label="Model"><select className="field" name="model">{models.map((m) => <option key={m}>{m}</option>)}</select></Field></div>
              <Field label="Input $ / 1M tokens"><input className="field" name="input_per_mtok" inputMode="decimal" /></Field>
              <Field label="Output $ / 1M tokens"><input className="field" name="output_per_mtok" inputMode="decimal" /></Field>
              <Field label="$ per web search"><input className="field" name="per_web_search" inputMode="decimal" /></Field>
              <Field label="$ per image"><input className="field" name="per_image" inputMode="decimal" /></Field>
              <div className="col-span-2"><Field label="Source note" hint="Where these prices came from and when"><input className="field" name="source_note" maxLength={300} /></Field></div>
              <div className="col-span-2"><Button>Save new version</Button></div>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
