"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { requireRole } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rate-limit";
import { randomToken, sha256Hex } from "@/lib/crypto/secrets";
import { env } from "@/lib/env";
import { done, isRedirect, safeMessage } from "./util";

const P = "/settings#members";

export async function createInvitation(fd: FormData) {
  let link = "";
  try {
    const ws = String(fd.get("workspace_id"));
    const { sb, user } = await requireRole(ws, "owner");
    if (!(await rateLimit(user.id, ws, "invite", 20, 86400))) throw new Error("Rate limit: too many invitations today");
    const email = z.email().parse(String(fd.get("email") ?? "").trim().toLowerCase());
    const role = z.enum(["editor", "viewer"]).parse(fd.get("role"));
    const token = randomToken(24);
    const { error } = await sb.from("workspace_invitations").insert({ workspace_id: ws, email, role, token_hash: sha256Hex(token), invited_by: user.id, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
    if (error) throw new Error(`Database error: ${error.message}`);
    const h = await headers();
    const base = env().APP_BASE_URL ?? `https://${h.get("host")}`;
    link = `${base.replace(/\/$/, "")}/invite/${token}`;
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(P, "err", safeMessage(e));
  }
  done(P, "ok", `Invitation created. Send this one-time link (valid 7 days): ${link}`);
}

export async function revokeInvitation(fd: FormData) {
  try {
    const ws = String(fd.get("workspace_id"));
    const { sb } = await requireRole(ws, "owner");
    await sb.from("workspace_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", String(fd.get("id"))).eq("workspace_id", ws);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(P, "err", safeMessage(e));
  }
  done(P, "ok", "Invitation revoked");
}

export async function updateMember(fd: FormData) {
  try {
    const ws = String(fd.get("workspace_id"));
    const { sb, user } = await requireRole(ws, "owner");
    const target = z.uuid().parse(fd.get("user_id"));
    if (target === user.id) throw new Error("Invalid request: you cannot change your own role");
    const action = String(fd.get("action"));
    if (action === "remove") {
      const { error } = await sb.from("workspace_members").delete().eq("workspace_id", ws).eq("user_id", target);
      if (error) throw new Error(`Database error: ${error.message}`);
    } else {
      const role = z.enum(["owner", "editor", "viewer"]).parse(fd.get("role"));
      const { error } = await sb.from("workspace_members").update({ role }).eq("workspace_id", ws).eq("user_id", target);
      if (error) throw new Error(`Database error: ${error.message}`);
    }
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(P, "err", safeMessage(e));
  }
  done(P, "ok", "Membership updated");
}
