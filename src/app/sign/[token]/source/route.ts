import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSigningToken } from "@/lib/documents/signing";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("source_bucket,source_path,status,expires_at").eq("token_hash", hashSigningToken(token)).maybeSingle();
  if (!envelope || ["void", "expired"].includes(envelope.status) || new Date(envelope.expires_at).getTime() <= Date.now()) return new NextResponse("Document unavailable", { status: 404 });
  const { data, error } = await admin.storage.from(envelope.source_bucket).download(envelope.source_path);
  if (error || !data) return new NextResponse("Document unavailable", { status: 404 });
  return new NextResponse(new Uint8Array(await data.arrayBuffer()), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "private, no-store" } });
}
