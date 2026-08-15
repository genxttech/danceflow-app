import { describe, expect, it } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import {
  captureFloorRentalRedeliveryBaseline,
  captureFloorRentalRedeliverySnapshot,
  compareFloorRentalRedeliverySnapshots,
  resolveFloorRentalRedeliveryCheckResult,
} from "@/lib/payment-harness/redeliverySnapshot";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";
import type {
  PaymentHarnessConfig,
  PaymentHarnessRedeliveryAppointmentSnapshotEntry,
  PaymentHarnessRedeliveryBaselineSnapshot,
  PaymentHarnessRedeliveryPaymentSnapshotEntry,
  PaymentHarnessRedeliverySnapshot,
} from "@/lib/payment-harness/types";

/**
 * Regression coverage for the Payment Harness Slice 6 redelivery-
 * idempotency verifier (redeliverySnapshot.ts). No real Stripe account or
 * network access is required for any test in this file -- DB access goes
 * through the same FakeTable/createFakeAdminClient fixture already shared
 * across the payments test suite, the same fixture browser.test.ts uses.
 * This module never calls Stripe at all, so there's no Stripe fake to
 * inject either.
 */

const CONFIG: PaymentHarnessConfig = Object.freeze({
  studioId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  environment: "development",
  baseUrl: "https://harness-qa.example.com",
  portalLoginEmail: "harness-qa@example.com",
});

const CHECKOUT_SESSION_ID = "cs_test_redelivery_abc123";
const PAYMENT_ID = "pay-redelivery-1";

function freshTables() {
  return {
    paymentsTable: new FakeTable(),
    appointmentsTable: new FakeTable(),
  };
}

function fakeAdmin(tables: { paymentsTable: FakeTable; appointmentsTable: FakeTable }) {
  return createFakeAdminClient({
    payments: tables.paymentsTable,
    appointments: tables.appointmentsTable,
  }) as never;
}

function seedPaidPayment(paymentsTable: FakeTable, overrides: Record<string, unknown> = {}) {
  const row = {
    id: PAYMENT_ID,
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    source: "floor_rental",
    status: "paid",
    amount: 25,
    stripe_checkout_session_id: CHECKOUT_SESSION_ID,
    stripe_payment_intent_id: "pi_test_redelivery_1",
    paid_at: "2026-08-14T16:05:00.000Z",
    ...overrides,
  };
  paymentsTable.rows.push(row);
  return row;
}

function seedAppointment(appointmentsTable: FakeTable, overrides: Record<string, unknown> = {}) {
  const row = {
    id: `apt-${appointmentsTable.rows.length + 1}`,
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    payment_status: "paid",
    ...overrides,
  };
  appointmentsTable.rows.push(row);
  return row;
}

/** A minimal always-erroring `.from(table).select(...).eq(...)` chain, for
 * simulating a genuine DB lookup failure -- same pattern browser.test.ts
 * uses. */
