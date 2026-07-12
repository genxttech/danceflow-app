"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getOptionalUploadFile, PDF_UPLOAD_MIME_TYPES, safeOriginalFileName, validateUploadFile } from "@/lib/security/uploads";
import { createSigningToken, DOCUMENT_FILES_BUCKET, hashSigningToken, sourceStoragePath } from "@/lib/documents/signing";
import { getPdfPageSizes, sha256Hex } from "@/lib/documents/pdf";

type FieldType = "signature" | "initials" | "printed_name" | "date" | "text" | "checkbox";
type FieldDraft = { id?: string; field_type: FieldType; page_number: number; x: number; y: number; width: number; height: number; label: string; required: boolean; placeholder_text?: string | null; default_value?: string | null };

const FIELD_TYPES = new Set<FieldType>(["signature", "initials", "printed_name", "date", "text", "checkbox"]);

function text(formData: FormData, key: string, max = 200) {
  const value = formData.get(key);
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function documentsSignPath(key?: string, value?: string) {
  const base = "/app/documents/sign";
  return key && value ? `${base}?${key}=${encodeURIComponent(value)}` : base;
}

async function requireDraftEnvelope(envelopeId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const admin = createAdminClient();
  const { data: envelope } = await admin.from("document_sign_envelopes")
    .select("id,studio_id,title,signer_name,signer_email,status,expires_at,page_count")
    .eq("id", envelopeId).eq("studio_id", context.studioId).maybeSingle();
  if (!envelope || envelope.status !== "draft") redirect(documentsSignPath("error", "draft_unavailable"));
  return { admin, envelope, user, studioId: context.studioId };
}

export async function createSignEnvelopeAction(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const title = text(formData, "title", 180);
  const signerName = text(formData, "signerName", 160);
  const signerEmail = text(formData, "signerEmail", 320).toLowerCase();
  const expiresInDays = Math.min(30, Math.max(1, Number(text(formData, "expiresInDays", 2)) || 7));
  const file = getOptionalUploadFile(formData, "pdfFile");

  if (!title || !signerName || !signerEmail.includes("@")) redirect(documentsSignPath("error", "missing_required_fields"));

  const validation = await validateUploadFile(file, {
    fieldLabel: "PDF document", maxBytes: 15 * 1024 * 1024,
    allowedMimeTypes: PDF_UPLOAD_MIME_TYPES, allowedExtensions: ["pdf"], kind: "pdf",
  });
  if (!validation.ok || !file) redirect(documentsSignPath("error", "invalid_pdf"));

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  let pageSizes;
  try { pageSizes = await getPdfPageSizes(sourceBytes); }
  catch { redirect(documentsSignPath("error", "unreadable_pdf")); }

  const envelopeId = randomUUID();
  const sourcePath = sourceStoragePath(studioId, envelopeId);
  const admin = createAdminClient();
  const originalName = safeOriginalFileName(file.name, "document.pdf");
  const { error: uploadError } = await admin.storage.from(DOCUMENT_FILES_BUCKET)
    .upload(sourcePath, sourceBytes, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
  if (uploadError) redirect(documentsSignPath("error", "upload_failed"));

  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const { error: envelopeError } = await admin.from("document_sign_envelopes").insert({
    id: envelopeId, studio_id: studioId, title, signer_name: signerName, signer_email: signerEmail,
    status: "draft", token_hash: null, source_bucket: DOCUMENT_FILES_BUCKET, source_path: sourcePath,
    source_sha256: sha256Hex(sourceBytes), page_count: pageSizes.length, page_sizes: pageSizes,
    expires_at: expiresAt, created_by: user.id,
  });
  if (envelopeError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect(documentsSignPath("error", "envelope_failed"));
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelopeId, event_type: "created", actor_user_id: user.id,
    actor_email: user.email ?? null, summary: "Signing draft created.", metadata: { original_file_name: originalName },
  });

  redirect(`/app/documents/sign/${envelopeId}/edit`);
}

export async function saveSignFieldsAction(formData: FormData) {
  const envelopeId = text(formData, "envelopeId", 36);
  const raw = text(formData, "fieldsJson", 50000);
  const { admin, envelope } = await requireDraftEnvelope(envelopeId);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { redirect(`/app/documents/sign/${envelopeId}/edit?error=invalid_fields`); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) redirect(`/app/documents/sign/${envelopeId}/edit?error=invalid_fields`);

  const fields: FieldDraft[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    const type = String(item.field_type ?? "") as FieldType;
    const page = Number(item.page_number);
    const x = Number(item.x); const y = Number(item.y); const width = Number(item.width); const height = Number(item.height);
    const label = String(item.label ?? "").trim().slice(0, 120);
    if (!FIELD_TYPES.has(type) || !Number.isInteger(page) || page < 1 || page > envelope.page_count || !label) redirect(`/app/documents/sign/${envelopeId}/edit?error=invalid_fields`);
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.0001 || y + height > 1.0001) redirect(`/app/documents/sign/${envelopeId}/edit?error=invalid_fields`);
    fields.push({ field_type: type, page_number: page, x, y, width, height, label, required: Boolean(item.required), placeholder_text: String(item.placeholder_text ?? "").trim().slice(0, 160) || null, default_value: String(item.default_value ?? "").trim().slice(0, 300) || null });
  }
  if (!fields.some((field) => field.field_type === "signature")) redirect(`/app/documents/sign/${envelopeId}/edit?error=signature_required`);

  const { error: deleteError } = await admin.from("document_sign_fields").delete().eq("envelope_id", envelopeId);
  if (deleteError) redirect(`/app/documents/sign/${envelopeId}/edit?error=save_failed`);
  const { error: insertError } = await admin.from("document_sign_fields").insert(fields.map((field, index) => ({ envelope_id: envelopeId, ...field, sort_order: (index + 1) * 10 })));
  if (insertError) redirect(`/app/documents/sign/${envelopeId}/edit?error=save_failed`);
  await admin.from("document_sign_envelopes").update({ updated_at: new Date().toISOString() }).eq("id", envelopeId);
  revalidatePath(`/app/documents/sign/${envelopeId}/edit`);
  redirect(`/app/documents/sign/${envelopeId}/edit?success=saved`);
}

