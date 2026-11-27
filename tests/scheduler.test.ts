import { describe, expect, it } from "vitest";
import { signTick, verifySchedulerRequest } from "@/lib/scheduler/signature";
import { runTick } from "@/lib/scheduler/tick";
import { isTerminal } from "@/lib/pipeline/types";
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
  it("creates one run per category for the due slot, exactly once, and works through them back to back", async () => {
    const h = await harness({ settings: { automation_changed_at: "2026-10-27T00:00:00Z" } });
    const t1 = await runTick(h.deps, { owner: "t1", budgetMs: 600_000 });
    const t2 = await runTick(h.deps, { owner: "t2", budgetMs: 600_000 });
    expect(t1.created).toBe(3);
    expect(t2.created).toBe(0);
    const scheduled = h.store.runs.filter((r) => r.trigger === "schedule");
    expect(scheduled.map((r) => r.slot_key)).toEqual(["2026-10-27T09:00#anime", "2026-10-27T09:00#gaming", "2026-10-27T09:00#esports"]);
    expect(scheduled.map((r) => r.category)).toEqual(["anime", "gaming", "esports"]);
    // The mock only has anime news; the other desks try every effort level before giving up.
    expect(scheduled[0]!.status).toBe("drafted");
    expect(scheduled[1]!.escalation).toBe(2);
    expect(scheduled[1]!.status).toBe("skipped");
    expect(scheduled[2]!.status).toBe("skipped");
    expect(h.store.notifications.filter((n) => n.title === "No article for this slot")).toHaveLength(2);
  });

  it("leaves a slot alone if it already ran the old way (one run for all categories)", async () => {
    const h = await harness({ settings: { automation_changed_at: "2026-10-27T00:00:00Z" } });
    await h.store.createRun({ workspace_id: h.ws, trigger: "schedule", slot_key: "2026-10-27T09:00", scheduled_for: NOW.toISOString(), status: "missed", publishing_mode: "draft_only", triggered_by: null });
    expect((await runTick(h.deps, { owner: "t", budgetMs: 600_000 })).created).toBe(0);
  });

  it("records missed slots and notifies", async () => {
    const h = await harness({ settings: { automation_changed_at: "2026-10-26T00:00:00Z" } });
    const t = await runTick(h.deps, { owner: "t", budgetMs: 600_000 });
    // Three slots yesterday after the change time (09:00 is still due today), each missed for three categories.
    expect(t.missed).toBe(9);
    expect(h.store.runs.filter((r) => r.status === "missed")).toHaveLength(9);
    expect(h.store.notifications.filter((n) => n.title.includes("Missed"))).toHaveLength(3);
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
    expect((await runTick(h.deps, { owner: "t", budgetMs: 600_000 })).created).toBe(3);
  });

  it("runs created in the same instant still all run, one after another, whatever order the queue is listed in", async () => {
    for (const reversed of [false, true]) {
      const h = await harness();
      const ids: string[] = [];
      for (const category of ["anime", "gaming", "esports"] as const) {
        const r = await h.store.createRun({ workspace_id: h.ws, trigger: "manual", slot_key: null, scheduled_for: null, status: "queued", publishing_mode: "dry_run", triggered_by: null, category });
        ids.push(r!.id);
      }
      const mine = h.store.runs.filter((r) => ids.includes(r.id));
      for (const r of mine) r.created_at = mine[0]!.created_at; // e.g. one multi-row insert
      if (reversed) {
        // A queue listed in a different order from the turn check must not stall either.
        const list = h.store.listRunnableRuns.bind(h.store);
        h.store.listRunnableRuns = async (now, limit) => (await list(now, limit)).reverse();
      }
      await runTick(h.deps, { owner: "t", budgetMs: 600_000 });
      expect(mine.map((r) => r.status).every((s) => isTerminal(s)), `reversed=${reversed}: ${mine.map((r) => r.status)}`).toBe(true);
      const startOrder = h.store.logs.filter((l) => l.message.startsWith("Run started") && ids.includes(l.run_id)).map((l) => l.run_id);
      expect(startOrder).toEqual([...ids].sort()); // tie broken by id, every time
    }
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
