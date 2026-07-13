import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createSigningToken,
  hashSigningToken,
} from "@/lib/documents/signing";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";

type Params = Promise<{
  studioSlug: string;
  assignmentId: string;
}>;

function portalDocumentsUrl(params: {
  request: NextRequest;
  studioSlug: string;
  clientId?: string | null;
  error?: string;
}) {
  const url = new URL(
    `/portal/${encodeURIComponent(params.studioSlug)}/documents`,
    params.request.url,
  );

  if (params.clientId) {
    url.searchParams.set("client", params.clientId);
  }

  if (params.error) {
    url.searchParams.set("error", params.error);
  }

  return url;
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

  if (!studio) {
    return NextResponse.redirect(new URL("/account", request.url));
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId,
    permission: "can_sign_documents",
  });

  if (!relationship) {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: requestedClientId,
        error: "document_not_assigned",
      }),
    );
  }

  const admin = createAdminClient();

  const { data: assignment } = await admin
    .from("document_assignments")
    .select("id, client_id, studio_id, status, sign_envelope_id")
    .eq("id", assignmentId)
    .eq("studio_id", studio.id)
    .eq("client_id", relationship.clientId)
    .maybeSingle();

  if (!assignment?.sign_envelope_id) {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: relationship.clientId,
        error: "document_not_found",
      }),
    );
  }

  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id, studio_id, client_id, assignment_id, status, expires_at")
    .eq("id", assignment.sign_envelope_id)
    .eq("studio_id", studio.id)
    .eq("client_id", relationship.clientId)
    .eq("assignment_id", assignment.id)
    .maybeSingle();

  if (!envelope) {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: relationship.clientId,
        error: "signing_request_unavailable",
      }),
    );
  }

  if (envelope.status === "draft") {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: relationship.clientId,
        error: "document_preparing",
      }),
    );
  }

  if (
    !["sent", "viewed", "started"].includes(envelope.status) ||
    new Date(envelope.expires_at).getTime() <= Date.now()
  ) {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: relationship.clientId,
        error: "signing_request_unavailable",
      }),
    );
  }

  /*
    The database stores only a token hash. An authenticated portal user who
    owns this assignment receives a fresh secure token before entering the
    public signing surface. This also invalidates any older token for the
    same envelope.
  */
  const token = createSigningToken();
  const now = new Date().toISOString();

  const { data: updatedEnvelope, error: updateError } = await admin
    .from("document_sign_envelopes")
    .update({
      token_hash: hashSigningToken(token),
      updated_at: now,
    })
    .eq("id", envelope.id)
    .eq("studio_id", studio.id)
    .eq("client_id", relationship.clientId)
    .in("status", ["sent", "viewed", "started"])
    .select("id")
    .maybeSingle();

  if (updateError || !updatedEnvelope) {
    return NextResponse.redirect(
      portalDocumentsUrl({
        request,
        studioSlug,
        clientId: relationship.clientId,
        error: "signing_request_unavailable",
      }),
    );
  }

  return NextResponse.redirect(
    new URL(`/sign/${encodeURIComponent(token)}`, request.url),
  );
}