function fakeAdminWithFailingTable(failingTable: "payments" | "appointments") {
  const base = fakeAdmin(freshTables()) as { from: (table: string) => unknown };
  return {
    from(table: string) {
      if (table !== failingTable) {
        return base.from(table);
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: { data: null; error: { message: string } }) => void) =>
          resolve({ data: null, error: { message: "simulated raw postgrest failure detail xyz" } }),
      };
      return chain;
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Snapshot fixtures -- hand-constructed, not run through capture, so
// comparison/resolve tests never need a DB fake.
// ---------------------------------------------------------------------------

function baselinePaymentEntry(
  overrides: Partial<PaymentHarnessRedeliveryPaymentSnapshotEntry> = {},
): PaymentHarnessRedeliveryPaymentSnapshotEntry {
  return {
    paymentId: PAYMENT_ID,
    relatedPaymentRowCount: 1,
    status: "paid",
    amount: 25,
    stripeCheckoutSessionId: CHECKOUT_SESSION_ID,
    stripePaymentIntentId: "pi_test_redelivery_1",
    paidAt: "2026-08-14T16:05:00.000Z",
    ...overrides,
  };
}

const BASELINE_APPOINTMENTS: readonly PaymentHarnessRedeliveryAppointmentSnapshotEntry[] = [
  { id: "apt-1", status: "scheduled", paymentStatus: "paid" },
  { id: "apt-2", status: "cancelled", paymentStatus: "unpaid" },
  { id: "apt-3", status: "voided", paymentStatus: "unpaid" },
];

/** A `PaymentHarnessRedeliveryBaselineSnapshot` -- payment is always
 * present, matching what `captureFloorRentalRedeliveryBaseline` would
 * itself have validated and returned. */
function validBaseline(
  overrides: {
    payment?: Partial<PaymentHarnessRedeliveryPaymentSnapshotEntry>;
    appointments?: readonly PaymentHarnessRedeliveryAppointmentSnapshotEntry[];
  } = {},
): PaymentHarnessRedeliveryBaselineSnapshot {
  return {
    payment: baselinePaymentEntry(overrides.payment ?? {}),
    appointments: overrides.appointments ?? BASELINE_APPOINTMENTS,
    capturedAt: "2026-08-14T16:05:01.000Z",
  };
}

/** A plain `PaymentHarnessRedeliverySnapshot` -- `payment` may legitimately
 * be `null` here (the "after" read is allowed to observe the payment has
 * disappeared). Pass `payment: null` explicitly to represent that. */
function afterState(
  overrides: {
    payment?: Partial<PaymentHarnessRedeliveryPaymentSnapshotEntry> | null;
    appointments?: readonly PaymentHarnessRedeliveryAppointmentSnapshotEntry[];
  } = {},
): PaymentHarnessRedeliverySnapshot {
  const paymentOverride = overrides.payment;
  return {
    payment: paymentOverride === null ? null : baselinePaymentEntry(paymentOverride ?? {}),
    appointments: overrides.appointments ?? BASELINE_APPOINTMENTS,
    capturedAt: "2026-08-14T16:10:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// captureFloorRentalRedeliverySnapshot -- the plain, unvalidated read.
// ---------------------------------------------------------------------------

describe("captureFloorRentalRedeliverySnapshot", () => {
  it("captures the payment and appointment state for the configured transaction", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable);
    seedAppointment(tables.appointmentsTable, { id: "apt-1", status: "scheduled", payment_status: "paid" });
    seedAppointment(tables.appointmentsTable, { id: "apt-2", status: "cancelled", payment_status: "unpaid" });

    const snapshot = await captureFloorRentalRedeliverySnapshot({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    expect(snapshot.payment).toEqual({
      paymentId: PAYMENT_ID,
      relatedPaymentRowCount: 1,
      status: "paid",
      amount: 25,
      stripeCheckoutSessionId: CHECKOUT_SESSION_ID,
      stripePaymentIntentId: "pi_test_redelivery_1",
      paidAt: "2026-08-14T16:05:00.000Z",
    });
    expect(snapshot.appointments).toEqual([
      { id: "apt-1", status: "scheduled", paymentStatus: "paid" },
      { id: "apt-2", status: "cancelled", paymentStatus: "unpaid" },
    ]);
    expect(typeof snapshot.capturedAt).toBe("string");
  });

  it("14. never writes -- only .select() calls are made against either table", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable);
    seedAppointment(tables.appointmentsTable);

    const paymentsBefore = JSON.stringify(tables.paymentsTable.rows);
    const appointmentsBefore = JSON.stringify(tables.appointmentsTable.rows);

    // insert()/update()/delete() on FakeTable mutate .rows directly; a
    // read-only capture must never call any of them, so the row content
    // (not just row count) must be byte-identical before and after.
    await captureFloorRentalRedeliverySnapshot({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    expect(JSON.stringify(tables.paymentsTable.rows)).toBe(paymentsBefore);
    expect(JSON.stringify(tables.appointmentsTable.rows)).toBe(appointmentsBefore);
  });

  it("captures payment: null (not a throw) when the expected payment row cannot be found", async () => {
    const tables = freshTables();
    // A row exists for the session but under a different id -- simulates
    // "the expected payment row is gone" without an empty table.
    seedPaidPayment(tables.paymentsTable, { id: "some-other-payment-id" });

    const snapshot = await captureFloorRentalRedeliverySnapshot({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    expect(snapshot.payment).toBeNull();
  });

  it("15. a payments-table DB failure fails closed with a sanitized error (no raw Supabase message)", async () => {
    try {
      await captureFloorRentalRedeliverySnapshot({
        adminSupabase: fakeAdminWithFailingTable("payments"),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentHarnessSafetyError);
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_PAYMENT_LOOKUP_FAILED");
      expect((error as Error).message).not.toContain("simulated raw postgrest failure detail xyz");
    }
  });

  it("15. an appointments-table DB failure fails closed with a sanitized error (no raw Supabase message)", async () => {
    try {
      await captureFloorRentalRedeliverySnapshot({
        adminSupabase: fakeAdminWithFailingTable("appointments"),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentHarnessSafetyError);
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_APPOINTMENTS_LOOKUP_FAILED");
      expect((error as Error).message).not.toContain("simulated raw postgrest failure detail xyz");
    }
  });

  it("rejects a disallowed environment even before any DB call", async () => {
    const tables = freshTables();
    await expect(
      captureFloorRentalRedeliverySnapshot({
        adminSupabase: fakeAdmin(tables),
        config: { ...CONFIG, environment: "production" as never },
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      }),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });
});

// ---------------------------------------------------------------------------
// captureFloorRentalRedeliveryBaseline -- the validated baseline capture.
// ---------------------------------------------------------------------------

describe("captureFloorRentalRedeliveryBaseline", () => {
  it("1. a missing expected payment fails closed with REDELIVERY_BASELINE_PAYMENT_MISSING", async () => {
    const tables = freshTables();
    // No payment row seeded at all.

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentHarnessSafetyError);
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_PAYMENT_MISSING");
    }
  });

  it("2. an unpaid/pending expected payment cannot become a valid baseline", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable, { status: "pending" });

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_NOT_PAID");
    }
  });

  it("3. a missing PaymentIntent id cannot become a valid baseline", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable, { stripe_payment_intent_id: null });

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_PAYMENT_INTENT_MISSING");
    }
  });

  it("a blank (empty-string) PaymentIntent id also cannot become a valid baseline", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable, { stripe_payment_intent_id: "" });

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_PAYMENT_INTENT_MISSING");
    }
  });

  it("4. a valid, already-paid expected payment succeeds and returns a non-null payment snapshot", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable);
    seedAppointment(tables.appointmentsTable, { id: "apt-1", status: "scheduled", payment_status: "paid" });

    const baseline = await captureFloorRentalRedeliveryBaseline({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    // Non-optional at the type level -- if this compiles and the object
    // has a `payment` property at all, TypeScript already proves it's
    // never null for this return type. This assertion just confirms the
    // runtime value matches too.
    expect(baseline.payment.paymentId).toBe(PAYMENT_ID);
    expect(baseline.payment.status).toBe("paid");
    expect(baseline.payment.stripePaymentIntentId).toBe("pi_test_redelivery_1");
    expect(baseline.appointments).toEqual([{ id: "apt-1", status: "scheduled", paymentStatus: "paid" }]);
  });

  it("also fails closed if the resolved payment id somehow doesn't match the requested one", async () => {
    const tables = freshTables();
    // A row for a different session/id entirely happens to share nothing
    // in common with the requested payment -- captureFloorRentalRedeliverySnapshot
    // would return payment: null in this case, which the baseline
    // validator turns into REDELIVERY_BASELINE_PAYMENT_MISSING (not a
    // separate id-mismatch code, since the row was never found at all).
    seedPaidPayment(tables.paymentsTable, { id: "unrelated-id", stripe_checkout_session_id: CHECKOUT_SESSION_ID });

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_PAYMENT_MISSING");
    }
  });

  it("fails closed when a caller-supplied expected amount does not match the actual paid amount", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable, { amount: 25 });

    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdmin(tables),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
        expectedAmount: 99,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_BASELINE_AMOUNT_MISMATCH");
    }
  });

  it("never invents an amount -- when expectedAmount is omitted, the actual amount is simply preserved", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable, { amount: 37.5 });

    const baseline = await captureFloorRentalRedeliveryBaseline({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    expect(baseline.payment.amount).toBe(37.5);
  });

  it("never writes -- baseline capture is read-only, same as the underlying snapshot capture", async () => {
    const tables = freshTables();
    seedPaidPayment(tables.paymentsTable);
    seedAppointment(tables.appointmentsTable);

    const paymentsBefore = JSON.stringify(tables.paymentsTable.rows);
    const appointmentsBefore = JSON.stringify(tables.appointmentsTable.rows);

    await captureFloorRentalRedeliveryBaseline({
      adminSupabase: fakeAdmin(tables),
      config: CONFIG,
      paymentId: PAYMENT_ID,
      checkoutSessionId: CHECKOUT_SESSION_ID,
    });

    expect(JSON.stringify(tables.paymentsTable.rows)).toBe(paymentsBefore);
    expect(JSON.stringify(tables.appointmentsTable.rows)).toBe(appointmentsBefore);
  });

  it("a DB failure while establishing a baseline still fails closed with a sanitized error", async () => {
    try {
      await captureFloorRentalRedeliveryBaseline({
        adminSupabase: fakeAdminWithFailingTable("payments"),
        config: CONFIG,
        paymentId: PAYMENT_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_PAYMENT_LOOKUP_FAILED");
      expect((error as Error).message).not.toContain("simulated raw postgrest failure detail xyz");
    }
  });
});

