import "server-only";
import { createDomainRegistry } from "@/lib/editorial/domains";
import { env, mockProvidersEnabled, ConfigError } from "@/lib/env";
import { decryptSecret } from "@/lib/crypto/secrets";
import { serverKeyRing } from "@/lib/crypto/keyring";
import { composeThumbnail } from "@/lib/image/compose";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import type { AiProvider } from "@/lib/ai/types";
import { AiError } from "@/lib/ai/types";
import { WordPressClient } from "@/lib/wordpress/client";
import { MockWordPress } from "@/lib/wordpress/mock";
import { adminClient } from "@/lib/supabase/admin";
import { isSafePublicHttpUrl } from "@/lib/wordpress/url";
import type { PipelineDeps } from "./context";
import { createPageFetcher } from "./source-verify";
import { SupabaseStore } from "./supabase-store";

class UnconfiguredAi implements AiProvider {
  readonly name = "unconfigured";
  private fail(): never {
    throw new AiError("not_configured", "OPENROUTER_API_KEY is not configured on the server");
  }
  research = async () => this.fail();
  complete = async () => this.fail();
  generateImage = async () => this.fail();
  listModels = async () => this.fail();
}

export function serverAi(): AiProvider {
  const e = env();
  if (!e.OPENROUTER_API_KEY) return new UnconfiguredAi();
  return new OpenRouterProvider({
    apiKey: e.OPENROUTER_API_KEY,
    baseUrl: e.OPENROUTER_BASE_URL,
    providerOnly: e.OPENROUTER_PROVIDER_ONLY.split(",").map((s) => s.trim()).filter(Boolean),
    webSearchMode: e.OPENROUTER_WEB_SEARCH_MODE,
    webMaxResults: e.OPENROUTER_WEB_MAX_RESULTS,
    appUrl: e.APP_BASE_URL,
    appName: "EditorialOS",
  });
}

/** Store that also forwards notifications to the workspace's optional webhook. */
class NotifyingStore extends SupabaseStore {
  override async notify(workspaceId: string, runId: string | null, level: "info" | "warning" | "error", title: string, body: string) {
    await super.notify(workspaceId, runId, level, title, body);
    try {
      const ct = await this.getSecretCiphertext(workspaceId, "notification_webhook");
      if (!ct) return;
      const url = decryptSecret(ct, `${workspaceId}:notification_webhook`, serverKeyRing());
      if (!isSafePublicHttpUrl(url) || !url.startsWith("https://")) return;
      const text = `[EditorialOS] ${level.toUpperCase()}: ${title}\n${body}`;
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
    } catch {
      // Webhook delivery is best effort; the in-app notification is the record.
    }
  }
}

export function serverDeps(): PipelineDeps {
  const e = env();
  const store = new NotifyingStore(adminClient());
  const mock = mockProvidersEnabled();
  const mockWp = mock ? new MockWordPress() : null;
  return {
    store,
    ai: serverAi(),
    wordpress: async (ctx) => {
      if (mockWp) return mockWp;
      if (!ctx.wp) return null;
      const ct = await store.getSecretCiphertext(ctx.workspaceId, "wordpress_app_password");
      if (!ct) throw new ConfigError("WordPress application password", "WordPress credentials are missing; reconnect the site in Settings");
      const appPassword = decryptSecret(ct, `${ctx.workspaceId}:wordpress_app_password`, serverKeyRing());
      return new WordPressClient({ siteUrl: ctx.wp.site_url, username: ctx.wp.username, appPassword });
    },
    domains: createDomainRegistry(),
    fetchPage: createPageFetcher(),
    composeImage: composeThumbnail,
    now: () => new Date(),
    models: { text: e.OPENROUTER_TEXT_MODEL, research: e.OPENROUTER_RESEARCH_MODEL, image: e.OPENROUTER_IMAGE_MODEL },
    siteName: "EditorialOS",
  };
}
