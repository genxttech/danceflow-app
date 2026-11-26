import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What a dancer can be billed to for one group class, for staff who choose funding (owner, admin, front desk). Read only: one call to the database function
 * get_eligible_group_class_funding_candidates (the same single source the web's Enroll Student page and roster panel use), on the CALLER'S client, so the
 * database's own authority check applies. It already filters out used-up packages and memberships with no allowance and honours the class's accepted funding types.
 * The enrollment itself (POST .../roster) still decides: a candidate listed here can be gone a moment later.
 */

export type FundingCandidate = {
  billingType: "package_credit" | "membership";
  /** Send this as clientPackageId (package_credit) or clientMembershipId (membership) when enrolling. */
  sourceId: string;
  label: string | null;
  unlimited: boolean;
  /** Credits or allowance left; null when unlimited. */
  remaining: number | null;
};

export type RosterFundingResult =
  | { ok: true; candidates: FundingCandidate[] }
  | { ok: false; reason: "not_found" };

type CandidateRow = {
  funding_type: string;
  source_id: string;
  label: string | null;
  is_unlimited: boolean | null;
  remaining: number | string | null;
};

const NOT_FOUND_MESSAGES = ["Group class not found", "Client not found", "Not authorized to resolve funding eligibility"];

export async function loadRosterFundingCandidates(params: {
  supabase: SupabaseClient;
  studioId: string;
  appointmentId: string;
  clientId: string;
}): Promise<RosterFundingResult> {
  const { supabase, studioId, appointmentId, clientId } = params;
  const { data, error } = await supabase.rpc("get_eligible_group_class_funding_candidates", {
    p_studio_id: studioId,
    p_client_id: clientId,
    p_appointment_id: appointmentId,
  });

  if (error) {
    // A missing class, another studio's class or client, and a caller without authority are indistinguishable to the app.
    if (NOT_FOUND_MESSAGES.some((text) => (error.message ?? "").includes(text))) return { ok: false, reason: "not_found" };
    throw new Error(`Funding lookup failed: ${error.message}`);
  }

  const candidates: FundingCandidate[] = [];
  for (const row of (data ?? []) as CandidateRow[]) {
    if (row.funding_type !== "package" && row.funding_type !== "membership") continue;
    const unlimited = row.is_unlimited === true;
    const remaining = unlimited || row.remaining === null || row.remaining === undefined ? null : Number(row.remaining);
    candidates.push({
      billingType: row.funding_type === "package" ? "package_credit" : "membership",
      sourceId: row.source_id,
      label: row.label,
      unlimited,
      remaining: remaining === null || Number.isFinite(remaining) ? remaining : null,
    });
  }
  return { ok: true, candidates };
}
