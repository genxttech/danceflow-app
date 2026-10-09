import { describe, expect, it } from "vitest";
import {
  earningDateFromIso,
  generateInstructorEarningsForCompletedAppointments,
  stageInstructorEarningForAppointment,
  studioLocalRangeBounds,
} from "../earnings";

/**
 * Phase 9E: earning_date is the studio-local business date of the lesson,
 * derived from starts_at with the studio IANA zone -- never the UTC date,
 * the server zone or a browser zone. Only the date changes; amounts do not.
 */

describe("earningDateFromIso", () => {
  it("uses the studio-local date when UTC is already the next day (the spec example)", () => {
    expect(earningDateFromIso("2026-10-10T02:30:00Z", "America/New_York")).toBe("2026-10-09");
  });
  it("keeps the same date for a late-evening-UTC time that is still that day locally", () => {
    expect(earningDateFromIso("2026-10-09T20:00:00Z", "America/New_York")).toBe("2026-10-09");
  });
  it("moves the UTC date forward for a zone ahead of UTC", () => {
    expect(earningDateFromIso("2026-10-09T20:30:00Z", "Pacific/Auckland")).toBe("2026-10-10");
    expect(earningDateFromIso("2026-10-09T16:00:00Z", "Asia/Tokyo")).toBe("2026-10-10");
  });
  it("gives different studios different dates for the same UTC instant", () => {
    const instant = "2026-10-10T02:30:00Z";
    expect(earningDateFromIso(instant, "America/Los_Angeles")).toBe("2026-10-09");
    expect(earningDateFromIso(instant, "America/New_York")).toBe("2026-10-09");
    expect(earningDateFromIso(instant, "Europe/London")).toBe("2026-10-10");
    expect(earningDateFromIso(instant, "Asia/Tokyo")).toBe("2026-10-10");
  });
  it("handles the spring-forward boundary (2026-03-08, New York)", () => {
    expect(earningDateFromIso("2026-03-08T04:59:00Z", "America/New_York")).toBe("2026-03-07");
    expect(earningDateFromIso("2026-03-08T05:00:00Z", "America/New_York")).toBe("2026-03-08");
    expect(earningDateFromIso("2026-03-09T03:59:00Z", "America/New_York")).toBe("2026-03-08");
    expect(earningDateFromIso("2026-03-09T04:00:00Z", "America/New_York")).toBe("2026-03-09");
  });
  it("handles the fall-back boundary (2026-11-01, New York)", () => {
    expect(earningDateFromIso("2026-11-01T03:59:00Z", "America/New_York")).toBe("2026-10-31");
    expect(earningDateFromIso("2026-11-01T04:00:00Z", "America/New_York")).toBe("2026-11-01");
    expect(earningDateFromIso("2026-11-02T04:59:00Z", "America/New_York")).toBe("2026-11-01");
    expect(earningDateFromIso("2026-11-02T05:00:00Z", "America/New_York")).toBe("2026-11-02");
  });
  it("defaults a blank zone to the product default and rejects a bad timestamp", () => {
    expect(earningDateFromIso("2026-10-10T02:30:00Z", "")).toBe("2026-10-09");
    expect(earningDateFromIso("not a date", "America/New_York")).toBeNull();
  });
  it("does not depend on the process (server/browser) time zone", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        expect(earningDateFromIso("2026-10-10T02:30:00Z", "America/New_York")).toBe("2026-10-09");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("studioLocalRangeBounds", () => {
  it("turns local dates into UTC bounds [from, toExclusive)", () => {
    expect(studioLocalRangeBounds("2026-10-09", "2026-10-09", "America/New_York")).toEqual({
      from: "2026-10-09T04:00:00.000Z",
      toExclusive: "2026-10-10T04:00:00.000Z",
    });
  });
  it("spans a DST change with the correct offsets", () => {
    expect(studioLocalRangeBounds("2026-11-01", "2026-11-01", "America/New_York")).toEqual({
      from: "2026-11-01T04:00:00.000Z",
      toExclusive: "2026-11-02T05:00:00.000Z",
    });
    expect(studioLocalRangeBounds("2026-03-08", "2026-03-08", "America/New_York")).toEqual({
      from: "2026-03-08T05:00:00.000Z",
      toExclusive: "2026-03-09T04:00:00.000Z",
    });
  });
  it("leaves open ends open", () => {
    expect(studioLocalRangeBounds(null, null, "America/New_York")).toEqual({ from: null, toExclusive: null });
  });
});

type Rows = Record<string, unknown[]>;

function fakeSupabase(rows: Rows) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const filters: Array<{ table: string; op: string; value: unknown }> = [];
  function builder(table: string) {
    let op = "select";
    let payload: unknown;
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "not", "in", "or", "order", "limit"]) chain[name] = () => chain;
    for (const name of ["gte", "lt", "lte"]) {
      chain[name] = (_column: string, value: unknown) => {
        filters.push({ table, op: name, value });
        return chain;
      };
    }
    chain.update = (value: unknown) => {
      op = "update";
      payload = value;
      return chain;
    };
    chain.insert = async (value: unknown) => {
      writes.push({ table, op: "insert", payload: value });
      return { error: null };
    };
    const result = () => {
      if (table === "attendance_records") return { data: null, count: 4, error: null };
      return { data: rows[table] ?? [], error: null };
    };
    chain.maybeSingle = async () => {
      const { data } = result();
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
    };
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (op === "update") writes.push({ table, op, payload });
      return resolve(result());
    };
    return chain;
  }
  return { writes, filters, client: { from: (table: string) => builder(table) } };
}

