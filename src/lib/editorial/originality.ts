import { shingles, stripHtml } from "./text";

export interface OriginalityReport {
  pass: boolean;
  maxSourceOverlap: number;
  maxExistingOverlap: number;
  comparedSources: number;
  comparedPosts: number;
  flaggedPassages: { passage: string; matchedIn: string }[];
  note: string;
}

const N = 8;

/**
 * Shingle-overlap originality review. Compares 8-word sequences in the article
 * with the source excerpts retrieved during research and with existing site
 * articles. This detects copied passages from material we actually saw; it
 * is not a guarantee against every plagiarism checker.
 */
export function reviewOriginality(
  bodyHtml: string,
  sources: { label: string; text: string }[],
  existing: { label: string; text: string }[],
  opts: { maxOverlap?: number } = {},
): OriginalityReport {
  const maxAllowed = opts.maxOverlap ?? 0.12;
  const article = stripHtml(bodyHtml);
  const art = shingles(article, N);
  const sentences = article.split(/(?<=[.!?])\s+/);
  const flagged: { passage: string; matchedIn: string }[] = [];

  const ratio = (other: Set<string>) => {
    if (art.size === 0) return 0;
    let inter = 0;
    for (const s of art) if (other.has(s)) inter++;
    return inter / art.size;
  };

  const check = (list: { label: string; text: string }[]) => {
    let max = 0;
    for (const item of list) {
      const sh = shingles(item.text, N);
      if (sh.size === 0) continue;
      max = Math.max(max, ratio(sh));
      for (const sentence of sentences) {
        const ss = shingles(sentence, N);
        for (const x of ss) {
          if (sh.has(x)) {
            if (flagged.length < 10 && !flagged.some((f) => f.passage === sentence)) flagged.push({ passage: sentence.slice(0, 240), matchedIn: item.label });
            break;
          }
        }
      }
    }
    return Math.round(max * 1000) / 1000;
  };

  const maxSourceOverlap = check(sources);
  const maxExistingOverlap = check(existing);
  return {
    pass: maxSourceOverlap <= maxAllowed && maxExistingOverlap <= maxAllowed,
    maxSourceOverlap,
    maxExistingOverlap,
    comparedSources: sources.filter((s) => s.text.trim()).length,
    comparedPosts: existing.filter((s) => s.text.trim()).length,
    flaggedPassages: flagged,
    note: "Compared 8-word sequences against retrieved source excerpts and existing site articles only.",
  };
}
