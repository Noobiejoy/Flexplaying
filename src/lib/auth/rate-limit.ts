import "server-only";
import { adminClient } from "@/lib/supabase/admin";

/**
 * Sliding-window limit for sensitive manual actions, backed by audit_log so it
 * holds across serverless instances. Records the attempt when allowed.
 */
export async function rateLimit(userId: string, workspaceId: string | null, action: string, max: number, windowSeconds: number, detail: Record<string, unknown> = {}) {
  const db = adminClient();
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count, error } = await db.from("audit_log").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("action", action).gte("created_at", since);
  if (error) throw new Error("Rate limit check failed");
  if ((count ?? 0) >= max) return false;
  await db.from("audit_log").insert({ user_id: userId, workspace_id: workspaceId, action, detail });
  return true;
}

export async function audit(userId: string | null, workspaceId: string | null, action: string, detail: Record<string, unknown> = {}) {
  await adminClient().from("audit_log").insert({ user_id: userId, workspace_id: workspaceId, action, detail });
}
