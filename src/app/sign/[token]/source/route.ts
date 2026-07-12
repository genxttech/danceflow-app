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
    action: "source_pdf",
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
    .select("source_bucket,source_path,status,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const expired = envelope ? new Date(envelope.expires_at).getTime() <= Date.now() : true;
  if (!envelope || expired || ["void", "expired", "declined"].includes(envelope.status)) {
    if (envelope && expired && !["completed", "void", "declined", "expired"].includes(envelope.status)) {
      await admin
        .from("document_sign_envelopes")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("token_hash", tokenHash);
    }
    return new NextResponse("Document unavailable", { status: 404 });
  }

  const { data, error } = await admin.storage
    .from(envelope.source_bucket)
    .download(envelope.source_path);
  if (error || !data) return new NextResponse("Document unavailable", { status: 404 });

  return new NextResponse(Buffer.from(await data.arrayBuffer()), {
    headers: {
      ...PUBLIC_PDF_HEADERS,
      "Content-Disposition": "inline",
    },
  });
}
