import type { SupabaseClient } from "@supabase/supabase-js";

export const CURRENT_LEGAL_AGREEMENTS = {
  terms: "2026-07-17",
  privacy: "2026-07-17",
  dpa: "2026-07-17",
  electronicSignature: "2026-07-17",
} as const;

export const CURRENT_BUSINESS_LEGAL_ACCEPTANCE_VERSION = "2026-07-17";

export type LegalAcceptanceSource =
  | "business_signup"
  | "business_reacceptance";

export type BusinessIntent = "studio" | "organizer";

type CurrentAcceptanceRow = {
  id: string;
};

export async function hasCurrentBusinessLegalAcceptance(params: {
  supabase: SupabaseClient;
  userId: string;
}) {
  const { supabase, userId } = params;

  const { data, error } = await supabase
    .from("legal_agreement_acceptances")
    .select("id")
    .eq("user_id", userId)
    .eq("acceptance_version", CURRENT_BUSINESS_LEGAL_ACCEPTANCE_VERSION)
    .eq("terms_version", CURRENT_LEGAL_AGREEMENTS.terms)
    .eq("privacy_version", CURRENT_LEGAL_AGREEMENTS.privacy)
    .eq("dpa_version", CURRENT_LEGAL_AGREEMENTS.dpa)
    .limit(1)
    .maybeSingle<CurrentAcceptanceRow>();

  if (error) {
    console.error("Could not verify current legal acceptance:", error.message);
    return false;
  }

  return Boolean(data?.id);
}

export async function recordBusinessLegalAcceptance(params: {
  supabase: SupabaseClient;
  userId: string;
  source: LegalAcceptanceSource;
  intent: BusinessIntent;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const {
    supabase,
    userId,
    source,
    intent,
    ipAddress,
    userAgent,
  } = params;

  const alreadyAccepted = await hasCurrentBusinessLegalAcceptance({
    supabase,
    userId,
  });

  if (alreadyAccepted) return;

  const { error } = await supabase
    .from("legal_agreement_acceptances")
    .insert({
      user_id: userId,
      acceptance_version: CURRENT_BUSINESS_LEGAL_ACCEPTANCE_VERSION,
      terms_version: CURRENT_LEGAL_AGREEMENTS.terms,
      privacy_version: CURRENT_LEGAL_AGREEMENTS.privacy,
      dpa_version: CURRENT_LEGAL_AGREEMENTS.dpa,
      electronic_signature_version:
        CURRENT_LEGAL_AGREEMENTS.electronicSignature,
      source,
      account_intent: intent,
      ip_address: ipAddress,
      user_agent: userAgent,
    });

  if (error) {
    throw new Error(`Could not record legal acceptance: ${error.message}`);
  }
}