const lesson = {
  id: "a1",
  studio_id: "s1",
  instructor_id: "i1",
  client_id: "c1",
  appointment_type: "private_lesson",
  status: "attended",
  starts_at: "2026-10-10T02:30:00Z",
  ends_at: "2026-10-10T03:30:00Z",
  duration_minutes: 60,
  price_amount: 100,
  billing_type: null,
  payment_status: "paid",
};
const percentageRule = {
  id: "r1",
  active: true,
  private_lesson_pay_mode: "percentage",
  private_lesson_flat_amount: 0,
  private_lesson_percentage: 40,
  group_class_pay_mode: "none",
  group_class_flat_amount: 0,
  group_class_percentage: 0,
  group_class_per_attendee_amount: 0,
};

async function stage(timezone: string | null | undefined) {
  const fake = fakeSupabase({
    studios: [{ timezone }],
    appointments: [lesson],
    instructor_compensation_rules: [percentageRule],
    instructor_payroll_profiles: [{ worker_classification: "contractor", payroll_active: true }],
    instructor_earnings: [],
  });
  const result = await stageInstructorEarningForAppointment({ supabase: fake.client as never, studioId: "s1", appointmentId: "a1" });
  return { result, payload: fake.writes[0]?.payload as Record<string, unknown> };
}

describe("staging uses the studio zone and changes only the date", () => {
  it("writes the studio-local earning_date", async () => {
    const { result, payload } = await stage("America/New_York");
    expect(result).toMatchObject({ staged: true, action: "created" });
    expect(payload.earning_date).toBe("2026-10-09");
  });
  it("writes a different date for a studio in another zone, with identical money fields", async () => {
    const ny = (await stage("America/New_York")).payload;
    const tokyo = (await stage("Asia/Tokyo")).payload;
    expect(tokyo.earning_date).toBe("2026-10-10");
    const money = [
      "gross_revenue_basis",
      "pay_mode",
      "pay_rate_amount",
      "pay_percentage",
      "attendance_count",
      "earning_amount",
      "taxable_compensation_amount",
      "reimbursement_amount",
      "deduction_amount",
      "status",
      "worker_classification_snapshot",
      "accounting_category_snapshot",
    ];
    for (const key of money) expect(tokyo[key]).toEqual(ny[key]);
    expect(ny).toMatchObject({ earning_amount: 40, reimbursement_amount: 0, deduction_amount: 0, status: "pending" });
  });
  it("falls back to the product default zone for a studio without one", async () => {
    expect((await stage(null)).payload.earning_date).toBe("2026-10-09");
  });
  it("does not stage when the studio zone cannot be read", async () => {
    const fake = fakeSupabase({ studios: [], appointments: [lesson] });
    const result = await stageInstructorEarningForAppointment({ supabase: fake.client as never, studioId: "s1", appointmentId: "a1" });
    expect(result).toEqual({ staged: false, reason: "studio_timezone_unavailable" });
    expect(fake.writes).toHaveLength(0);
  });
  it("keeps a non-pending earning locked and untouched", async () => {
    const fake = fakeSupabase({
      studios: [{ timezone: "America/New_York" }],
      appointments: [lesson],
      instructor_compensation_rules: [percentageRule],
      instructor_payroll_profiles: [{ worker_classification: "contractor", payroll_active: true }],
      instructor_earnings: [{ id: "e1", status: "approved" }],
    });
    const result = await stageInstructorEarningForAppointment({ supabase: fake.client as never, studioId: "s1", appointmentId: "a1" });
    expect(result).toEqual({ staged: false, reason: "earning_locked" });
    expect(fake.writes).toHaveLength(0);
  });
});

describe("generation date range is in studio-local days", () => {
  it("queries starts_at with studio-local bounds", async () => {
    const fake = fakeSupabase({ studios: [{ timezone: "America/New_York" }], appointments: [] });
    await generateInstructorEarningsForCompletedAppointments({
      supabase: fake.client as never,
      studioId: "s1",
      fromDate: "2026-10-09",
      toDate: "2026-10-09",
    });
    expect(fake.filters.filter((f) => f.table === "appointments")).toEqual([
      { table: "appointments", op: "gte", value: "2026-10-09T04:00:00.000Z" },
      { table: "appointments", op: "lt", value: "2026-10-10T04:00:00.000Z" },
    ]);
  });
  it("fails closed when the studio zone cannot be read", async () => {
    const fake = fakeSupabase({ studios: [], appointments: [{ id: "a1" }] });
    const result = await generateInstructorEarningsForCompletedAppointments({ supabase: fake.client as never, studioId: "s1" });
    expect(result).toMatchObject({ scanned: 0, error: "studio_timezone_unavailable" });
  });
});
