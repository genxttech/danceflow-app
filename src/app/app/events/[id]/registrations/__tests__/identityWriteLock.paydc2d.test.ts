import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOwnershipFakeSupabase,
  createStripeRecorder,
  type Row,
} from "@/lib/payments/__tests__/ownershipFakes";
import { paydc2dRowGuard } from "@/lib/payments/__tests__/identityWriteLockModel";

/**
 * PAY-DC-2D: event registration mark-paid / refund keep working under the
 * identity write-lock. The staff session writes only non-identity fields; the
 * Stripe identity (copied from the server-written registration, or proven by
 * Stripe) is written with the service role only after the existing role and
 * event/studio checks. Wrong role or wrong studio never reaches that write.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const REGISTRATION_ID = "reg-1";
const B = "acct_studioB";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
let recorder: ReturnType<typeof createStripeRecorder>;
const context = { studioId: STUDIO_ID, studioRole: "studio_owner", isPlatformAdmin: false };

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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.adminClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.adminClient }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ ...context }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => recorder.stripe }));

const { markEventRegistrationPaidAction, refundEventRegistrationAction } = await import("../actions");

function seed(options: { eventStudioId?: string; eventPayments?: Row[] } = {}) {
  db = createOwnershipFakeSupabase(
    {
      events: [
        {
          id: EVENT_ID,
          event_type: "social",
          studio_id: options.eventStudioId ?? STUDIO_ID,
          studios: { stripe_connected_account_id: B },
        },
      ],
      event_registrations: [
        {
          id: REGISTRATION_ID,
          event_id: EVENT_ID,
          total_amount: 40,
          total_price: 40,
          currency: "USD",
          status: "pending",
          payment_status: "pending",
          stripe_payment_intent_id: "pi_evt",
        },
      ],
      event_payments: options.eventPayments ?? [],
      payments: [],
      attendance_records: [],
    },
    { rowGuard: paydc2dRowGuard() },
  );
}

async function run(action: (form: FormData) => Promise<unknown>) {
  const form = new FormData();
  form.set("eventId", EVENT_ID);
  form.set("registrationId", REGISTRATION_ID);
  try {
    await action(form);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? "";
  }
  throw new Error("expected a redirect");
}

function adminMutations() {
  return db.mutations.filter((mutation) => mutation.client === "admin");
}

beforeEach(() => {
  context.studioRole = "studio_owner";
  recorder = createStripeRecorder({ objectAccounts: { pi_evt: B } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Note: markEventRegistrationPaidAction's pre-existing bare `catch {}` swallows
// every redirect (even success) into error=mark_paid_failed; out of PAY-DC-2D
// scope, so these tests assert the persisted writes rather than the URL.
describe("mark paid (logEventPayment)", () => {
  it("succeeds: the staff insert carries no Stripe identity, the service role copies the registration PI", async () => {
    seed();
    await run(markEventRegistrationPaidAction);

    expect(db.rows("event_registrations")[0]).toMatchObject({ payment_status: "paid", status: "confirmed" });
    const [payment] = db.rows("event_payments");
    expect(payment).toMatchObject({ registration_id: REGISTRATION_ID, status: "paid", stripe_payment_intent_id: "pi_evt" });

    const userInsert = db.mutations.find((m) => m.table === "event_payments" && m.op === "insert");
    expect(userInsert?.client).toBe("user");
    expect(userInsert?.values).not.toHaveProperty("stripe_payment_intent_id");
    expect(adminMutations()).toEqual([
      expect.objectContaining({ table: "event_payments", op: "update", values: { stripe_payment_intent_id: "pi_evt" } }),
    ]);
  });

  it("a role without registration-manage permission never reaches the service-role write", async () => {
    seed();
    context.studioRole = "instructor";
    await run(markEventRegistrationPaidAction);

    expect(db.mutations).toHaveLength(0);
  });

  it("an event of another studio never reaches the service-role write", async () => {
    seed({ eventStudioId: "studio-other" });
    const url = await run(markEventRegistrationPaidAction);

    expect(url).toContain("error=mark_paid_failed");
    expect(adminMutations()).toHaveLength(0);
    expect(db.rows("event_payments")).toHaveLength(0);
  });
});

describe("refund", () => {
  it("historical NULL owner: Stripe proof, service-role owner stamp, refund on the proven account", async () => {
    seed({
      eventPayments: [
        { id: "ep-1", registration_id: REGISTRATION_ID, amount: 40, status: "paid", stripe_payment_intent_id: "pi_evt", stripe_account_id: null },
      ],
    });

    const url = await run(refundEventRegistrationAction);

    expect(url).toContain("success=registration_refunded");
    expect(recorder.accountsUsed()).toEqual([B, B]);
    expect(db.rows("event_payments")[0]).toMatchObject({ stripe_account_id: B, status: "refunded" });
    expect(adminMutations().map((m) => m.values)).toEqual([{ stripe_account_id: B }]);
  });

  it("valid stored owner refunds with no service-role write at all", async () => {
    seed({
      eventPayments: [
        { id: "ep-1", registration_id: REGISTRATION_ID, amount: 40, status: "paid", stripe_payment_intent_id: "pi_evt", stripe_account_id: B },
      ],
    });

    const url = await run(refundEventRegistrationAction);

    expect(url).toContain("success=registration_refunded");
    expect(recorder.accountsUsed()).toEqual([B]);
    expect(adminMutations()).toHaveLength(0);
  });

  it("refund with no event payment row logs one via the same split write", async () => {
    seed({ eventPayments: [] });
    recorder = createStripeRecorder({ objectAccounts: { pi_evt: B } });

    const url = await run(refundEventRegistrationAction);

    expect(url).toContain("success=registration_refunded");
    expect(db.rows("event_payments")[0]).toMatchObject({ status: "refunded", stripe_payment_intent_id: "pi_evt" });
  });

  it("unauthorized role -> no Stripe call and no write", async () => {
    seed();
    context.studioRole = "front_desk";
    const url = await run(refundEventRegistrationAction);

    expect(url).toContain("error=event_registration_unauthorized");
    expect(recorder.calls).toHaveLength(0);
    expect(db.mutations).toHaveLength(0);
  });
});
