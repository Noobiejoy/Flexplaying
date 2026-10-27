import "server-only";
import { env, ConfigError } from "@/lib/env";
import { parseKey, type KeyRing } from "./secrets";

export function serverKeyRing(): KeyRing {
  const e = env();
  if (!e.CREDENTIALS_ENCRYPTION_KEY) throw new ConfigError("CREDENTIALS_ENCRYPTION_KEY");
  const ring: KeyRing = { current: { id: e.CREDENTIALS_ENCRYPTION_KEY_ID, key: parseKey(e.CREDENTIALS_ENCRYPTION_KEY) } };
  if (e.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS && e.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS_ID) {
    ring.previous = { id: e.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS_ID, key: parseKey(e.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) };
  }
  return ring;
}
