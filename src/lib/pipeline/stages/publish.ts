import { jsonLdScript, buildNewsArticle, validateNewsArticle } from "@/lib/editorial/schema";
import { CATEGORY_LABEL } from "@/lib/editorial/categories";
import { WpError, type WordPressApi, type WpPostSummary } from "@/lib/wordpress/types";
import type { StageContext, StageResult } from "../context";
import { StageError } from "../context";
import type { ArticleRecord } from "../types";
import { toExisting } from "./dedupe";

export function marker(publishKey: string): string {
  return `<!-- editorialos:${publishKey} -->`;
}

/**
 * Find a post this article already created (e.g. the create call succeeded but
 * its response was lost). Matches on the invisible publish marker, never on
 * title alone, so an unrelated post with the same slug is not adopted.
 */
export async function reconcilePost(wp: WordPressApi, article: ArticleRecord): Promise<WpPostSummary | null> {
  const m = marker(article.publish_key);
  if (article.wp_post_id) {
    const p = await wp.getPost(article.wp_post_id);
    if (p) return p;
  }
  for (const p of await wp.findPostsBySlug(article.slug)) {
    const full = p.content !== undefined ? p : await wp.getPost(p.id);
    if (full?.content?.includes(m) || full?.content?.includes(`editorialos:${article.publish_key}`)) return full;
  }
  const recent = await wp.listPosts({
    statuses: ["publish", "future", "draft", "pending", "private"],
    search: article.headline.split(/\s+/).slice(0, 6).join(" "),
    after: new Date(Date.parse(article.created_at) - 3_600_000).toISOString(),
    perPage: 20,
    maxPages: 1,
    includeContent: true,
  });
  return recent.find((p) => p.content?.includes(`editorialos:${article.publish_key}`)) ?? null;
}

async function ensureMedia(sc: StageContext, wp: WordPressApi, article: ArticleRecord): Promise<number | null> {
  const { deps, ws, run } = sc;
  const img = await deps.store.getImage(article.id);
  if (!img || !img.storage_path || (img.status !== "generated" && img.status !== "uploaded")) return null;
  if (img.wp_media_id) {
    const m = await wp.getMedia(img.wp_media_id);
    if (m) return m.id;
  }
  const filename = `${article.slug.slice(0, 60)}-${article.publish_key.slice(0, 8)}.jpg`;
  // Reconcile a previous upload whose response was lost.
  const prior = (await wp.findMedia(`${article.slug.slice(0, 60)}-${article.publish_key.slice(0, 8)}`)).find((m) => m.sourceUrl.includes(article.publish_key.slice(0, 8)));
  let media = prior ?? null;
  if (!media) {
    const bytes = await deps.store.loadImageBytes(img.storage_path);
    media = await wp.uploadMedia(bytes, filename, img.mime_type ?? "image/jpeg");
  }
  await deps.store.upsertImage(article.id, ws.workspaceId, { prompt: img.prompt, model: img.model, status: "uploaded", wp_media_id: media.id, wp_source_url: media.sourceUrl });
  try {
    await wp.updateMedia(media.id, { alt_text: img.alt_text ?? article.headline, title: img.title ?? article.headline, caption: "" });
  } catch (e) {
    await sc.log("warning", `Could not set media alt text: ${(e as Error).message}`);
  }
  const verified = await wp.getMedia(media.id);
  if (!verified || !verified.sourceUrl) throw new StageError("media_verify", "Uploaded media could not be read back from WordPress", true);
  await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: article.id, action: "upload_media", status: "ok", wp_id: media.id, detail: { source_url: verified.sourceUrl, reconciled: Boolean(prior) } });
  return media.id;
}

async function resolveCategory(sc: StageContext, wp: WordPressApi, article: ArticleRecord): Promise<number> {
  const mapped = sc.ws.wp?.category_map?.[article.category];
  if (mapped) return mapped;
  const cats = await wp.listCategories();
  const found = cats.find((c) => c.slug === article.category || c.name.toLowerCase() === CATEGORY_LABEL[article.category].toLowerCase());
  if (!found) {
    throw new StageError("category_unmapped", `No WordPress category mapped for "${article.category}". Map it in Settings → WordPress.`, false);
  }
  return found.id;
}

