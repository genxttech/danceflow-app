"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { applySigningFields, type AppliedSignature, type SigningField, type SigningValue } from "@/lib/documents/pdf";
import { DOCUMENT_FILES_BUCKET, hashSigningToken, signedStoragePath } from "@/lib/documents/signing";
import { consumePublicSigningRateLimit, serverActionIp } from "@/lib/documents/public-signing-security";
import { advanceEventSigningCheckpoint, normalizeSigningReturnUrl } from "@/lib/documents/event-signing";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { renderStudioBrandedEmail } from "@/lib/notifications/email-branding";

const CONSENT_TEXT = "I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own.";

type SigningEmailContext = {
  studioName: string;
  studioLogoUrl: string | null;
  studioSlug: string | null;
  studioEmail: string | null;
};

async function getSigningEmailContext(studioId: string): Promise<SigningEmailContext> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("studios")
    .select("name, public_name, public_logo_url, slug, email")
    .eq("id", studioId)
    .maybeSingle();

  return {
    studioName: data?.public_name?.trim() || data?.name || "Your dance studio",
    studioLogoUrl: data?.public_logo_url ?? null,
    studioSlug: data?.slug ?? null,
    studioEmail: data?.email?.trim() || null,
  };
}

async function queueSigningCompletedEmails(params: {
  envelopeId: string;
  studioId: string;
  title: string;
  signerName: string;
  signerEmail: string | null;
}) {
  const context = await getSigningEmailContext(params.studioId);
  const portalUrl = context.studioSlug
    ? `${process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com"}/portal/${encodeURIComponent(context.studioSlug)}/documents`
    : null;

  if (params.signerEmail) {
    const subject = `${params.title} has been signed`;
    const bodyText = [
      `Hi ${params.signerName || "there"},`,
      "",
      `Your signature for ${params.title} has been completed successfully.`,
      portalUrl ? `View your documents: ${portalUrl}` : "",
      "",
      `Questions? Reply to this email to contact ${context.studioName}.`,
      "",
      "Thanks,",
      context.studioName,
    ].filter(Boolean).join("\\n");

    const bodyHtml = renderStudioBrandedEmail(
      { name: context.studioName, logoUrl: context.studioLogoUrl },
      {
        previewText: `${params.title} has been signed.`,
        eyebrow: "Signature Complete",
        heading: "Your document is signed",
        greeting: `Hi ${params.signerName || "there"},`,
        intro: `Your signature for ${params.title} has been completed successfully.`,
        bodyText,
        detailRows: [{ label: "Document", value: params.title }],
        actionLabel: portalUrl ? "View Documents" : null,
        actionUrl: portalUrl,
        footerText: `Sent by ${context.studioName} through DanceFlow.`,
      },
    );

    await queueOutboundDelivery({
      studioId: params.studioId,
      channel: "email",
      templateKey: "document_signing_completed_signer",
      recipientEmail: params.signerEmail,
      subject,
      bodyText,
      bodyHtml,
      relatedTable: "document_sign_envelopes",
      relatedId: params.envelopeId,
      dedupeKey: `document_signing_completed_signer:${params.envelopeId}`,
    });
  }

  if (context.studioEmail) {
    const subject = `Signed: ${params.title}`;
    const bodyText = [
      `${params.signerName || "A signer"} completed ${params.title}.`,
      "",
      "The signed document is available in DanceFlow.",
    ].join("\\n");

    const bodyHtml = renderStudioBrandedEmail(
      { name: context.studioName, logoUrl: context.studioLogoUrl },
      {
        previewText: `${params.signerName || "A signer"} completed ${params.title}.`,
        eyebrow: "Document Completed",
        heading: "A document has been signed",
        intro: `${params.signerName || "A signer"} completed ${params.title}.`,
        bodyText,
        detailRows: [
          { label: "Document", value: params.title },
          { label: "Signer", value: params.signerName || "Signer" },
        ],
        footerText: "This operational notice was sent through DanceFlow.",
      },
    );

    await queueOutboundDelivery({
      studioId: params.studioId,
      channel: "email",
      templateKey: "document_signing_completed_studio",
      recipientEmail: context.studioEmail,
      subject,
      bodyText,
      bodyHtml,
      relatedTable: "document_sign_envelopes",
      relatedId: params.envelopeId,
      dedupeKey: `document_signing_completed_studio:${params.envelopeId}`,
      replyToEmail: params.signerEmail,
    });
  }
}

async function queueSigningDeclinedEmail(params: {
  envelopeId: string;
  studioId: string;
  title: string;
  signerName: string | null;
  signerEmail: string | null;
  reason: string;
}) {
  const context = await getSigningEmailContext(params.studioId);
  if (!context.studioEmail) return;

  const subject = `Declined: ${params.title}`;
  const bodyText = [
    `${params.signerName || "The signer"} declined ${params.title}.`,
    params.reason ? `Reason: ${params.reason}` : "",
    "",
    "Review the request in DanceFlow before deciding whether to revise or resend it.",
  ].filter(Boolean).join("\\n");

  const bodyHtml = renderStudioBrandedEmail(
    { name: context.studioName, logoUrl: context.studioLogoUrl },
    {
      previewText: `${params.title} was declined.`,
      eyebrow: "Signature Declined",
      heading: "A signer declined a document",
      intro: `${params.signerName || "The signer"} declined ${params.title}.`,
      bodyText,
      detailRows: [
        { label: "Document", value: params.title },
        { label: "Signer", value: params.signerName || "Signer" },
        ...(params.reason ? [{ label: "Reason", value: params.reason }] : []),
      ],
      footerText: "This operational notice was sent through DanceFlow.",
    },
  );

  await queueOutboundDelivery({
    studioId: params.studioId,
    channel: "email",
    templateKey: "document_signing_declined_studio",
    recipientEmail: context.studioEmail,
    subject,
    bodyText,
    bodyHtml,
    relatedTable: "document_sign_envelopes",
    relatedId: params.envelopeId,
    dedupeKey: `document_signing_declined_studio:${params.envelopeId}`,
    replyToEmail: params.signerEmail,
  });
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
  const { error: valuesError } = await admin
    .from("document_sign_values")
    .upsert(valueRows, { onConflict: "envelope_id,field_id" });

  if (valuesError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([signedPath]);
    console.error("Document signing values could not be saved", {
      envelopeId: envelope.id,
      message: valuesError.message,
    });
    redirect(`/sign/${encodeURIComponent(token)}?error=completion_failed`);
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
    .select("id,studio_id,title,signer_name,signer_email,status,expires_at")
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
  redirect(`/sign/${encodeURIComponent(token)}?success=declined`);
}