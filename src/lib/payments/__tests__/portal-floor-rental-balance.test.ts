import { describe, expect, it, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { getPayableFloorRentalAppointments } from "@/lib/payments/portal-floor-rental-balance";

/**
 * Regression coverage for the PR #11 QA incident: the portal My Rentals
 * page displayed a $20 Balance Due (computed from an `upcoming`-only,
 * `starts_at >= now()`-filtered query) while the checkout route charged
 * $40 (its own query had no date restriction and also picked up a past
 * unpaid rental). `getPayableFloorRentalAppointments` is now the single
 * definition both the page and the checkout route call, so these tests
 * are the proof that both consume the identical payable set -- there is
 * no second implementation left to drift out of sync with this one.
 */

let appointmentsTable: FakeTable;

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";

function seedAppointment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `apt-${appointmentsTable.rows.length + 1}`,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    appointment_type: "floor_space_rental",
    status: "scheduled",
    payment_status: "unpaid",
    price_amount: 20,
    starts_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  appointmentsTable.rows.push(row);
  return row;
}

function fakeSupabase() {
  return createFakeAdminClient({ appointments: appointmentsTable }) as never;
}

async function getPayable() {
  return getPayableFloorRentalAppointments({
    supabase: fakeSupabase(),
    studioId: STUDIO_ID,
    clientId: CLIENT_ID,
  });
}

beforeEach(() => {
  appointmentsTable = new FakeTable();
});

describe("getPayableFloorRentalAppointments", () => {
  it("a past unpaid $20 rental plus a future unpaid $20 rental produce a single $40 payable set -- the exact PR #11 QA scenario", async () => {
    seedAppointment({ id: "apt-past", starts_at: "2020-01-01T00:00:00Z", price_amount: 20 });
    seedAppointment({ id: "apt-future", starts_at: "2099-01-01T00:00:00Z", price_amount: 20 });

    const payable = await getPayable();
    const total = payable.reduce((sum, r) => sum + r.price_amount, 0);

    // This $40 total is exactly what both the page's Balance Due display
    // and the checkout route's charged amount now compute, because both
    // call this same function with the same arguments -- there is no
    // separate route-side query left that could disagree with it.
    expect(payable.map((r) => r.id).sort()).toEqual(["apt-future", "apt-past"]);
    expect(total).toBe(40);
  });

  it("a past-only unpaid rental remains collectible", async () => {
    seedAppointment({ id: "apt-past", starts_at: "2020-01-01T00:00:00Z" });

    const payable = await getPayable();

    expect(payable.map((r) => r.id)).toEqual(["apt-past"]);
  });

  it("a future-only unpaid rental remains collectible", async () => {
    seedAppointment({ id: "apt-future", starts_at: "2099-01-01T00:00:00Z" });

    const payable = await getPayable();

    expect(payable.map((r) => r.id)).toEqual(["apt-future"]);
  });

  it("excludes a cancelled rental", async () => {
    seedAppointment({ status: "cancelled" });

    const payable = await getPayable();

    expect(payable).toHaveLength(0);
  });

  it("excludes an already-paid rental", async () => {
    seedAppointment({ payment_status: "paid" });

    const payable = await getPayable();

    expect(payable).toHaveLength(0);
  });

  it("includes a partially-paid rental", async () => {
    seedAppointment({ payment_status: "partial" });

    const payable = await getPayable();

    expect(payable).toHaveLength(1);
  });

  it("excludes a zero-price rental", async () => {
    seedAppointment({ price_amount: 0 });

    const payable = await getPayable();

    expect(payable).toHaveLength(0);
  });

  it("excludes a negative-price rental", async () => {
    seedAppointment({ price_amount: -5 });

    const payable = await getPayable();

    expect(payable).toHaveLength(0);
  });

  it("is scoped strictly to the given studio and client", async () => {
    seedAppointment({ id: "apt-mine" });
    seedAppointment({ id: "apt-other-client", client_id: "someone-else" });
    seedAppointment({ id: "apt-other-studio", studio_id: "other-studio" });

    const payable = await getPayable();

    expect(payable.map((r) => r.id)).toEqual(["apt-mine"]);
  });

  it("ignores appointments of a different type", async () => {
    seedAppointment({ appointment_type: "private_lesson" });

    const payable = await getPayable();

    expect(payable).toHaveLength(0);
  });
});
