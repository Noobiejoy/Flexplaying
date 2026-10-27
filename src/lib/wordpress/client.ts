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
import { normalizeSiteUrl } from "./url";

type Json = Record<string, unknown>;

export interface WordPressClientConfig {
  siteUrl: string;
  username: string;
  appPassword: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rendered(v: unknown): string {
  if (v && typeof v === "object" && typeof (v as Json).rendered === "string") return (v as Json).rendered as string;
  return str(v);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mapPost(p: Json, includeContent = false): WpPostSummary {
  const out: WpPostSummary = {
    id: Number(p.id),
    slug: str(p.slug),
    title: decodeEntities(rendered(p.title)),
    link: str(p.link),
    status: str(p.status) || "publish",
    dateGmt: str(p.date_gmt) ? `${str(p.date_gmt)}Z` : null,
    modifiedGmt: str(p.modified_gmt) ? `${str(p.modified_gmt)}Z` : null,
    excerpt: decodeEntities(rendered(p.excerpt)).slice(0, 600),
    featuredMedia: Number(p.featured_media ?? 0),
  };
  if (includeContent) out.content = rendered(p.content);
  return out;
}

function mapMedia(m: Json): WpMedia {
  return {
    id: Number(m.id),
    sourceUrl: str(m.source_url),
    mimeType: str(m.mime_type),
    altText: str(m.alt_text),
  };
}

export class WordPressClient implements WordPressApi {
  readonly siteUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: WordPressClientConfig) {
    this.siteUrl = normalizeSiteUrl(cfg.siteUrl);
    // Application Passwords are shown with spaces; WordPress accepts them either way.
    this.auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.appPassword.replace(/\s+/g, "")}`).toString("base64");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(`${this.siteUrl}/wp-json${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; json?: unknown; body?: BodyInit; headers?: Record<string, string>; retries?: number; allow404?: boolean } = {},
  ): Promise<{ data: unknown; headers: Headers; status: number }> {
    const retries = opts.retries ?? (method === "GET" ? 2 : 0);
    let last: WpError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path, opts.query), {
          method,
          headers: {
            Authorization: this.auth,
            Accept: "application/json",
            ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
          signal: ctrl.signal,
          redirect: "error",
        });
      } catch (e) {
        clearTimeout(timer);
        last = new WpError("network", `WordPress request failed (${(e as Error).name})`);
        continue;
      }
      clearTimeout(timer);
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        if (res.ok) throw new WpError("invalid_response", `WordPress returned non-JSON for ${path}`, res.status);
      }
      if (res.ok) return { data, headers: res.headers, status: res.status };
      const code = data && typeof data === "object" ? str((data as Json).code) : "";
      const msg = data && typeof data === "object" ? str((data as Json).message).slice(0, 200) : "";
      const detail = `${res.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`;
      if (res.status === 401) throw new WpError("auth", `WordPress rejected the credentials (${detail})`, 401);
      if (res.status === 403) throw new WpError("permission", `WordPress user lacks permission (${detail})`, 403);
      if (res.status === 404) {
        if (opts.allow404) return { data: null, headers: res.headers, status: 404 };
        throw new WpError("not_found", `WordPress resource not found (${detail})`, 404);
      }
      if (res.status === 429) last = new WpError("rate_limit", `WordPress rate limited the request (${detail})`, 429);
      else if (res.status >= 500) last = new WpError("server", `WordPress server error (${detail})`, res.status);
      else throw new WpError("bad_request", `WordPress rejected the request (${detail})`, res.status);
    }
    throw last ?? new WpError("network", "WordPress request failed");
  }

  async discover(): Promise<WpSiteInfo> {
    const { data } = await this.request("GET", "/");
    const d = (data ?? {}) as Json;
    const namespaces = Array.isArray(d.namespaces) ? (d.namespaces as string[]) : [];
    if (!namespaces.includes("wp/v2")) throw new WpError("invalid_response", "WordPress REST API (wp/v2) is not available");
    const seoPlugin = namespaces.includes("yoast/v1") ? "yoast" : namespaces.includes("rankmath/v1") ? "rankmath" : "none";
    return { name: decodeEntities(str(d.name)), url: str(d.url), namespaces, seoPlugin };
  }

  async me(): Promise<WpUserInfo> {
    const { data } = await this.request("GET", "/wp/v2/users/me", { query: { context: "edit" } });
    const d = (data ?? {}) as Json;
    return {
      id: Number(d.id),
      name: str(d.name),
      roles: Array.isArray(d.roles) ? (d.roles as string[]) : [],
      capabilities: (d.capabilities ?? {}) as Record<string, boolean>,
    };
  }

  private async paginate(path: string, query: Record<string, string | number | undefined>, maxPages: number): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, headers, status } = await this.request("GET", path, { query: { ...query, page }, allow404: page > 1 });
      if (status === 404 || !Array.isArray(data)) break;
      out.push(...(data as Json[]));
      const totalPages = Number(headers.get("x-wp-totalpages") ?? "1");
      if (page >= totalPages || (data as Json[]).length === 0) break;
    }
    return out;
  }

  async listCategories(): Promise<WpTerm[]> {
    const rows = await this.paginate("/wp/v2/categories", { per_page: 100, _fields: "id,name,slug" }, 10);
    return rows.map((r) => ({ id: Number(r.id), name: decodeEntities(str(r.name)), slug: str(r.slug) }));
  }

  async ensureTag(name: string): Promise<WpTerm> {
    const clean = name.trim().slice(0, 60);
    const { data } = await this.request("GET", "/wp/v2/tags", { query: { search: clean, per_page: 20, _fields: "id,name,slug" } });
    const found = (Array.isArray(data) ? (data as Json[]) : []).find(
      (t) => decodeEntities(str(t.name)).toLowerCase() === clean.toLowerCase(),
    );
    if (found) return { id: Number(found.id), name: decodeEntities(str(found.name)), slug: str(found.slug) };
    try {
      const created = await this.request("POST", "/wp/v2/tags", { json: { name: clean } });
      const t = created.data as Json;
      return { id: Number(t.id), name: decodeEntities(str(t.name)), slug: str(t.slug) };
    } catch (e) {
      // term_exists returns the existing id in data.term_id
      if (e instanceof WpError && e.kind === "bad_request" && /term_exists/.test(e.message)) {
        const retry = await this.request("GET", "/wp/v2/tags", { query: { search: clean, per_page: 20 } });
        const t = (retry.data as Json[])[0];
        if (t) return { id: Number(t.id), name: decodeEntities(str(t.name)), slug: str(t.slug) };
      }
      throw e;
    }
  }

  async listPosts(opts: ListPostsOptions): Promise<WpPostSummary[]> {
    const fields = ["id", "slug", "title", "link", "status", "date_gmt", "modified_gmt", "excerpt", "featured_media"];
    if (opts.includeContent) fields.push("content");
    const rows = await this.paginate(
      "/wp/v2/posts",
      {
        status: opts.statuses.join(","),
        search: opts.search,
        after: opts.after,
        per_page: opts.perPage ?? 100,
        orderby: "date",
        order: "desc",
        context: "edit",
        _fields: fields.join(","),
      },
      opts.maxPages ?? 10,
    );
    return rows.map((r) => mapPost(r, opts.includeContent));
  }

  async getPost(id: number): Promise<WpPostSummary | null> {
    const { data, status } = await this.request("GET", `/wp/v2/posts/${id}`, { query: { context: "edit" }, allow404: true });
    if (status === 404 || !data) return null;
    return mapPost(data as Json, true);
  }

  async findPostsBySlug(slug: string): Promise<WpPostSummary[]> {
    const { data } = await this.request("GET", "/wp/v2/posts", {
      query: { slug, status: "publish,future,draft,pending,private", context: "edit", per_page: 10 },
    });
    return (Array.isArray(data) ? (data as Json[]) : []).map((p) => mapPost(p));
  }

  async createPost(input: WpPostInput): Promise<WpPostSummary> {
    const { data } = await this.request("POST", "/wp/v2/posts", { json: input });
    return mapPost(data as Json, true);
  }

  async updatePost(id: number, input: Partial<WpPostInput>): Promise<WpPostSummary> {
    const { data } = await this.request("POST", `/wp/v2/posts/${id}`, { json: input });
    return mapPost(data as Json, true);
  }

  async uploadMedia(data: Buffer, filename: string, mimeType: string): Promise<WpMedia> {
    const safeName = filename.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120);
    const res = await this.request("POST", "/wp/v2/media", {
      body: new Uint8Array(data),
      headers: { "Content-Type": mimeType, "Content-Disposition": `attachment; filename="${safeName}"` },
    });
    const media = mapMedia(res.data as Json);
    if (!media.id || !media.sourceUrl) throw new WpError("invalid_response", "Media upload response missing id or source_url");
    return media;
  }

  async updateMedia(id: number, fields: { alt_text?: string; title?: string; caption?: string }): Promise<WpMedia> {
    const { data } = await this.request("POST", `/wp/v2/media/${id}`, { json: fields });
    return mapMedia(data as Json);
  }

  async getMedia(id: number): Promise<WpMedia | null> {
    const { data, status } = await this.request("GET", `/wp/v2/media/${id}`, { query: { context: "edit" }, allow404: true });
    if (status === 404 || !data) return null;
    return mapMedia(data as Json);
  }

  async findMedia(search: string): Promise<WpMedia[]> {
    const { data } = await this.request("GET", "/wp/v2/media", { query: { search, per_page: 10, context: "edit" } });
    return (Array.isArray(data) ? (data as Json[]) : []).map(mapMedia);
  }

  async updateRankMathMeta(postId: number, meta: Record<string, string>): Promise<boolean> {
    const { status } = await this.request("POST", "/rankmath/v1/updateMeta", {
      json: { objectType: "post", objectID: postId, meta },
      allow404: true,
    });
    return status !== 404;
  }

  async getYoastHead(postId: number): Promise<{ title?: string; description?: string } | null> {
    const { data, status } = await this.request("GET", `/wp/v2/posts/${postId}`, {
      query: { context: "edit", _fields: "yoast_head_json" },
      allow404: true,
    });
    if (status === 404 || !data) return null;
    const y = (data as Json).yoast_head_json as Json | undefined;
    if (!y) return null;
    return { title: str(y.title) || undefined, description: str(y.description) || undefined };
  }
}
