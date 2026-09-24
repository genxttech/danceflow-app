import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";

type Params = Promise<{
  studioSlug: string;
  assignmentId: string;
}>;

function notFound() {
  return new NextResponse("Not found", { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { studioSlug, assignmentId } = await params;
  const requestedClientId = request.nextUrl.searchParams.get("client");
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("intent", "public");
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  const { data: studio } = await supabase
    .from("studios")
    .select("id, slug")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (!studio) return notFound();

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_view_schedule",
  });

  if (!relationship) return notFound();

  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("document_assignments")
    .select("id, client_id, studio_id, sign_envelope_id")
    .eq("id", assignmentId)
    .eq("studio_id", studio.id)
    .eq("client_id", relationship.clientId)
    .maybeSingle();

  if (!assignment?.sign_envelope_id) return notFound();

  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("title, status, signed_bucket, signed_path")
    .eq("id", assignment.sign_envelope_id)
    .eq("assignment_id", assignment.id)
    .eq("studio_id", studio.id)
    .eq("client_id", relationship.clientId)
    .maybeSingle();

  if (
    !envelope ||
    envelope.status !== "completed" ||
    !envelope.signed_bucket ||
    !envelope.signed_path
  ) {
    return notFound();
  }

  const { data, error } = await admin.storage
    .from(envelope.signed_bucket)
    .download(envelope.signed_path);

  if (error || !data) return notFound();

  const filename = `${
    String(envelope.title)
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "signed-document"
  }-signed.pdf`;

  return new NextResponse(new Uint8Array(await data.arrayBuffer()), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
