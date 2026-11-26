/**
 * Complimentary studios (an active billing override) get plan access without paying, so DanceFlow carries their AI cost. Their
 * INCLUDED monthly AI allowance is capped; purchased add-on credits are added on top by the caller and are never reduced.
 * Pilot value, tunable with AI_COMPLIMENTARY_STUDIO_MONTHLY_CAP (0 = no included AI for complimentary studios).
 */

export const DEFAULT_COMPLIMENTARY_MONTHLY_CAP = 50;

export function complimentaryMonthlyCap() {
  const parsed = Number.parseInt(process.env.AI_COMPLIMENTARY_STUDIO_MONTHLY_CAP ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COMPLIMENTARY_MONTHLY_CAP;
}

type OverrideRow = { billing_override_enabled: boolean | null; billing_override_expires_at: string | null };

type StudioReader = {
  // Structural on purpose: both the session client and the service-role client are accepted.
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export async function capComplimentaryAllowance(client: StudioReader, studioId: string, included: number) {
  if (included <= 0) return included;
  const { data, error } = (await client
    .from("studios")
    .select("billing_override_enabled, billing_override_expires_at")
    .eq("id", studioId)
    .maybeSingle()) as { data: OverrideRow | null; error: unknown };

  // Unreadable: apply the cap rather than assume a paying studio.
  if (error || !data) return Math.min(included, complimentaryMonthlyCap());

  const expiresAt = data.billing_override_expires_at ? new Date(data.billing_override_expires_at).getTime() : null;
  const complimentary = Boolean(data.billing_override_enabled) && (expiresAt === null || expiresAt >= Date.now());
  return complimentary ? Math.min(included, complimentaryMonthlyCap()) : included;
}
