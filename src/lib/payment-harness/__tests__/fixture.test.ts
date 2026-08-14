import { describe, expect, it, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { establishPaymentHarnessFloorRentalFixture } from "@/lib/payment-harness/fixture";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";
import type { PaymentHarnessConfig } from "@/lib/payment-harness/types";

/**
 * Regression coverage for the Payment Harness fixture establish-or-create
 * logic. Uses the same generic fake Supabase fixture already shared across
 * the payments test suite (src/lib/payments/__tests__/fakeSupabase.ts) --
 * no real database connection, and no parallel reimplementation of either
 * Supabase query semantics or the canonical payable-rental filter (that
 * filter is exercised via the real, unmodified
 * getPayableFloorRentalAppointments, not a test-only stand-in).
 */

const CONFIG: PaymentHarnessConfig = Object.freeze({
  studioId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  environment: "development",
  baseUrl: "https://harness-qa.example.com",
  portalLoginEmail: "harness-qa@example.com",
});

const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";

let appointmentsTable: FakeTable;
let clientsTable: FakeTable;
let paymentsTable: FakeTable;

function fakeAdmin() {
  return createFakeAdminClient({
    appointments: appointmentsTable,
    clients: clientsTable,
    payments: paymentsTable,
  }) as never;
}

beforeEach(() => {
  appointmentsTable = new FakeTable();
  clientsTable = new FakeTable();
  paymentsTable = new FakeTable();
});

function seedValidClient(overrides: Record<string, unknown> = {}) {
  const row = { id: CONFIG.clientId, studio_id: CONFIG.studioId, ...overrides };
  clientsTable.rows.push(row);
  return row;
}

function seedAppointment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `apt-${appointmentsTable.rows.length + 1}`,
    studio_id: CONFIG.studioId,
    client_id: CONFIG.clientId,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    payment_status: "unpaid",
    price_amount: 40,
    starts_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  appointmentsTable.rows.push(row);
  return row;
}

describe("establishPaymentHarnessFloorRentalFixture", () => {
  it("reuses an existing payable rental without inserting a new appointment", async () => {
    seedValidClient();
    const existing = seedAppointment({ price_amount: 40 });

    const result = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    expect(result.reusedExisting).toBe(true);
    expect(result.created).toBe(false);
    expect(result.payableAppointmentIds).toEqual([existing.id]);
    expect(appointmentsTable.rows).toHaveLength(1);
  });

  it("includes every existing payable rental in the expected balance", async () => {
    seedValidClient();
    seedAppointment({ price_amount: 20 });
    seedAppointment({ price_amount: 30 });

    const result = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    expect(result.reusedExisting).toBe(true);
    expect(result.payableAppointmentIds).toHaveLength(2);
    expect(result.expectedBalanceCents).toBe(5000);
  });

  it("creates exactly one appointment when no payable rentals exist", async () => {
    seedValidClient();

    const result = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    expect(result.created).toBe(true);
    expect(result.reusedExisting).toBe(false);
    expect(appointmentsTable.rows).toHaveLength(1);
  });

  it("re-reads the created appointment through the canonical payable helper before reporting success", async () => {
    seedValidClient();

    const result = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    const created = appointmentsTable.rows[0];
    expect(result.payableAppointmentIds).toContain(created.id);
  });

  it("gives the created appointment the correct studio/client/type/payment-state/positive price", async () => {
    seedValidClient();

    await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    const created = appointmentsTable.rows[0];
    expect(created.studio_id).toBe(CONFIG.studioId);
    expect(created.client_id).toBe(CONFIG.clientId);
    expect(created.appointment_type).toBe("floor_space_rental");
    expect(created.status).not.toBe("cancelled");
    expect(created.payment_status).not.toBe("paid");
    expect(Number(created.price_amount)).toBeGreaterThan(0);
  });

  it("fails closed before any write when the configured client belongs to a different studio", async () => {
    seedValidClient({ studio_id: OTHER_STUDIO_ID });

    await expect(establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG)).rejects.toThrow(
      PaymentHarnessSafetyError,
    );
    expect(appointmentsTable.rows).toHaveLength(0);

    try {
      await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
      throw new Error("expected establishPaymentHarnessFloorRentalFixture to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("STUDIO_MISMATCH");
    }
  });

  it("fails closed before any write when the configured client does not exist", async () => {
    // clientsTable deliberately left empty.
    await expect(establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG)).rejects.toThrow(
      PaymentHarnessSafetyError,
    );
    expect(appointmentsTable.rows).toHaveLength(0);

    try {
      await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
      throw new Error("expected establishPaymentHarnessFloorRentalFixture to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CLIENT_MISMATCH");
    }
  });

  it("fails closed before any write when the configured environment is not allowed", async () => {
    seedValidClient();
    const tamperedConfig = { ...CONFIG, environment: "production" } as unknown as PaymentHarnessConfig;

    await expect(establishPaymentHarnessFloorRentalFixture(fakeAdmin(), tamperedConfig)).rejects.toThrow(
      PaymentHarnessSafetyError,
    );
    expect(appointmentsTable.rows).toHaveLength(0);
  });

  it("does not treat cancelled/paid/zero-price rentals as payable, since the canonical helper excludes them", async () => {
    seedValidClient();
    const cancelled = seedAppointment({ status: "cancelled" });
    const paid = seedAppointment({ payment_status: "paid" });
    const zeroPrice = seedAppointment({ price_amount: 0 });

    const result = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    expect(result.created).toBe(true);
    expect(result.payableAppointmentIds).not.toContain(cancelled.id);
    expect(result.payableAppointmentIds).not.toContain(paid.id);
    expect(result.payableAppointmentIds).not.toContain(zeroPrice.id);
  });

  it("never creates a payment row, on either the reuse or create path", async () => {
    seedValidClient();
    seedAppointment({ price_amount: 40 });

    await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
    expect(paymentsTable.rows).toHaveLength(0);

    appointmentsTable = new FakeTable();
    seedValidClient();
    await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
    expect(paymentsTable.rows).toHaveLength(0);
  });

  it("never modifies or deletes an existing appointment", async () => {
    seedValidClient();
    const preExisting = seedAppointment({ status: "cancelled", price_amount: 15 });
    const snapshotBefore = { ...preExisting };

    await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);

    expect(appointmentsTable.rows.find((row) => row.id === preExisting.id)).toEqual(snapshotBefore);
    expect(appointmentsTable.rows).toHaveLength(2);
  });

  it("reports created record refs that identify only harness-created records", async () => {
    seedValidClient();
    const preExisting = seedAppointment({ status: "cancelled" });

    const created = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
    const createdAppointmentId = appointmentsTable.rows.find((row) => row.id !== preExisting.id)!.id;

    expect(created.createdRecordRefs).toEqual({ appointments: [createdAppointmentId] });
    expect(created.createdRecordRefs.appointments).not.toContain(preExisting.id);

    appointmentsTable = new FakeTable();
    seedValidClient();
    seedAppointment({ price_amount: 40 });
    const reused = await establishPaymentHarnessFloorRentalFixture(fakeAdmin(), CONFIG);
    expect(reused.createdRecordRefs).toEqual({});
  });
});
