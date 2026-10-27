import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM envelope for credentials stored in public.workspace_secrets.
 * Format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * The workspace id is bound as additional authenticated data so a ciphertext
 * cannot be moved to a different workspace.
 */
export interface KeyRing {
  current: { id: string; key: Buffer };
  previous?: { id: string; key: Buffer };
}

export function parseKey(material: string): Buffer {
  const trimmed = material.trim();
  const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error("Encryption key must be 32 bytes (base64 or 64 hex characters)");
  }
  return buf;
}

export function encryptSecret(plaintext: string, aad: string, ring: KeyRing): { ciphertext: string; keyId: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.current.key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = ["v1", ring.current.id, iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
  return { ciphertext, keyId: ring.current.id };
}

export function decryptSecret(envelope: string, aad: string, ring: KeyRing): string {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Unrecognised secret format");
  const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
  const key =
    keyId === ring.current.id ? ring.current.key : keyId === ring.previous?.id ? ring.previous.key : null;
  if (!key) throw new Error("Secret was encrypted with an unknown key; reconnect the credential");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

export function needsReencryption(envelope: string, ring: KeyRing): boolean {
  return envelope.split(".")[1] !== ring.current.id;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing does not reveal length differences cheaply.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
