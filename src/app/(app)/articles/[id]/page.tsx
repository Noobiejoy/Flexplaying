/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { notFound } from "next/navigation";
import sanitizeHtml from "sanitize-html";
import { Badge, Card, ExternalLink, PageHeader, RunStatus, Score, Table } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { formatInZone } from "@/lib/dashboard/time";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Check = { id: string; label: string; pass: boolean; severity: string; detail: string };

function Checks({ checks }: { checks: Check[] | undefined }) {
  if (!checks?.length) return <p className="text-sm text-ink-3">Not evaluated yet.</p>;
  return (
    <ul className="space-y-1.5">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start justify-between gap-3 text-sm">
          <span className="flex items-center gap-2"><Badge tone={c.pass ? "good" : c.severity === "error" ? "bad" : "warn"} icon>{c.pass ? "pass" : c.severity}</Badge>{c.label}</span>
          <span className="max-w-[55%] text-right text-xs text-ink-3">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function ArticleDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sb, membership } = await currentWorkspace();
  const ws = membership.workspace_id;
  const { data: a } = await sb.from("articles").select("*").eq("id", id).eq("workspace_id", ws).maybeSingle();
  if (!a) notFound();
  const [settings, image, revisions, claims, usage, runUsage, conn, sync] = await Promise.all([
    sb.from("workspace_settings").select("timezone").eq("workspace_id", ws).single(),
    sb.from("article_images").select("*").eq("article_id", id).maybeSingle(),
    sb.from("article_revisions").select("revision,source,headline,change_summary,created_at").eq("article_id", id).order("revision"),
    a.candidate_id ? sb.from("claims").select("id,text,kind,importance,status,notes, claim_sources(sources(url,title,domain,quality_tier))").eq("candidate_id", a.candidate_id) : Promise.resolve({ data: [] }),
    sb.from("usage_events").select("action,cost_usd").eq("article_id", id),
    a.run_id ? sb.from("usage_events").select("cost_usd").eq("run_id", a.run_id) : Promise.resolve({ data: [] }),
    sb.from("wordpress_connections").select("site_url").eq("workspace_id", ws).maybeSingle(),
    sb.from("wp_sync_events").select("action,status,wp_id,detail,created_at").eq("article_id", id).order("created_at"),
  ]);
  const tz = settings.data?.timezone ?? "Asia/Kolkata";
  let imageUrl: string | null = null;
  if (image.data?.storage_path) {
    // Membership was verified above; sign a short-lived URL for this workspace's own file.
    const signed = await adminClient().storage.from("thumbnails").createSignedUrl(image.data.storage_path, 600);
    imageUrl = signed.data?.signedUrl ?? null;
  }
  const safeBody = sanitizeHtml(a.body_html, {
    allowedTags: ["p", "h2", "h3", "h4", "ul", "ol", "li", "a", "strong", "em", "b", "i", "blockquote", "cite", "br", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    allowedAttributes: { a: ["href", "rel", "target"] },
    allowedSchemes: ["https", "http"],
  });
  const seo = (a.seo_report ?? {}) as { checks?: Check[]; schemaErrors?: string[]; removedLinks?: string[]; internalLinks?: string[] };
  const quality = (a.quality_report ?? {}) as { checks?: Check[]; score?: number; decision?: string; issues?: string[]; review?: { scores?: Record<string, number> } };
  const originality = (a.originality_report ?? {}) as { maxSourceOverlap?: number; maxExistingOverlap?: number; flaggedPassages?: { passage: string; matchedIn: string }[]; note?: string; comparedSources?: number };
  const seoSync = (a.seo_sync ?? {}) as { plugin?: string; status?: string; detail?: string; json_ld?: string };
  const direct = (usage.data ?? []).reduce((s, x) => s + (x.cost_usd === null ? 0 : Number(x.cost_usd)), 0);
  const runTotal = (runUsage.data ?? []).reduce((s, x) => s + (x.cost_usd === null ? 0 : Number(x.cost_usd)), 0);
  const unknown = (runUsage.data ?? []).filter((x) => x.cost_usd === null).length;
  const editUrl = conn.data && a.wp_post_id ? `${conn.data.site_url}/wp-admin/post.php?post=${a.wp_post_id}&action=edit` : null;

  return (
    <>
      <PageHeader
        title={a.headline}
        description={<span className="inline-flex flex-wrap items-center gap-2"><Badge>{a.category}</Badge><RunStatus status={a.status} /><span>{a.word_count} words · {formatInZone(a.created_at, tz)}</span></span>}
        actions={
          <>
            {a.wp_url && <ExternalLink href={a.wp_url}>View on site ↗</ExternalLink>}
            {editUrl && <ExternalLink href={editUrl}>Edit in WordPress ↗</ExternalLink>}
            {a.run_id && <Link className="text-sm text-[var(--accent)]" href={`/activity/${a.run_id}`}>Run trace →</Link>}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            {imageUrl ? <img src={imageUrl} alt={image.data?.alt_text ?? ""} className="mb-4 aspect-video w-full rounded-xl object-cover" /> : <div className="mb-4 rounded-xl bg-[var(--hairline)] p-6 text-center text-sm text-ink-3">{image.data?.status === "failed" ? `Thumbnail failed: ${image.data.error}` : "No thumbnail"}</div>}
            {a.draft_headline && a.draft_headline !== a.headline && <p className="mb-2 text-xs text-ink-3">Draft headline: {a.draft_headline}</p>}
            <p className="mb-3 text-sm italic text-ink-2">{a.excerpt}</p>
            <div className="prose-article text-[15px]" dangerouslySetInnerHTML={{ __html: safeBody }} />
          </Card>
          <Card title="Claims and evidence" subtitle="Each important claim with the sources that support it">
            <ul className="space-y-3">
              {((claims.data ?? []) as unknown as { id: string; text: string; kind: string; importance: string; status: string; notes: string | null; claim_sources: { sources: { url: string; title: string | null; domain: string; quality_tier: string } | null }[] }[]).map((c) => (
                <li key={c.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone={c.status.includes("confirmed") ? "good" : c.status === "single_source" ? "warn" : "bad"} icon>{c.status.replace("_", " ")}</Badge><Badge>{c.kind}</Badge>{c.importance === "high" && <Badge tone="info">key</Badge>}</div>
                  <p className="mt-1 text-ink">{c.text}</p>
                  {c.notes && <p className="text-xs text-ink-3">{c.notes}</p>}
                  <ul className="mt-1 text-xs">{c.claim_sources.filter((x) => x.sources).map((x) => <li key={x.sources!.url} className="truncate"><ExternalLink href={x.sources!.url}>{x.sources!.title ?? x.sources!.domain}</ExternalLink> <span className="text-ink-3">({x.sources!.quality_tier})</span></li>)}</ul>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Revisions">
            <Table head={["#", "Source", "Headline", "Change", "When"]}>
              {(revisions.data ?? []).map((r) => (
                <tr key={r.revision}><td>{r.revision}</td><td><Badge>{r.source}</Badge></td><td className="text-sm">{r.headline}</td><td className="max-w-[300px] text-xs text-ink-2">{r.change_summary}</td><td className="text-xs text-ink-3">{formatInZone(r.created_at, tz)}</td></tr>
              ))}
            </Table>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Quality gate" action={<Score value={a.quality_score === null ? null : Number(a.quality_score)} />}>
            {quality.decision && <p className="mb-2 text-xs text-ink-3">Decision: {quality.decision.replace(/_/g, " ")}</p>}
            <Checks checks={quality.checks} />
            {quality.issues?.length ? <ul className="mt-3 list-disc pl-4 text-xs text-ink-2">{quality.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
          </Card>
          <Card title="SEO / AEO fields">
            <dl className="space-y-2 text-sm">
              {[["SEO title", a.seo_title], ["Slug", a.slug], ["Meta description", a.meta_description], ["Primary keyword", a.primary_keyword], ["Secondary", (a.secondary_keywords ?? []).join(", ")], ["Tags", (a.tags ?? []).join(", ")], ["Entities", (a.entities ?? []).join(", ")], ["Image alt", image.data?.alt_text ?? "—"]].map(([k, v]) => (
                <div key={k}><dt className="text-[11px] text-ink-3">{k}</dt><dd className="text-ink">{v || "—"}</dd></div>
              ))}
            </dl>
            <div className="mt-3 text-xs text-ink-2"><span className="font-medium">SEO plugin sync:</span> {seoSync.plugin ? `${seoSync.plugin} — ${seoSync.status}` : "not published yet"}{seoSync.detail && <p className="mt-1 text-ink-3">{seoSync.detail}</p>}{seoSync.json_ld && <p className="mt-1 text-ink-3">{seoSync.json_ld}</p>}</div>
            <div className="mt-3"><Checks checks={seo.checks} /></div>
            {seo.removedLinks?.length ? <p className="mt-2 text-xs text-[var(--warn)]">Removed unverified links: {seo.removedLinks.join(", ")}</p> : null}
            <details className="mt-3"><summary className="cursor-pointer text-xs text-ink-3">Structured data (NewsArticle)</summary><pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-[var(--hairline)] p-2 text-[11px]">{JSON.stringify(a.json_ld, null, 2)}</pre></details>
          </Card>
          <Card title="Originality review">
            <p className="text-sm">Max overlap with sources: <strong>{((originality.maxSourceOverlap ?? 0) * 100).toFixed(1)}%</strong>; with site articles: <strong>{((originality.maxExistingOverlap ?? 0) * 100).toFixed(1)}%</strong></p>
            <p className="mt-1 text-xs text-ink-3">{originality.note} Compared against {originality.comparedSources ?? 0} source excerpt(s). This is not a guarantee against every plagiarism checker.</p>
            {originality.flaggedPassages?.length ? <ul className="mt-2 space-y-1 text-xs text-[var(--warn)]">{originality.flaggedPassages.map((p) => <li key={p.passage}>“{p.passage}”</li>)}</ul> : null}
          </Card>
          <Card title="WordPress">
            <p className="text-sm">Post: {a.wp_post_id ? `#${a.wp_post_id} (${a.wp_status})` : "not created"}</p>
            <p className="text-xs text-ink-3">Featured media: {a.wp_featured_media_id ?? "—"} · synced {formatInZone(a.wp_synced_at, tz)}</p>
            <ul className="mt-2 space-y-1 text-xs">{(sync.data ?? []).map((e, i) => <li key={i}><Badge tone={e.status === "ok" ? "good" : e.status === "error" ? "bad" : "neutral"}>{e.action}</Badge> <span className="text-ink-3">{formatInZone(e.created_at, tz)}{e.wp_id ? ` · id ${e.wp_id}` : ""}</span></li>)}</ul>
          </Card>
          <Card title="Estimated cost">
            <p className="text-sm">Writing, review and image: <strong>{formatUsd(direct)}</strong></p>
            <p className="text-sm">Whole run (incl. research): <strong>{formatUsd(runTotal)}</strong></p>
            {unknown > 0 && <p className="text-xs text-[var(--warn)]">{unknown} call(s) had no reported cost; totals are a lower bound.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
