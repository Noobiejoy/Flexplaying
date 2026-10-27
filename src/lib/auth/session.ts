import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export type Role = "owner" | "editor" | "viewer";

export interface Membership {
  workspace_id: string;
  role: Role;
  name: string;
}

export const WORKSPACE_COOKIE = "eos_ws";

export async function getUser() {
  const sb = await createUserClient();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}

export async function requireUser() {
  const sb = await createUserClient();
  if (!sb) redirect("/setup");
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect("/login");
  return { user: data.user, sb };
}

export async function listMemberships(): Promise<Membership[]> {
  const { user, sb } = await requireUser();
  const { data, error } = await sb.from("workspace_members").select("workspace_id, role, workspaces(name)").eq("user_id", user.id);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as { workspace_id: string; role: Role; workspaces: { name: string } | null }[]).map((m) => ({
    workspace_id: m.workspace_id,
    role: m.role,
    name: m.workspaces?.name ?? "Workspace",
  }));
}

/** The active workspace for the dashboard (cookie-selected, validated against membership). */
export async function currentWorkspace() {
  const { user, sb } = await requireUser();
  const memberships = await listMemberships();
  if (memberships.length === 0) redirect("/onboarding");
  const jar = await cookies();
  const wanted = jar.get(WORKSPACE_COOKIE)?.value;
  const m = memberships.find((x) => x.workspace_id === wanted) ?? memberships[0]!;
  return { user, sb, membership: m, memberships };
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export class AuthzError extends Error {
  constructor(message = "You do not have permission to do that") {
    super(message);
    this.name = "AuthzError";
  }
}

/**
 * Server-side authorisation for privileged actions. Re-reads membership from
 * the database (RLS-scoped to the caller) rather than trusting UI state.
 */
export async function requireRole(workspaceId: string, min: Role) {
  const { user, sb } = await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new AuthzError("Invalid workspace");
  const { data, error } = await sb.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
  if (error || !data) throw new AuthzError("You are not a member of this workspace");
  const role = data.role as Role;
  if (RANK[role] < RANK[min]) throw new AuthzError(`This action requires the ${min} role`);
  return { user, sb, role };
}
