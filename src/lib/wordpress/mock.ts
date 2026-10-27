import {
  WpError,
  type ListPostsOptions,
  type WordPressApi,
  type WpMedia,
  type WpPostInput,
  type WpPostSummary,
  type WpSiteInfo,
  type WpTerm,
  type WpUserInfo,
} from "./types";

/**
 * In-memory WordPress used by automated tests and local mock mode.
 * `failNext` lets tests simulate errors, including "lost response after
 * the post was created" to exercise publish reconciliation.
 */
export class MockWordPress implements WordPressApi {
  siteUrl = "https://mock-wordpress.example";
  posts: (WpPostSummary & { categories: number[]; tags: number[]; meta?: Record<string, string> })[] = [];
  media: WpMedia[] = [];
  tags: WpTerm[] = [];
  categories: WpTerm[] = [
    { id: 11, name: "Anime", slug: "anime" },
    { id: 12, name: "Gaming", slug: "gaming" },
    { id: 13, name: "Esports", slug: "esports" },
  ];
  seoPlugin: WpSiteInfo["seoPlugin"] = "yoast";
  calls: string[] = [];
  private nextId = 1000;
  private failures: { op: string; error: WpError; afterEffect: boolean }[] = [];

  /** Make the next call to `op` fail. With afterEffect=true the side effect happens before the error (lost response). */
  failNext(op: string, error: WpError, afterEffect = false) {
    this.failures.push({ op, error, afterEffect });
  }

  private takeFailure(op: string) {
    const i = this.failures.findIndex((f) => f.op === op);
    if (i < 0) return null;
    return this.failures.splice(i, 1)[0]!;
  }

  private guard(op: string) {
    this.calls.push(op);
    const f = this.takeFailure(op);
    if (f && !f.afterEffect) throw f.error;
    return f;
  }

  seedPost(p: Partial<WpPostSummary> & { title: string }) {
    const id = this.nextId++;
    const slug = p.slug ?? p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    this.posts.push({
      id,
      slug,
      title: p.title,
      link: p.link ?? `${this.siteUrl}/${slug}/`,
      status: p.status ?? "publish",
      dateGmt: p.dateGmt ?? new Date().toISOString(),
      modifiedGmt: p.modifiedGmt ?? new Date().toISOString(),
      excerpt: p.excerpt ?? "",
      featuredMedia: 0,
      content: p.content ?? "",
      categories: [],
      tags: [],
    });
    return id;
  }

  async discover(): Promise<WpSiteInfo> {
    this.guard("discover");
    const ns = ["wp/v2", ...(this.seoPlugin === "yoast" ? ["yoast/v1"] : this.seoPlugin === "rankmath" ? ["rankmath/v1"] : [])];
    return { name: "Mock Site", url: this.siteUrl, namespaces: ns, seoPlugin: this.seoPlugin };
  }

  async me(): Promise<WpUserInfo> {
    this.guard("me");
    return { id: 1, name: "editor", roles: ["editor"], capabilities: { publish_posts: true, upload_files: true, edit_posts: true } };
  }

  async listCategories() {
    this.guard("listCategories");
    return this.categories;
  }

  async ensureTag(name: string) {
    this.guard("ensureTag");
    const found = this.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (found) return found;
    const t = { id: this.nextId++, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
    this.tags.push(t);
    return t;
  }

  async listPosts(opts: ListPostsOptions) {
    this.guard("listPosts");
    const q = opts.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return this.posts
      .filter((p) => opts.statuses.includes(p.status))
      .filter((p) => !opts.after || (p.dateGmt ?? "") >= opts.after)
      .filter((p) => q.length === 0 || q.some((w) => `${p.title} ${p.excerpt} ${p.content ?? ""}`.toLowerCase().includes(w)))
      .map((p) => ({ ...p, content: opts.includeContent ? p.content : undefined }));
  }

  async getPost(id: number) {
    this.guard("getPost");
    return this.posts.find((p) => p.id === id) ?? null;
  }

  async findPostsBySlug(slug: string) {
    this.guard("findPostsBySlug");
    return this.posts.filter((p) => p.slug === slug || p.slug.startsWith(`${slug}-`));
  }

  async createPost(input: WpPostInput) {
    const f = this.guard("createPost");
    const id = this.nextId++;
    const slugTaken = this.posts.some((p) => p.slug === input.slug);
    const slug = slugTaken ? `${input.slug}-2` : input.slug;
    const post = {
      id,
      slug,
      title: input.title,
      link: `${this.siteUrl}/${slug}/`,
      status: input.status,
      dateGmt: new Date().toISOString(),
      modifiedGmt: new Date().toISOString(),
      excerpt: input.excerpt,
      featuredMedia: input.featured_media ?? 0,
      content: input.content,
      categories: input.categories,
      tags: input.tags,
      meta: input.meta,
    };
    this.posts.push(post);
    if (f?.afterEffect) throw f.error;
    return post;
  }

  async updatePost(id: number, input: Partial<WpPostInput>) {
    this.guard("updatePost");
    const p = this.posts.find((x) => x.id === id);
    if (!p) throw new WpError("not_found", "post not found", 404);
    Object.assign(p, {
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.featured_media !== undefined ? { featuredMedia: input.featured_media } : {}),
      ...(input.excerpt ? { excerpt: input.excerpt } : {}),
    });
    return p;
  }

  async uploadMedia(_data: Buffer, filename: string, mimeType: string) {
    const f = this.guard("uploadMedia");
    const m = { id: this.nextId++, sourceUrl: `${this.siteUrl}/wp-content/uploads/${filename}`, mimeType, altText: "" };
    this.media.push(m);
    if (f?.afterEffect) throw f.error;
    return m;
  }

  async updateMedia(id: number, fields: { alt_text?: string }) {
    this.guard("updateMedia");
    const m = this.media.find((x) => x.id === id);
    if (!m) throw new WpError("not_found", "media not found", 404);
    if (fields.alt_text) m.altText = fields.alt_text;
    return m;
  }

  async getMedia(id: number) {
    this.guard("getMedia");
    return this.media.find((m) => m.id === id) ?? null;
  }

  async findMedia(search: string) {
    this.guard("findMedia");
    return this.media.filter((m) => m.sourceUrl.includes(search));
  }

  async updateRankMathMeta() {
    this.guard("updateRankMathMeta");
    return this.seoPlugin === "rankmath";
  }

  async getYoastHead(postId: number) {
    this.guard("getYoastHead");
    const p = this.posts.find((x) => x.id === postId);
    if (!p || this.seoPlugin !== "yoast") return null;
    // Yoast falls back to the excerpt when no custom meta description is set.
    return { title: p.title, description: p.meta?._yoast_wpseo_metadesc ?? p.excerpt };
  }
}
