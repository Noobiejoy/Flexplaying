import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { serverDeps } from "@/lib/pipeline/server-deps";
import { runTick } from "@/lib/scheduler/tick";
import { verifySchedulerRequest } from "@/lib/scheduler/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Stages may only start within this window so each has headroom before maxDuration. */
const STAGE_START_BUDGET_MS = 170_000;

async function handle(req: NextRequest) {
  const auth = verifySchedulerRequest(req.headers, env().CRON_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const deps = serverDeps();
  if (auth.mode === "signed") {
    const fresh = await deps.store.recordNonce(auth.nonce, "supabase_cron");
    if (!fresh) return NextResponse.json({ ok: false, error: "replayed request" }, { status: 409 });
  }
  try {
    const result = await runTick(deps, { owner: `tick-${randomUUID()}`, budgetMs: STAGE_START_BUDGET_MS });
    return NextResponse.json({
      ok: true,
      auth: auth.mode,
      workspaces: result.workspaces,
      runs_created: result.created,
      runs_missed: result.missed,
      processed: result.processed.map((p) => ({ run: p.runId, status: p.status, stages: p.stagesRun })),
    });
  } catch (e) {
    console.error("scheduler tick failed", (e as Error).message);
    return NextResponse.json({ ok: false, error: "tick failed" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle; // Vercel Cron issues GET with a Bearer token
