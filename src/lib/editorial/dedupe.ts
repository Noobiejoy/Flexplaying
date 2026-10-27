import { canonicalUrl, jaccard, normalize, overlap, stripHtml, tokens } from "./text";
import { normalizeEntity } from "./preferences";

export interface DedupeCandidate {
  headline: string;
  topic: string;
  entities: string[];
  sourceUrls: string[];
}

export interface ExistingPost {
  id: number;
  title: string;
  slug: string;
  link: string;
  status: string;
  excerpt: string;
  content?: string;
  dateGmt?: string | null;
  origin: "wordpress" | "local";
}

export interface DuplicateMatch {
  post: ExistingPost;
  score: number;
  signals: { title: number; entities: number; slug: number; sourceUrl: boolean };
  verdict: "duplicate" | "borderline" | "distinct";
}

export const DUPLICATE_THRESHOLD = 0.72;
export const BORDERLINE_THRESHOLD = 0.38;

export function slugify(s: string, maxWords = 9): string {
  return normalize(s)
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 75)
    .replace(/-+$/g, "");
}

export function comparePost(c: DedupeCandidate, post: ExistingPost): DuplicateMatch {
  const candTitle = new Set(tokens(`${c.headline}`));
  const candTopic = new Set(tokens(`${c.topic}`));
  const postTitle = new Set(tokens(post.title));
  const title = Math.max(jaccard(candTitle, postTitle), 0.9 * overlap(candTitle, postTitle), 0.8 * overlap(candTopic, postTitle));

  const body = normalize(`${post.title} ${post.excerpt} ${post.content ? stripHtml(post.content) : ""}`);
  const ents = c.entities.map(normalizeEntity).filter((e) => e.length > 1);
  const entities = ents.length ? ents.filter((e) => ` ${body} `.includes(` ${e} `)).length / ents.length : 0;

  const slug = jaccard(new Set(post.slug.split("-").filter((t) => t.length > 1)), new Set(slugify(c.headline).split("-")));

  const content = post.content ?? "";
  const sourceUrl = c.sourceUrls.some((u) => {
    const cu = canonicalUrl(u);
    return cu.length > 12 && content.includes(cu.replace(/^https?:\/\//, ""));
  });

  let score = 0.5 * title + 0.3 * entities + 0.2 * slug;
  if (sourceUrl) score = Math.max(score, 0.85);
  score = Math.round(score * 1000) / 1000;
  const verdict = score >= DUPLICATE_THRESHOLD ? "duplicate" : score >= BORDERLINE_THRESHOLD ? "borderline" : "distinct";
  return {
    post,
    score,
    signals: { title: Math.round(title * 1000) / 1000, entities: Math.round(entities * 1000) / 1000, slug: Math.round(slug * 1000) / 1000, sourceUrl },
    verdict,
  };
}

export function findMatches(c: DedupeCandidate, posts: ExistingPost[], limit = 5): DuplicateMatch[] {
  return posts
    .map((p) => comparePost(c, p))
    .filter((m) => m.verdict !== "distinct")
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Search terms for querying WordPress: the most distinctive entities and headline words. */
export function searchTerms(c: DedupeCandidate): string[] {
  const out: string[] = [];
  for (const e of c.entities.slice(0, 3)) if (e.trim().length > 2) out.push(e.trim().slice(0, 60));
  const words = tokens(c.headline).filter((w) => w.length > 3).slice(0, 4).join(" ");
  if (words) out.push(words);
  return [...new Set(out)].slice(0, 4);
}