// ---------------------------------------------------------------------------
// compareFloorRentalRedeliverySnapshots
// ---------------------------------------------------------------------------

describe("compareFloorRentalRedeliverySnapshots", () => {
  it("an identical baseline/after snapshot pair compares as unchanged", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState(),
    });

    expect(result.outcome).toBe("unchanged");
    expect(result.mismatches).toEqual([]);
  });

  it("the same payment remaining paid with the same ids/amount passes", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { status: "paid" } }),
    });

    expect(result.outcome).toBe("unchanged");
  });

  it("a second payment row appearing (row count changed) fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { relatedPaymentRowCount: 2 } }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches.map((m) => m.code)).toContain("REDELIVERY_PAYMENT_ROW_COUNT_CHANGED");
  });

  it("5. the expected payment disappearing after a valid baseline fails with REDELIVERY_PAYMENT_MISSING", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: null }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches).toEqual([
      { code: "REDELIVERY_PAYMENT_MISSING", detail: expect.any(String) },
    ]);
  });

  it("a payment status change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { status: "voided" } }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches.map((m) => m.code)).toContain("REDELIVERY_PAYMENT_STATUS_CHANGED");
  });

  it("an amount change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { amount: 99 } }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches.map((m) => m.code)).toContain("REDELIVERY_PAYMENT_AMOUNT_CHANGED");
  });

  it("a Checkout Session change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { stripeCheckoutSessionId: "cs_test_totally_different" } }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches.map((m) => m.code)).toContain("REDELIVERY_CHECKOUT_SESSION_CHANGED");
  });

  it("a PaymentIntent change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { stripePaymentIntentId: "pi_test_different" } }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches.map((m) => m.code)).toContain("REDELIVERY_PAYMENT_INTENT_CHANGED");
  });

  it("an appointment disappearing fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ appointments: BASELINE_APPOINTMENTS.filter((a) => a.id !== "apt-2") }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ code: "REDELIVERY_APPOINTMENT_MISSING" }),
    );
  });

  it("an unexpected appointment appearing fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({
        appointments: [...BASELINE_APPOINTMENTS, { id: "apt-new", status: "scheduled", paymentStatus: "unpaid" }],
      }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ code: "REDELIVERY_UNEXPECTED_APPOINTMENT" }),
    );
  });

  it("an appointment status change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({
        appointments: BASELINE_APPOINTMENTS.map((a) => (a.id === "apt-1" ? { ...a, status: "cancelled" } : a)),
      }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ code: "REDELIVERY_APPOINTMENT_CHANGED" }),
    );
  });

  it("an appointment payment_status change fails", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({
        appointments: BASELINE_APPOINTMENTS.map((a) => (a.id === "apt-1" ? { ...a, paymentStatus: "unpaid" } : a)),
      }),
    });

    expect(result.outcome).toBe("changed");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({ code: "REDELIVERY_APPOINTMENT_CHANGED" }),
    );
  });

  it("historical paid/voided appointments that stay unchanged pass -- not treated as contamination", () => {
    // apt-2 is cancelled/unpaid and apt-3 is voided/unpaid in the baseline
    // fixture already -- legitimate pre-existing history, not part of any
    // "payable set" concept. As long as they don't change, this passes.
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState(),
    });

    expect(result.outcome).toBe("unchanged");
  });

  it("throws REDELIVERY_MALFORMED_BASELINE as defense-in-depth if a payment-less baseline ever reaches comparison", () => {
    // Not reachable through normal, type-checked usage -- only
    // captureFloorRentalRedeliveryBaseline can produce a
    // PaymentHarnessRedeliveryBaselineSnapshot, and it always has a
    // non-null payment. This simulates a caller bypassing the type system
    // (e.g. `as` from untyped data) to confirm the runtime guard still
    // fires as a second line of defense.
    const malformedBaseline = {
      payment: null,
      appointments: BASELINE_APPOINTMENTS,
      capturedAt: "2026-08-14T16:05:01.000Z",
    } as unknown as PaymentHarnessRedeliveryBaselineSnapshot;

    expect(() =>
      compareFloorRentalRedeliverySnapshots({ baseline: malformedBaseline, after: afterState() }),
    ).toThrow(PaymentHarnessSafetyError);
    try {
      compareFloorRentalRedeliverySnapshots({ baseline: malformedBaseline, after: afterState() });
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("REDELIVERY_MALFORMED_BASELINE");
    }
  });

  it("reports every mismatch found, not just the first", () => {
    const result = compareFloorRentalRedeliverySnapshots({
      baseline: validBaseline(),
      after: afterState({ payment: { status: "voided", amount: 99 } }),
    });

    const codes = result.mismatches.map((m) => m.code);
    expect(codes).toContain("REDELIVERY_PAYMENT_STATUS_CHANGED");
    expect(codes).toContain("REDELIVERY_PAYMENT_AMOUNT_CHANGED");
  });
});

