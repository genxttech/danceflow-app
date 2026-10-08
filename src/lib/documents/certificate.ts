import { readSignerEvidence, type SigningChannel } from "@/lib/documents/signer-evidence";

/*
  Phase 8C -- completion certificate model. Built only from immutable evidence recorded at the time: the completed
  envelope (hashes, method, consent, timestamps), its document_sign_events audit trail (including the signer
  evidence in the "completed" event) and the template VERSION it was issued from. Template edits never change it,
  and nothing missing is inferred: an absent fact is shown as "Not recorded" or omitted. Rendering the same evidence
  twice yields the same certificate (dates are formatted in fixed UTC), so it stays generated on demand.
*/

export type CertificateEnvelope = {
  id: string;
  title: string | null;
  signer_name: string | null;
  signer_email: string | null;
  source_kind: string | null;
  source_sha256: string | null;
  signed_sha256: string | null;
  completed_at: string | null;
  signature_method: string | null;
  signed_timezone: string | null;
  consent_text: string | null;
};

export type CertificateEvent = {
  event_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  created_at: string;
};

export type CertificateRow = { label: string; value: string };
export type CertificateTimelineEntry = { at: string; label: string; detail: string | null };
export type CertificateModel = {
  rows: CertificateRow[];
  timeline: CertificateTimelineEntry[];
  consentText: string;
};

const EVENT_LABELS: Record<string, string> = {
  created: "Request created",
  sent: "Sent to signer",
  resent: "Reminder sent with a new secure link",
  viewed: "Opened",
  started: "Signing started",
  completed: "Signed and completed",
  declined: "Declined",
  expired: "Expired",
  voided: "Voided",
  revoked: "Revoked or superseded",
  delivery_exception: "Delivery problem recorded",
  downloaded: "Signed copy downloaded",
};

const CHANNEL_LABELS: Record<SigningChannel, string> = {
  public_link: "Secure signing link",
  portal_session: "DanceFlow client portal (signed in)",
  student_app: "DanceFlow student app (signed in)",
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  self: "the client",
  guardian: "guardian",
  parent: "parent",
  billing_contact: "billing contact",
  dependent_manager: "dependent manager",
  dependent: "dependent",
};

export function formatCertificateDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function methodLabel(method: string | null) {
  if (method === "typed") return "Typed signature";
  if (method === "drawn") return "Drawn signature";
  if (method === "mixed") return "Typed and drawn signatures";
  return "Not recorded";
}

export function buildCertificateModel(input: {
  envelope: CertificateEnvelope;
  events: CertificateEvent[];
  clientName: string | null;
  template: { title: string | null; versionNumber: number | null } | null;
}): CertificateModel {
  const { envelope } = input;
  const events = [...input.events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const completed = [...events].reverse().find((event) => event.event_type === "completed") ?? null;
  const evidence = completed ? readSignerEvidence(completed.metadata) : {};
  const signerAccount = completed?.actor_user_id ? completed.actor_email ?? "Signed-in DanceFlow account" : null;

  const rows: CertificateRow[] = [{ label: "Document", value: envelope.title || "Document" }];

  if (envelope.source_kind === "template_version" && input.template) {
    rows.push({
      label: "Template",
      value: `${input.template.title || "Template"}${input.template.versionNumber ? ` (version ${input.template.versionNumber})` : ""}`,
    });
  } else if (envelope.source_kind === "uploaded_pdf") {
    rows.push({ label: "Source", value: "Uploaded PDF" });
  }

  if (input.clientName) rows.push({ label: "Client", value: input.clientName });

  rows.push({ label: "Signed by", value: evidence.signer_name_entered || "Not recorded" });

  if (evidence.on_behalf === true) {
    const relationship = evidence.relationship_type ? RELATIONSHIP_LABELS[evidence.relationship_type] ?? evidence.relationship_type : null;
    rows.push({
      label: "Signed on behalf of",
      value: `${input.clientName || "the client"}${relationship ? ` (signer is the ${relationship})` : ""}`,
    });
  } else if (evidence.on_behalf === false) {
    rows.push({ label: "Signed on behalf of", value: "No - signed by the client" });
  }

  if (evidence.signing_channel) {
    rows.push({ label: "Signing channel", value: CHANNEL_LABELS[evidence.signing_channel] ?? evidence.signing_channel });
  }
  rows.push({
    label: "Signer account",
    value: signerAccount ?? (evidence.signing_channel ? "Not signed in (access by secure signing link)" : "Not recorded"),
  });

  if (envelope.signer_name || envelope.signer_email) {
    rows.push({
      label: "Requested signer",
      value: [envelope.signer_name, envelope.signer_email ? `<${envelope.signer_email}>` : null].filter(Boolean).join(" "),
    });
  }

  rows.push(
    { label: "Completed", value: formatCertificateDate(envelope.completed_at) },
    { label: "Signer timezone", value: envelope.signed_timezone || "Not recorded" },
    { label: "Signature method", value: methodLabel(envelope.signature_method) },
  );
  if (completed?.ip_address) rows.push({ label: "Completion IP", value: completed.ip_address });
  if (completed?.user_agent) rows.push({ label: "Completion device", value: completed.user_agent });
  rows.push(
    { label: "Envelope ID", value: envelope.id },
    { label: "Source SHA-256", value: envelope.source_sha256 || "Not recorded" },
    { label: "Signed SHA-256", value: envelope.signed_sha256 || "Not recorded" },
  );

  const timeline: CertificateTimelineEntry[] = events.map((event) => ({
    at: formatCertificateDate(event.created_at),
    label: EVENT_LABELS[event.event_type] ?? event.event_type,
    // An actor is shown only when an authenticated account was recorded -- never the requested recipient.
    detail: event.actor_user_id && event.actor_email ? event.actor_email : null,
  }));

  return {
    rows,
    timeline,
    consentText: envelope.consent_text || "Consent recorded during signing.",
  };
}

/** Standard PDF fonts (WinAnsi) cannot draw every character; anything else is replaced rather than failing. */
export function certificateSafeText(value: string) {
  return value.replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, "?");
}
