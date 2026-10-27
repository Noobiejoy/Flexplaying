export interface WpPostSummary {
  id: number;
  slug: string;
  title: string;
  link: string;
  status: string;
  dateGmt: string | null;
  modifiedGmt: string | null;
  excerpt: string;
  featuredMedia: number;
  content?: string;
}

export interface WpPostInput {
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  status: "draft" | "publish" | "pending";
  categories: number[];
  tags: number[];
  featured_media?: number;
  meta?: Record<string, string>;
}

export interface WpMedia {
  id: number;
  sourceUrl: string;
  mimeType: string;
  altText: string;
}

export interface WpTerm {
  id: number;
  name: string;
  slug: string;
}

export interface WpSiteInfo {
  name: string;
  url: string;
  namespaces: string[];
  seoPlugin: "yoast" | "rankmath" | "none";
}

export interface WpUserInfo {
  id: number;
  name: string;
  roles: string[];
  capabilities: Record<string, boolean>;
}

export interface ListPostsOptions {
  statuses: string[];
  search?: string;
  after?: string;
  perPage?: number;
  maxPages?: number;
  includeContent?: boolean;
}

export interface WordPressApi {
  siteUrl: string;
  discover(): Promise<WpSiteInfo>;
  me(): Promise<WpUserInfo>;
  listCategories(): Promise<WpTerm[]>;
  ensureTag(name: string): Promise<WpTerm>;
  listPosts(opts: ListPostsOptions): Promise<WpPostSummary[]>;
  getPost(id: number): Promise<WpPostSummary | null>;
  findPostsBySlug(slug: string): Promise<WpPostSummary[]>;
  createPost(input: WpPostInput): Promise<WpPostSummary>;
  updatePost(id: number, input: Partial<WpPostInput>): Promise<WpPostSummary>;
  uploadMedia(data: Buffer, filename: string, mimeType: string): Promise<WpMedia>;
  updateMedia(id: number, fields: { alt_text?: string; title?: string; caption?: string }): Promise<WpMedia>;
  getMedia(id: number): Promise<WpMedia | null>;
  findMedia(search: string): Promise<WpMedia[]>;
  /** Rank Math's editor endpoint. Returns false when the endpoint is unavailable. */
  updateRankMathMeta(postId: number, meta: Record<string, string>): Promise<boolean>;
  /** Yoast's computed head data for a post (read-only), used to verify SEO writes. */
  getYoastHead(postId: number): Promise<{ title?: string; description?: string } | null>;
}

export type WpErrorKind =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "bad_request"
  | "invalid_response"
  | "invalid_url";

export class WpError extends Error {
  readonly transient: boolean;
  constructor(public readonly kind: WpErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = "WpError";
    this.transient = kind === "rate_limit" || kind === "server" || kind === "network";
  }
}
