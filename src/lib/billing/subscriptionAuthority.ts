/**
 * LAUNCH-SEC-2A: who may manage a workspace's DanceFlow subscription
 * (start a plan checkout, change plans, or open the Stripe billing portal).
 *
 * Owner-level only: the studio owner, the organizer owner, or a platform
 * admin. Studio membership alone (admin, front desk, instructor, ...) never
 * grants it. This is the rule the billing settings page and the billing
 * portal route already used; the plan checkout route now shares it.
 */
export function canManageWorkspaceSubscription(
  role: string | null | undefined,
  isPlatformAdmin: boolean,
) {
  if (isPlatformAdmin) return true;
  return role === "studio_owner" || role === "organizer_owner";
}
