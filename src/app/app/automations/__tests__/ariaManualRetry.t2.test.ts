import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * T2: the staff "Retry now" server action (retryAriaAutomationActionDeliveryAction) requeues the SAME delivery, so it
 * re-sends with the same provider idempotency key. It must refuse, on the server, any failure that does not prove the
 * message was undelivered (unknown outcome, expired retry window, payload mismatch, unclassifiable legacy text), and still
 * allow a retry of a definite non-delivery. Real server action, in-memory database.
 */

const state: { db: FakeSupabase; role: string } = { db: new FakeSupabase(), role: "studio_owner" };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: A, studioRole: state.role, userId: ACTOR }),
}));

const A = "studio-a";
const B = "studio-b";
const ACTOR = "user-owner";
const ACTION_ID = "action-1";
const DELIVERY_ID = "delivery-1";
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function seed(delivery: Record<string, unknown> = {}, action: Record<string, unknown> = {}) {
  state.db = new FakeSupabase({
    automation_actions: [
      {
        id: ACTION_ID,
        studio_id: A,
        status: "failed",
        execution_status: "exhausted",
        execution_delivery_id: DELIVERY_ID,
        execution_attempt_count: 3,
        execution_next_attempt_at: null,
        execution_error_message: "x",
        ...action,
      },
    ],
    automation_action_events: [],
    outbound_deliveries: [
      {
        id: DELIVERY_ID,
        studio_id: A,
        channel: "email",
        template_key: "aria_execution_aria_membership_past_due",
        related_table: "automation_actions",
        related_id: ACTION_ID,
        status: "failed",
        error_message: "provider_rejected:validation_error",
        updated_at: THREE_DAYS_AGO,
        ...delivery,
      },
    ],
  });
  return state.db;
}

async function retry(actionId = ACTION_ID): Promise<string> {
  const { retryAriaAutomationActionDeliveryAction } = await import("@/app/app/automations/actions");
  const form = new FormData();
  form.set("actionId", actionId);
  form.set("returnTo", "/app/aria/operations");
  try {
    await retryAriaAutomationActionDeliveryAction(form);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("redirect:")) return message.slice("redirect:".length);
    throw error;
  }
  throw new Error("expected a redirect");
}

const delivery = () => state.db.rows("outbound_deliveries")[0];
const action = () => state.db.rows("automation_actions")[0];
const events = () => state.db.rows("automation_action_events");

beforeEach(() => {
  state.role = "studio_owner";
});

describe("T2: staff manual retry of an ARIA delivery", () => {
  it.each([
    ["definite provider rejection", "provider_rejected:validation_error"],
    ["pre-provider failure", "missing_sender_address"],
    ["email lookup/render exception", "dispatch_exception"],
    ["retry window ended with every attempt definitely unsent", "provider_retry_window_exhausted_unsent"],
  ])("%s: allowed, requeues the same delivery (same key) and records a manual retry", async (_label, code) => {
    seed({ error_message: code });
    const url = await retry();
    expect(url).toContain("success=aria_delivery_requeued");
    expect(delivery()).toMatchObject({ id: DELIVERY_ID, status: "queued", error_message: null });
    expect(action()).toMatchObject({ status: "queued", execution_status: "retrying", execution_error_message: null });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event_type: "delivery_requeued", created_by: ACTOR });
    expect((events()[0].metadata as Record<string, unknown>).manual_retry).toBe(true);
  });

  it("a definite rejection older than the provider's 24-hour idempotency window is still retryable (it proves non-delivery)", async () => {
    seed({ error_message: "provider_rejected:validation_error", updated_at: THREE_DAYS_AGO });
    const url = await retry();
    expect(url).toContain("success=aria_delivery_requeued");
    expect(delivery().status).toBe("queued");
  });

  it.each([
    ["unknown outcome after the retry window", "email", "provider_retry_window_exhausted"],
    ["payload mismatch on the reused key", "email", "provider_idempotency_mismatch"],
    ["rejection after an attempt that may have been accepted", "email", "failed_after_uncertain_attempt"],
    ["sanitizer fallback", "email", "dispatch_error"],
    ["pre-T2 free text (cannot be classified)", "email", "Unable to fetch data. The request could not be resolved."],
    ["no recorded reason", "email", null],
    ["SMS sent but unrecorded", "sms", "sms_sent_outcome_unrecorded"],
    ["SMS exception (Twilio may have received it)", "sms", "dispatch_exception"],
  ])("%s: refused on the server, nothing changes", async (_label, channel, code) => {
    seed({ channel, error_message: code });
    const before = { delivery: { ...delivery() }, action: { ...action() } };
    const url = await retry();
    expect(url).toContain("error=aria_retry_delivery_uncertain");
    expect(delivery()).toEqual(before.delivery);
    expect(action()).toEqual(before.action);
    expect(events()).toHaveLength(0);
  });

  it("an uncertain outcome is refused even after the provider's idempotency window has long passed", async () => {
    seed({ error_message: "provider_retry_window_exhausted", updated_at: THREE_DAYS_AGO });
    const url = await retry();
    expect(url).toContain("error=aria_retry_delivery_uncertain");
    expect(delivery().status).toBe("failed");
  });

  it("refuses when the failure changes to an uncertain one between the check and the requeue (compare-and-set)", async () => {
    const db = seed({ error_message: "provider_rejected:validation_error" });
    const originalFrom = db.from.bind(db);
    let deliveryCalls = 0;
    db.from = ((table: string) => {
      if (table === "outbound_deliveries" && ++deliveryCalls === 2) {
        // Another process records a different outcome just before the requeue update runs.
        db.rows("outbound_deliveries")[0].error_message = "provider_retry_window_exhausted";
      }
      return originalFrom(table);
    }) as typeof db.from;
    const url = await retry();
    expect(url).toContain("error=aria_retry_failed");
    expect(delivery()).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted" });
    expect(events()).toHaveLength(0);
  });

  it("cannot requeue another studio's delivery", async () => {
    seed({ studio_id: B });
    const url = await retry();
    expect(url).toContain("error=aria_retry_failed");
    expect(delivery()).toMatchObject({ studio_id: B, status: "failed" });
  });

  it("does not read another studio's delivery state (lookup is studio-scoped)", async () => {
    seed({ studio_id: B, error_message: "provider_retry_window_exhausted" });
    const url = await retry();
    // Unscoped, the lookup would reveal the other studio's outcome as `aria_retry_delivery_uncertain`.
    expect(url).toContain("error=aria_retry_failed");
  });

  it("requires a settings-managing role", async () => {
    seed();
    state.role = "instructor";
    const url = await retry();
    expect(url).toContain("error=not-authorized");
    expect(delivery().status).toBe("failed");
  });
});

describe("T2: staff wording distinguishes uncertain from failed", () => {
  it("uncertain codes read as 'delivery uncertain'; definite failures keep their reason", async () => {
    const { describeDeliveryNoteForStaff, isUncertainDeliveryOutcome } = await import("@/lib/notifications/deliveryOutcome");
    for (const code of ["provider_retry_window_exhausted", "provider_idempotency_mismatch", "sms_sent_outcome_unrecorded", "failed_after_uncertain_attempt"]) {
      expect(isUncertainDeliveryOutcome(code)).toBe(true);
      expect(describeDeliveryNoteForStaff(code)).toMatch(/^Delivery uncertain:/);
    }
    expect(isUncertainDeliveryOutcome("provider_rejected:validation_error")).toBe(false);
    expect(describeDeliveryNoteForStaff("provider_rejected:validation_error")).toBe("provider_rejected:validation_error");
  });
});
