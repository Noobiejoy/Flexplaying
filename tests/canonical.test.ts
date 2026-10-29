import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "@/lib/canonical";

const BASE = "https://editor.flexplaying.com";
const at = (u: string) => new URL(u);

describe("canonicalRedirect", () => {
  it("sends other production hosts to the canonical address, keeping path and query", () => {
    const to = canonicalRedirect(at("https://editorialos-chi.vercel.app/articles?status=drafted"), "editorialos-chi.vercel.app", BASE, "production");
    expect(to?.toString()).toBe("https://editor.flexplaying.com/articles?status=drafted");
  });

  it("leaves the canonical host alone, whatever the case", () => {
    expect(canonicalRedirect(at("https://editor.flexplaying.com/overview"), "Editor.FlexPlaying.com", BASE, "production")).toBeNull();
  });

  it("never redirects API routes, so the scheduler keeps working on an old URL", () => {
    expect(canonicalRedirect(at("https://editorialos-chi.vercel.app/api/cron/tick"), "editorialos-chi.vercel.app", BASE, "production")).toBeNull();
    expect(canonicalRedirect(at("https://editorialos-chi.vercel.app/api"), "editorialos-chi.vercel.app", BASE, "production")).toBeNull();
  });

  it("does nothing outside production or without a valid base URL", () => {
    const u = at("https://x.vercel.app/overview");
    expect(canonicalRedirect(u, "x.vercel.app", BASE, "preview")).toBeNull();
    expect(canonicalRedirect(u, "localhost:3000", BASE, undefined)).toBeNull();
    expect(canonicalRedirect(u, "x.vercel.app", undefined, "production")).toBeNull();
    expect(canonicalRedirect(u, "x.vercel.app", "not a url", "production")).toBeNull();
  });

  it("drops Vercel share tokens from the redirected URL", () => {
    const to = canonicalRedirect(at("https://x.vercel.app/login?_vercel_share=abc&next=%2Foverview"), "x.vercel.app", BASE, "production");
    expect(to?.toString()).toBe("https://editor.flexplaying.com/login?next=%2Foverview");
  });
});
