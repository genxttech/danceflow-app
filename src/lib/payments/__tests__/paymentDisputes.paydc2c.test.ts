import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "./ownershipFakes";

/**
 * PAY-DC-2C: dispute lifecycle tracking. Connect disputes bind to the persisted owner
 * or the Stripe-signed account's studio; platform disputes are attributed only via
 * exact persisted charge/PaymentIntent ids proving one studio. No metadata, no current
 * account inference for platform disputes, no PII, one notice per dispute per recipient.
 */

const queued = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  keys: new Set<string>(),
}));

vi.mock("@/lib/notifications/outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/outbound")>();
  return {
    ...actual,
    queueOutboundDelivery: async (params: Record<string, unknown>) => {
      queued.calls.push(params);
      const key = String(params.dedupeKey);
      if (queued.keys.has(key)) return { queued: false, skipped: true, reason: "duplicate" };
      queued.keys.add(key);
      return { queued: true, skipped: false, reason: null };
    },
  };
});

const { handleChargeDisputeEvent } = await import("@/lib/payments/paymentDisputes");

const A = "acct_ownerA";
const C = "acct_otherC";

const USERS: Record<string, string> = {
  "user-owner": "Owner@Studio.test",
  "user-admin": "admin@studio.test",
  "user-owner-2": "owner@studio-two.test",
};

function db(rows: Record<string, Row[]>) {
  const fake = createOwnershipFakeSupabase({
    user_studio_roles: [
      { studio_id: "studio-1", user_id: "user-owner", role: "studio_owner", active: true },
      { studio_id: "studio-1", user_id: "user-admin", role: "studio_admin", active: true },
      { studio_id: "studio-2", user_id: "user-owner-2", role: "studio_owner", active: true },
    ],
    payment_disputes: [],
    payments: [],
    event_payments: [],
    events: [],
    ...rows,
  });
  const client = {
    ...fake.client,
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: USERS[id] ?? null } }, error: null }),
      },
    },
  };
  return { fake, supabase: client as unknown as SupabaseClient };
}