// ---------------------------------------------------------------------------
// resolveFloorRentalRedeliveryCheckResult
// ---------------------------------------------------------------------------

describe("resolveFloorRentalRedeliveryCheckResult", () => {
  const unchanged = compareFloorRentalRedeliverySnapshots({
    baseline: validBaseline(),
    after: afterState(),
  });
  const changed = compareFloorRentalRedeliverySnapshots({
    baseline: validBaseline(),
    after: afterState({ payment: { status: "voided" } }),
  });
  const missingAfter = compareFloorRentalRedeliverySnapshots({
    baseline: validBaseline(),
    after: afterState({ payment: null }),
  });

  it("7. a confirmed trigger with a valid, unchanged baseline/after pair -> passed", () => {
    const outcome = resolveFloorRentalRedeliveryCheckResult({
      triggerStatus: "confirmed",
      comparison: unchanged,
    });

    expect(outcome.result).toBe("passed");
    expect(outcome.checkpoint.status).toBe("passed");
  });

  it("a confirmed trigger with a state mutation -> failed", () => {
    const outcome = resolveFloorRentalRedeliveryCheckResult({
      triggerStatus: "confirmed",
      comparison: changed,
    });

    expect(outcome.result).toBe("failed");
    expect(outcome.checkpoint.status).toBe("failed");
  });

  it("6. a confirmed trigger where the payment went missing can never resolve to passed", () => {
    const outcome = resolveFloorRentalRedeliveryCheckResult({
      triggerStatus: "confirmed",
      comparison: missingAfter,
    });

    expect(outcome.result).not.toBe("passed");
    expect(outcome.result).toBe("failed");
  });

  it("8. no trigger available -> not_available, never passed, even for an otherwise-unchanged comparison", () => {
    const outcome = resolveFloorRentalRedeliveryCheckResult({
      triggerStatus: "not_available",
      comparison: unchanged,
    });

    expect(outcome.result).toBe("not_available");
    expect(outcome.result).not.toBe("passed");
  });

  it("8. a trigger that could not be verified -> not_verified, never passed, even for an otherwise-unchanged comparison", () => {
    const outcome = resolveFloorRentalRedeliveryCheckResult({
      triggerStatus: "unverified",
      comparison: unchanged,
    });

    expect(outcome.result).toBe("not_verified");
    expect(outcome.result).not.toBe("passed");
  });

  it("never returns the not_run status -- that value belongs only to the DB column's own pre-call default", () => {
    for (const triggerStatus of ["not_available", "unverified", "confirmed"] as const) {
      const outcome = resolveFloorRentalRedeliveryCheckResult({ triggerStatus, comparison: unchanged });
      expect(outcome.result).not.toBe("not_run");
    }
  });
});
