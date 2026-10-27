"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser, WORKSPACE_COOKIE, listMemberships } from "@/lib/auth/session";
import { isValidTimeZone } from "@/lib/schedule/slots";
import { sha256Hex } from "@/lib/crypto/secrets";
import { done, isRedirect, safeMessage } from "./util";

export async function createWorkspace(fd: FormData) {
  const name = z.string().trim().min(1).max(80).safeParse(fd.get("name"));
  const tz = String(fd.get("timezone") ?? "Asia/Kolkata");
  if (!name.success) done("/onboarding", "err", "Workspace name is required");
  if (!isValidTimeZone(tz)) done("/onboarding", "err", "Unknown timezone");
  const { sb } = await requireUser();
  const { data, error } = await sb.rpc("create_workspace", { p_name: name.data, p_timezone: tz });
  if (error) done("/onboarding", "err", error.message);
  (await cookies()).set(WORKSPACE_COOKIE, String(data), { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  redirect("/settings?ok=Workspace created. Connect your WordPress site next.#wordpress");
}

export async function switchWorkspace(fd: FormData) {
  const id = String(fd.get("workspace_id") ?? "");
  const memberships = await listMemberships();
  if (!memberships.some((m) => m.workspace_id === id)) done("/overview", "err", "Not a member of that workspace");
  (await cookies()).set(WORKSPACE_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  redirect("/overview");
}

export async function updateProfile(fd: FormData) {
  const name = z.string().trim().min(1).max(120).safeParse(fd.get("display_name"));
  if (!name.success) done("/profile", "err", "Display name is required");
  const { user, sb } = await requireUser();
  const { error } = await sb.from("profiles").update({ display_name: name.data }).eq("id", user.id);
  if (error) done("/profile", "err", "Could not update profile");
  done("/profile", "ok", "Profile updated");
}

export async function acceptInvitation(fd: FormData) {
  const token = String(fd.get("token") ?? "");
  try {
    const { sb } = await requireUser();
    const { data, error } = await sb.rpc("accept_invitation", { p_token_hash: sha256Hex(token) });
    if (error) done(`/invite/${encodeURIComponent(token)}`, "err", error.message);
    (await cookies()).set(WORKSPACE_COOKIE, String(data), { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  } catch (e) {
    if (isRedirect(e)) throw e;
    done("/overview", "err", safeMessage(e));
  }
  redirect("/overview?ok=Invitation accepted");
}
