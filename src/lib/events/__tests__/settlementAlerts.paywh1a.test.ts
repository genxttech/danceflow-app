import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAdminClient, FakeTable } from "@/lib/supabase/__tests__/simpleFakeAdminClient";

vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: vi.fn(async () => ({ queued: true, skipped: false })) }));
vi.mock("@/lib/notifications/event-email-branding", () => ({
  resolveEventEmailBranding: vi.fn(async () => ({ name: "Brand Studio", logoUrl: null, kind: "studio", studioName: "Brand Studio", organizerName: null, senderDisplayName: null })),
}));

import { queueOutboundDelivery } from "@/lib/notifications/outbound";
import { drainSettlementExceptionAlerts, paymentExceptionReviewUrl } from "@/lib/events/settlementAlerts";

/**
 * PAY-WH-1A H-1 -- staff alert worker. The database queues one alert per exception (sql-tests cover the queue itself);
 * this covers what the worker does with a leased alert: in-app notification for the studio, branded email per event
 * manager (studio owners/admins + organizer owners/admins), idempotent keys, post-condition, honest completion.
 */

const EXCEPTION = {
  id: "exc-1", order_id: "order-1", studio_id: "studio-1", event_id: "event-1", registration_id: null,
  kind: "late_payment_after_release", money_state: "captured", amount_cents: 3000, currency: "usd", stripe_payment_intent_id: "pi_late",
};

function setup(options: { claimed?: Array<typeof EXCEPTION>; completeResult?: boolean; notificationInsertError?: { message: string; code?: string } } = {}) {
  const tables: Record<string, FakeTable> = {};
  for (const name of ["notifications", "user_studio_roles", "organizer_users", "profiles", "events", "event_orders"]) tables[name] = new FakeTable();
  tables.user_studio_roles.rows.push(
    { user_id: "u-owner", studio_id: "studio-1", role: "studio_owner", active: true },
    { user_id: "u-admin", studio_id: "studio-1", role: "studio_admin", active: true },
  );
  tables.organizer_users.rows.push({ user_id: "u-org", organizer_id: "org-1", role: "organizer_owner", active: true });
  tables.profiles.rows.push(
    { id: "u-owner", email: "owner@example.com" },
    { id: "u-admin", email: "admin@example.com" },
    { id: "u-org", email: "org@example.com" },
  );
  tables.events.rows.push({ id: "event-1", name: "Spring Showcase", organizer_id: "org-1" });
  tables.event_orders.rows.push({ id: "order-1", buyer_email: "buyer@example.com" });
  const completions: Array<Record<string, unknown>> = [];
  const client = createFakeAdminClient(tables) as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>; from: (t: string) => unknown };
  const originalFrom = client.from.bind(client);
  if (options.notificationInsertError) {
    client.from = (table: string) => {
      const builder = originalFrom(table) as Record<string, unknown>;
      if (table !== "notifications") return builder;
      const injected = options.notificationInsertError;
      return { ...builder, insert: async () => ({ data: null, error: injected?.code === "silent" ? null : injected }) };
    };
  }
  client.rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === "claim_settlement_exception_alerts") return { data: options.claimed ?? [EXCEPTION], error: null };
    if (fn === "complete_settlement_exception_alert") {
      completions.push(args);
      return { data: options.completeResult ?? true, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  };
  return { tables, completions, admin: client as unknown as SupabaseClient };
}

beforeEach(() => vi.mocked(queueOutboundDelivery).mockClear());

describe("payment exception staff alerts", () => {
  it("notifies the studio in-app and emails every event manager, with per-exception (and per-recipient) dedupe keys", async () => {
    const { tables, completions, admin } = setup();
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(tables.notifications.rows).toEqual([expect.objectContaining({
      studio_id: "studio-1", type: "payment_exception", category: "payment", priority: "urgent", dedupe_key: "payment_exception:exc-1",
    })]);
    const deliveries = vi.mocked(queueOutboundDelivery).mock.calls.map(([params]) => params);
    expect(deliveries.map((d) => [d.recipientEmail, d.dedupeKey]).sort()).toEqual([
      ["admin@example.com", "payment_exception:exc-1:email:u-admin"],
      ["org@example.com", "payment_exception:exc-1:email:u-org"],
      ["owner@example.com", "payment_exception:exc-1:email:u-owner"],
    ]);
    expect(deliveries[0]).toMatchObject({ studioId: "studio-1", channel: "email", templateKey: "payment_exception_alert", relatedTable: "event_order_settlement_exceptions", relatedId: "exc-1" });
    expect(deliveries[0].subject).toContain("Payment needs review");
    expect(deliveries[0].bodyText).toContain("Nothing was refunded or fulfilled automatically");
    expect(deliveries[0].bodyText).toContain("$30.00");
    expect(deliveries[0].bodyHtml).toContain("Brand Studio");
    expect(deliveries[0].bodyText).toContain(paymentExceptionReviewUrl(EXCEPTION));
    expect(completions).toEqual([{ p_exception_id: "exc-1", p_owner: "w1", p_ok: true, p_error: null }]);
  });

  it("a duplicate in-app notification (replayed worker) is not an error", async () => {
    const { completions, admin, tables } = setup({ notificationInsertError: { message: "duplicate key", code: "23505" } });
    tables.notifications.rows.push({ id: "n-1", dedupe_key: "payment_exception:exc-1" });
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(completions[0]).toMatchObject({ p_ok: true });
  });

  it("a failed notification write is recorded as a failed attempt (retried with backoff), never as sent", async () => {
    const { completions, admin } = setup({ notificationInsertError: { message: "check constraint", code: "23514" } });
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completions[0]).toMatchObject({ p_ok: false });
    expect(String(completions[0].p_error)).toContain("check constraint");
  });

  it("an in-app notification that was not actually stored fails the post-condition (retried, never marked sent)", async () => {
    const { completions, admin } = setup({ notificationInsertError: { message: "", code: "silent" } });
    // the fake "succeeds" without storing anything when the error code is "silent"
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completions[0]).toMatchObject({ p_ok: false, p_error: "payment exception notification not recorded" });
  });

  it("an alert whose lease was lost is not counted as sent", async () => {
    const { admin } = setup({ completeResult: false });
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 0, failed: 1 });
  });

  it("an exception that no studio owns completes without writing studio alerts (platform page only)", async () => {
    const { tables, completions, admin } = setup({ claimed: [{ ...EXCEPTION, studio_id: null as unknown as string, event_id: null as unknown as string }] });
    expect(await drainSettlementExceptionAlerts({ admin, owner: "w1" })).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(tables.notifications.rows).toEqual([]);
    expect(queueOutboundDelivery).not.toHaveBeenCalled();
    expect(completions[0]).toMatchObject({ p_ok: true });
  });
});
