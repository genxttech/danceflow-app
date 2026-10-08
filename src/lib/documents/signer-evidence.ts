import { createAdminClient } from "@/lib/supabase/admin";

/*
  Phase 8C -- signer evidence. Three questions are kept apart:
    A. signing authorization (who MAY sign): the signing link token, or a linked account whose stored
       client_account_links.can_sign_documents is true for that client (enforced by each signing path);
    B. signer evidence (who DID sign): recorded here, at completion time, from facts known at that moment;
    C. evidence access (who may later read it): RLS + staff routes (Documents-management roles).

  The evidence is stored on the immutable "completed" document_sign_events row (metadata JSON + actor columns), so
  no schema change is needed and nothing is derived later from a client profile, an account profile, the requested
  recipient or a current email address. Unknown facts are recorded as null, never guessed.
*/

export type SigningChannel = "public_link" | "portal_session" | "student_app";

export type SignerRelationship = {
  relationshipType: string;
  canSignDocuments: boolean;
};

export type SignerEvidence = {
  signer_name_entered: string;
  signing_channel: SigningChannel;
  authenticated_user_id: string | null;
  subject_client_id: string | null;
  relationship_type: string | null;
  /** true: a linked account signed for another client; false: the client signed for themself; null: unknown. */
  on_behalf: boolean | null;
  requested_signer_email: string | null;
};

/** The linked relationship between an authenticated user and the client a document belongs to (if any). */
export async function resolveSignerRelationship(params: {
  userId: string;
  studioId: string;
  clientId: string | null | undefined;
}): Promise<SignerRelationship | null> {
  if (!params.clientId) return null;
  const { data } = await createAdminClient()
    .from("client_account_links")
    .select("relationship_type, can_sign_documents, is_primary")
    .eq("user_id", params.userId)
    .eq("studio_id", params.studioId)
    .eq("client_id", params.clientId)
    .eq("status", "linked")
    .order("can_sign_documents", { ascending: false })
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    relationshipType: String(data.relationship_type ?? ""),
    canSignDocuments: data.can_sign_documents === true,
  };
}

export function buildSignerEvidence(params: {
  signerName: string;
  channel: SigningChannel;
  authenticatedUserId: string | null;
  subjectClientId: string | null;
  relationship: SignerRelationship | null;
  requestedSignerEmail: string | null;
}): SignerEvidence {
  const relationshipType = params.relationship?.relationshipType || null;
  return {
    signer_name_entered: params.signerName,
    signing_channel: params.channel,
    authenticated_user_id: params.authenticatedUserId,
    subject_client_id: params.subjectClientId,
    relationship_type: relationshipType,
    on_behalf: relationshipType ? relationshipType !== "self" : null,
    requested_signer_email: params.requestedSignerEmail,
  };
}

/** Reads signer evidence back from a completed event's metadata (absent keys stay null: never inferred). */
export function readSignerEvidence(metadata: unknown): Partial<SignerEvidence> {
  if (!metadata || typeof metadata !== "object") return {};
  const value = metadata as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" && value[key] ? (value[key] as string) : null);
  return {
    signer_name_entered: text("signer_name_entered") ?? undefined,
    signing_channel: (text("signing_channel") as SigningChannel | null) ?? undefined,
    authenticated_user_id: text("authenticated_user_id"),
    subject_client_id: text("subject_client_id"),
    relationship_type: text("relationship_type"),
    on_behalf: typeof value.on_behalf === "boolean" ? value.on_behalf : null,
    requested_signer_email: text("requested_signer_email"),
  };
}
