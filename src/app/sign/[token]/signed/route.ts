import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSigningToken } from "@/lib/documents/signing";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes").select("title,status,signed_bucket,signed_path").eq("token_hash", hashSigningToken(token)).maybeSingle();
  if (!envelope || envelope.status !== "completed" || !envelope.signed_bucket || !envelope.signed_path) return new NextResponse("Signed document unavailable", { status: 404 });
  const { data, error } = await admin.storage.from(envelope.signed_bucket).download(envelope.signed_path);
  if (error || !data) return new NextResponse("Signed document unavailable", { status: 404 });
  const filename = `${String(envelope.title).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "signed-document"}-signed.pdf`;
  return new NextResponse(new Uint8Array(await data.arrayBuffer()), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
}