export async function publishStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  if (!run.article_id) throw new StageError("no_article", "No article to publish", false);
  const article = await deps.store.getArticle(run.article_id);
  if (!article) throw new StageError("no_article", "Article not found", false);
  const target = article.publish_target ?? "none";
  const qualityPassed = (article.quality_report as { pass?: boolean }).pass === true;
  const imageFailed = (article.quality_report as { image_failed?: boolean }).image_failed === true;

  const finish = async (articleStatus: ArticleRecord["status"], runStatus: StageResult["next"], message: string, extra: Partial<ArticleRecord> = {}): Promise<StageResult> => {
    await deps.store.updateArticle(article.id, { status: articleStatus, ...extra });
    await deps.store.updateCandidate(article.candidate_id!, { status: articleStatus === "published" ? "published" : articleStatus === "dry_run" ? "dry_run" : "drafted" });
    const produced = run.articles_produced + 1;
    const more = produced < ws.settings.max_articles_per_run;
    return {
      next: more ? "deduplicating" : runStatus,
      patch: {
        articles_produced: produced,
        outcome_reason: message,
        ...(more ? { article_id: null, selected_candidate_id: null } : {}),
      },
      message: more ? `${message}; looking for another article (${produced}/${ws.settings.max_articles_per_run})` : message,
    };
  };

  if (run.publishing_mode === "dry_run" || target === "none") {
    if (run.publishing_mode !== "dry_run") {
      return { next: "needs_review", patch: { outcome_reason: "Article not eligible for WordPress (quality policy)" }, message: "Article kept in EditorialOS for review; WordPress not modified" };
    }
    await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: article.id, action: "dry_run", status: "skipped", wp_id: null, detail: { target } });
    return finish("dry_run", "dry_run_completed", "Dry run complete: article prepared, WordPress not modified");
  }

  // Auto-publish only when every gate passed; anything else becomes a draft for review.
  const status: "draft" | "publish" = target === "publish" && qualityPassed && !imageFailed && run.publishing_mode === "auto_publish" ? "publish" : "draft";
  const wp = await sc.wp();
  const site = await wp.discover();

  const mediaId = await ensureMedia(sc, wp, article);
  if (status === "publish" && !mediaId) {
    throw new StageError("media_missing", "Featured image is not ready; refusing to auto-publish without it", false);
  }
  const categoryId = await resolveCategory(sc, wp, article);
  const tagIds: number[] = [];
  for (const t of article.tags.slice(0, 6)) {
    try {
      tagIds.push((await wp.ensureTag(t)).id);
    } catch (e) {
      if (e instanceof WpError && !e.transient) await sc.log("warning", `Tag "${t}" skipped: ${e.message}`);
      else throw e;
    }
  }

  // SEO metadata: written through the plugin's own mechanism where one exists, then verified.
  const meta: Record<string, string> = {};
  if (site.seoPlugin === "yoast") {
    meta._yoast_wpseo_title = article.seo_title;
    meta._yoast_wpseo_metadesc = article.meta_description;
    meta._yoast_wpseo_focuskw = article.primary_keyword;
  }
  let content = article.body_html;
  let jsonLdInjected = false;
  if (ws.settings.inject_json_ld && site.seoPlugin === "none" && article.json_ld) {
    const doc = { ...article.json_ld };
    if (validateNewsArticle(doc, article.headline).length === 0) {
      content += `\n${jsonLdScript(doc)}`;
      jsonLdInjected = true;
    }
  }
  content += `\n${marker(article.publish_key)}`;
  const payload = {
    title: article.headline,
    content,
    excerpt: article.excerpt,
    slug: article.slug,
    status,
    categories: [categoryId],
    tags: tagIds,
    ...(mediaId ? { featured_media: mediaId } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };

  // Idempotency: never create a second post if one already exists for this article.
  let post = await reconcilePost(wp, article);
  let action: "create_post" | "update_post" = "create_post";
  let expectedStatus: string = status;
  if (post) {
    action = "update_post";
    await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: article.id, action: "reconcile", status: "ok", wp_id: post.id, detail: { found_status: post.status } });
    // Do not downgrade a post a human already published.
    const safeStatus = post.status === "publish" ? "publish" : status;
    expectedStatus = safeStatus;
    post = await wp.updatePost(post.id, { ...payload, status: safeStatus });
  } else {
    await deps.store.updateArticle(article.id, { wp_status: "creating" });
    post = await wp.createPost(payload);
  }
  await deps.store.updateArticle(article.id, { wp_post_id: post.id, wp_url: post.link, wp_status: post.status });

  const readBack = await wp.getPost(post.id);
  if (!readBack) throw new StageError("readback_failed", `Post ${post.id} could not be read back`, true);
  const problems: string[] = [];
  if (readBack.status !== expectedStatus) problems.push(`status is ${readBack.status}`);
  if (mediaId && readBack.featuredMedia !== mediaId) problems.push(`featured media is ${readBack.featuredMedia}, expected ${mediaId}`);
  if (!readBack.link) problems.push("no permalink");
  if (problems.length) throw new StageError("readback_mismatch", `WordPress read-back mismatch: ${problems.join(", ")}`, true);

  let seoSync: Record<string, unknown> = { plugin: site.seoPlugin };
  if (site.seoPlugin === "yoast") {
    const head = await wp.getYoastHead(post.id).catch(() => null);
    const written = head?.description?.trim() === article.meta_description.trim();
    seoSync = {
      plugin: "yoast",
      status: written ? "written" : "not_writable",
      detail: written
        ? "Yoast meta title/description/focus keyword written and verified via yoast_head_json"
        : "Yoast meta fields are not exposed to the REST API on this site; Yoast is using the excerpt as the description. See docs/WORDPRESS.md to enable.",
    };
  } else if (site.seoPlugin === "rankmath") {
    const ok = await wp.updateRankMathMeta(post.id, { rank_math_title: article.seo_title, rank_math_description: article.meta_description, rank_math_focus_keyword: article.primary_keyword }).catch(() => false);
    seoSync = { plugin: "rankmath", status: ok ? "written_unverified" : "not_writable", detail: ok ? "Sent to Rank Math updateMeta endpoint" : "Rank Math updateMeta endpoint unavailable" };
  } else {
    seoSync = { plugin: "none", status: "excerpt_only", detail: "No SEO plugin detected; the excerpt serves as the meta description", json_ld_injected: jsonLdInjected };
  }
  if (site.seoPlugin !== "none") seoSync.json_ld = "Not injected: the SEO plugin already outputs Article schema";

  const imageRow = await deps.store.getImage(article.id);
  const finalJsonLd = buildNewsArticle({
    headline: article.headline,
    description: article.meta_description,
    url: readBack.link,
    imageUrl: imageRow?.wp_source_url ?? null,
    datePublished: readBack.dateGmt ?? deps.now().toISOString(),
    dateModified: readBack.modifiedGmt ?? deps.now().toISOString(),
    authorName: ws.workspaceName,
    publisherName: site.name || ws.workspaceName,
    section: CATEGORY_LABEL[article.category],
    keywords: [article.primary_keyword, ...article.secondary_keywords],
  });

  await deps.store.upsertWpPosts(ws.workspaceId, [toExisting({ ...readBack, content: undefined })]);
  await deps.store.recordWpSync({ workspace_id: ws.workspaceId, run_id: run.id, article_id: article.id, action, status: "ok", wp_id: post.id, detail: { status: readBack.status, link: readBack.link, featured_media: readBack.featuredMedia, seo: seoSync } });
  await sc.log("succeeded", `${readBack.status === "publish" ? "Published" : "Saved draft"} on WordPress (post ${post.id})`, { link: readBack.link, seo: seoSync });

  const extra = { wp_post_id: post.id, wp_url: readBack.link, wp_status: readBack.status, wp_featured_media_id: readBack.featuredMedia || null, wp_synced_at: deps.now().toISOString(), seo_sync: seoSync, json_ld: finalJsonLd };
  if (readBack.status === "publish") return finish("published", "published", `Article published: ${readBack.link}`, extra);
  if (qualityPassed && !imageFailed) return finish("drafted", "drafted", `Draft created for review: post ${post.id}`, extra);
  return finish("needs_review", "needs_review", `Saved as draft; needs review (quality or image checks failed): post ${post.id}`, extra);
}
