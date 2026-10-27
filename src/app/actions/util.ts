import "server-only";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { AuthzError } from "@/lib/auth/session";
import { ConfigError } from "@/lib/env";
import { WpError } from "@/lib/wordpress/types";

export function done(path: string, kind: "ok" | "err", message: string): never {
  const u = new URL(path, "http://x");
  u.searchParams.set(kind, message.slice(0, 300));
  redirect(`${u.pathname}${u.search}`);
}

/** Converts an error into a user-safe message (never echoes secrets or stack traces). */
export function safeMessage(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (e instanceof AuthzError || e instanceof ConfigError || e instanceof WpError) return e.message;
  if (e instanceof Error && /^(Database error|Invalid|Rate|WordPress|Model)/.test(e.message)) return e.message.slice(0, 200);
  return "Something went wrong. The error has been logged.";
}

export function isRedirect(e: unknown): boolean {
  return typeof e === "object" && e !== null && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}
