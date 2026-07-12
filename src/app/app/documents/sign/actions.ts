"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getOptionalUploadFile, PDF_UPLOAD_MIME_TYPES, safeOriginalFileName, validateUploadFile } from "@/lib/security/uploads";
import { createSigningToken, DOCUMENT_FILES_BUCKET, hashSigningToken, sourceStoragePath } from "@/lib/documents/signing";
import { getPdfPageCount, sha256Hex } from "@/lib/documents/pdf";

function text(formData: FormData, key: string, max = 200) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function documentsSignPath(key?: string, value?: string) {
  const base = "/app/documents/sign";
  return key && value ? `${base}?${key}=${encodeURIComponent(value)}` : base;
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

  if (!title || !signerName || !signerEmail.includes("@")) {
    redirect(documentsSignPath("error", "missing_required_fields"));
  }

  const validation = await validateUploadFile(file, {
    fieldLabel: "PDF document",
    maxBytes: 15 * 1024 * 1024,
    allowedMimeTypes: PDF_UPLOAD_MIME_TYPES,
    allowedExtensions: ["pdf"],
    kind: "pdf",
  });
  if (!validation.ok || !file) redirect(documentsSignPath("error", "invalid_pdf"));

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  let pageCount: number;
  try {
    pageCount = await getPdfPageCount(sourceBytes);
  } catch {
    redirect(documentsSignPath("error", "unreadable_pdf"));
  }

  const envelopeId = randomUUID();
  const token = createSigningToken();
  const tokenHash = hashSigningToken(token);
  const sourcePath = sourceStoragePath(studioId, envelopeId);
  const admin = createAdminClient();
  const originalName = safeOriginalFileName(file.name, "document.pdf");

  const { error: uploadError } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .upload(sourcePath, sourceBytes, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
  if (uploadError) redirect(documentsSignPath("error", "upload_failed"));

  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const now = new Date().toISOString();
  const { error: envelopeError } = await admin.from("document_sign_envelopes").insert({
    id: envelopeId,
    studio_id: studioId,
    title,
    signer_name: signerName,
    signer_email: signerEmail,
    status: "sent",
    token_hash: tokenHash,
    source_bucket: DOCUMENT_FILES_BUCKET,
    source_path: sourcePath,
    source_sha256: sha256Hex(sourceBytes),
    page_count: pageCount,
    expires_at: expiresAt,
    sent_at: now,
    created_by: user.id,
  });

  if (envelopeError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect(documentsSignPath("error", "envelope_failed"));
  }

  const lastPage = pageCount;
  const { error: fieldsError } = await admin.from("document_sign_fields").insert([
    { envelope_id: envelopeId, field_type: "printed_name", page_number: lastPage, x: 0.10, y: 0.76, width: 0.38, height: 0.045, label: "Printed name", required: true, sort_order: 10 },
    { envelope_id: envelopeId, field_type: "signature", page_number: lastPage, x: 0.10, y: 0.83, width: 0.38, height: 0.055, label: "Signature", required: true, sort_order: 20 },
    { envelope_id: envelopeId, field_type: "date", page_number: lastPage, x: 0.58, y: 0.83, width: 0.24, height: 0.045, label: "Date", required: true, sort_order: 30 },
  ]);

  if (fieldsError) {
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect(documentsSignPath("error", "field_setup_failed"));
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com";
  const signUrl = `${appUrl}/sign/${encodeURIComponent(token)}`;
  await admin.from("outbound_deliveries").insert({
    studio_id: studioId,
    channel: "email",
    template_key: "document_sign_request",
    recipient_email: signerEmail,
    subject: `Signature requested: ${title}`,
    body_text: `${signerName},\n\nPlease review and sign ${title}.\n\n${signUrl}\n\nThis secure link expires in ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}.`,
    body_html: `<p>${signerName},</p><p>Please review and sign <strong>${title}</strong>.</p><p><a href="${signUrl}">Review and sign document</a></p><p>This secure link expires in ${expiresInDays} day${expiresInDays === 1 ? "" : "s"}.</p>`,
    related_table: "document_sign_envelopes",
    related_id: envelopeId,
    dedupe_key: `document-sign:${envelopeId}:initial`,
    status: "queued",
    updated_at: now,
    metadata: { original_file_name: originalName },
  });

  await admin.from("document_sign_events").insert([
    { envelope_id: envelopeId, event_type: "created", actor_user_id: user.id, actor_email: user.email ?? null, summary: "Signing request created." },
    { envelope_id: envelopeId, event_type: "sent", actor_user_id: user.id, actor_email: user.email ?? null, summary: "Signing request queued for email delivery." },
  ]);

  revalidatePath("/app/documents/sign");
  redirect(documentsSignPath("success", "sent"));
}
