import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness only. Integration details are shown to signed-in owners in Settings. */
export function GET() {
  return NextResponse.json({ ok: true, service: "editorialos", time: new Date().toISOString() });
}
