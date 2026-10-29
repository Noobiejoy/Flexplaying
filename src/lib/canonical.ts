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
