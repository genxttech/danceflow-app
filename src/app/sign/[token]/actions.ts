"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { applySigningFields, sha256Hex, type AppliedSignature, type SigningField, type SigningValue } from "@/lib/documents/pdf";
import { DOCUMENT_FILES_BUCKET, hashSigningToken, signedStoragePath } from "@/lib/documents/signing";
import { consumePublicSigningRateLimit, serverActionIp } from "@/lib/documents/public-signing-security";
import { advanceEventSigningCheckpoint, normalizeSigningReturnUrl } from "@/lib/documents/event-signing";
import { isSignableAssignmentStatus, OPEN_SIGN_ENVELOPE_STATUSES } from "@/lib/documents/signing-integrity";
import { SIGNING_CONSENT_TEXT } from "@/lib/documents/consent";
import { queueSigningCompletedEmails, queueSigningDeclinedEmail } from "@/lib/documents/signing-completion-emails";
import { buildSignerEvidence, resolveSignerRelationship } from "@/lib/documents/signer-evidence";
import { parsePortalReturn, portalReturnQuery } from "@/lib/documents/portal-return";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 8C: the signed-in DanceFlow account in this browser at signing time, if any. A portal hand-off reaches this
 * public surface with the portal session still present; a plain emailed link usually has none. Never guessed.
 */
async function currentSigningUser(): Promise<{ id: string; email: string | null } | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ? { id: data.user.id, email: data.user.email ?? null } : null;
  } catch {
    return null;
  }
}

function clean(value: FormDataEntryValue | null, max = 300) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function parseSignature(value: string): AppliedSignature | null {
  try {
    const parsed = JSON.parse(value) as Partial<AppliedSignature>;
    if (parsed.method !== "typed" && parsed.method !== "drawn") return null;
    if (typeof parsed.value !== "string" || !parsed.value.trim()) return null;
    if (parsed.method === "drawn" && !parsed.value.startsWith("data:image/png;base64,")) return null;
    if (parsed.value.length > 1_500_000) return null;
    return { method: parsed.method, value: parsed.value };
  } catch {
    return null;
  }
}

