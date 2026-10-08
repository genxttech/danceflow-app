import { createAdminClient } from "@/lib/supabase/admin";
import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { resolveStudioDisplayName } from "@/lib/email/brand";
import {
  buildSigningCompletedSignerEmail,
  buildSigningCompletedStudioEmail,
  buildSigningDeclinedStudioEmail,
  type SigningEmailContext,
} from "@/app/sign/[token]/signingEmails";

/*
  Phase 8C: one completion-notification contract for every signing channel (public / portal link and the student
  app), so a document completed natively in the app notifies the signer and the studio exactly like one completed
  through the secure link. All messages stay branded HTML (built by signingEmails.ts).
*/

export async function getSigningEmailContext(studioId: string): Promise<SigningEmailContext> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("studios")
    .select("name, public_name, public_logo_url, slug, email")
    .eq("id", studioId)
    .maybeSingle();

  return {
    studioName: resolveStudioDisplayName(data),
    studioLogoUrl: data?.public_logo_url ?? null,
    studioSlug: data?.slug ?? null,
    studioEmail: data?.email?.trim() || null,
  };
}

export async function queueSigningCompletedEmails(params: {
  envelopeId: string;
  studioId: string;
  title: string;
  signerName: string;
  signerEmail: string | null;
}) {
  const context = await getSigningEmailContext(params.studioId);

  if (params.signerEmail) {
    const { subject, bodyText, bodyHtml } = buildSigningCompletedSignerEmail({
      context,
      title: params.title,
      signerName: params.signerName,
    });

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
    const { subject, bodyText, bodyHtml } = buildSigningCompletedStudioEmail({
      context,
      title: params.title,
      signerName: params.signerName,
    });

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

export async function queueSigningDeclinedEmail(params: {
  envelopeId: string;
  studioId: string;
  title: string;
  signerName: string | null;
  signerEmail: string | null;
  reason: string;
}) {
  const context = await getSigningEmailContext(params.studioId);
  if (!context.studioEmail) return;

  const { subject, bodyText, bodyHtml } = buildSigningDeclinedStudioEmail({
    context,
    title: params.title,
    signerName: params.signerName,
    reason: params.reason,
  });

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
