import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeLikePattern } from "@/lib/auth/verifiedIdentity";

/**
 * G-01 -- how a DanceFlow Marketplace purchase relates to the selling studio's CRM.
 *
 * Policy (audit D6, owner decision pending): a marketplace buyer has NO studio relationship unless one already exists.
 * Checkout creation never creates a clients row (lead or otherwise) and never creates or revives a client_account_links
 * row / portal permissions. The purchase entitlement belongs to the buyer's DanceFlow account (commerce_entitlements.user_id)
 * and is created only by verified payment settlement (commerce_finalize_student_digital_order).
 *
 * The buyer's order may be attached to an EXISTING studio client record only when
 *   - the buyer already has a linked self relationship with the studio ("existing_self_link", unchanged from before), or
 *   - the buyer's verified, bound email exactly matches exactly one existing client of that studio
 *     ("verified_email_match"; unchanged guards: a client held by another account, or a relationship the studio closed,
 *     blocks the purchase). Nothing is created or written on the client or the link.
 * Otherwise the order is a guest order ("none").
 */
export const MARKETPLACE_AUTO_STUDIO_RELATIONSHIP = false as const;

/** relationships a purchase must never silently revive (LAUNCH-SEC-1C-B) */
const NON_REVIVABLE_LINK_STATUSES = ["disconnected", "former_client", "rejected", "conflict"];

export type MarketplaceBuyerResolution =
  | { ok: true; clientId: string | null; basis: "existing_self_link" | "verified_email_match" | "none" }
  | { ok: false; status: number; message: string };

/**
 * SEAM (D6): the single place where a buyer's explicit opt-in to a studio relationship would be honoured -- e.g. a
 * checkbox "Share my details with this studio" that, once the owner decides the product behaviour, creates the lead
 * and/or link AFTER settlement. Today it intentionally does nothing and returns { created: false }; checkout and
 * settlement never call anything that creates a relationship.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function applyMarketplaceBuyerRelationshipOptIn(_input: {
  studioId: string;
  userId: string;
  orderId: string;
  optIn: boolean;
}): Promise<{ created: false; reason: "not_implemented_pending_owner_decision_d6" }> {
  return { created: false, reason: "not_implemented_pending_owner_decision_d6" };
}

type Admin = Pick<SupabaseClient, "from">;

/**
 * Resolves the existing studio client (if any) a marketplace order may be attached to. READ-ONLY: it never inserts or
 * updates clients or client_account_links.
 */
export async function resolveMarketplaceBuyerClient(input: {
  admin: Admin;
  studioId: string;
  userId: string;
  normalizedEmail: string;
  /** Called only when no self link exists (so the verified-email gate is unchanged); returns false when not verified. */
  isEmailVerified: () => Promise<boolean> | boolean;
}): Promise<MarketplaceBuyerResolution> {
  const { admin, studioId, userId, normalizedEmail } = input;

  const { data: existingSelfLink, error: existingSelfLinkError } = await admin
    .from("client_account_links")
    .select("id, client_id")
    .eq("user_id", userId)
    .eq("studio_id", studioId)
    .eq("status", "linked")
    .eq("relationship_type", "self")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existingSelfLinkError) {
    return { ok: false, status: 500, message: "Your studio relationship could not be verified." };
  }
  if (existingSelfLink?.client_id) {
    return { ok: true, clientId: existingSelfLink.client_id as string, basis: "existing_self_link" };
  }

  // LAUNCH-SEC-1C-B (T1-B): matching a studio customer record needs the buyer's verified, bound current email.
  if (!(await input.isEmailVerified())) {
    return { ok: false, status: 403, message: "Verify your email address before purchasing from this studio." };
  }

  const { data: candidateClients, error: matchingClientError } = await admin
    .from("clients")
    .select("id, email")
    .eq("studio_id", studioId)
    .ilike("email", escapeLikePattern(normalizedEmail))
    .order("created_at", { ascending: true })
    .limit(5);

  if (matchingClientError) {
    return { ok: false, status: 500, message: "Your customer record could not be resolved." };
  }

  const matchingClients = (candidateClients ?? []).filter(
    (candidate) => String(candidate.email ?? "").trim().toLowerCase() === normalizedEmail,
  );

  if (matchingClients.length > 1) {
    return {
      ok: false,
      status: 409,
      message: "This studio has duplicate customer records for your email. Contact the studio before purchasing.",
    };
  }

  const clientId = (matchingClients[0]?.id as string | undefined) ?? null;
  if (!clientId) return { ok: true, clientId: null, basis: "none" };

  const { data: clientLinks, error: clientLinksError } = await admin
    .from("client_account_links")
    .select("id, user_id, status")
    .eq("studio_id", studioId)
    .eq("client_id", clientId);

  if (clientLinksError) {
    return { ok: false, status: 500, message: "The customer relationship could not be verified." };
  }

  if ((clientLinks ?? []).some((link) => link.status === "linked" && link.user_id && link.user_id !== userId)) {
    return {
      ok: false,
      status: 409,
      message:
        "A different DanceFlow account is already connected to this studio customer record. Contact the studio before purchasing.",
    };
  }

  if (
    (clientLinks ?? []).some(
      (link) => link.user_id === userId && NON_REVIVABLE_LINK_STATUSES.includes(String(link.status)),
    )
  ) {
    return {
      ok: false,
      status: 409,
      message:
        "Your connection to this studio was closed. Ask the studio to send you a new invitation before purchasing.",
    };
  }

  return { ok: true, clientId, basis: "verified_email_match" };
}
