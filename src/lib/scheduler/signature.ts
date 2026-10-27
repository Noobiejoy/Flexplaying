import { createHmac } from "node:crypto";
import { constantTimeEqual } from "@/lib/crypto/secrets";

/**
 * Scheduler request authentication.
 *
 * Supabase pg_cron signs each tick:
 *   X-EditorialOS-Timestamp: unix seconds
 *   X-EditorialOS-Nonce:     unique id (uuid)
 *   X-EditorialOS-Signature: hex(HMAC-SHA256(secret, "<timestamp>.<nonce>"))
 *
 * The server checks the signature in constant time, rejects timestamps outside
 * the tolerance window and records nonces so a captured request cannot be
 * replayed. A plain "Authorization: Bearer <secret>" header (Vercel Cron or a
 * manual curl) is also accepted; it has no replay protection, which is safe
 * because ticks are idempotent (slot uniqueness + run leases).
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signTick(secret: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}`).digest("hex");
}

export type SchedulerAuthResult =
  | { ok: true; mode: "signed"; nonce: string }
  | { ok: true; mode: "bearer" }
  | { ok: false; reason: string };

export function verifySchedulerRequest(
  headers: Headers,
  secret: string | undefined,
  nowMs: number = Date.now(),
): SchedulerAuthResult {
  if (!secret) return { ok: false, reason: "scheduler secret not configured" };

  const sig = headers.get("x-editorialos-signature");
  if (sig) {
    const ts = headers.get("x-editorialos-timestamp") ?? "";
    const nonce = headers.get("x-editorialos-nonce") ?? "";
    if (!/^\d{9,11}$/.test(ts) || !/^[A-Za-z0-9-]{8,64}$/.test(nonce)) {
      return { ok: false, reason: "malformed signature headers" };
    }
    const age = Math.abs(nowMs / 1000 - Number(ts));
    if (age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
    const expected = signTick(secret, ts, nonce);
    if (!constantTimeEqual(sig.toLowerCase(), expected)) return { ok: false, reason: "bad signature" };
    return { ok: true, mode: "signed", nonce };
  }

  const auth = headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (m && constantTimeEqual(m[1]!, secret)) return { ok: true, mode: "bearer" };
  return { ok: false, reason: "missing or invalid credentials" };
}
