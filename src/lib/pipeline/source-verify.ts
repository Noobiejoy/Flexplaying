import { isSafePublicHttpUrl } from "@/lib/wordpress/url";

export interface PageMeta {
  ok: boolean;
  status: number;
  finalUrl: string;
  title: string | null;
  publishedAt: string | null;
}

export type PageFetcher = (url: string) => Promise<PageMeta>;

const MAX_BYTES = 400_000;

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

export function extractMeta(html: string): { title: string | null; publishedAt: string | null } {
  const pick = (re: RegExp) => {
    const m = re.exec(html);
    return m ? decode(m[1]!) : null;
  };
  const title =
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{3,300})["']/i) ??
    pick(/<meta[^>]+content=["']([^"']{3,300})["'][^>]+property=["']og:title["']/i) ??
    pick(/<title[^>]*>([^<]{3,300})<\/title>/i);
  const rawDate =
    pick(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i) ??
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i) ??
    pick(/"datePublished"\s*:\s*"([^"]+)"/i) ??
    pick(/<meta[^>]+(?:name|itemprop)=["'](?:date|pubdate|publishdate|datePublished)["'][^>]+content=["']([^"']+)["']/i) ??
    pick(/<time[^>]+datetime=["']([^"']+)["']/i);
  const t = rawDate ? Date.parse(rawDate) : NaN;
  return { title, publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

/**
 * Confirms a source URL resolves to a real page and reads only its title and
 * publication-date metadata. Page text is never passed to the model, so a
 * hostile page cannot inject instructions through this path.
 */
export function createPageFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): PageFetcher {
  return async (url: string) => {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!isSafePublicHttpUrl(current)) return { ok: false, status: 0, finalUrl: current, title: null, publishedAt: null };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(current, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "User-Agent": "EditorialOS-SourceCheck/1.0 (+source verification)", Accept: "text/html,application/xhtml+xml" },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          clearTimeout(timer);
          if (!loc) return { ok: false, status: res.status, finalUrl: current, title: null, publishedAt: null };
          current = new URL(loc, current).toString();
          continue;
        }
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
          clearTimeout(timer);
          return { ok: res.ok, status: res.status, finalUrl: current, title: null, publishedAt: null };
        }
        const reader = res.body?.getReader();
        let html = "";
        if (reader) {
          const dec = new TextDecoder();
          let total = 0;
          while (total < MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            html += dec.decode(value, { stream: true });
          }
          await reader.cancel().catch(() => undefined);
        }
        clearTimeout(timer);
        return { ok: true, status: res.status, finalUrl: current, ...extractMeta(html) };
      } catch {
        clearTimeout(timer);
        return { ok: false, status: 0, finalUrl: current, title: null, publishedAt: null };
      }
    }
    return { ok: false, status: 0, finalUrl: current, title: null, publishedAt: null };
  };
}
