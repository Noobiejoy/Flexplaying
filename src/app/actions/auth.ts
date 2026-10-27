"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { done } from "./util";

const creds = z.object({ email: z.email().max(200), password: z.string().min(10, "Password must be at least 10 characters").max(200) });

async function origin() {
  const base = env().APP_BASE_URL;
  if (base) return base.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
}

function safeNext(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/overview";
}

export async function signIn(fd: FormData) {
  const parsed = creds.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) done("/login", "err", "Enter a valid email and password");
  const sb = await createUserClient();
  if (!sb) redirect("/setup");
  const { error } = await sb.auth.signInWithPassword(parsed.data);
  if (error) done("/login", "err", "Sign-in failed. Check your email and password.");
  redirect(safeNext(fd.get("next")));
}

export async function signUp(fd: FormData) {
  const parsed = creds.extend({ name: z.string().trim().min(1).max(80) }).safeParse({ email: fd.get("email"), password: fd.get("password"), name: fd.get("name") });
  if (!parsed.success) done("/signup", "err", parsed.error.issues[0]?.message ?? "Invalid input");
  const sb = await createUserClient();
  if (!sb) redirect("/setup");
  const { data, error } = await sb.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { display_name: parsed.data.name }, emailRedirectTo: `${await origin()}/auth/callback?next=/onboarding` },
  });
  if (error) done("/signup", "err", error.message);
  if (!data.session) done("/login", "ok", "Check your inbox to confirm your email, then sign in.");
  redirect("/onboarding");
}

export async function signOut() {
  const sb = await createUserClient();
  await sb?.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(fd: FormData) {
  const email = z.email().safeParse(fd.get("email"));
  if (email.success) {
    const sb = await createUserClient();
    await sb?.auth.resetPasswordForEmail(email.data, { redirectTo: `${await origin()}/auth/callback?next=/reset-password` });
  }
  // Same response whether or not the account exists.
  done("/forgot-password", "ok", "If that email has an account, a reset link is on its way.");
}

export async function updatePassword(fd: FormData) {
  const pw = z.string().min(10).max(200).safeParse(fd.get("password"));
  if (!pw.success) done("/reset-password", "err", "Password must be at least 10 characters");
  if (fd.get("password") !== fd.get("confirm")) done("/reset-password", "err", "Passwords do not match");
  const sb = await createUserClient();
  if (!sb) redirect("/setup");
  const { error } = await sb.auth.updateUser({ password: pw.data });
  if (error) done("/reset-password", "err", "Could not update password. Request a new reset link.");
  done("/overview", "ok", "Password updated");
}
