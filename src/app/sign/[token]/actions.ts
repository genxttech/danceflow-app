"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { applySigningFields, type AppliedSignature, type SigningField, type SigningValue } from "@/lib/documents/pdf";
import { DOCUMENT_FILES_BUCKET, hashSigningToken, signedStoragePath } from "@/lib/documents/signing";
import { consumePublicSigningRateLimit, serverActionIp } from "@/lib/documents/public-signing-security";
import { advanceEventSigningCheckpoint, normalizeSigningReturnUrl } from "@/lib/documents/event-signing";

const CONSENT_TEXT = "I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own.";

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
  if (!token || !signerName || !consent) redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_fields`);

  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const ip = await serverActionIp();
  const rateLimit = await consumePublicSigningRateLimit(admin, {
    action: "complete",
    tokenHash,
    ip,
  });
  if (!rateLimit.allowed) {
    redirect(`/sign/${encodeURIComponent(token)}?error=too_many_attempts`);
  }
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,studio_id,title,signer_name,signer_email,status,expires_at,source_bucket,source_path,return_url,context_type,context_id,sequence_group_id,sequence_position,sequence_total,event_signing_checkpoint_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!envelope) redirect(`/sign/${encodeURIComponent(token)}?error=invalid_link`);
  if (envelope.status === "completed") redirect(`/sign/${encodeURIComponent(token)}?success=completed`);
  if (["declined", "expired", "void"].includes(envelope.status)) redirect(`/sign/${encodeURIComponent(token)}?error=link_unavailable`);
  if (new Date(envelope.expires_at).getTime() <= Date.now()) {
    await admin.from("document_sign_envelopes").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", envelope.id);
    redirect(`/sign/${encodeURIComponent(token)}?error=link_expired`);
  }

  const { data: fields, error: fieldsError } = await admin
    .from("document_sign_fields")
    .select("id,field_type,page_number,x,y,width,height,label,required,placeholder_text,default_value")
    .eq("envelope_id", envelope.id)
    .order("sort_order");
  if (fieldsError || !fields?.length) redirect(`/sign/${encodeURIComponent(token)}?error=fields_unavailable`);

  const values: Record<string, SigningValue> = {};
  const signatureMethods = new Set<string>();
  for (const field of fields as SigningField[]) {
    const key = `field_${field.id}`;
    if (field.field_type === "checkbox") {
      values[field.id] = formData.get(key) === "on";
      if (field.required && values[field.id] !== true) redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_fields`);
      continue;
    }
    if (field.field_type === "signature" || field.field_type === "initials") {
      const signature = parseSignature(clean(formData.get(key), 1_500_000));
      if (!signature && field.required) redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_signature`);
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
    if (field.required && !value) redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_fields`);
  }

  const { data: sourceBlob, error: sourceError } = await admin.storage.from(envelope.source_bucket).download(envelope.source_path);
  if (sourceError || !sourceBlob) redirect(`/sign/${encodeURIComponent(token)}?error=document_unavailable`);

  const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
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
  if (signedUploadError) redirect(`/sign/${encodeURIComponent(token)}?error=completion_failed`);

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
  await admin.from("document_sign_values").upsert(valueRows, { onConflict: "envelope_id,field_id" });

  const method = signatureMethods.size === 1 ? Array.from(signatureMethods)[0] : signatureMethods.size > 1 ? "mixed" : null;
  const { data: completedEnvelope, error: updateError } = await admin.from("document_sign_envelopes").update({
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
    redirect(`/sign/${encodeURIComponent(token)}?error=link_unavailable`);
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelope.id,
    event_type: "completed",
    actor_email: envelope.signer_email,
    ip_address: ip,
    user_agent: userAgent,
    summary: "Signer completed the document with an electronic signature.",
    metadata: { consent_text: CONSENT_TEXT, signature_method: method, signed_timezone: timezone, signed_at: signedAt },
  });

  if (envelope.context_type === "event_checkout" && envelope.event_signing_checkpoint_id) {
    try {
      const next = await advanceEventSigningCheckpoint(envelope.id);
      if (next?.url) redirect(next.url);
    } catch (error) {
      console.error(
        "Event signing continuation failed",
        error instanceof Error ? error.message : error,
      );
      redirect(`/sign/${encodeURIComponent(token)}?error=event_checkout_continuation_failed`);
    }
  }

  const safeReturnUrl = normalizeSigningReturnUrl(envelope.return_url);
  if (safeReturnUrl) {
    const separator = safeReturnUrl.includes("?") ? "&" : "?";
    redirect(
      `${safeReturnUrl}${separator}signing=completed&envelope=${encodeURIComponent(envelope.id)}`,
    );
  }

  redirect(`/sign/${encodeURIComponent(token)}?success=completed`);
}

export async function declineSigningAction(formData: FormData) {
  const token = clean(formData.get("token"), 200);
  const reason = clean(formData.get("reason"), 500);
  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const ip = await serverActionIp();
  const rateLimit = await consumePublicSigningRateLimit(admin, {
    action: "decline",
    tokenHash,
    ip,
  });
  if (!rateLimit.allowed) redirect(`/sign/${encodeURIComponent(token)}?error=too_many_attempts`);

  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,signer_email,status,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!envelope || !["sent", "viewed", "started"].includes(envelope.status)) {
    redirect(`/sign/${encodeURIComponent(token)}?error=link_unavailable`);
  }
  if (new Date(envelope.expires_at).getTime() <= Date.now()) {
    await admin.from("document_sign_envelopes").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", envelope.id);
    redirect(`/sign/${encodeURIComponent(token)}?error=link_expired`);
  }
  const now = new Date().toISOString();
  const { data: declinedEnvelope } = await admin
    .from("document_sign_envelopes")
    .update({ status: "declined", declined_at: now, updated_at: now })
    .eq("id", envelope.id)
    .in("status", ["sent", "viewed", "started"])
    .select("id")
    .maybeSingle();
  if (!declinedEnvelope) redirect(`/sign/${encodeURIComponent(token)}?error=link_unavailable`);
  await admin.from("document_sign_events").insert({ envelope_id: envelope.id, event_type: "declined", actor_email: envelope.signer_email, summary: reason || "Signer declined the document." });
  redirect(`/sign/${encodeURIComponent(token)}?success=declined`);
}