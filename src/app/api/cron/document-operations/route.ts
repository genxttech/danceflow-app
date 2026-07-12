import { NextResponse } from "next/server";
import { getCronAuthFailure } from "@/lib/security/cron";
import { runDocumentOperations } from "@/lib/documents/operations";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authFailure = getCronAuthFailure(request);
  if (authFailure) return authFailure;
  try {
    const result = await runDocumentOperations();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Document operations cron failed", error);
    return NextResponse.json({ ok: false, error: "Document operations failed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
