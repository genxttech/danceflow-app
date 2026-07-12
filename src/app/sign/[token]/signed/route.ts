import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSigningToken } from "@/lib/documents/signing";
import {
  consumePublicSigningRateLimit,
  PUBLIC_PDF_HEADERS,
  requestIp,
} from "@/lib/documents/public-signing-security";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const rateLimit = await consumePublicSigningRateLimit(admin, {
    action: "signed_pdf",
    tokenHash,
    ip: requestIp(request),
  });
  if (!rateLimit.allowed) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    });
  }

  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("title,status,signed_bucket,signed_path")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (
    !envelope ||
    envelope.status !== "completed" ||
    !envelope.signed_bucket ||
    !envelope.signed_path
  ) {
    return new NextResponse("Signed document unavailable", { status: 404 });
  }

  const { data, error } = await admin.storage
    .from(envelope.signed_bucket)
    .download(envelope.signed_path);
  if (error || !data) return new NextResponse("Signed document unavailable", { status: 404 });

  const filename = `${String(envelope.title)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "signed-document"}-signed.pdf`;

  return new NextResponse(Buffer.from(await data.arrayBuffer()), {
    headers: {
      ...PUBLIC_PDF_HEADERS,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