export async function completeSigningAction(formData: FormData) {
  const token = clean(formData.get("token"), 200);
  const signerName = clean(formData.get("signerName"), 160);
  const timezone = clean(formData.get("timezone"), 100) || "UTC";
  const consent = formData.get("consent") === "on";
  const portalReturn = parsePortalReturn(formData.get("portalSlug"), formData.get("portalClient"));
  const back = portalReturnQuery(portalReturn);
  const here = (query: string) => `/sign/${encodeURIComponent(token)}?${query}${back ? `&${back}` : ""}`;
  if (!token || !signerName || !consent) redirect(here(`error=missing_required_fields`));

  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const ip = await serverActionIp();
  const rateLimit = await consumePublicSigningRateLimit(admin, {
    action: "complete",
    tokenHash,
    ip,
  });
  if (!rateLimit.allowed) {
    redirect(here(`error=too_many_attempts`));
  }
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,studio_id,client_id,assignment_id,title,signer_name,signer_email,status,expires_at,source_bucket,source_path,source_sha256,return_url,context_type,context_id,sequence_group_id,sequence_position,sequence_total,event_signing_checkpoint_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!envelope) redirect(here(`error=invalid_link`));
  if (envelope.status === "completed") redirect(here(`success=completed`));
  if (["declined", "expired", "void"].includes(envelope.status)) redirect(here(`error=link_unavailable`));
  if (new Date(envelope.expires_at).getTime() <= Date.now()) {
    // Phase 8A: only an envelope that is still open may be marked expired (never a concurrently completed one).
    await admin.from("document_sign_envelopes").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", envelope.id).in("status", [...OPEN_SIGN_ENVELOPE_STATUSES]);
    redirect(here(`error=link_expired`));
  }

  // Phase 8A: re-read the authoritative assignment -- a waived / void / already-signed assignment is not signable even if
  // its envelope is still open. (Staff waive/void close the envelope first, so the guarded completion below also fails.)
  if (envelope.assignment_id) {
    const { data: linkedAssignment } = await admin
      .from("document_assignments")
      .select("status")
      .eq("id", envelope.assignment_id)
      .eq("studio_id", envelope.studio_id)
      .maybeSingle();
    if (!linkedAssignment || !isSignableAssignmentStatus(linkedAssignment.status)) {
      redirect(here(`error=link_unavailable`));
    }
  }

  const { data: fields, error: fieldsError } = await admin
    .from("document_sign_fields")
    .select("id,field_type,page_number,x,y,width,height,label,required,placeholder_text,default_value")
    .eq("envelope_id", envelope.id)
    .order("sort_order");
  if (fieldsError || !fields?.length) redirect(here(`error=fields_unavailable`));

  const values: Record<string, SigningValue> = {};
  const signatureMethods = new Set<string>();
  for (const field of fields as SigningField[]) {
    const key = `field_${field.id}`;
    if (field.field_type === "checkbox") {
      values[field.id] = formData.get(key) === "on";
      if (field.required && values[field.id] !== true) redirect(here(`error=missing_required_fields`));
      continue;
    }
    if (field.field_type === "signature" || field.field_type === "initials") {
      const signature = parseSignature(clean(formData.get(key), 1_500_000));
      if (!signature && field.required) redirect(here(`error=missing_required_signature`));
      if (signature) {
        values[field.id] = signature;
        signatureMethods.add(signature.method);
      }
      continue;
    }
    let value = clean(formData.get(key), 500);
    if (!value) value = field.default_value?.trim() ?? "";
    if (!value && field.field_type === "date") value = new Date().toLocaleDateString("en-US");
    if (!value && field.field_type === "printed_name") value = signerName;
    values[field.id] = value;
    if (field.required && !value) redirect(here(`error=missing_required_fields`));
  }

  const { data: sourceBlob, error: sourceError } = await admin.storage.from(envelope.source_bucket).download(envelope.source_path);
  if (sourceError || !sourceBlob) redirect(here(`error=document_unavailable`));

  const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
  if (sha256Hex(sourceBytes) !== envelope.source_sha256) {
    redirect(here(`error=completion_failed`));
  }
  const signedAt = new Date().toISOString();
  const result = await applySigningFields({
    sourceBytes,
    fields: fields as SigningField[],
    values,
    signerName,
    signerEmail: envelope.signer_email,
    signedAt,
    timezone,
  });
  const signedPath = signedStoragePath(envelope.studio_id, envelope.id);
  const { error: signedUploadError } = await admin.storage.from(DOCUMENT_FILES_BUCKET).upload(signedPath, result.bytes, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
  if (signedUploadError) redirect(here(`error=completion_failed`));

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent");

  const valueRows = (fields as SigningField[]).map((field) => {
    const value = values[field.id];
    const signature = typeof value === "object" && value !== null && "method" in value ? value as AppliedSignature : null;
    return {
      envelope_id: envelope.id,
      field_id: field.id,
      value_text: typeof value === "string" ? value : signature?.method === "typed" ? signature.value : null,
      value_boolean: typeof value === "boolean" ? value : null,
      signature_method: signature?.method ?? null,
      signature_data_url: signature?.method === "drawn" ? signature.value : null,
    };
  });
  const { error: valuesError } = await admin
    .from("document_sign_values")
    .upsert(valueRows, { onConflict: "envelope_id,field_id" });

  if (valuesError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([signedPath]);
    console.error("Document signing values could not be saved", {
      envelopeId: envelope.id,
      message: valuesError.message,
    });
    redirect(here(`error=completion_failed`));
  }

  const method = signatureMethods.size === 1 ? Array.from(signatureMethods)[0] : signatureMethods.size > 1 ? "mixed" : null;
  const { data: completedEnvelope, error: updateError } = await admin.from("document_sign_envelopes").update({
    status: "completed",
    signed_bucket: DOCUMENT_FILES_BUCKET,
    signed_path: signedPath,
    signed_sha256: result.sha256,
    completed_at: signedAt,
    signature_method: method,
    signed_timezone: timezone,
    consent_text: SIGNING_CONSENT_TEXT,
    updated_at: signedAt,
  })
    .eq("id", envelope.id)
    .in("status", ["sent", "viewed", "started"])
    .select("id")
    .maybeSingle();
  if (updateError || !completedEnvelope) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([signedPath]);
    redirect(here(`error=link_unavailable`));
  }

  // Phase 8C: record who actually signed, as known at this moment -- the entered name, the signed-in account (if
  // any) and its relationship to the client. The requested recipient is kept separately and never used as the actor.
  const sessionUser = await currentSigningUser();
  const relationship = sessionUser
    ? await resolveSignerRelationship({ userId: sessionUser.id, studioId: envelope.studio_id, clientId: envelope.client_id })
    : null;
  const signerEvidence = buildSignerEvidence({
    signerName,
    channel: sessionUser && relationship?.canSignDocuments ? "portal_session" : "public_link",
    authenticatedUserId: sessionUser?.id ?? null,
    subjectClientId: envelope.client_id ?? null,
    relationship,
    requestedSignerEmail: envelope.signer_email ?? null,
  });
  await admin.from("document_sign_events").insert({
    envelope_id: envelope.id,
    event_type: "completed",
    actor_user_id: sessionUser?.id ?? null,
    actor_email: sessionUser?.email ?? null,
    ip_address: ip,
    user_agent: userAgent,
    summary: signerEvidence.on_behalf
      ? `${signerName} completed the document with an electronic signature on behalf of the client.`
      : `${signerName} completed the document with an electronic signature.`,
    metadata: {
      consent_text: SIGNING_CONSENT_TEXT,
      signature_method: method,
      signed_timezone: timezone,
      signed_at: signedAt,
      requested_signer_name: envelope.signer_name ?? null,
      ...signerEvidence,
    },
  });

  try {
    await queueSigningCompletedEmails({
      envelopeId: envelope.id,
      studioId: envelope.studio_id,
      title: envelope.title || "Document",
      signerName,
      signerEmail: envelope.signer_email,
    });
  } catch (emailError) {
    console.error(
      "Document signing completion email queue failed",
      emailError instanceof Error ? emailError.message : emailError,
    );
  }

  if (envelope.context_type === "event_checkout" && envelope.event_signing_checkpoint_id) {
    try {
      const next = await advanceEventSigningCheckpoint(envelope.id);
      if (next?.url) redirect(next.url);
    } catch (error) {
      // redirect() above throws Next.js's own internal NEXT_REDIRECT signal
      // on success -- unstable_rethrow lets that (and any other Next
      // control-flow signal) continue propagating to the framework before
      // the genuine-error handling below runs, so a successful continuation
      // is never misreported as event_checkout_continuation_failed.
      unstable_rethrow(error);
      console.error(
        "Event signing continuation failed",
        error instanceof Error ? error.message : error,
      );
      redirect(here(`error=event_checkout_continuation_failed`));
    }
  }

  const safeReturnUrl = normalizeSigningReturnUrl(envelope.return_url);
  if (safeReturnUrl) {
    const separator = safeReturnUrl.includes("?") ? "&" : "?";
    redirect(
      `${safeReturnUrl}${separator}signing=completed&envelope=${encodeURIComponent(envelope.id)}`,
    );
  }

  redirect(here(`success=completed`));
}

