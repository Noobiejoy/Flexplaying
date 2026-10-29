/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { notFound } from "next/navigation";
import sanitizeHtml from "sanitize-html";
import { Card, CategoryTag, ExternalLink, KeyValues, LinkButton, Notice, PageHeader, RunStatus, Score, Table, statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { formatUsd } from "@/lib/costs/pricing";
import { formatInZone } from "@/lib/dashboard/time";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Check = { id: string; label: string; pass: boolean; severity: string; detail: string };

function Checks({ checks }: { checks: Check[] | undefined }) {
  if (!checks?.length) return <p className="text-[14px] text-ink-3">Not checked yet.</p>;
  const sorted = [...checks].sort((x, y) => Number(x.pass) - Number(y.pass));
  return (
    <ul className="divide-y divide-[var(--rule)]">
      {sorted.map((c) => {
        const color = c.pass ? "var(--good)" : c.severity === "error" ? "var(--bad)" : "var(--warn)";
        return (
          <li key={c.id} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0 text-[13px]">
            <span aria-hidden className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white" style={{ background: color }}>{c.pass ? "✓" : "!"}</span>
            <div className="min-w-0">
              <div className="text-ink">{c.label}<span className="sr-only">: {c.pass ? "passed" : c.severity === "error" ? "failed" : "warning"}</span></div>
              {!c.pass && c.detail && <div className="mt-0.5 break-words text-[12px] text-ink-3">{c.detail}</div>}
            </div>
          </li>
        );
      })}
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

  const claimRows = (claims.data ?? []) as unknown as { id: string; text: string; kind: string; importance: string; status: string; notes: string | null; claim_sources: { sources: { url: string; title: string | null; domain: string; quality_tier: string } | null }[] }[];
  const qualityFailed = (quality.checks ?? []).some((c) => !c.pass && c.severity === "error");

  return (
    <>
      <PageHeader
        kicker={<Link href="/articles" className="hover:text-ink">Articles</Link>}
        title={a.headline}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <CategoryTag category={a.category} />
            <RunStatus status={a.status} />
            <span className="text-ink-3">{a.word_count} words, written {formatInZone(a.created_at, tz)}</span>
          </span>
        }
        actions={
          <>
            {a.run_id && <LinkButton href={`/activity/${a.run_id}`} variant="ghost">Run trace</LinkButton>}
            {a.wp_url && <a href={a.wp_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg border border-[var(--rule-strong)] bg-[var(--surface)] px-3.5 py-2 text-[14px] font-medium hover:bg-[var(--sunken)]">View on site<span className="sr-only"> (opens in a new tab)</span></a>}
            {editUrl && <a href={editUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg bg-[var(--ink)] px-3.5 py-2 text-[14px] font-medium text-[var(--on-ink)] hover:opacity-90">Edit in WordPress<span className="sr-only"> (opens in a new tab)</span></a>}
          </>
        }
      />
      {a.status === "needs_review" && (
        <div className="mb-6">
          <Notice tone="warn" title="This draft needs a person">
            {qualityFailed ? "It didn't pass every quality check. The failed checks are listed under Quality gate." : "It was held back for review."} {editUrl ? "Review and publish it in WordPress when it's ready." : ""}
          </Notice>
        </div>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          <article className="panel overflow-hidden rounded-xl">
            {imageUrl ? <img src={imageUrl} alt={image.data?.alt_text ?? ""} className="aspect-video w-full object-cover" /> : <div className="grid aspect-[3/1] place-items-center bg-[var(--sunken)] text-[14px] text-ink-3">{image.data?.status === "failed" ? `Thumbnail failed: ${image.data.error}` : "No thumbnail"}</div>}
            <div className="mx-auto max-w-[68ch] px-5 py-7 sm:px-8">
              {a.draft_headline && a.draft_headline !== a.headline && <p className="mb-2 text-[12px] text-ink-3">First-draft headline: {a.draft_headline}</p>}
              {a.excerpt && <p className="mb-5 text-[17px] leading-relaxed text-ink">{a.excerpt}</p>}
              <div className="prose-article text-[16px]" dangerouslySetInnerHTML={{ __html: safeBody }} />
            </div>
          </article>

          <Card title="Claims and evidence" subtitle="Each fact the article relies on, and the sources that back it">
            {claimRows.length === 0 ? <p className="text-[14px] text-ink-3">No claims were recorded for this article.</p> : (
              <ul className="divide-y divide-[var(--rule)]">
                {claimRows.map((c) => (
                  <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2"><RunStatus status={c.status} /><span className="text-[12px] text-ink-3">{c.kind}{c.importance === "high" ? ", key fact" : ""}</span></div>
                    <p className="mt-1.5 text-[14px] text-ink">{c.text}</p>
                    {c.notes && <p className="mt-0.5 text-[12px] text-ink-3">{c.notes}</p>}
                    {c.claim_sources.some((x) => x.sources) && (
                      <ul className="mt-1.5 space-y-0.5 text-[13px]">{c.claim_sources.filter((x) => x.sources).map((x) => <li key={x.sources!.url} className="truncate"><ExternalLink href={x.sources!.url}>{x.sources!.title ?? x.sources!.domain}</ExternalLink> <span className="text-[12px] text-ink-3">{x.sources!.quality_tier}</span></li>)}</ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Revisions">
            <Table head={["#", "Source", "Headline", "What changed", "When"]} empty={(revisions.data ?? []).length === 0}>
              {(revisions.data ?? []).map((r) => (
                <tr key={r.revision}><td className="tabular-nums">{r.revision}</td><td className="text-[13px] text-ink-2">{r.source}</td><td className="text-[14px]">{r.headline}</td><td className="max-w-[300px] text-[13px] text-ink-2">{r.change_summary}</td><td className="text-[13px] text-ink-3">{formatInZone(r.created_at, tz)}</td></tr>
              ))}
            </Table>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Quality gate" action={<Score value={a.quality_score === null ? null : Number(a.quality_score)} />} subtitle={quality.decision ? statusLabel(quality.decision).replace(/^./, (c) => c.toUpperCase()) : undefined}>
            <Checks checks={quality.checks} />
            {quality.issues?.length ? (
              <div className="mt-4 border-t border-[var(--rule)] pt-3">
                <div className="mb-1 text-[12px] font-medium text-ink-2">Reviewer notes</div>
                <ul className="list-disc space-y-1 pl-4 text-[13px] text-ink-2">{quality.issues.map((i) => <li key={i}>{i}</li>)}</ul>
              </div>
            ) : null}
          </Card>
          <Card title="Search and answer-engine fields">
            <dl className="space-y-3 text-[14px]">
              {[["SEO title", a.seo_title], ["Slug", a.slug], ["Meta description", a.meta_description], ["Primary keyword", a.primary_keyword], ["Secondary keywords", (a.secondary_keywords ?? []).join(", ")], ["Tags", (a.tags ?? []).join(", ")], ["Entities", (a.entities ?? []).join(", ")], ["Image alt text", image.data?.alt_text ?? ""]].map(([k, v]) => (
                <div key={k}><dt className="text-[12px] text-ink-3">{k}</dt><dd className="break-words text-ink">{v || "—"}</dd></div>
              ))}
            </dl>
            <div className="mt-4 border-t border-[var(--rule)] pt-3 text-[13px] text-ink-2">
              <span className="font-medium text-ink">SEO plugin sync:</span> {seoSync.plugin ? `${seoSync.plugin}, ${seoSync.status}` : "not published yet"}
              {seoSync.detail && <p className="mt-1 text-ink-3">{seoSync.detail}</p>}
              {seoSync.json_ld && <p className="mt-1 text-ink-3">{seoSync.json_ld}</p>}
            </div>
            <div className="mt-4 border-t border-[var(--rule)] pt-3"><Checks checks={seo.checks} /></div>
            {seo.removedLinks?.length ? <p className="mt-3 text-[12px] text-[var(--warn)]">Removed unverified links: {seo.removedLinks.join(", ")}</p> : null}
            <details className="mt-3"><summary className="cursor-pointer text-[13px] text-ink-3 hover:text-ink-2">Structured data (NewsArticle)</summary><pre className="mt-1.5 max-h-60 overflow-auto rounded-lg bg-[var(--sunken)] p-3 font-mono text-[12px]">{JSON.stringify(a.json_ld, null, 2)}</pre></details>
          </Card>
          <Card title="Originality">
            <KeyValues rows={[["Overlap with sources", `${((originality.maxSourceOverlap ?? 0) * 100).toFixed(1)}%`], ["Overlap with your site", `${((originality.maxExistingOverlap ?? 0) * 100).toFixed(1)}%`], ["Source excerpts compared", originality.comparedSources ?? 0]]} />
            <p className="mt-3 text-[12px] text-ink-3">{originality.note} This is not a guarantee against every plagiarism checker.</p>
            {originality.flaggedPassages?.length ? <ul className="mt-2 space-y-1 text-[12px] text-[var(--warn)]">{originality.flaggedPassages.map((p) => <li key={p.passage}>“{p.passage}”</li>)}</ul> : null}
          </Card>
          <Card title="WordPress">
            <KeyValues rows={[["Post", a.wp_post_id ? `${a.wp_post_id} (${a.wp_status})` : "Not created"], ["Featured image", a.wp_featured_media_id ?? "—"], ["Last synced", formatInZone(a.wp_synced_at, tz)]]} />
            {(sync.data ?? []).length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[13px] text-ink-3 hover:text-ink-2">Sync log ({(sync.data ?? []).length})</summary>
                <ul className="mt-2 space-y-1 text-[12px]">{(sync.data ?? []).map((e, i) => <li key={i} className="flex justify-between gap-2"><span style={{ color: e.status === "ok" ? "var(--good)" : e.status === "error" ? "var(--bad)" : "var(--ink-2)" }}>{e.action}</span><span className="text-ink-3">{formatInZone(e.created_at, tz)}{e.wp_id ? `, id ${e.wp_id}` : ""}</span></li>)}</ul>
              </details>
            )}
          </Card>
          <Card title="Cost">
            <KeyValues rows={[["Writing, review and image", formatUsd(direct)], ["Whole run, with research", formatUsd(runTotal)]]} />
            {unknown > 0 && <p className="mt-2 text-[12px] text-[var(--warn)]">{unknown} call(s) had no reported cost, so these totals are a lower bound.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
