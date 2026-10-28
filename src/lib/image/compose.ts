import { escapeHtml } from "@/lib/editorial/sanitize";

export const THUMB_WIDTH = 1200;
export const THUMB_HEIGHT = 675;

export interface ComposedImage {
  data: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = (cur + " " + w).trim();
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

/**
 * Deterministic thumbnail composition: crop/resize the generated artwork to a
 * 16:9 1200×675 JPEG and optionally overlay the headline as real text (the
 * image model is never asked to render exact typography).
 */
export async function composeThumbnail(
  source: Buffer,
  opts: { overlayText?: string | null; label?: string | null } = {},
): Promise<ComposedImage> {
  // Loaded lazily so a missing native image library only fails the thumbnail
  // stage (which has its own failure policy), never the whole scheduler tick.
  const { default: sharp } = await import("sharp");
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) throw new Error("Generated image could not be decoded");
  if (meta.width < 512 || meta.height < 288) throw new Error(`Generated image too small (${meta.width}×${meta.height})`);

  let pipeline = sharp(source).resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover", position: "attention" });
  if (opts.overlayText) {
    const lines = wrap(opts.overlayText, 34, 3);
    const lineH = 62;
    const startY = THUMB_HEIGHT - 60 - lines.length * lineH;
    const svg = `<svg width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      ${opts.label ? `<text x="64" y="${startY - 18}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#7dd3fc" letter-spacing="3">${escapeHtml(opts.label.toUpperCase())}</text>` : ""}
      ${lines
        .map((l, i) => `<text x="64" y="${startY + (i + 1) * lineH - 12}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="52" font-weight="800" fill="#ffffff">${escapeHtml(l)}</text>`)
        .join("")}
    </svg>`;
    pipeline = pipeline.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }
  const data = await pipeline.jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return { data, mimeType: "image/jpeg", width: THUMB_WIDTH, height: THUMB_HEIGHT };
}
