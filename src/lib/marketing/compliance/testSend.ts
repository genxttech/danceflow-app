import type { createAdminClient } from "@/lib/supabase/admin";
import type { CampaignKind } from "./campaignDelivery";

/**
 * Marketing M-0 (D3): a campaign test send may go only to a verified address of the workspace's own staff, and is
 * rate limited per workspace and recorded. The database decides (marketing_authorize_test_send); any error refuses.
 */

export const TEST_SENDS_PER_WORKSPACE_PER_HOUR = 10;

export type TestSendDecision =
  | { allowed: true }
  | { allowed: false; reason: "recipient_not_verified_staff" | "rate_limited" | "not_found" | "unavailable" };

export async function authorizeCampaignTestSend(
  admin: ReturnType<typeof createAdminClient>,
  args: { kind: CampaignKind; scopeId: string; campaignId: string; requestedBy: string; email: string },
): Promise<TestSendDecision> {
  try {
    const { data, error } = await admin.rpc("marketing_authorize_test_send", {
      p_scope_kind: args.kind,
      p_scope_id: args.scopeId,
      p_campaign_id: args.campaignId,
      p_requested_by: args.requestedBy,
      p_email: args.email,
      p_max_per_hour: TEST_SENDS_PER_WORKSPACE_PER_HOUR,
    });
    const result = (data ?? {}) as { allowed?: boolean; reason?: string };
    if (error || typeof result.allowed !== "boolean") return { allowed: false, reason: "unavailable" };
    if (result.allowed) return { allowed: true };
    const reason = result.reason;
    if (reason === "recipient_not_verified_staff" || reason === "rate_limited" || reason === "not_found") {
      return { allowed: false, reason };
    }
    return { allowed: false, reason: "unavailable" };
  } catch {
    return { allowed: false, reason: "unavailable" };
  }
}

/** Redirect error code shown on the campaign page for a refused test send. */
export function testSendRefusalCode(reason: Exclude<TestSendDecision, { allowed: true }>["reason"]) {
  switch (reason) {
    case "recipient_not_verified_staff":
      return "test_recipient_not_allowed";
    case "rate_limited":
      return "test_send_rate_limited";
    case "not_found":
      return "not_found";
    default:
      return "test_send_failed";
  }
}
