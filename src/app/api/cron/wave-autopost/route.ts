import { NextResponse } from "next/server";
import { runWaveAutoPost } from "@/lib/integrations/wave/autopost";

export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET ?? process.env.WAVE_AUTOPOST_CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const maxRuns = Number(url.searchParams.get("maxRuns") ?? "10");
  const maxLines = Number(url.searchParams.get("maxLines") ?? "10");

  try {
    const result = await runWaveAutoPost({ maxRuns, maxLines });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Wave auto-post failed.",
    }, { status: 500 });
  }
}
