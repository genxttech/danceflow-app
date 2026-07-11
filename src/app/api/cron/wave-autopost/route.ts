import { NextResponse } from "next/server";
import { runWaveAutoPost } from "@/lib/integrations/wave/autopost";
import { getCronAuthFailure } from "@/lib/security/cron";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authFailure = getCronAuthFailure(request, {
    secrets: [process.env.CRON_SECRET, process.env.WAVE_AUTOPOST_CRON_SECRET],
  });
  if (authFailure) return authFailure;

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
