import { getCurrentStudioPlanForUser, studioHasFeature } from "@/lib/billing/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsageAllowance, getUsageLimitMessage, recordUsageEvent } from "@/lib/usage/addons";

/**
 * Who may use the event description assistant, and what it is counted against. Always a signed-in studio user, always metered.
 *
 * - Plans with the AI assistant (Growth, Pro, Organizer Suite plan): the studio `ai_action` allowance, as for the other
 *   assistants.
 * - Other active studios that can publish events (Starter, including Starter with the Organizer Suite add-on): a small separate
 *   monthly PILOT pool under its own key, so nobody who could use the helper loses it and none of them draws on `ai_action`.
 *   Reserve-then-verify: the row is inserted before the provider call and counted, so parallel requests cannot exceed the pool.
 */

export const EVENT_BASIC_FEATURE_KEY = "ai_event_basic";
export const DEFAULT_EVENT_BASIC_MONTHLY_CAP = 10;

export function eventBasicMonthlyCap() {
  const parsed = Number.parseInt(process.env.AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EVENT_BASIC_MONTHLY_CAP;
}

export type EventAiOutcome = "success" | "maybe_billed" | "not_billed";

export type EventAiAccess =
  | { ok: true; finish: (outcome: EventAiOutcome) => Promise<void> }
  | { ok: false; error: string };

const NOT_AVAILABLE = "AI event writing help needs an active DanceFlow studio sign-in.";
const BASIC_USED_UP = "This month's AI description help for your plan has been used. It renews next month.";

export async function authorizeEventDescriptionAi(task: string): Promise<EventAiAccess> {
  if (await studioHasFeature("ai_assistant")) {
    const allowance = await getUsageAllowance({ featureKey: "ai_action" });
    if (!allowance.allowed) return { ok: false, error: getUsageLimitMessage(allowance, "AI action") };
    return {
      ok: true,
      finish: async (outcome) => {
        if (outcome !== "success") return;
        await recordUsageEvent({ featureKey: "ai_action", source: "event_ai_assistant", metadata: { task } });
      },
    };
  }

  // False for a signed-out caller and for an inactive subscription.
  if (!(await studioHasFeature("public_events"))) return { ok: false, error: NOT_AVAILABLE };
  const subscription = await getCurrentStudioPlanForUser();
  if (!subscription) return { ok: false, error: NOT_AVAILABLE };

  const cap = eventBasicMonthlyCap();
  if (cap <= 0) return { ok: false, error: BASIC_USED_UP };

  const studioId = subscription.studioId;
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const admin = createAdminClient();

  const { data: inserted, error } = await admin
    .from("usage_events")
    .insert({
      studio_id: studioId,
      organizer_id: null,
      workspace_type: "studio",
      feature_key: EVENT_BASIC_FEATURE_KEY,
      quantity: 1,
      source: "event_ai_assistant_basic",
      metadata: { task, state: "reserved" },
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select("id")
    .single();

  if (error || !inserted?.id) {
    console.error("Event AI usage reservation failed", error?.message);
    return { ok: false, error: "AI event writing help could not check its usage. Please try again shortly." };
  }

  const setState = async (state: "settled" | "released") => {
    const { error: updateError } = await admin
      .from("usage_events")
      .update({ metadata: { task, state } })
      .eq("id", inserted.id)
      .eq("studio_id", studioId)
      .eq("feature_key", EVENT_BASIC_FEATURE_KEY);
    if (updateError) console.error("Event AI usage state update failed", state, updateError.message);
  };

  const { count, error: countError } = await admin
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("feature_key", EVENT_BASIC_FEATURE_KEY)
    .eq("period_start", periodStart)
    .in("metadata->>state", ["reserved", "settled"]);

  // The count includes this request's own reserved row.
  if (countError || count === null || count > cap) {
    await setState("released");
    return { ok: false, error: BASIC_USED_UP };
  }

  return { ok: true, finish: (outcome) => setState(outcome === "not_billed" ? "released" : "settled") };
}
