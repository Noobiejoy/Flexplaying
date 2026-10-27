import sanitizeHtml from "sanitize-html";
import { canonicalUrl } from "./text";

export interface LinkPolicy {
  /** External URLs the article may link to (verified sources). */
  allowedExternal: string[];
  /** Internal URLs that exist on the WordPress site. */
  allowedInternal: string[];
}

export interface SanitizeResult {
  html: string;
  removedLinks: string[];
  internalLinks: string[];
  externalLinks: string[];
}

/**
 * Sanitises model-generated HTML for WordPress: a strict tag allow-list, no
 * scripts/styles/event handlers, and links only to verified sources or to
 * existing site articles. Any other link is unwrapped to plain text so the
 * model cannot introduce fabricated or malicious URLs.
 */
export function sanitizeArticleHtml(html: string, policy: LinkPolicy): SanitizeResult {
  const ext = new Map(policy.allowedExternal.map((u) => [canonicalUrl(u), u]));
  const int = new Map(policy.allowedInternal.map((u) => [canonicalUrl(u), u]));
  const removedLinks: string[] = [];
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];

  const out = sanitizeHtml(html, {
    allowedTags: ["p", "h2", "h3", "h4", "ul", "ol", "li", "a", "strong", "em", "b", "i", "blockquote", "cite", "br", "hr", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption"],
    allowedAttributes: { a: ["href", "rel", "target"] },
    allowedSchemes: ["https", "http"],
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed"],
    transformTags: {
      h1: "h2",
      a: (_tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
        const href = attribs.href ?? "";
        const key = canonicalUrl(href);
        if (int.has(key)) {
          internalLinks.push(int.get(key)!);
          return { tagName: "a", attribs: { href: int.get(key)! } };
        }
        if (ext.has(key)) {
          externalLinks.push(ext.get(key)!);
          return { tagName: "a", attribs: { href: ext.get(key)!, rel: "noopener", target: "_blank" } };
        }
        if (href) removedLinks.push(href);
        return { tagName: "span", attribs: {} };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "p" && !frame.text.trim() && !frame.mediaChildren?.length,
  });
  // sanitize-html keeps <span> from the transform; strip the wrapper but keep its text.
  const html2 = out.replace(/<span>([\s\S]*?)<\/span>/g, "$1");
  return { html: html2, removedLinks, internalLinks: [...new Set(internalLinks)], externalLinks: [...new Set(externalLinks)] };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Plain-text sanitiser for short fields (titles, meta descriptions, alt text). */
export function plainText(s: string, max: number): string {
  return sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
