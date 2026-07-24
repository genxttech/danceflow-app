import { NextRequest, NextResponse } from "next/server";
import { verifyPendingAriaOutcomes } from "@/lib/aria/outcome-verification";
import { getCronAuthFailure } from "@/lib/security/cron";

async function handleRequest(request: NextRequest) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;

  try {
    const result = await verifyPendingAriaOutcomes(100);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown ARIA outcome verification error",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRequest(request);
}
