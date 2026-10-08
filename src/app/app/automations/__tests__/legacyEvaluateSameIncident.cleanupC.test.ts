import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C: the legacy "Evaluate now" rules (still reachable from /app/automations) follow the same incident rule as
 * ARIA generation: a dismissed/completed action is not replaced for the same continuous incident.
 */

const state: { db: FakeSupabase } = { db: new FakeSupabase() };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "studio_owner", userId: "user-owner" }),
}));

const A = "studio-a";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T15:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

async function evaluate(ruleKey: string) {
  const { evaluateAutomationRuleAction } = await import("@/app/app/automations/actions");
  const form = new FormData();
  form.set("ruleKey", ruleKey);
  await expect(evaluateAutomationRuleAction(form)).rejects.toThrow(/redirect:/);
}

function rows(ruleKey: string) {
  return state.db.rows("automation_actions").filter((row) => row.rule_key === ruleKey);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("legacy Evaluate now", () => {
  it("low_package_balance: a dismissed action for the same still-low package is not recreated", async () => {
    state.db = new FakeSupabase({
      automation_rules: [{ id: "rule-1", studio_id: A, rule_key: "low_package_balance", enabled: true, mode: "suggestion", trigger_config: { threshold: 2 } }],
      client_packages: [
        {
          id: "pkg-1",
          studio_id: A,
          client_id: "client-1",
          name_snapshot: "Starter",
          active: true,
          expiration_date: null,
          clients: { first_name: "Robin", last_name: "Lee", email: null },
          client_package_items: [{ id: "i1", usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false }],
        },
      ],
      automation_actions: [
        {
          id: "old",
          studio_id: A,
          rule_key: "low_package_balance",
          related_table: "client_packages",
          related_id: "pkg-1",
          status: "dismissed",
          created_at: ago(3),
        },
      ],
      automation_action_events: [],
      automation_runs: [],
    });
    await evaluate("low_package_balance");
    expect(rows("low_package_balance")).toHaveLength(1);
    expect(rows("low_package_balance")[0].status).toBe("dismissed");
  });

  it("pending_booking_request: a completed action for the same pending request is not recreated; a new request is", async () => {
    state.db = new FakeSupabase({
      automation_rules: [{ id: "rule-2", studio_id: A, rule_key: "pending_booking_request", enabled: true, mode: "suggestion", trigger_config: {} }],
      booking_requests: [
        { id: "br-1", studio_id: A, client_id: null, status: "pending", created_at: ago(5), requested_starts_at: ago(-2), customer_first_name: "Sam", customer_last_name: "Ray", customer_email: null },
      ],
      automation_actions: [
        {
          id: "old",
          studio_id: A,
          rule_key: "pending_booking_request",
          related_table: "booking_requests",
          related_id: "br-1",
          status: "completed",
          created_at: ago(2),
        },
      ],
      automation_action_events: [],
      automation_runs: [],
    });
    await evaluate("pending_booking_request");
    expect(rows("pending_booking_request")).toHaveLength(1);

    state.db.rows("booking_requests").push({
      id: "br-2",
      studio_id: A,
      client_id: null,
      status: "pending",
      created_at: ago(4),
      requested_starts_at: ago(-3),
      customer_first_name: "Ann",
      customer_last_name: "Ko",
      customer_email: null,
    });
    await evaluate("pending_booking_request");
    expect(rows("pending_booking_request").map((row) => row.related_id).sort()).toEqual(["br-1", "br-2"]);
  });
});
