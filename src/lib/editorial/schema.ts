export interface NewsArticleInput {
  headline: string;
  description: string;
  url: string | null;
  imageUrl: string | null;
  datePublished: string;
  dateModified: string;
  authorName: string;
  publisherName: string;
  section: string;
  keywords: string[];
}

/** schema.org NewsArticle. Only properties that match visible content are emitted. */
export function buildNewsArticle(a: NewsArticleInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: a.headline.slice(0, 110),
    description: a.description,
    datePublished: a.datePublished,
    dateModified: a.dateModified,
    author: [{ "@type": "Organization", name: a.authorName }],
    publisher: { "@type": "Organization", name: a.publisherName },
    articleSection: a.section,
    keywords: a.keywords.join(", "),
  };
  if (a.url) out.mainEntityOfPage = { "@type": "WebPage", "@id": a.url };
  if (a.imageUrl) out.image = [a.imageUrl];
  return out;
}

export function buildFaqPage(faq: { question: string; answer: string }[]): Record<string, unknown> | null {
  if (faq.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })),
  };
}

/** Structural validation against Google's documented required/recommended Article properties. */
export function validateNewsArticle(doc: Record<string, unknown>, visibleText: string): string[] {
  const errors: string[] = [];
  if (doc["@type"] !== "NewsArticle") errors.push("@type must be NewsArticle");
  const h = doc.headline;
  if (typeof h !== "string" || !h) errors.push("headline is required");
  else if (h.length > 110) errors.push("headline exceeds 110 characters");
  for (const k of ["datePublished", "dateModified"]) {
    const v = doc[k];
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) errors.push(`${k} must be an ISO-8601 date`);
  }
  if (typeof doc.datePublished === "string" && typeof doc.dateModified === "string" && Date.parse(doc.dateModified) < Date.parse(doc.datePublished)) {
    errors.push("dateModified is earlier than datePublished");
  }
  if (!Array.isArray(doc.author) || doc.author.length === 0) errors.push("author is required");
  if (doc.image !== undefined && (!Array.isArray(doc.image) || !doc.image.every((u) => typeof u === "string" && /^https:\/\//.test(u)))) {
    errors.push("image must be an array of HTTPS URLs");
  }
  if (typeof h === "string" && h && !visibleText.toLowerCase().includes(h.toLowerCase().slice(0, 40))) {
    errors.push("headline does not match the visible article title");
  }
  return errors;
}

export function validateFaqPage(doc: Record<string, unknown>, bodyHtml: string): string[] {
  const errors: string[] = [];
  const items = doc.mainEntity;
  if (!Array.isArray(items) || items.length === 0) return ["FAQPage requires mainEntity questions"];
  for (const q of items as { name?: string }[]) {
    if (!q.name || !bodyHtml.includes(q.name)) errors.push(`FAQ question not visible in article: ${q.name ?? "(empty)"}`);
  }
  return errors;
}

export function jsonLdScript(doc: Record<string, unknown>): string {
  // Escape "<" so the payload can never terminate the script element.
  return `<script type="application/ld+json">${JSON.stringify(doc).replace(/</g, "\\u003c")}</script>`;
}