let seq = 0;
function disputeEvent(options: {
  type?: string;
  account?: string | null;
  created?: number;
  dispute?: Record<string, unknown>;
}): Stripe.Event {
  seq += 1;
  return {
    id: `evt_${seq}`,
    object: "event",
    type: options.type ?? "charge.dispute.created",
    created: options.created ?? 1_800_000_000,
    ...(options.account ? { account: options.account } : {}),
    data: {
      object: {
        id: "du_1",
        object: "dispute",
        amount: 4500,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        charge: "ch_1",
        payment_intent: "pi_1",
        evidence_details: { due_by: 1_800_600_000 },
        evidence: {
          customer_email_address: "cardholder@example.test",
          customer_name: "Card Holder",
          billing_address: "1 Private Lane",
        },
        metadata: { studioId: "studio-2" },
        ...options.dispute,
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  queued.calls.length = 0;
  queued.keys.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Connect disputes", () => {
  it("created: persisted owner row decides studio + payment link; one notice per staff recipient", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    const [row] = fake.rows("payment_disputes");
    expect(row).toMatchObject({
      studio_id: "studio-1",
      stripe_scope: "connect",
      stripe_account_id: A,
      stripe_dispute_id: "du_1",
      payment_id: "pay-1",
      event_payment_id: null,
      amount_cents: 4500,
      status: "needs_response",
    });
    expect(queued.calls.map((call) => call.recipientEmail)).toEqual(["owner@studio.test", "admin@studio.test"]);
    for (const call of queued.calls) {
      expect(call).toMatchObject({
        studioId: "studio-1",
        channel: "email",
        templateKey: "payment_dispute_opened_studio",
        relatedTable: "payment_disputes",
        relatedId: row.id,
      });
      expect(String(call.dedupeKey)).toBe(`payment_dispute_opened_studio:du_1:${call.recipientEmail}`);
      expect(String(call.bodyHtml)).toContain("<html");
    }
  });

  it("created: owner-matched event_payments row links event_payment_id", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      events: [{ id: "event-1", studio_id: "studio-1" }],
      event_payments: [{ id: "ep-1", event_id: "event-1", stripe_payment_intent_id: "pi_1", stripe_account_id: A }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({ studio_id: "studio-1", event_payment_id: "ep-1", payment_id: null });
  });

  it("updated/closed/funds events update the same dispute; older events and duplicates are no-ops", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A, created: 100 }) });
    await handleChargeDisputeEvent({
      supabase,
      event: disputeEvent({ account: A, type: "charge.dispute.funds_withdrawn", created: 200 }),
    });
    await handleChargeDisputeEvent({
      supabase,
      event: disputeEvent({ account: A, type: "charge.dispute.closed", created: 300, dispute: { status: "won" } }),
    });
    // Older update arriving late must not reopen the dispute.
    await handleChargeDisputeEvent({
      supabase,
      event: disputeEvent({ account: A, type: "charge.dispute.updated", created: 150, dispute: { status: "under_review" } }),
    });

    const rows = fake.rows("payment_disputes");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "won",
      last_stripe_event_type: "charge.dispute.closed",
      closed_at: new Date(300_000).toISOString(),
      funds_withdrawn_at: new Date(200_000).toISOString(),
    });
    // Only the created event notifies.
    expect(queued.calls).toHaveLength(2);
  });

  it("duplicate created delivery does not duplicate the notification", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });
    const event = disputeEvent({ account: A });

    await handleChargeDisputeEvent({ supabase, event });
    await handleChargeDisputeEvent({ supabase, event });

    expect(fake.rows("payment_disputes")).toHaveLength(1);
    const keys = queued.calls.map((call) => call.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    expect(queued.keys.size).toBe(2);
  });

  it("stored owner wins after a reconnect: studio comes from the persisted row", async () => {
    const { fake, supabase } = db({
      studios: [
        { id: "studio-1", name: "Studio One", stripe_connected_account_id: "acct_newB" },
        { id: "studio-2", name: "Studio Two", stripe_connected_account_id: null },
      ],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({ studio_id: "studio-1", stripe_account_id: A });
  });

  it("rows owned by another account are never linked; legacy NULL rows only within the studio", async () => {
    const { fake, supabase } = db({
      studios: [
        { id: "studio-1", name: "Studio One", stripe_connected_account_id: A },
        { id: "studio-2", name: "Studio Two", stripe_connected_account_id: C },
      ],
      payments: [
        { id: "pay-other", studio_id: "studio-2", stripe_charge_id: "ch_1", stripe_account_id: C },
        { id: "pay-legacy-other", studio_id: "studio-2", stripe_payment_intent_id: "pi_1", stripe_account_id: null },
      ],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({ studio_id: "studio-1", payment_id: null, event_payment_id: null });
    expect(fake.rows("payments").find((row) => row.id === "pay-legacy-other")?.stripe_account_id).toBeNull();
  });

  it("legacy NULL-owner row in the account's own studio is linked but not stamped", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-legacy", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: null }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({ studio_id: "studio-1", payment_id: "pay-legacy" });
    expect(fake.rows("payments")[0].stripe_account_id).toBeNull();
  });

  it("an existing dispute cannot be re-pointed to another account (zero writes)", async () => {
    const { fake, supabase } = db({
      studios: [
        { id: "studio-1", name: "Studio One", stripe_connected_account_id: A },
        { id: "studio-2", name: "Studio Two", stripe_connected_account_id: C },
      ],
      payment_disputes: [
        {
          id: "pd-1",
          studio_id: "studio-1",
          stripe_scope: "connect",
          stripe_account_id: A,
          stripe_dispute_id: "du_1",
          last_stripe_event_created_at: new Date(1_000).toISOString(),
        },
      ],
    });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: C }) })).rejects.toThrow(
      "dispute_account_mismatch",
    );
    expect(fake.mutations).toHaveLength(0);
    expect(queued.calls).toHaveLength(0);
  });

  it("unmapped account (no owner row, no studio) -> dispute_unmapped, zero writes", async () => {
    const { fake, supabase } = db({ studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: "acct_x" }] });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) })).rejects.toThrow(
      "dispute_unmapped",
    );
    expect(fake.mutations).toHaveLength(0);
    expect(queued.calls).toHaveLength(0);
  });
});

