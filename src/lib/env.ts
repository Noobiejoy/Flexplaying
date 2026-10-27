import "server-only";
import { z } from "zod";

/**
 * Server-only configuration. Every value is optional at parse time so the app
 * can boot in an "unconfigured" state and show onboarding instead of crashing;
 * callers use the require* helpers when a value is mandatory for an operation.
 */
const googleModel = z
  .string()
  .regex(/^google\/[a-z0-9.\-:_]+$/i, "Only google/* models are allowed");

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(10).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(10).optional(),
  SUPABASE_SECRET_KEY: z.string().min(10).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_TEXT_MODEL: googleModel.default("google/gemini-3.7-flash"),
  OPENROUTER_RESEARCH_MODEL: googleModel.default("google/gemini-3.7-flash"),
  OPENROUTER_IMAGE_MODEL: googleModel.default("google/gemini-3.1-flash-image"),
  OPENROUTER_PROVIDER_ONLY: z.string().default("google-vertex,google-ai-studio"),
  OPENROUTER_WEB_SEARCH_MODE: z.enum(["server_tool", "plugin"]).default("server_tool"),
  OPENROUTER_WEB_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(8),
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIALS_ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9_-]{1,16}$/i).default("k1"),
  CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  CREDENTIALS_ENCRYPTION_KEY_PREVIOUS_ID: z.string().optional(),
  CRON_SECRET: z.string().min(32).optional(),
  APP_BASE_URL: z.url().optional(),
  EDITORIALOS_MOCK_PROVIDERS: z.enum(["true", "false"]).default("false"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Never echo values, only the names of invalid variables.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server configuration: ${names}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache() {
  cached = null;
}

export class ConfigError extends Error {
  constructor(public readonly variable: string, message?: string) {
    super(message ?? `Missing required configuration: ${variable}`);
    this.name = "ConfigError";
  }
}

export function supabasePublicConfig() {
  const e = env();
  const key = e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? e.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !key) return null;
  return { url: e.NEXT_PUBLIC_SUPABASE_URL, key };
}

export function supabaseSecretKey(): string | null {
  const e = env();
  return e.SUPABASE_SECRET_KEY ?? e.SUPABASE_SERVICE_ROLE_KEY ?? null;
}

export function mockProvidersEnabled(): boolean {
  return env().EDITORIALOS_MOCK_PROVIDERS === "true" && process.env.NODE_ENV !== "production";
}

export interface IntegrationHealth {
  supabase: boolean;
  supabaseServer: boolean;
  openrouter: boolean;
  encryption: boolean;
  scheduler: boolean;
  baseUrl: boolean;
  mock: boolean;
}

export function integrationHealth(): IntegrationHealth {
  const e = env();
  return {
    supabase: supabasePublicConfig() !== null,
    supabaseServer: supabaseSecretKey() !== null,
    openrouter: Boolean(e.OPENROUTER_API_KEY),
    encryption: Boolean(e.CREDENTIALS_ENCRYPTION_KEY),
    scheduler: Boolean(e.CRON_SECRET),
    baseUrl: Boolean(e.APP_BASE_URL),
    mock: mockProvidersEnabled(),
  };
}
