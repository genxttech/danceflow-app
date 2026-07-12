"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { applySigningFields, type SigningField } from "@/lib/documents/pdf";
import { DOCUMENT_FILES_BUCKET, hashSigningToken, signedStoragePath } from "@/lib/documents/signing";

function clean(value: FormDataEntryValue | null, max = 300) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

export async function completeSigningAction(formData: FormData) {
  const token = clean(formData.get("token"), 200);
  const signerName = clean(formData.get("signerName"), 160);
  const consent = formData.get("consent") === "on";
  if (!token || !signerName || !consent) redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_fields`);

  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const { data: envelope } = await admin
    .from("document_sign_envelopes")
    .select("id,studio_id,title,signer_name,signer_email,status,expires_at,source_bucket,source_path")
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
    .select("id,field_type,page_number,x,y,width,height,label,required")
    .eq("envelope_id", envelope.id)
    .order("sort_order");
  if (fieldsError || !fields?.length) redirect(`/sign/${encodeURIComponent(token)}?error=fields_unavailable`);

  const values: Record<string, string | boolean> = {};
  for (const field of fields as SigningField[]) {
    const key = `field_${field.id}`;
    if (field.field_type === "checkbox") values[field.id] = formData.get(key) === "on";
    else values[field.id] = clean(formData.get(key), 500);
    if (field.required && field.field_type !== "date" && field.field_type !== "signature" && field.field_type !== "printed_name" && !values[field.id]) {
      redirect(`/sign/${encodeURIComponent(token)}?error=missing_required_fields`);
    }
  }

  const { data: sourceBlob, error: sourceError } = await admin.storage.from(envelope.source_bucket).download(envelope.source_path);
  if (sourceError || !sourceBlob) redirect(`/sign/${encodeURIComponent(token)}?error=document_unavailable`);

  const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
  const signedAt = new Date().toISOString();
  const result = await applySigningFields({ sourceBytes, fields: fields as SigningField[], values, signerName, signedAt });
  const signedPath = signedStoragePath(envelope.studio_id, envelope.id);
  const { error: signedUploadError } = await admin.storage.from(DOCUMENT_FILES_BUCKET).upload(signedPath, result.bytes, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
  if (signedUploadError) redirect(`/sign/${encodeURIComponent(token)}?error=completion_failed`);

  const headerStore = await headers();
  const ip = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() || headerStore.get("x-real-ip") || null;
  const userAgent = headerStore.get("user-agent");

  const valueRows = (fields as SigningField[]).map((field) => ({
    envelope_id: envelope.id,
    field_id: field.id,
    value_text: typeof values[field.id] === "string" ? values[field.id] : null,
    value_boolean: typeof values[field.id] === "boolean" ? values[field.id] : null,
  }));
  await admin.from("document_sign_values").upsert(valueRows, { onConflict: "envelope_id,field_id" });

  const { error: updateError } = await admin.from("document_sign_envelopes").update({
    status: "completed",
    signed_bucket: DOCUMENT_FILES_BUCKET,
    signed_path: signedPath,
    signed_sha256: result.sha256,
    completed_at: signedAt,
    updated_at: signedAt,
  }).eq("id", envelope.id).neq("status", "completed");
  if (updateError) redirect(`/sign/${encodeURIComponent(token)}?error=completion_failed`);

  await admin.from("document_sign_events").insert({
    envelope_id: envelope.id,
    event_type: "completed",
    actor_email: envelope.signer_email,
    ip_address: ip,
    user_agent: userAgent,
    summary: "Signer completed the document.",
    metadata: { consent_text: "I have reviewed this document and agree to sign it electronically." },
  });

  redirect(`/sign/${encodeURIComponent(token)}?success=completed`);
}

export async function declineSigningAction(formData: FormData) {
  const token = clean(formData.get("token"), 200);
  const reason = clean(formData.get("reason"), 500);
  const admin = createAdminClient();
  const tokenHash = hashSigningToken(token);
  const { data: envelope } = await admin.from("document_sign_envelopes").select("id,signer_email,status").eq("token_hash", tokenHash).maybeSingle();
  if (!envelope || envelope.status === "completed") redirect(`/sign/${encodeURIComponent(token)}?error=link_unavailable`);
  const now = new Date().toISOString();
  await admin.from("document_sign_envelopes").update({ status: "declined", declined_at: now, updated_at: now }).eq("id", envelope.id);
  await admin.from("document_sign_events").insert({ envelope_id: envelope.id, event_type: "declined", actor_email: envelope.signer_email, summary: reason || "Signer declined the document." });
  redirect(`/sign/${encodeURIComponent(token)}?success=declined`);
}
