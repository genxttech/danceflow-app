import { NextResponse } from "next/server";
import {
  normalizeStudentApiUuid,
  requireStudentApiUser,
  studentApiJsonError,
} from "@/lib/auth/studentApiAuth";
import { applySigningFields, type AppliedSignature, type SigningField, type SigningValue } from "@/lib/documents/pdf";
import {
  DOCUMENT_FILES_BUCKET,
  signedStoragePath,
} from "@/lib/documents/signing";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = Promise<{ assignmentId: string }>;

const CONSENT_TEXT =
  "I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own.";

function clean(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, maxLength)
    : "";
}

function parseValue(value: unknown): SigningValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return clean(value, 500);

  if (value && typeof value === "object") {
    const candidate = value as Partial<AppliedSignature>;
    if (candidate.method !== "typed") return null;

    const signatureValue = clean(candidate.value, 160);
    if (!signatureValue) return null;

    return {
      method: "typed",
      value: signatureValue,
    };
  }

  return null;
}

export async function POST(
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

  let body: {
    signerName?: unknown;
    timezone?: unknown;
    consent?: unknown;
    values?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return studentApiJsonError("Invalid signing request.", 400);
  }

  const signerName = clean(body.signerName, 160);
  const timezone = clean(body.timezone, 100) || "UTC";
  const consent = body.consent === true;
  const submittedValues =
    body.values && typeof body.values === "object"
      ? (body.values as Record<string, unknown>)
      : {};

  if (!signerName || !consent) {
    return studentApiJsonError(
      "Complete the signer name and consent before signing.",
      400,
    );
  }

  const admin = createAdminClient();

  const { data: assignment, error: assignmentError } = await admin
    .from("document_assignments")
    .select("id, studio_id, client_id, sign_envelope_id, status, signed_at")
    .eq("id", assignmentId)
    .maybeSingle();

  if (assignmentError) {
    return studentApiJsonError(assignmentError.message, 400);
  }

  if (!assignment?.sign_envelope_id) {
    return studentApiJsonError("Signing request is unavailable.", 404);
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
    .select(`
      id,
      studio_id,
      client_id,
      assignment_id,
      signer_email,
      status,
      expires_at,
      source_bucket,
      source_path,
      signed_bucket,
      signed_path,
      completed_at
    `)
    .eq("id", assignment.sign_envelope_id)
    .eq("studio_id", assignment.studio_id)
    .eq("client_id", assignment.client_id)
    .eq("assignment_id", assignment.id)
    .maybeSingle();

  if (envelopeError || !envelope) {
    return studentApiJsonError("Signing request could not be found.", 404);
  }

  if (
    envelope.status === "completed" ||
    assignment.status === "signed" ||
    assignment.signed_at
  ) {
    return NextResponse.json({
      completed: true,
      signedAt: assignment.signed_at ?? envelope.completed_at,
      signedUrl: null,
    });
  }

  if (!["sent", "viewed", "started"].includes(envelope.status)) {
    return studentApiJsonError("Signing request is no longer available.", 409);
  }

  if (new Date(envelope.expires_at).getTime() <= Date.now()) {
    await admin
      .from("document_sign_envelopes")
      .update({
        status: "expired",
        updated_at: new Date().toISOString(),
      })
      .eq("id", envelope.id);

    return studentApiJsonError("Signing request has expired.", 410);
  }

  const { data: fieldRows, error: fieldsError } = await admin
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
      default_value
    `)
    .eq("envelope_id", envelope.id)
    .order("sort_order");

  if (fieldsError || !fieldRows?.length) {
    return studentApiJsonError("Signing fields are unavailable.", 400);
  }

  const fields = fieldRows as SigningField[];
  const values: Record<string, SigningValue> = {};
  const signatureMethods = new Set<string>();

  for (const field of fields) {
    const parsed = parseValue(submittedValues[field.id]);

    if (field.field_type === "checkbox") {
      values[field.id] = parsed === true;

      if (field.required && values[field.id] !== true) {
        return studentApiJsonError(
          `Complete the required field: ${field.label || "checkbox"}.`,
          400,
        );
      }
      continue;
    }

    if (field.field_type === "signature" || field.field_type === "initials") {
      const signature =
        parsed && typeof parsed === "object" && "method" in parsed
          ? (parsed as AppliedSignature)
          : null;

      if (!signature && field.required) {
        return studentApiJsonError(
          `Apply the required ${field.field_type}.`,
          400,
        );
      }

      if (signature) {
        values[field.id] = signature;
        signatureMethods.add(signature.method);
      }
      continue;
    }

    let value = typeof parsed === "string" ? parsed : "";

    if (!value) value = field.default_value?.trim() ?? "";
    if (!value && field.field_type === "date") {
      value = new Date().toLocaleDateString("en-US");
    }
    if (!value && field.field_type === "printed_name") {
      value = signerName;
    }

    values[field.id] = value;

    if (field.required && !value) {
      return studentApiJsonError(
        `Complete the required field: ${field.label || "document field"}.`,
        400,
      );
    }
  }

  const { data: sourceBlob, error: sourceError } = await admin.storage
    .from(envelope.source_bucket)
    .download(envelope.source_path);

  if (sourceError || !sourceBlob) {
    return studentApiJsonError("The document PDF could not be loaded.", 400);
  }

  const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
  const signedAt = new Date().toISOString();

  let result: Awaited<ReturnType<typeof applySigningFields>>;

  try {
    result = await applySigningFields({
      sourceBytes,
      fields,
      values,
      signerName,
      signerEmail: envelope.signer_email,
      signedAt,
      timezone,
    });
  } catch (error) {
    console.error("Student document PDF completion failed", {
      assignmentId,
      envelopeId: envelope.id,
      message: error instanceof Error ? error.message : "Unknown PDF error",
    });

    return studentApiJsonError(
      "The signed document could not be generated.",
      500,
    );
  }

  const signedPath = signedStoragePath(envelope.studio_id, envelope.id);

  const { error: signedUploadError } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .upload(signedPath, result.bytes, {
      contentType: "application/pdf",
      upsert: false,
      cacheControl: "0",
    });

  if (signedUploadError) {
    return studentApiJsonError(
      "The signed PDF could not be saved. Please try again.",
      500,
    );
  }

  const valueRows = fields.map((field) => {
    const value = values[field.id];
    const signature =
      typeof value === "object" && value !== null && "method" in value
        ? (value as AppliedSignature)
        : null;

    return {
      envelope_id: envelope.id,
      field_id: field.id,
      value_text:
        typeof value === "string"
          ? value
          : signature?.method === "typed"
            ? signature.value
            : null,
      value_boolean: typeof value === "boolean" ? value : null,
      signature_method: signature?.method ?? null,
      signature_data_url: null,
    };
  });

  const { error: valuesError } = await admin
    .from("document_sign_values")
    .upsert(valueRows, { onConflict: "envelope_id,field_id" });

  if (valuesError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([signedPath]);
    return studentApiJsonError("Signing values could not be saved.", 500);
  }

  const method =
    signatureMethods.size === 1 ? Array.from(signatureMethods)[0] : null;

  const { data: completedEnvelope, error: updateError } = await admin
    .from("document_sign_envelopes")
    .update({
      status: "completed",
      signed_bucket: DOCUMENT_FILES_BUCKET,
      signed_path: signedPath,
      signed_sha256: result.sha256,
      completed_at: signedAt,
      signature_method: method,
      signed_timezone: timezone,
      consent_text: CONSENT_TEXT,
      updated_at: signedAt,
    })
    .eq("id", envelope.id)
    .in("status", ["sent", "viewed", "started"])
    .select("id")
    .maybeSingle();

  if (updateError || !completedEnvelope) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([signedPath]);
    return studentApiJsonError("Signing request changed. Refresh and try again.", 409);
  }

  const { error: assignmentUpdateError } = await admin
    .from("document_assignments")
    .update({
      status: "signed",
      signed_at: signedAt,
    })
    .eq("id", assignment.id)
    .eq("sign_envelope_id", envelope.id)
    .neq("status", "void");

  if (assignmentUpdateError) {
    console.error("Student document assignment status update failed", {
      assignmentId,
      envelopeId: envelope.id,
      message: assignmentUpdateError.message,
    });
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelope.id,
    event_type: "completed",
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? envelope.signer_email,
    ip_address:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null,
    user_agent: request.headers.get("user-agent"),
    summary: "Signer completed the document in the DanceFlow student app.",
    metadata: {
      source: "student_mobile_app",
      consent_text: CONSENT_TEXT,
      signature_method: method,
      signed_timezone: timezone,
      signed_at: signedAt,
    },
  });

  const { data: signedDocument } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .createSignedUrl(signedPath, 5 * 60);

  return NextResponse.json({
    completed: true,
    signedAt,
    signedUrl: signedDocument?.signedUrl ?? null,
  });
}
