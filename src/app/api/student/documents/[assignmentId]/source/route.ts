import {
  normalizeStudentApiUuid,
  requireStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = Promise<{ assignmentId: string }>;

export async function GET(
  request: Request,
  { params }: { params: Params },
) {
  const auth = await requireStudentApiUser(request);
  if (!auth.ok) return auth.response;

  const { assignmentId: rawAssignmentId } = await params;
  const assignmentId = normalizeStudentApiUuid(rawAssignmentId);

  if (!assignmentId) {
    return studentApiJsonError("Invalid document assignment.", 400);
  }

  const admin = createAdminClient();

  const { data: assignment, error: assignmentError } = await admin
    .from("document_assignments")
    .select("id, studio_id, client_id, sign_envelope_id")
    .eq("id", assignmentId)
    .maybeSingle();

  if (assignmentError) {
    return studentApiJsonError(assignmentError.message, 400);
  }

  if (!assignment?.sign_envelope_id) {
    return studentApiJsonError("Document not found.", 404);
  }

  const { data: relationship, error: relationshipError } = await admin
    .from("client_account_links")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("studio_id", assignment.studio_id)
    .eq("client_id", assignment.client_id)
    .eq("status", "linked")
    .eq("can_sign_documents", true)
    .maybeSingle();

  if (relationshipError || !relationship) {
    return studentApiJsonError("Document access is not available.", 403);
  }

  const { data: envelope, error: envelopeError } = await admin
    .from("document_sign_envelopes")
    .select(
      "id, studio_id, client_id, assignment_id, status, source_bucket, source_path",
    )
    .eq("id", assignment.sign_envelope_id)
    .eq("studio_id", assignment.studio_id)
    .eq("client_id", assignment.client_id)
    .eq("assignment_id", assignment.id)
    .maybeSingle();

  if (envelopeError || !envelope) {
    return studentApiJsonError("Signing request could not be found.", 404);
  }

  if (["expired", "void"].includes(envelope.status)) {
    return studentApiJsonError("Signing request is no longer available.", 410);
  }

  const bucket = envelope.source_bucket;
  const path = envelope.source_path;

  if (!bucket || !path) {
    return studentApiJsonError("The source PDF is unavailable.", 404);
  }

  const { data: fileBlob, error: downloadError } = await admin.storage
    .from(bucket)
    .download(path);

  if (downloadError || !fileBlob) {
    console.error("Student document PDF download failed", {
      assignmentId,
      envelopeId: envelope.id,
      kind: "source",
      message: downloadError?.message ?? "Storage returned no file.",
    });

    return studentApiJsonError("The PDF could not be loaded.", 404);
  }

  const bytes = await fileBlob.arrayBuffer();

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="danceflow-document.pdf"',
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
