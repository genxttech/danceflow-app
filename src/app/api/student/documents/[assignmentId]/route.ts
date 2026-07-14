import { NextResponse } from "next/server";
import {
  normalizeStudentApiUuid,
  requireStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = Promise<{ assignmentId: string }>;

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

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
    .select(`
      id,
      studio_id,
      client_id,
      template_id,
      template_version_id,
      sign_envelope_id,
      status,
      due_at,
      assigned_at,
      signed_at,
      document_templates:template_id (
        title,
        description,
        document_type,
        requires_signature,
        is_required
      ),
      studios:studio_id (
        slug,
        name,
        public_name
      )
    `)
    .eq("id", assignmentId)
    .maybeSingle();

  if (assignmentError) {
    return studentApiJsonError(assignmentError.message, 400);
  }

  if (!assignment) {
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

  const template = firstJoin(assignment.document_templates);
  const studio = firstJoin(assignment.studios);

  if (!assignment.sign_envelope_id) {
    return NextResponse.json({
      document: {
        id: assignment.id,
        studioId: assignment.studio_id,
        clientId: assignment.client_id,
        studioName: studio?.public_name || studio?.name || "Studio",
        studioSlug: studio?.slug || null,
        title: template?.title || "Document",
        description: template?.description || null,
        documentType: template?.document_type || "document",
        required: template?.is_required === true,
        requiresSignature: template?.requires_signature !== false,
        status: assignment.status || "assigned",
        dueAt: assignment.due_at,
        assignedAt: assignment.assigned_at,
        signedAt: assignment.signed_at,
        envelopeStatus: null,
        nativeSigningAvailable: false,
        signerName: "",
        signerEmail: auth.user.email ?? null,
        expiresAt: null,
        pageCount: 0,
        pageSizes: [],
        sourceUrl: null,
        signedUrl: null,
      },
      fields: [],
    });
  }

  const { data: envelope, error: envelopeError } = await admin
    .from("document_sign_envelopes")
    .select(`
      id,
      studio_id,
      client_id,
      assignment_id,
      title,
      signer_name,
      signer_email,
      status,
      expires_at,
      viewed_at,
      completed_at,
      page_count,
      page_sizes,
      source_bucket,
      source_path,
      signed_bucket,
      signed_path
    `)
    .eq("id", assignment.sign_envelope_id)
    .eq("studio_id", assignment.studio_id)
    .eq("client_id", assignment.client_id)
    .eq("assignment_id", assignment.id)
    .maybeSingle();

  if (envelopeError || !envelope) {
    return studentApiJsonError("Signing request could not be found.", 404);
  }

  const expired = new Date(envelope.expires_at).getTime() <= Date.now();

  if (
    expired &&
    !["completed", "declined", "expired", "void"].includes(envelope.status)
  ) {
    await admin
      .from("document_sign_envelopes")
      .update({
        status: "expired",
        updated_at: new Date().toISOString(),
      })
      .eq("id", envelope.id);
    envelope.status = "expired";
  }

  if (
    !envelope.viewed_at &&
    !expired &&
    envelope.status === "sent"
  ) {
    const now = new Date().toISOString();

    await admin
      .from("document_sign_envelopes")
      .update({
        status: "viewed",
        viewed_at: now,
        updated_at: now,
      })
      .eq("id", envelope.id)
      .eq("status", "sent");

    await admin.from("document_sign_events").insert({
      envelope_id: envelope.id,
      event_type: "viewed",
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? envelope.signer_email,
      summary: "Signer opened the document in the DanceFlow student app.",
      metadata: { source: "student_mobile_app" },
    });

    envelope.status = "viewed";
    envelope.viewed_at = now;
  }

  const { data: fields, error: fieldsError } = await admin
    .from("document_sign_fields")
    .select(`
      id,
      field_type,
      page_number,
      x,
      y,
      width,
      height,
      label,
      required,
      placeholder_text,
      default_value,
      sort_order
    `)
    .eq("envelope_id", envelope.id)
    .order("sort_order");

  if (fieldsError) {
    return studentApiJsonError(fieldsError.message, 400);
  }

  let sourceUrl: string | null = null;
  let signedUrl: string | null = null;

  if (envelope.source_bucket && envelope.source_path) {
    const { data: signedSource } = await admin.storage
      .from(envelope.source_bucket)
      .createSignedUrl(envelope.source_path, 5 * 60);
    sourceUrl = signedSource?.signedUrl ?? null;
  }

  if (envelope.signed_bucket && envelope.signed_path) {
    const { data: signedDocument } = await admin.storage
      .from(envelope.signed_bucket)
      .createSignedUrl(envelope.signed_path, 5 * 60);
    signedUrl = signedDocument?.signedUrl ?? null;
  }

  const completed =
    envelope.status === "completed" ||
    assignment.status === "signed" ||
    Boolean(assignment.signed_at || envelope.completed_at);

  return NextResponse.json({
    document: {
      id: assignment.id,
      studioId: assignment.studio_id,
      clientId: assignment.client_id,
      studioName: studio?.public_name || studio?.name || "Studio",
      studioSlug: studio?.slug || null,
      title: envelope.title || template?.title || "Document",
      description: template?.description || null,
      documentType: template?.document_type || "document",
      required: template?.is_required === true,
      requiresSignature: template?.requires_signature !== false,
      status: completed ? "signed" : assignment.status || "assigned",
      dueAt: assignment.due_at,
      assignedAt: assignment.assigned_at,
      signedAt: assignment.signed_at ?? envelope.completed_at ?? null,
      envelopeStatus: envelope.status,
      nativeSigningAvailable: true,
      signerName: envelope.signer_name,
      signerEmail: envelope.signer_email,
      expiresAt: envelope.expires_at,
      pageCount: envelope.page_count,
      pageSizes: Array.isArray(envelope.page_sizes)
        ? envelope.page_sizes
        : [],
      sourceUrl,
      signedUrl,
    },
    fields: (fields ?? []).map((field) => ({
      id: field.id,
      fieldType: field.field_type,
      pageNumber: field.page_number,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      label: field.label,
      required: field.required === true,
      placeholderText: field.placeholder_text,
      defaultValue: field.default_value,
    })),
  });
}
