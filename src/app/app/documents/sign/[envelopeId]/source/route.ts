import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageDocumentsRole } from "@/lib/documents/studio-access";

export async function GET(_request: Request, { params }: { params: Promise<{ envelopeId: string }> }) {
  const { envelopeId } = await params; const context = await getCurrentStudioContext(); if (!canManageDocumentsRole(context.studioRole)) return new NextResponse("Not found", { status: 404 }); const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("source_bucket,source_path").eq("id", envelopeId).eq("studio_id", context.studioId).maybeSingle();
  if (!envelope) return new NextResponse("Not found", { status: 404 });
  const { data, error } = await admin.storage.from(envelope.source_bucket).download(envelope.source_path);
  if (error || !data) return new NextResponse("Document unavailable", { status: 404 });
  return new NextResponse(new Uint8Array(await data.arrayBuffer()), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "Content-Disposition": "inline" } });
}
