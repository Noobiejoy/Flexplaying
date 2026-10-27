import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ConfigError, supabasePublicConfig, supabaseSecretKey } from "@/lib/env";

let admin: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses RLS, so it is used only by the scheduler,
 * the pipeline and server actions that have already authorised the caller.
 */
export function adminClient(): SupabaseClient {
  if (admin) return admin;
  const cfg = supabasePublicConfig();
  const secret = supabaseSecretKey();
  if (!cfg) throw new ConfigError("NEXT_PUBLIC_SUPABASE_URL");
  if (!secret) throw new ConfigError("SUPABASE_SECRET_KEY");
  admin = createClient(cfg.url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
