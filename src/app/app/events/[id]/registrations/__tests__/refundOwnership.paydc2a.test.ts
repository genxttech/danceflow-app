import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOwnershipFakeSupabase,
  createStripeRecorder,
  stripeError,
  type Row,
} from "@/lib/payments/__tests__/ownershipFakes";

/**
 * PAY-DC-2A: event registration refunds use the stored immutable owner (from
 * event_payments or payments); the event studio's current account is only a D1(b)
 * proof candidate. Also proves a successful refund redirects to success.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const REGISTRATION_ID = "reg-1";
const A = "acct_storedA";
const B = "acct_currentB";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
let recorder: ReturnType<typeof createStripeRecorder>;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...db.client,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }));
// PAY-DC-2D: the owner stamp uses the service role; same fake store.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: STUDIO_ID,
    studioRole: "studio_owner",
    isPlatformAdmin: false,
  }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => recorder.stripe }));

const { refundEventRegistrationAction } = await import("../actions");

function seed(options: {
  studioAccount?: string | null;
  eventPayments?: Row[];
  payments?: Row[];
}) {
  db = createOwnershipFakeSupabase({
    events: [
      {
        id: EVENT_ID,
        event_type: "social",
        studio_id: STUDIO_ID,
        studios: { stripe_connected_account_id: options.studioAccount === undefined ? B : options.studioAccount },
      },
    ],
    event_registrations: [
      {
        id: REGISTRATION_ID,
        event_id: EVENT_ID,
        total_amount: 40,
        total_price: 40,
        currency: "USD",
        status: "confirmed",
        payment_status: "paid",
        stripe_payment_intent_id: "pi_evt",
      },
    ],
    event_payments: options.eventPayments ?? [
      {
        id: "ep-1",
        registration_id: REGISTRATION_ID,
        amount: 40,
        status: "paid",
        stripe_payment_intent_id: "pi_evt",
        stripe_account_id: null,
      },
    ],
    payments: options.payments ?? [],
    attendance_records: [],
  });
}

async function refund() {
  const form = new FormData();
  form.set("eventId", EVENT_ID);
  form.set("registrationId", REGISTRATION_ID);
  try {
    await refundEventRegistrationAction(form);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? "";
  }
  throw new Error("expected a redirect");
}

function registrationRow() {
  return db.rows("event_registrations")[0];
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stored owner is authoritative", () => {
  it("stored A (event_payments) + studio currently B -> refund only on A and success redirect", async () => {
    seed({
      studioAccount: B,
      eventPayments: [
        { id: "ep-1", registration_id: REGISTRATION_ID, amount: 40, status: "paid", stripe_payment_intent_id: "pi_evt", stripe_account_id: A },
      ],
    });
    recorder = createStripeRecorder({ objectAccounts: { pi_evt: A } });

    const url = await refund();

    expect(url).toBe(`/app/events/${EVENT_ID}/registrations?success=registration_refunded`);
    expect(recorder.calls.map((call) => call.method)).toEqual(["refunds.create"]);
    expect(recorder.accountsUsed()).toEqual([A]);
    expect(recorder.accountsUsed()).not.toContain(B);
    expect(registrationRow()).toMatchObject({ payment_status: "refunded", status: "cancelled" });
  });

  it("a single terminal-ticket owner stored only on payments is authoritative", async () => {
    seed({
      studioAccount: B,
      payments: [{ id: "pay-t", studio_id: STUDIO_ID, stripe_payment_intent_id: "pi_evt", stripe_account_id: A }],
    });
    recorder = createStripeRecorder({ objectAccounts: { pi_evt: A } });

    const url = await refund();

    expect(url).toContain("success=registration_refunded");
    expect(recorder.accountsUsed()).toEqual([A]);
  });

  it("two conflicting stored owners -> zero Stripe calls, mismatch", async () => {
    seed({
      eventPayments: [
        { id: "ep-1", registration_id: REGISTRATION_ID, amount: 40, status: "paid", stripe_payment_intent_id: "pi_evt", stripe_account_id: A },
      ],
      payments: [{ id: "pay-t", studio_id: STUDIO_ID, stripe_payment_intent_id: "pi_evt", stripe_account_id: "acct_conflictC" }],
    });
    recorder = createStripeRecorder();

    const url = await refund();

    expect(url).toContain("error=refund_payment_account_mismatch");
    expect(recorder.calls).toHaveLength(0);
    expect(registrationRow()).toMatchObject({ payment_status: "paid", status: "confirmed" });
  });

  it("Stripe rejects stored A -> fails closed, registration/payment/attendance unchanged", async () => {
    seed({
      eventPayments: [
        { id: "ep-1", registration_id: REGISTRATION_ID, amount: 40, status: "paid", stripe_payment_intent_id: "pi_evt", stripe_account_id: A },
      ],
    });
    recorder = createStripeRecorder({ refundError: stripeError({ code: "account_invalid", statusCode: 400 }) });

    const url = await refund();

    expect(url).toContain("error=refund_payment_account_unavailable");
    expect(recorder.accountsUsed()).toEqual([A]);
    expect(db.mutations).toHaveLength(0);
  });
});

describe("historical NULL owner (D1(b))", () => {
  it("NULL + studio currently B -> retrieve B, persist B on event_payments, refund B", async () => {
    seed({ studioAccount: B });
    recorder = createStripeRecorder({ objectAccounts: { pi_evt: B } });

    const url = await refund();

    expect(url).toContain("success=registration_refunded");
    expect(recorder.calls.map((call) => call.method)).toEqual(["paymentIntents.retrieve", "refunds.create"]);
    expect(recorder.accountsUsed()).toEqual([B, B]);
    expect(db.rows("event_payments")[0].stripe_account_id).toBe(B);
  });

  it("NULL, not found on B -> no refund", async () => {
    seed({ studioAccount: B });
    recorder = createStripeRecorder({ objectAccounts: { pi_evt: "acct_platformOrOther" } });

    const url = await refund();

    expect(url).toContain("error=refund_payment_account_unverified");
    expect(recorder.calls.some((call) => call.method === "refunds.create")).toBe(false);
    expect(db.mutations).toHaveLength(0);
  });

  it("NULL, no current studio account -> zero Stripe calls", async () => {
    seed({ studioAccount: null });
    recorder = createStripeRecorder();

    const url = await refund();

    expect(url).toContain("error=refund_stripe_not_connected");
    expect(recorder.calls).toHaveLength(0);
  });
});
