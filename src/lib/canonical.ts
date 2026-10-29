/**
 * Where a production request should be redirected so the app is served on
 * one address only (the host of APP_BASE_URL). Returns null when no redirect
 * applies: outside production, already on the canonical host, or for API
 * routes, which callers like the scheduler may still reach on an older URL.
 */
export function canonicalRedirect(url: URL, host: string | null, appBaseUrl: string | undefined, vercelEnv: string | undefined): URL | null {
  if (vercelEnv !== "production" || !appBaseUrl || !host) return null;
  let canonical: URL;
  try {
    canonical = new URL(appBaseUrl);
  } catch {
    return null;
  }
  if (host.toLowerCase() === canonical.host.toLowerCase()) return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const to = new URL(url.pathname + url.search, canonical.origin);
  to.searchParams.delete("_vercel_share");
  return to;
}

/**
 * Supabase sends people to the Site URL (with `?code=`) when the requested
 * redirect isn't on its allow-list. Route such a code to the callback so the
 * sign-in isn't silently dropped by whatever page it landed on.
 */
export function strayAuthCode(url: URL): URL | null {
  const code = url.searchParams.get("code");
  if (!code || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) return null;
  const to = new URL("/auth/callback", url.origin);
  to.searchParams.set("code", code);
  const next = url.searchParams.get("next");
  to.searchParams.set("next", next && next.startsWith("/") && !next.startsWith("//") ? next : url.pathname === "/" || url.pathname === "/login" ? "/overview" : url.pathname);
  return to;
}