export async function declineSigningAction(formData: FormData) {
  const token = clean(formData.get("token"), 200);
  const reason = clean(formData.get("reason"), 500);
  const portalReturn = parsePortalReturn(formData.get("portalSlug"), formData.get("portalClient"));
  const back = portalReturnQuery(portalReturn);
  const here = (query: string) => `/sign/${encodeURIComponent(token)}?${query}${back ? `&${back}` : ""}`;
  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const ip = await serverActionIp();
  const rateLimit = await consumePublicSigningRateLimit(admin, {
    action: "decline",
    tokenHash,
    ip,
  });
  if (!rateLimit.allowed) redirect(here(`error=too_many_attempts`));

  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,studio_id,title,signer_name,signer_email,status,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!envelope || !["sent", "viewed", "started"].includes(envelope.status)) {
    redirect(here(`error=link_unavailable`));
  }
  if (new Date(envelope.expires_at).getTime() <= Date.now()) {
    await admin.from("document_sign_envelopes").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", envelope.id).in("status", [...OPEN_SIGN_ENVELOPE_STATUSES]);
    redirect(here(`error=link_expired`));
  }
  const now = new Date().toISOString();
  const { data: declinedEnvelope } = await admin
    .from("document_sign_envelopes")
    .update({ status: "declined", declined_at: now, updated_at: now })
    .eq("id", envelope.id)
    .in("status", ["sent", "viewed", "started"])
    .select("id")
    .maybeSingle();
  if (!declinedEnvelope) redirect(here(`error=link_unavailable`));
  const declinedBy = await currentSigningUser();
  await admin.from("document_sign_events").insert({
    envelope_id: envelope.id,
    event_type: "declined",
    actor_user_id: declinedBy?.id ?? null,
    actor_email: declinedBy?.email ?? null,
    summary: reason || "Signer declined the document.",
    metadata: { requested_signer_email: envelope.signer_email ?? null, signing_channel: declinedBy ? "portal_session" : "public_link" },
  });

  try {
    await queueSigningDeclinedEmail({
      envelopeId: envelope.id,
      studioId: envelope.studio_id,
      title: envelope.title || "Document",
      signerName: envelope.signer_name,
      signerEmail: envelope.signer_email,
      reason,
    });
  } catch (emailError) {
    console.error(
      "Document signing decline email queue failed",
      emailError instanceof Error ? emailError.message : emailError,
    );
  }
  redirect(here(`success=declined`));
}