export async function sendSignEnvelopeAction(formData: FormData) {
  const envelopeId = text(formData, "envelopeId", 36);
  const { admin, envelope, user, studioId } = await requireDraftEnvelope(envelopeId);
  const { data: fields } = await admin.from("document_sign_fields").select("id,field_type").eq("envelope_id", envelopeId);
  if (!fields?.length || !fields.some((field) => field.field_type === "signature")) redirect(`/app/documents/sign/${envelopeId}/edit?error=fields_required`);

  const token = createSigningToken();
  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("document_sign_envelopes").update({
    status: "sent", token_hash: hashSigningToken(token), sent_at: now, updated_at: now,
  }).eq("id", envelopeId).eq("studio_id", studioId).eq("status", "draft");
  if (updateError) redirect(`/app/documents/sign/${envelopeId}/edit?error=send_failed`);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com";
  const signUrl = `${appUrl}/sign/${encodeURIComponent(token)}`;
  const expiresInDays = Math.max(1, Math.ceil((new Date(envelope.expires_at).getTime() - Date.now()) / 86400000));
  const { error: deliveryError } = await admin.from("outbound_deliveries").insert({
    studio_id: studioId, channel: "email", template_key: "document_sign_request",
    recipient_email: envelope.signer_email, subject: `Signature requested: ${envelope.title}`,
    body_text: `${envelope.signer_name},\n\nPlease review and sign ${envelope.title}.\n\n${signUrl}\n\nThis secure link expires in ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}.`,
    body_html: `<p>${envelope.signer_name},</p><p>Please review and sign <strong>${envelope.title}</strong>.</p><p><a href="${signUrl}">Review and sign document</a></p><p>This secure link expires in ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}.</p>`,
    related_table: "document_sign_envelopes", related_id: envelopeId,
    dedupe_key: `document-sign:${envelopeId}:initial`, status: "queued", updated_at: now,
  });
  await admin.from("document_sign_events").insert({
    envelope_id: envelopeId, event_type: deliveryError ? "delivery_exception" : "sent",
    actor_user_id: user.id, actor_email: user.email ?? null,
    summary: deliveryError ? "Signing request could not be queued for delivery." : "Signing request queued for email delivery.",
  });
  revalidatePath("/app/documents/sign");
  redirect(documentsSignPath(deliveryError ? "error" : "success", deliveryError ? "delivery_failed" : "sent"));
}
