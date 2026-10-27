import { describe, expect, it } from "vitest";
import { signTick, verifySchedulerRequest } from "@/lib/scheduler/signature";
import { runTick } from "@/lib/scheduler/tick";
import { harness, NOW } from "./helpers/fixtures";

const SECRET = "s".repeat(48);

function headers(h: Record<string, string>) {
  return new Headers(h);
}

describe("scheduler authentication", () => {
  const ts = String(Math.floor(NOW.getTime() / 1000));
  it("accepts a valid signature", () => {
    const r = verifySchedulerRequest(headers({ "x-editorialos-timestamp": ts, "x-editorialos-nonce": "nonce-12345678", "x-editorialos-signature": signTick(SECRET, ts, "nonce-12345678") }), SECRET, NOW.getTime());
    expect(r).toEqual({ ok: true, mode: "signed", nonce: "nonce-12345678" });
  });
  it("rejects a bad signature, stale timestamp, missing secret and wrong bearer", () => {
    expect(verifySchedulerRequest(headers({ "x-editorialos-timestamp": ts, "x-editorialos-nonce": "nonce-12345678", "x-editorialos-signature": "00" }), SECRET, NOW.getTime()).ok).toBe(false);
    const old = String(Number(ts) - 600);
    expect(verifySchedulerRequest(headers({ "x-editorialos-timestamp": old, "x-editorialos-nonce": "nonce-12345678", "x-editorialos-signature": signTick(SECRET, old, "nonce-12345678") }), SECRET, NOW.getTime()).ok).toBe(false);
    expect(verifySchedulerRequest(headers({ authorization: `Bearer ${SECRET}` }), undefined).ok).toBe(false);
    expect(verifySchedulerRequest(headers({ authorization: "Bearer nope" }), SECRET).ok).toBe(false);
    expect(verifySchedulerRequest(headers({}), SECRET).ok).toBe(false);
  });
  it("accepts the bearer form (Vercel Cron / manual)", () => {
    expect(verifySchedulerRequest(headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toEqual({ ok: true, mode: "bearer" });
  });
  it("replay protection: the same nonce is accepted once", async () => {
    const h = await harness();
    expect(await h.store.recordNonce("n-1", "t")).toBe(true);
    expect(await h.store.recordNonce("n-1", "t")).toBe(false);
  });
});

describe("scheduler tick", () => {
  it("creates the due slot exactly once even if ticks repeat, and runs it to completion", async () => {
    const h = await harness({ settings: { automation_changed_at: "2026-10-27T00:00:00Z" } });
    const t1 = await runTick(h.deps, { owner: "t1", budgetMs: 600_000 });
    const t2 = await runTick(h.deps, { owner: "t2", budgetMs: 600_000 });
    expect(t1.created).toBe(1);
    expect(t2.created).toBe(0);
    const scheduled = h.store.runs.filter((r) => r.trigger === "schedule");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.slot_key).toBe("2026-10-27T09:00");
    expect(scheduled[0]!.status).toBe("drafted");
  });

  it("records missed slots and notifies", async () => {
    const h = await harness({ settings: { automation_changed_at: "2026-10-26T00:00:00Z" } });
    const t = await runTick(h.deps, { owner: "t", budgetMs: 600_000 });
    expect(t.missed).toBe(3);
    expect(h.store.runs.filter((r) => r.status === "missed")).toHaveLength(3);
    expect(h.store.notifications.some((n) => n.title.includes("Missed"))).toBe(true);
  });

  it("pause: no runs are created and queued scheduled runs are cancelled", async () => {
    const h = await harness({ settings: { automation_enabled: false, automation_changed_at: "2026-10-27T00:00:00Z" } });
    expect((await runTick(h.deps, { owner: "t", budgetMs: 600_000 })).created).toBe(0);
    const queued = await h.store.createRun({ workspace_id: h.ws, trigger: "schedule", slot_key: "2026-10-27T09:00", scheduled_for: NOW.toISOString(), status: "queued", publishing_mode: "draft_only", triggered_by: null });
    await runTick(h.deps, { owner: "t", budgetMs: 600_000 });
    expect((await h.store.getRun(queued!.id))!.status).toBe("cancelled");
  });

  it("resume: re-enabling automation creates runs again", async () => {
    const h = await harness({ settings: { automation_enabled: false, automation_changed_at: "2026-10-27T00:00:00Z" } });
    await runTick(h.deps, { owner: "t", budgetMs: 600_000 });
    h.store.settings.get(h.ws)!.automation_enabled = true;
    expect((await runTick(h.deps, { owner: "t", budgetMs: 600_000 })).created).toBe(1);
  });

  it("only one active run per workspace is advanced at a time", async () => {
    const h = await harness();
    const a = await h.store.createRun({ workspace_id: h.ws, trigger: "manual", slot_key: null, scheduled_for: null, status: "queued", publishing_mode: "dry_run", triggered_by: null });
    await h.store.updateRun(a!.id, { status: "researching" });
    await h.store.claimRun(a!.id, "someone-else", 300);
    const b = await h.store.createRun({ workspace_id: h.ws, trigger: "manual", slot_key: null, scheduled_for: null, status: "queued", publishing_mode: "dry_run", triggered_by: null });
    const { processRun } = await import("@/lib/pipeline/engine");
    await processRun(h.deps, b!.id, { owner: "x", budgetMs: 60_000 });
    expect((await h.store.getRun(b!.id))!.status).toBe("queued");
  });
});
