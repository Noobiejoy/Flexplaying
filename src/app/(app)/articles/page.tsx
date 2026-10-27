import Link from "next/link";
import { Badge, Card, ExternalLink, PageHeader, RunStatus, Score, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatInZone } from "@/lib/dashboard/time";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "published", "drafted", "needs_review", "dry_run", "failed", "ready", "writing"];

export default async function Articles({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: settings } = await sb.from("workspace_settings").select("timezone").eq("workspace_id", ws).single();
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const cat = ["anime", "gaming", "esports"].includes(sp.category ?? "") ? sp.category! : "all";
  const status = STATUSES.includes(sp.status ?? "") ? sp.status! : "all";
  const mode = ["dry_run", "draft_only", "auto_publish"].includes(sp.mode ?? "") ? sp.mode! : "all";
  const wp = ["synced", "local"].includes(sp.wp ?? "") ? sp.wp! : "all";
  const minQ = Number(sp.min_quality ?? "");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : "";
  const q = (sp.q ?? "").trim().slice(0, 80).replace(/[%_]/g, "");

  let query = sb.from("articles").select("id,headline,category,status,publishing_mode,quality_score,word_count,wp_url,wp_post_id,created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(100);
  if (cat !== "all") query = query.eq("category", cat);
  if (status !== "all") query = query.eq("status", status);
  if (mode !== "all") query = query.eq("publishing_mode", mode);
  if (wp === "synced") query = query.not("wp_post_id", "is", null);
  if (wp === "local") query = query.is("wp_post_id", null);
  if (Number.isFinite(minQ) && minQ > 0) query = query.gte("quality_score", minQ);
  if (from) query = query.gte("created_at", `${from}T00:00:00Z`);
  if (to) query = query.lte("created_at", `${to}T23:59:59Z`);
  if (q) query = query.ilike("headline", `%${q}%`);
  const { data } = await query;
  const rows = data ?? [];

  return (
    <>
      <PageHeader title="Article library" description="Everything the agent has written, with its WordPress state." />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/articles">
        <input className="field !w-56" name="q" placeholder="Search headlines" defaultValue={q} />
        <select className="field !w-auto" name="category" defaultValue={cat}>{["all", "anime", "gaming", "esports"].map((c) => <option key={c}>{c}</option>)}</select>
        <select className="field !w-auto" name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
        <select className="field !w-auto" name="mode" defaultValue={mode}>{["all", "dry_run", "draft_only", "auto_publish"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
        <select className="field !w-auto" name="wp" defaultValue={wp}><option value="all">any WordPress state</option><option value="synced">on WordPress</option><option value="local">not on WordPress</option></select>
        <input className="field !w-28" name="min_quality" type="number" step="0.05" min="0" max="1" placeholder="min quality" defaultValue={sp.min_quality ?? ""} />
        <input className="field !w-auto" type="date" name="from" defaultValue={from} aria-label="From date" />
        <input className="field !w-auto" type="date" name="to" defaultValue={to} aria-label="To date" />
        <button className="glass-strong rounded-full px-3.5 py-1.5 text-sm">Filter</button>
      </form>
      <Card>
        <Table head={["Headline", "Category", "Status", "Mode", "Quality", "Words", "Created", "WordPress"]} empty={rows.length === 0}>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="max-w-[360px]"><Link href={`/articles/${a.id}`} className="font-medium text-[var(--accent)]">{a.headline}</Link></td>
              <td><Badge>{a.category}</Badge></td>
              <td><RunStatus status={a.status} /></td>
              <td className="text-xs text-ink-2">{a.publishing_mode.replace("_", " ")}</td>
              <td><Score value={a.quality_score === null ? null : Number(a.quality_score)} /></td>
              <td className="text-xs tabular-nums text-ink-2">{a.word_count}</td>
              <td className="text-xs text-ink-2">{formatInZone(a.created_at, tz)}</td>
              <td className="text-xs">{a.wp_url ? <ExternalLink href={a.wp_url}>#{a.wp_post_id} ↗</ExternalLink> : <span className="text-ink-3">—</span>}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
