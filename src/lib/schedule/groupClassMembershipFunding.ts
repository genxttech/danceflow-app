import { createClient } from "@/lib/supabase/server";
import { resolveGroupClassBenefit } from "@/lib/memberships/groupClassBenefit";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type MembershipFundingDisplay =
  | { kind: "unlimited"; membershipName: string }
  | { kind: "finite"; membershipName: string; quantity: number | null; usedInPeriod: number }
  | { kind: "unresolved"; membershipName: string };

/**
 * Whether a membership's group-class funding can be offered/auto-selected
 * as an eligible enrollment source (Add Student, PR #70 review correction).
 * Unlimited is always eligible (nothing to exhaust). Finite is eligible
 * only while quantity - usedInPeriod > 0 -- a fully-consumed finite
 * membership must never be auto-preselected or offered as if it could
 * still fund an enrollment, since the DB (GC-2c) will correctly reject it
 * at submission time regardless; this keeps the UI from walking a staff
 * member into a foreseeable rejection. Unresolved (no applicable benefit
 * at all) is never eligible.
 */
export function isMembershipFundingEligibleForEnrollment(funding: MembershipFundingDisplay): boolean {
  if (funding.kind === "unresolved") return false;
  if (funding.kind === "finite") return (funding.quantity ?? 0) - funding.usedInPeriod > 0;
  return true;
}

/**
 * Roster-display-only funding summary for membership-billed group-class
 * attendees (item B of the UX audit). This is informational, not
 * authoritative -- the DB triggers (GC-2c/GC-2f) remain the sole enforcement
 * point regardless of what this shows. "usedInPeriod" counts only actual
 * client_membership_usage rows dated within the membership's current period;
 * it does not additionally subtract other booked-but-not-yet-attended
 * reservations, so it can read slightly optimistic compared to the DB's own
 * reserved+consumed balance check -- acceptable for a staff-facing glance,
 * since the enrollment trigger is what actually prevents overcommitment.
 */
export async function getGroupClassMembershipFundingForRoster(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  membershipIds: string[];
}): Promise<Map<string, MembershipFundingDisplay>> {
  const { supabase, studioId, membershipIds } = params;
  const result = new Map<string, MembershipFundingDisplay>();

  const uniqueIds = Array.from(new Set(membershipIds));
  if (uniqueIds.length === 0) return result;

  const { data: memberships, error: membershipsError } = await supabase
    .from("client_memberships")
    .select("id, name_snapshot, membership_plan_id, current_period_start, current_period_end")
    .eq("studio_id", studioId)
    .in("id", uniqueIds);

  if (membershipsError) {
    throw new Error(`Failed to load membership funding details: ${membershipsError.message}`);
  }

  const typedMemberships = (memberships ?? []) as {
    id: string;
    name_snapshot: string | null;
    membership_plan_id: string;
    current_period_start: string | null;
    current_period_end: string | null;
  }[];

  const planIds = Array.from(new Set(typedMemberships.map((m) => m.membership_plan_id)));
  if (planIds.length === 0) return result;

  const { data: benefitRows, error: benefitsError } = await supabase
    .from("membership_plan_benefits")
    .select("membership_plan_id, benefit_type, quantity, applies_to")
    .in("membership_plan_id", planIds);

  if (benefitsError) {
    throw new Error(`Failed to load membership benefits: ${benefitsError.message}`);
  }

  const benefitsByPlanId = new Map<
    string,
    { benefit_type: string; quantity: number | null; applies_to: string | null }[]
  >();
  for (const row of benefitRows ?? []) {
    const planId = row.membership_plan_id as string;
    benefitsByPlanId.set(planId, [
      ...(benefitsByPlanId.get(planId) ?? []),
      {
        benefit_type: row.benefit_type as string,
        quantity: row.quantity as number | null,
        applies_to: row.applies_to as string | null,
      },
    ]);
  }

  const finiteMembershipIds: string[] = [];
  for (const membership of typedMemberships) {
    const membershipName = membership.name_snapshot || "Membership";
    const resolution = resolveGroupClassBenefit(benefitsByPlanId.get(membership.membership_plan_id) ?? []);

    if (!resolution) {
      result.set(membership.id, { kind: "unresolved", membershipName });
      continue;
    }

    if (resolution.kind === "unlimited") {
      result.set(membership.id, { kind: "unlimited", membershipName });
      continue;
    }

    finiteMembershipIds.push(membership.id);
    result.set(membership.id, {
      kind: "finite",
      membershipName,
      quantity: resolution.quantity,
      usedInPeriod: 0,
    });
  }

  if (finiteMembershipIds.length > 0) {
    const { data: usageRows, error: usageError } = await supabase
      .from("client_membership_usage")
      .select("client_membership_id, quantity_used, usage_date")
      .in("client_membership_id", finiteMembershipIds);

    if (usageError) {
      throw new Error(`Failed to load membership usage: ${usageError.message}`);
    }

    const periodByMembershipId = new Map(
      typedMemberships.map((m) => [m.id, { start: m.current_period_start, end: m.current_period_end }]),
    );

    for (const row of usageRows ?? []) {
      const membershipId = row.client_membership_id as string;
      const period = periodByMembershipId.get(membershipId);
      const usageDate = row.usage_date as string;
      if (period?.start && period?.end && (usageDate < period.start || usageDate > period.end)) {
        continue;
      }

      const existing = result.get(membershipId);
      if (existing?.kind === "finite") {
        existing.usedInPeriod += Number(row.quantity_used ?? 0);
      }
    }
  }

  return result;
}
