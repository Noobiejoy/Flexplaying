/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { CategoryTag, Empty, ExternalLink, PageHeader, RunStatus, Score, categoryColor, statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatInZone } from "@/lib/dashboard/time";
import { adminClient } from "@/lib/supabase/admin";

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
  // Thumbnails live in a private bucket: sign short-lived URLs for this workspace's own rows (membership verified above).
  const thumbs = new Map<string, string>();
  if (rows.length) {
    const { data: imgs } = await sb.from("article_images").select("article_id,storage_path").in("article_id", rows.map((r) => r.id));
    const paths = (imgs ?? []).filter((i) => i.storage_path);
    if (paths.length) {
      const { data: signed } = await adminClient().storage.from("thumbnails").createSignedUrls(paths.map((i) => i.storage_path as string), 600);
      for (const sgn of signed ?? []) {
        const img = paths.find((i) => i.storage_path === sgn.path);
        if (img && sgn.signedUrl) thumbs.set(img.article_id, sgn.signedUrl);
      }
    }
  }
  const filtered = q || cat !== "all" || status !== "all" || mode !== "all" || wp !== "all" || minQ > 0 || from || to;
  const label = (v: string) => statusLabel(v).replace(/^./, (c) => c.toUpperCase());

  return (
    <>
      <PageHeader title="Articles" description="Everything the desk has written, and where each piece stands on WordPress." />
      <form className="mb-6 flex flex-wrap items-center gap-2" action="/articles" role="search">
        <input className="field !w-full sm:!w-64" name="q" placeholder="Search headlines" defaultValue={q} aria-label="Search headlines" />
        <select className="field !w-auto" name="category" defaultValue={cat} aria-label="Category">{["all", "anime", "gaming", "esports"].map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : label(c)}</option>)}</select>
        <select className="field !w-auto" name="status" defaultValue={status} aria-label="Status">{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "Any status" : label(s)}</option>)}</select>
        <select className="field !w-auto" name="mode" defaultValue={mode} aria-label="Publishing mode">{["all", "dry_run", "draft_only", "auto_publish"].map((s) => <option key={s} value={s}>{s === "all" ? "Any mode" : label(s)}</option>)}</select>
        <select className="field !w-auto" name="wp" defaultValue={wp} aria-label="WordPress state"><option value="all">Any WordPress state</option><option value="synced">On WordPress</option><option value="local">Not on WordPress</option></select>
        <details className="group">
          <summary className="cursor-pointer list-none rounded-lg px-2 py-2 text-[13px] font-medium text-ink-2 hover:text-ink">More filters</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="field !w-32" name="min_quality" type="number" step="0.05" min="0" max="1" placeholder="Min quality" aria-label="Minimum quality score" defaultValue={sp.min_quality ?? ""} />
            <input className="field !w-auto" type="date" name="from" defaultValue={from} aria-label="From date" />
            <input className="field !w-auto" type="date" name="to" defaultValue={to} aria-label="To date" />
          </div>
        </details>
        <button className="rounded-lg border border-[var(--rule-strong)] bg-[var(--surface)] px-3.5 py-2 text-[14px] font-medium hover:bg-[var(--sunken)]">Apply filters</button>
      </form>
      {rows.length === 0 ? (
        <Empty title={filtered ? "No articles match these filters" : "No articles yet"}>{filtered ? "Clear a filter to see more." : "Articles appear here after a run gets through writing. Start a dry run from the Runs page."}</Empty>
      ) : (
        <ol className="panel divide-y divide-[var(--rule)] rounded-xl">
          {rows.map((a) => {
            const thumb = thumbs.get(a.id);
            return (
              <li key={a.id} className="grid grid-cols-[96px_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[152px_minmax(0,1fr)_auto] sm:items-center sm:px-5">
                <Link href={`/articles/${a.id}`} tabIndex={-1} aria-hidden className="block aspect-video overflow-hidden rounded-lg bg-[var(--sunken)]" style={thumb ? undefined : { boxShadow: `inset 0 -3px 0 ${categoryColor(a.category)}` }}>
                  {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
                </Link>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><CategoryTag category={a.category} /><RunStatus status={a.status} /></div>
                  <Link href={`/articles/${a.id}`} className="mt-1 line-clamp-2 block text-[16px] font-semibold leading-snug text-ink hover:underline">{a.headline}</Link>
                  <div className="mt-1 text-[12px] text-ink-3">{formatInZone(a.created_at, tz)}, {a.word_count} words, {statusLabel(a.publishing_mode)}</div>
                </div>
                <div className="col-span-2 flex items-center gap-5 sm:col-span-1 sm:flex-col sm:items-end sm:gap-1.5">
                  <Score value={a.quality_score === null ? null : Number(a.quality_score)} />
                  <span className="text-[13px]">{a.wp_url ? <ExternalLink href={a.wp_url}>Post {a.wp_post_id}</ExternalLink> : <span className="text-ink-3">Not on WordPress</span>}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
