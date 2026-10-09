import { describe, expect, it } from "vitest";
import { isAllowedEarningReviewTransition, overrideEarningAmounts } from "../payroll-integrity";
import { EARNINGS_GENERATION_LIMIT, generateInstructorEarningsForCompletedAppointments, stageInstructorEarningForAppointment } from "../earnings";

describe("earning review transitions", () => {
  it.each([
    ["pending", "approved", true],
    ["pending", "void", true],
    ["approved", "void", true],
    ["pending", "paid", false],
    ["approved", "paid", false],
    ["approved", "pending", false],
    ["paid", "approved", false],
    ["paid", "void", false],
    ["void", "pending", false],
  ])("%s -> %s is %s", (current, next, allowed) => {
    expect(isAllowedEarningReviewTransition(current, next)).toBe(allowed);
  });
});

describe("override amounts", () => {
  it("keeps an existing reimbursement on a compensation earning", () => {
    expect(overrideEarningAmounts({ adjustment_type: null, reimbursement_amount: "12.5", deduction_amount: 0 }, 90)).toEqual({
      earning_amount: 90,
      taxable_compensation_amount: 90,
      reimbursement_amount: 12.5,
      deduction_amount: 0,
      adjustment_type: "override",
    });
  });

  it("treats a negative compensation override as a deduction without losing the reimbursement", () => {
    expect(overrideEarningAmounts({ adjustment_type: "bonus", reimbursement_amount: 5, deduction_amount: 0 }, -20)).toMatchObject({
      taxable_compensation_amount: 0,
      deduction_amount: 20,
      reimbursement_amount: 5,
    });
  });

  it("keeps a reimbursement a reimbursement", () => {
    expect(overrideEarningAmounts({ adjustment_type: "reimbursement", reimbursement_amount: 20, deduction_amount: 0 }, 25)).toEqual({
      earning_amount: 25,
      taxable_compensation_amount: 0,
      reimbursement_amount: 25,
      deduction_amount: 0,
      adjustment_type: "reimbursement",
    });
  });

  it("rejects a negative reimbursement", () => {
    expect(overrideEarningAmounts({ adjustment_type: "reimbursement", reimbursement_amount: 20, deduction_amount: 0 }, -5)).toEqual({
      error: "invalid_override_amount",
    });
  });

  it("keeps a deduction a deduction", () => {
    expect(overrideEarningAmounts({ adjustment_type: "deduction", reimbursement_amount: 0, deduction_amount: 10 }, 15)).toEqual({
      earning_amount: -15,
      taxable_compensation_amount: 0,
      reimbursement_amount: 0,
      deduction_amount: 15,
      adjustment_type: "deduction",
    });
  });
});

type Rows = Record<string, unknown[]>;

// Minimal query fake for the earnings staging path: every builder resolves
// to the configured rows for its table; attendance_records can fail.
function fakeSupabase(rows: Rows, options: { attendanceError?: boolean } = {}) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  function builder(table: string) {
    let op = "select";
    let payload: unknown;
    let limit: number | null = null;
    const result = () => {
      if (table === "attendance_records") {
        return options.attendanceError
          ? { data: null, count: null, error: { message: "read failed" } }
          : { data: null, count: 3, error: null };
      }
      // Every studio has a time zone; the staging path reads it (Phase 9E).
      const data = rows[table] ?? (table === "studios" ? [{ timezone: "America/New_York" }] : []);
      return { data: limit === null ? data : data.slice(0, limit), error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "not", "in", "or", "order", "gte", "lte", "lt"]) {
      chain[name] = () => chain;
    }
    chain.limit = (value: number) => {
      limit = value;
      return chain;
    };
    chain.update = (value: unknown) => {
      op = "update";
      payload = value;
      return chain;
    };
    chain.insert = async (value: unknown) => {
      writes.push({ table, op: "insert", payload: value });
      return { error: null };
    };
    chain.maybeSingle = async () => {
      const { data } = result();
      return { data: Array.isArray(data) ? data[0] ?? null : data, error: null };
    };
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (op === "update") writes.push({ table, op, payload });
      return resolve(result());
    };
    return chain;
  }
  return { writes, client: { from: (table: string) => builder(table) } };
}

const groupClass = {
  id: "a1",
  studio_id: "s1",
  instructor_id: "i1",
  client_id: null,
  appointment_type: "group_class",
  status: "attended",
  starts_at: "2026-01-05T10:00:00Z",
  ends_at: "2026-01-05T11:00:00Z",
  price_amount: 100,
  billing_type: null,
  payment_status: null,
};

const perAttendeeRule = {
  studio_id: "s1",
  instructor_id: "i1",
  active: true,
  group_class_pay_mode: "per_attendee",
  group_class_flat_amount: 0,
  group_class_percentage: 0,
  group_class_per_attendee_amount: 10,
  private_lesson_pay_mode: "none",
};

describe("earnings generation", () => {
  it("does not stage a class whose attendance could not be read", async () => {
    const fake = fakeSupabase(
      {
        appointments: [groupClass],
        instructor_compensation_rules: [perAttendeeRule],
        instructor_payroll_profiles: [{ worker_classification: "contractor", payroll_active: true }],
        instructor_earnings: [],
      },
      { attendanceError: true },
    );
    const result = await stageInstructorEarningForAppointment({
      supabase: fake.client as never,
      studioId: "s1",
      appointmentId: "a1",
      createdBy: null,
    });
    expect(result).toEqual({ staged: false, reason: "attendance_read_failed" });
    expect(fake.writes).toHaveLength(0);
  });

  it("stages a class when attendance is readable", async () => {
    const fake = fakeSupabase({
      appointments: [groupClass],
      instructor_compensation_rules: [perAttendeeRule],
      instructor_payroll_profiles: [{ worker_classification: "contractor", payroll_active: true }],
      instructor_earnings: [],
    });
    const result = await stageInstructorEarningForAppointment({
      supabase: fake.client as never,
      studioId: "s1",
      appointmentId: "a1",
      createdBy: null,
    });
    expect(result).toMatchObject({ staged: true });
    expect(fake.writes[0]?.payload).toMatchObject({ attendance_count: 3, status: "pending" });
  });

  it("reports truncation instead of claiming a complete run", async () => {
    const appointments = Array.from({ length: EARNINGS_GENERATION_LIMIT + 1 }, (_, index) => ({ id: `a${index}` }));
    const fake = fakeSupabase({ appointments });
    const result = await generateInstructorEarningsForCompletedAppointments({ supabase: fake.client as never, studioId: "s1" });
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(EARNINGS_GENERATION_LIMIT);
  });

  it("reports a window within the limit as complete", async () => {
    const fake = fakeSupabase({ appointments: [{ id: "a1" }, { id: "a2" }] });
    const result = await generateInstructorEarningsForCompletedAppointments({ supabase: fake.client as never, studioId: "s1" });
    expect(result.truncated).toBe(false);
    expect(result.scanned).toBe(2);
  });

  it("counts attendance read failures separately from skips", async () => {
    const fake = fakeSupabase(
      {
        appointments: [groupClass],
        instructor_compensation_rules: [perAttendeeRule],
        instructor_payroll_profiles: [{ worker_classification: "contractor", payroll_active: true }],
        instructor_earnings: [],
      },
      { attendanceError: true },
    );
    const result = await generateInstructorEarningsForCompletedAppointments({ supabase: fake.client as never, studioId: "s1" });
    expect(result).toMatchObject({ attendanceFailed: 1, staged: 0, skipped: 0 });
  });
});
