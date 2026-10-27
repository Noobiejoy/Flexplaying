import { AiError } from "@/lib/ai/types";
import { CATEGORY_LABEL } from "@/lib/editorial/categories";
import type { StageContext, StageResult } from "../context";
import { StageError } from "../context";
import { imagePrompt } from "../prompts";

export const MAX_IMAGE_ATTEMPTS = 3;

export async function imageStage(sc: StageContext): Promise<StageResult> {
  const { deps, run, ws } = sc;
  if (!run.article_id) throw new StageError("no_article", "No article for image generation", false);
  const article = await deps.store.getArticle(run.article_id);
  if (!article) throw new StageError("no_article", "Article not found", false);
  const existing = await deps.store.getImage(article.id);
  if (existing && (existing.status === "generated" || existing.status === "uploaded") && existing.storage_path) {
    return { next: "publishing", message: "Thumbnail already generated" };
  }

  const brief = existing?.prompt ?? article.headline;
  const prompt = imagePrompt(article.category, brief);
  const model = sc.models.image;
  try {
    await sc.ensureModel(model, "image");
    const res = await sc.tracked("image", model, article.id, () => deps.ai.generateImage({ model, prompt, aspectRatio: "16:9" }));
    const composed = await deps.composeImage(res.images[0]!.data, {
      overlayText: ws.settings.thumbnail_text_overlay ? article.headline : null,
      label: ws.settings.thumbnail_text_overlay ? CATEGORY_LABEL[article.category] : null,
    });
    const path = `${ws.workspaceId}/${article.id}-${article.publish_key.slice(0, 8)}.jpg`;
    await deps.store.saveImageBytes(path, composed.data, composed.mimeType);
    await deps.store.upsertImage(article.id, ws.workspaceId, {
      prompt: brief,
      model: res.usage.model || model,
      status: "generated",
      storage_path: path,
      width: composed.width,
      height: composed.height,
      mime_type: composed.mimeType,
      byte_size: composed.data.byteLength,
      attempts: (existing?.attempts ?? 0) + 1,
      error: null,
    });
    await sc.log("info", "Thumbnail generated", { model: res.usage.model || model, width: composed.width, height: composed.height, bytes: composed.data.byteLength, prompt });
    return { next: "publishing", message: `Thumbnail generated (${composed.width}×${composed.height})` };
  } catch (e) {
    const message = (e as Error).message;
    await deps.store.upsertImage(article.id, ws.workspaceId, { prompt: brief, model, status: "failed", attempts: (existing?.attempts ?? 0) + 1, error: message.slice(0, 500) });
    const retryable = (e instanceof AiError && (e.transient || e.kind === "parse")) || !(e instanceof AiError);
    if (retryable && sc.attempt < MAX_IMAGE_ATTEMPTS) throw e; // engine schedules a bounded retry

    // Retries exhausted or permanent failure: apply the workspace policy. Never publish a broken image reference.
    if (ws.settings.image_failure_policy === "fail") {
      return {
        next: "failed",
        patch: { error_code: "image_failed", error_message: message.slice(0, 500), outcome_reason: "Thumbnail generation failed" },
        message: `Thumbnail generation failed after ${sc.attempt} attempt(s); policy is to fail the run`,
      };
    }
    const target = article.publish_target === "none" ? "none" : "draft";
    await deps.store.updateArticle(article.id, {
      publish_target: target,
      status: "needs_review",
      quality_report: { ...article.quality_report, image_failed: true, image_error: message.slice(0, 300) },
    });
    await sc.log("warning", `Thumbnail failed after ${sc.attempt} attempt(s); continuing without image as a draft for review`, { error: message });
    return { next: "publishing", message: "Continuing without a featured image (saved as draft for review)" };
  }
}