describe("platform-scoped disputes (D4)", () => {
  it("exact payments match (NULL owner) -> recorded for that studio, platform scope, notified", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-hist", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: null }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({}) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({
      studio_id: "studio-1",
      stripe_scope: "platform",
      stripe_account_id: null,
      payment_id: "pay-hist",
    });
    expect(queued.calls).toHaveLength(2);
  });

  it("exact event_payments match -> studio from events.studio_id, event_payment_id linked, notified", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-2", name: "Studio Two" }],
      events: [{ id: "event-2", studio_id: "studio-2" }],
      event_payments: [{ id: "ep-hist", event_id: "event-2", stripe_payment_intent_id: "pi_1", stripe_account_id: null }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ dispute: { charge: null } }) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({
      studio_id: "studio-2",
      stripe_scope: "platform",
      event_payment_id: "ep-hist",
    });
    expect(queued.calls.map((call) => call.recipientEmail)).toEqual(["owner@studio-two.test"]);
  });

  it("several cart rows of one studio -> recorded for the studio with no link", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-2", name: "Studio Two" }],
      events: [{ id: "event-2", studio_id: "studio-2" }],
      event_payments: [
        { id: "ep-a", event_id: "event-2", stripe_payment_intent_id: "pi_1", stripe_account_id: null },
        { id: "ep-b", event_id: "event-2", stripe_payment_intent_id: "pi_1", stripe_account_id: null },
      ],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({}) });

    expect(fake.rows("payment_disputes")[0]).toMatchObject({ studio_id: "studio-2", payment_id: null, event_payment_id: null });
  });

  it("no exact match -> platform_dispute_unmapped; never consults studios or metadata", async () => {
    const { fake, supabase } = db({
      // A studio whose account/metadata would "match" if the platform path guessed.
      studios: [{ id: "studio-2", name: "Studio Two", stripe_connected_account_id: A }],
    });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({}) })).rejects.toThrow(
      "platform_dispute_unmapped",
    );
    expect(fake.mutations).toHaveLength(0);
    expect(fake.fromCalls).not.toContain("studios");
    expect(queued.calls).toHaveLength(0);
  });

  it("matches in two studios -> platform_dispute_ambiguous, zero writes", async () => {
    const { fake, supabase } = db({
      events: [{ id: "event-2", studio_id: "studio-2" }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: null }],
      event_payments: [{ id: "ep-2", event_id: "event-2", stripe_payment_intent_id: "pi_1", stripe_account_id: null }],
    });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({}) })).rejects.toThrow(
      "platform_dispute_ambiguous",
    );
    expect(fake.mutations).toHaveLength(0);
  });

  it("matched row with a connected owner -> platform_dispute_ambiguous, zero writes", async () => {
    const { fake, supabase } = db({
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({}) })).rejects.toThrow(
      "platform_dispute_ambiguous",
    );
    expect(fake.mutations).toHaveLength(0);
    expect(fake.fromCalls).not.toContain("studios");
  });

  it("a platform dispute cannot later be re-pointed to a connected scope", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
      payment_disputes: [
        {
          id: "pd-1",
          studio_id: "studio-1",
          stripe_scope: "platform",
          stripe_account_id: null,
          stripe_dispute_id: "du_1",
          last_stripe_event_created_at: new Date(1_000).toISOString(),
        },
      ],
    });

    await expect(handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) })).rejects.toThrow(
      "dispute_account_mismatch",
    );
    expect(fake.mutations).toHaveLength(0);
  });
});

describe("data minimization", () => {
  it("persists only scalar dispute facts: no evidence, metadata or cardholder data", async () => {
    const { fake, supabase } = db({
      studios: [{ id: "studio-1", name: "Studio One", stripe_connected_account_id: A }],
      payments: [{ id: "pay-1", studio_id: "studio-1", stripe_charge_id: "ch_1", stripe_account_id: A }],
    });

    await handleChargeDisputeEvent({ supabase, event: disputeEvent({ account: A }) });

    const [row] = fake.rows("payment_disputes");
    expect(Object.keys(row).sort()).toEqual(
      [
        "amount_cents",
        "closed_at",
        "currency",
        "event_payment_id",
        "evidence_due_by",
        "funds_reinstated_at",
        "funds_withdrawn_at",
        "id",
        "last_stripe_event_created_at",
        "last_stripe_event_id",
        "last_stripe_event_type",
        "payment_id",
        "reason",
        "status",
        "stripe_account_id",
        "stripe_charge_id",
        "stripe_dispute_id",
        "stripe_payment_intent_id",
        "stripe_scope",
        "studio_id",
      ].sort(),
    );
    const serialized = JSON.stringify(row) + JSON.stringify(queued.calls);
    expect(serialized).not.toMatch(/cardholder@example\.test|Card Holder|1 Private Lane/);
  });

  it("the webhook routes every dispute lifecycle event to the handler", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(join(process.cwd(), "src", "app", "api", "payments", "webhook", "route.ts"), "utf8");
    for (const type of [
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated",
    ]) {
      expect(route).toContain(`case "${type}":`);
    }
    expect(route).toContain("await handleChargeDisputeEvent({ supabase, event });");
  });

  it("ignores non-dispute events", async () => {
    const { fake, supabase } = db({});
    const event = { ...disputeEvent({}), type: "charge.succeeded" } as Stripe.Event;
    await expect(handleChargeDisputeEvent({ supabase, event })).resolves.toBe(false);
    expect(fake.fromCalls).toHaveLength(0);
  });
});
