import { WpError } from "./types";

const PRIVATE_HOST = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/** Normalise and validate a WordPress site URL: HTTPS only, public hostnames only, no credentials. */
export function normalizeSiteUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new WpError("invalid_url", "Site URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new WpError("invalid_url", "Site URL must use HTTPS");
  if (u.username || u.password) throw new WpError("invalid_url", "Site URL must not contain credentials");
  if (!u.hostname.includes(".") || PRIVATE_HOST.some((r) => r.test(u.hostname))) {
    throw new WpError("invalid_url", "Site URL must be a public hostname");
  }
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

export function isSafePublicHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    return u.hostname.includes(".") && !PRIVATE_HOST.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}
