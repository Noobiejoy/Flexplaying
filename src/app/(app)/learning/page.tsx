import { nowMs } from "@/lib/dashboard/time";
import { activatePreferenceVersion, updateManualPreferences } from "@/app/actions/feedback";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Empty, Field, Notice, PageHeader, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatInZone } from "@/lib/dashboard/time";
import { DEFAULT_WEIGHTS } from "@/lib/editorial/preferences";

export const dynamic = "force-dynamic";

type Pref = { id: string; version: number; active: boolean; source: string; scoring_weights: Record<string, number>; category_weights: Record<string, number>; entity_adjustments: Record<string, number>; blocked_terms: string[]; change_summary: string; signals: Record<string, number>; created_at: string };

export default async function Learning({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const [{ data: prefs }, { data: settings }, { data: feedback }, { data: outcomes }] = await Promise.all([
    sb.from("editorial_preferences").select("*").eq("workspace_id", ws).order("version", { ascending: false }).limit(30),
    sb.from("workspace_settings").select("timezone").eq("workspace_id", ws).single(),
    sb.from("topic_feedback").select("verdict, created_at, topic_candidates(headline, category)").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(20),
    sb.from("topic_candidates").select("status").eq("workspace_id", ws).gte("created_at", new Date(nowMs() - 30 * 86400_000).toISOString()),
  ]);
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const list = (prefs ?? []) as Pref[];
  const active = list.find((p) => p.active);
  const counts = (outcomes ?? []).reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const isOwner = membership.role === "owner";
  const ents = Object.entries(active?.entity_adjustments ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHeader title="Editorial feedback & learning" description="What the agent has learned about this site, and the evidence behind each change." />
      <Flash searchParams={searchParams} />
      <div className="mb-4"><Notice>The agent does not train a model or rewrite its own code. Its &quot;learning&quot; is a small, versioned set of scoring weights, category weights and entity adjustments. They are updated by fixed rules from your feedback and from logged outcomes, and you can inspect or revert every change.</Notice></div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={`Active preferences${active ? ` (v${active.version})` : ""}`} subtitle={active ? `${active.source} · ${formatInZone(active.created_at, tz)}` : undefined}>
          {active ? (
            <div className="space-y-3 text-sm">
              <div><div className="mb-1 text-[11px] text-ink-3">Scoring weights</div>{Object.entries(active.scoring_weights).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-ink-2">{k.replace("_", " ")}</span><span className="tabular-nums">{Number(v).toFixed(2)}</span></div>)}</div>
              <div><div className="mb-1 text-[11px] text-ink-3">Category weights</div>{Object.entries(active.category_weights).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-ink-2">{k}</span><span className="tabular-nums">×{Number(v).toFixed(2)}</span></div>)}</div>
              <div><div className="mb-1 text-[11px] text-ink-3">Blocked terms</div>{active.blocked_terms.length ? active.blocked_terms.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-ink-3">none</span>}</div>
            </div>
          ) : <Empty title="No preferences" />}
        </Card>
        <Card title="Learned entity adjustments" subtitle="Added to the relevance score when a story mentions the entity (bounded ±0.30)">
          {ents.length ? (
            <ul className="space-y-1 text-sm">{ents.slice(0, 25).map(([e, v]) => <li key={e} className="flex justify-between"><span className="text-ink-2">{e}</span><Badge tone={v > 0 ? "good" : "bad"}>{v > 0 ? "+" : ""}{v.toFixed(2)}</Badge></li>)}</ul>
          ) : <Empty title="Nothing learned yet">Mark topics as interesting or irrelevant on the Research page.</Empty>}
        </Card>
        <Card title="Signals (last 30 days)">
          <ul className="space-y-1 text-sm">
            {[["Published", counts.published], ["Drafted", counts.drafted], ["Duplicates rejected", counts.duplicate], ["Insufficient evidence", counts.insufficient_evidence], ["Below threshold", counts.below_threshold], ["Held for review", counts.needs_review]].map(([k, v]) => <li key={String(k)} className="flex justify-between"><span className="text-ink-2">{k}</span><span className="tabular-nums">{v ?? 0}</span></li>)}
          </ul>
          <div className="mt-4 text-[11px] text-ink-3">Recent feedback</div>
          <ul className="mt-1 space-y-1 text-xs">
            {((feedback ?? []) as unknown as { verdict: string; created_at: string; topic_candidates: { headline: string; category: string } | null }[]).map((f, i) => (
              <li key={i} className="flex items-start gap-2"><Badge tone={f.verdict === "interesting" ? "good" : f.verdict === "irrelevant" ? "bad" : "neutral"}>{f.verdict.replace("_", " ")}</Badge><span className="text-ink-2">{f.topic_candidates?.headline}</span></li>
            ))}
            {(feedback ?? []).length === 0 && <li className="text-ink-3">No feedback yet.</li>}
          </ul>
        </Card>
      </div>
      <Card title="Version history" className="mt-4">
        <Table head={["Version", "Source", "Changes", "Signals", "Created", ""]} empty={list.length === 0}>
          {list.map((p) => (
            <tr key={p.id}>
              <td>v{p.version} {p.active && <Badge tone="good">active</Badge>}</td>
              <td><Badge>{p.source}</Badge></td>
              <td className="max-w-[420px] text-xs text-ink-2">{p.change_summary}</td>
              <td className="text-[11px] text-ink-3">{Object.entries(p.signals ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</td>
              <td className="text-xs text-ink-3">{formatInZone(p.created_at, tz)}</td>
              <td>{isOwner && !p.active && <form action={activatePreferenceVersion}><input type="hidden" name="workspace_id" value={ws} /><input type="hidden" name="version" value={p.version} /><Button variant="ghost">Revert to this</Button></form>}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {isOwner && active && (
        <Card title="Edit scoring manually" className="mt-4" subtitle="Saving creates a new version; weights are normalised during scoring">
          <form action={updateManualPreferences} className="grid gap-3 md:grid-cols-6">
            <input type="hidden" name="workspace_id" value={ws} />
            {(Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[]).map((k) => (
              <Field key={k} label={k.replace("_", " ")}><input className="field" name={`w_${k}`} type="number" step="0.05" min="0" max="1" defaultValue={active.scoring_weights[k] ?? DEFAULT_WEIGHTS[k]} /></Field>
            ))}
            <div className="md:col-span-6"><Field label="Blocked terms (comma separated)" hint="Stories mentioning these are rejected before writing"><input className="field" name="blocked_terms" defaultValue={active.blocked_terms.join(", ")} /></Field></div>
            <div className="md:col-span-6"><Button>Save as new version</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
