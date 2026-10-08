import { createAdminClient } from "@/lib/supabase/admin";

/*
  Phase 8D -- who RECEIVES a document request for a client.

    owner / subject : always the client (document_assignments.client_id) -- never transferred;
    recipient       : the client, or ONE explicitly eligible linked account;
    actual signer   : whoever signs, recorded by the Phase 8C signer evidence (on-behalf for a guardian).

  A linked account is eligible only when its relationship is active (linked) for this studio + client, its stored
  can_sign_documents is true, it is a real signed-in account, and that account has a usable email. Relationship type
  alone never makes anyone eligible. Among several eligible people the choice is staff's -- never guessed.
*/

export type DocumentSignerOption = {
  linkId: string;
  relationshipType: string;
  email: string;
  name: string | null;
};

export type DocumentRecipient =
  | { kind: "client"; email: string; name: string }
  | { kind: "linked"; email: string; name: string; linkId: string; relationshipType: string };

export type RecipientChoice =
  | { ok: true; recipient: DocumentRecipient }
  | { ok: false; reason: "not_eligible" | "choose_recipient" | "no_signer" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function usableEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  return EMAIL.test(email) ? email : null;
}

/** Eligible linked signers for one client (studio + client scoped; service role, after the caller's own checks). */
export async function loadEligibleDocumentSigners(params: { studioId: string; clientId: string }) {
  const admin = createAdminClient();
  const { data: links } = await admin
    .from("client_account_links")
    .select("id, user_id, relationship_type")
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "linked")
    .eq("can_sign_documents", true);
  const rows = ((links ?? []) as Array<{ id: string; user_id: string | null; relationship_type: string }>).filter(
    (row) => Boolean(row.user_id),
  );
  if (!rows.length) return [] as DocumentSignerOption[];

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .in("id", rows.map((row) => row.user_id as string));
  const byId = new Map(
    ((profiles ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>).map((profile) => [profile.id, profile]),
  );

  const options: DocumentSignerOption[] = [];
  for (const row of rows) {
    const profile = byId.get(row.user_id as string);
    const email = usableEmail(profile?.email);
    if (!email) continue;
    options.push({ linkId: row.id, relationshipType: row.relationship_type, email, name: profile?.full_name?.trim() || null });
  }
  return options;
}

/**
 * Deterministic recipient rule. `requested` is "client", a linkId, or empty.
 *   - an explicitly requested linked signer must be eligible;
 *   - otherwise the client receives it when they have a usable email;
 *   - a client without email: exactly one eligible signer is used, several require a choice, none blocks.
 */
export function chooseDocumentRecipient(params: {
  clientName: string;
  clientEmail: string | null | undefined;
  eligible: DocumentSignerOption[];
  requested?: string | null;
}): RecipientChoice {
  const requested = params.requested?.trim() || "";
  if (requested && requested !== "client") {
    const signer = params.eligible.find((option) => option.linkId === requested);
    if (!signer) return { ok: false, reason: "not_eligible" };
    return { ok: true, recipient: linked(signer) };
  }

  const clientEmail = usableEmail(params.clientEmail);
  if (clientEmail) return { ok: true, recipient: { kind: "client", email: clientEmail, name: params.clientName || clientEmail } };

  if (params.eligible.length === 1) return { ok: true, recipient: linked(params.eligible[0]) };
  if (params.eligible.length > 1) return { ok: false, reason: "choose_recipient" };
  return { ok: false, reason: "no_signer" };
}

function linked(option: DocumentSignerOption): DocumentRecipient {
  return {
    kind: "linked",
    email: option.email,
    name: option.name || option.email,
    linkId: option.linkId,
    relationshipType: option.relationshipType,
  };
}

export const RECIPIENT_ERRORS: Record<"not_eligible" | "choose_recipient" | "no_signer", string> = {
  not_eligible: "That person is not allowed to sign documents for this client. Choose the client or an authorized signer.",
  choose_recipient: "This client has no email and more than one authorized signer. Choose who should receive this document.",
  no_signer:
    "This client has no email address and no one linked to them is allowed to sign documents. Add the client's email, or link a parent or guardian and allow them to sign documents, then try again.",
};
