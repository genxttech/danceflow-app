import { NextResponse } from "next/server";
import { runWaveAutoPost } from "@/lib/integrations/wave/autopost";
import { getCronAuthFailure } from "@/lib/security/cron";

export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

export async function GET(request: Request) {
  const authFailure = getCronAuthFailure(request, {
    secrets: [process.env.CRON_SECRET, process.env.WAVE_AUTOPOST_CRON_SECRET],
  });
  if (authFailure) return authFailure;

  const url = new URL(request.url);
  const maxRuns = positiveInt(url.searchParams.get("maxRuns"), 10, 25);
  const maxLines = positiveInt(url.searchParams.get("maxLines"), 10, 50);

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
