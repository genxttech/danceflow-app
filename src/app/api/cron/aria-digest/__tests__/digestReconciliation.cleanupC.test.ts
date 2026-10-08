import { describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C: the Morning Briefing (email or in-app) reconciles stored ARIA actions against current DanceFlow state
 * before selecting what to report, and leaves snoozed actions out until their snooze ends.
 */

const state: { db: FakeSupabase } = { db: new FakeSupabase() };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

const A = "studio-a";
const B = "studio-b";
const NOW = new Date("2026-10-08T12:00:00.000Z");

function lowAction(id: string, packageId: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    studio_id: A,
    rule_key: "aria_low_package_balance",
    related_table: "client_packages",
    related_id: packageId,
    client_id: "client-1",
    title: `Renewal ${id}`,
    body: null,
    status: "approved",
    priority: "high",
    due_at: "2026-10-08T00:00:00.000Z",
    assigned_to: null,
    snoozed_until: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...fields,
  };
}

function seed() {
  const pkg = (id: string, client: string) => ({
    id,
    studio_id: A,
    client_id: client,
    active: true,
    expiration_date: null,
  });
  const item = (id: string, remaining: number) => ({
    client_package_id: id,
    studio_id: A,
    usage_type: "private_lesson",
    quantity_remaining: remaining,
    is_unlimited: false,
  });
  return new FakeSupabase({
    studios: [{ id: A, name: "Studio A", public_name: null, public_logo_url: null, timezone: "America/New_York" }],
    profiles: [{ id: "owner", full_name: "Owner", email: "owner@example.test" }],
    aria_digest_runs: [],
    outbound_deliveries: [],
    automation_action_events: [],
    client_packages: [
      pkg("pkg-resolved", "client-1"),
      pkg("pkg-replacement", "client-1"),
      pkg("pkg-low", "client-2"),
      pkg("pkg-low-2", "client-3"),
      pkg("pkg-low-3", "client-4"),
    ],
    client_package_items: [
      item("pkg-resolved", 1),
      item("pkg-replacement", 10),
      item("pkg-low", 1),
      item("pkg-low-2", 1),
      item("pkg-low-3", 1),
    ],
    automation_actions: [
      // N: resolved after an external sale -> reconciled, not in the briefing
      lowAction("resolved", "pkg-resolved"),
      // still unresolved and open -> in the briefing
      lowAction("still-low", "pkg-low", { client_id: "client-2" }),
      // L: snoozed into the future -> excluded (and stays snoozed)
      lowAction("snoozed-future", "pkg-low-2", {
        client_id: "client-3",
        status: "snoozed",
        snoozed_until: "2026-10-10T00:00:00.000Z",
      }),
      // M: snooze expired and still unresolved -> may return
      lowAction("snooze-expired", "pkg-low-3", {
        client_id: "client-4",
        status: "snoozed",
        snoozed_until: "2026-10-08T11:00:00.000Z",
      }),
      // another studio's open action never appears in studio A's briefing
      { ...lowAction("other-studio", "pkg-other"), studio_id: B },
    ],
  });
}

async function runDigest(channel: "in_app" | "email") {
  const { processDigestRun } = await import("@/app/api/cron/aria-digest/route");
  return processDigestRun({
    preference: {
      studio_id: A,
      morning_digest_enabled: true,
      end_of_day_digest_enabled: false,
      delivery_channel: channel,
      default_recipient_user_id: "owner",
      morning_digest_time: "08:00",
      end_of_day_digest_time: null,
    },
    digestType: "morning",
    digestDate: "2026-10-08",
    now: NOW,
  });
}

function topActionIds(db: FakeSupabase) {
  const run = db.rows("aria_digest_runs")[0];
  const summary = run.summary as { open_actions: number; top_actions: Array<{ id: string }> };
  return { open: summary.open_actions, ids: summary.top_actions.map((action) => action.id).sort() };
}

// The first test pays the cold import of the digest route (which pulls in the ARIA generation module); allow for that
// under a fully parallel run.
describe("Morning Briefing selection", { timeout: 20_000 }, () => {
  it("in-app: reconciles first, then reports only still-actionable, non-snoozed, same-studio actions", async () => {
    state.db = seed();
    const result = await runDigest("in_app");
    expect(result.status).toBe("prepared");

    expect(topActionIds(state.db)).toEqual({ open: 2, ids: ["snooze-expired", "still-low"] });

    const byId = (id: string) => state.db.rows("automation_actions").find((row) => row.id === id)!;
    expect(byId("resolved").status).toBe("completed");
    expect(byId("snoozed-future")).toMatchObject({ status: "snoozed", snoozed_until: "2026-10-10T00:00:00.000Z" });
    expect(byId("snooze-expired").status).toBe("snoozed");
    expect(byId("other-studio").status).toBe("approved");
  });

  it("email: the stale and snoozed actions are not in the briefing email", async () => {
    state.db = seed();
    const result = await runDigest("email");
    expect(result.status).toBe("queued");
    const [delivery] = state.db.rows("outbound_deliveries");
    expect(String(delivery.body_text)).toContain("Renewal still-low");
    expect(String(delivery.body_text)).not.toContain("Renewal resolved");
    expect(String(delivery.body_text)).not.toContain("Renewal snoozed-future");
    expect(String(delivery.body_text)).not.toContain("Renewal other-studio");
  });

  it("a reconciliation failure does not block the briefing", async () => {
    state.db = seed();
    const original = state.db.from.bind(state.db);
    state.db.from = (table: string) => {
      if (table === "client_packages") throw new Error("source unavailable");
      return original(table);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runDigest("in_app");
    expect(result.status).toBe("prepared");
    // nothing was closed on ambiguous state; snoozed-future is still excluded
    expect(state.db.rows("automation_actions").find((row) => row.id === "resolved")?.status).toBe("approved");
    expect(topActionIds(state.db).ids).not.toContain("snoozed-future");
    warn.mockRestore();
  });
});
