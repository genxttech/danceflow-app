import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9A: the Instructor Pay actions only offer what the payroll chain
 * allows. An individual earning is never marked paid (payment happens only
 * through an approved batch), review operations are limited to approve and
 * void on unbatched earnings, an override never erases a reimbursement and
 * reports when an approved earning went back to review, earnings generation
 * reports a capped window or unreadable attendance, and the 9A migration's
 * RPCs are studio-scoped and fail closed.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const requirePayrollPrepareAccess = vi.fn();
const requirePayrollDisbursementAccess = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requirePayrollPrepareAccess: () => requirePayrollPrepareAccess(),
  requirePayrollDisbursementAccess: () => requirePayrollDisbursementAccess(),
}));

const generateInstructorEarningsForCompletedAppointments = vi.fn();

vi.mock("@/lib/compensation/earnings", () => ({
  generateInstructorEarningsForCompletedAppointments: (...args: unknown[]) =>
    generateInstructorEarningsForCompletedAppointments(...args),
}));

const {
  updateInstructorEarningStatusAction,
  overrideInstructorEarningAction,
  generateInstructorEarningsAction,
  markPayrollBatchPaidAction,
  approvePayrollBatchAction,
} = await import("../actions");

type Call = {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
};

function fakeSupabase(
  options: {
    existing?: Record<string, unknown> | null;
    saved?: Record<string, unknown> | null;
    rpcError?: { message: string } | null;
  } = {},
) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const chain = {
      select: () => chain,
      update: (payload: unknown) => {
        call.op = "update";
        call.payload = payload;
        return chain;
      },
      insert: (payload: unknown) => {
        call.op = "insert";
        call.payload = payload;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push(["eq", column, value]);
        return chain;
      },
      is: (column: string, value: unknown) => {
        call.filters.push(["is", column, value]);
        return chain;
      },
      maybeSingle: async () => {
        if (call.op === "update")
          return { data: options.saved ?? null, error: null };
        return { data: options.existing ?? null, error: null };
      },
      then: (resolve: (value: { data: null; error: null }) => unknown) =>
        resolve({ data: null, error: null }),
    };
    return chain;
  }

  return {
    calls,
    rpcCalls,
    client: {
      from: (table: string) => builder(table),
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return { data: null, error: options.rpcError ?? null };
      },
    },
  };
}

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? "";
  }
  throw new Error("expected a redirect");
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function grant(fake: ReturnType<typeof fakeSupabase>) {
  const ctx = {
    supabase: fake.client,
    studioId: "studio-a",
    user: { id: "user-1" },
  };
  requirePayrollPrepareAccess.mockResolvedValue(ctx);
  requirePayrollDisbursementAccess.mockResolvedValue(ctx);
}

beforeEach(() => {
  requirePayrollPrepareAccess.mockReset();
  requirePayrollDisbursementAccess.mockReset();
  generateInstructorEarningsForCompletedAppointments.mockReset();
});

describe("no individual earning payment", () => {
  it.each(["pending", "approved"])(
    "refuses nextStatus=paid for a %s earning before any read or write",
    async (status) => {
      const fake = fakeSupabase({
        existing: { id: "e1", status, payroll_batch_id: null },
      });
      grant(fake);
      const url = await redirectOf(() =>
        updateInstructorEarningStatusAction(
          form({ earningId: "e1", nextStatus: "paid", paymentMethod: "check" }),
        ),
      );
      expect(url).toContain("status=earning_paid_through_batch");
      expect(fake.calls).toHaveLength(0);
      expect(requirePayrollDisbursementAccess).not.toHaveBeenCalled();
    },
  );

  it("never writes paid fields from the per-earning action", async () => {
    const fake = fakeSupabase({
      existing: { id: "e1", status: "pending", payroll_batch_id: null },
    });
    grant(fake);
    await redirectOf(() =>
      updateInstructorEarningStatusAction(
        form({ earningId: "e1", nextStatus: "approved" }),
      ),
    );
    const update = fake.calls.find((call) => call.op === "update");
    expect(update?.payload).toMatchObject({ status: "approved" });
    expect(update?.payload).not.toHaveProperty("paid_at");
    expect(update?.payload).not.toHaveProperty("paid_by");
    expect(update?.payload).not.toHaveProperty("payment_method");
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "studio_id", "studio-a"],
        ["eq", "status", "pending"],
        ["is", "payroll_batch_id", null],
      ]),
    );
  });

  it("pays only through the batch RPC with the disbursement guard", async () => {
    const fake = fakeSupabase();
    grant(fake);
    const url = await redirectOf(() =>
      markPayrollBatchPaidAction(
        form({ payrollBatchId: "b1", paymentMethod: "check" }),
      ),
    );
    expect(url).toContain("status=payroll_batch_paid");
    expect(requirePayrollDisbursementAccess).toHaveBeenCalledTimes(1);
    expect(fake.rpcCalls).toEqual([
      {
        fn: "mark_payroll_batch_paid",
        args: {
          p_studio_id: "studio-a",
          p_batch_id: "b1",
          p_payment_method: "check",
          p_provider_batch_reference: null,
        },
      },
    ]);
  });

  it("maps the batch totals guard to a clear status", async () => {
    const fake = fakeSupabase({
      rpcError: {
        message: "Payroll batch totals do not match its approved earnings.",
      },
    });
    grant(fake);
    const url = await redirectOf(() =>
      markPayrollBatchPaidAction(form({ payrollBatchId: "b1" })),
    );
    expect(url).toContain("status=batch_totals_out_of_date");
  });

  it("surfaces a cross-studio / unknown batch as not found", async () => {
    const fake = fakeSupabase({
      rpcError: { message: "Payroll batch not found." },
    });
    grant(fake);
    const url = await redirectOf(() =>
      approvePayrollBatchAction(form({ payrollBatchId: "other-studio-batch" })),
    );
    expect(url).toContain("status=payroll_batch_not_found");
  });
});

describe("earning review operations", () => {
  it("refuses a casual approved -> pending", async () => {
    const fake = fakeSupabase({
      existing: { id: "e1", status: "approved", payroll_batch_id: null },
    });
    grant(fake);
    const url = await redirectOf(() =>
      updateInstructorEarningStatusAction(
        form({ earningId: "e1", nextStatus: "pending" }),
      ),
    );
    expect(url).toContain("status=invalid_status");
    expect(fake.calls.some((call) => call.op === "update")).toBe(false);
  });

  it.each(["approved", "void"])(
    "refuses %s on a batched earning",
    async (nextStatus) => {
      const fake = fakeSupabase({
        existing: { id: "e1", status: "pending", payroll_batch_id: "b1" },
      });
      grant(fake);
      const url = await redirectOf(() =>
        updateInstructorEarningStatusAction(
          form({ earningId: "e1", nextStatus }),
        ),
      );
      expect(url).toContain("status=earning_locked");
      expect(fake.calls.some((call) => call.op === "update")).toBe(false);
    },
  );

  it.each(["paid", "void"])(
    "refuses changes to a %s earning",
    async (status) => {
      const fake = fakeSupabase({
        existing: { id: "e1", status, payroll_batch_id: null },
      });
      grant(fake);
      const url = await redirectOf(() =>
        updateInstructorEarningStatusAction(
          form({ earningId: "e1", nextStatus: "approved" }),
        ),
      );
      expect(url).toContain("status=earning_locked");
      expect(fake.calls.some((call) => call.op === "update")).toBe(false);
    },
  );

  it("voids an approved unbatched earning", async () => {
    const fake = fakeSupabase({
      existing: { id: "e1", status: "approved", payroll_batch_id: null },
    });
    grant(fake);
    const url = await redirectOf(() =>
      updateInstructorEarningStatusAction(
        form({ earningId: "e1", nextStatus: "void" }),
      ),
    );
    expect(url).toContain("status=earning_updated");
    expect(
      fake.calls.find((call) => call.op === "update")?.payload,
    ).toMatchObject({ status: "void" });
  });
});

describe("override after approval", () => {
  it("does not keep an approval or rewrite approved_by itself; reports re-review", async () => {
    const fake = fakeSupabase({
      existing: {
        id: "e1",
        status: "approved",
        payroll_batch_id: null,
        adjustment_type: null,
        reimbursement_amount: 15,
        deduction_amount: 0,
      },
      saved: { status: "pending" },
    });
    grant(fake);
    const url = await redirectOf(() =>
      overrideInstructorEarningAction(
        form({
          earningId: "e1",
          overrideAmount: "80",
          overrideReason: "rate fix",
        }),
      ),
    );
    expect(url).toContain("status=override_saved_needs_review");
    const update = fake.calls.find((call) => call.op === "update");
    expect(update?.payload).not.toHaveProperty("approved_by");
    expect(update?.payload).not.toHaveProperty("status");
    expect(update?.payload).toMatchObject({
      earning_amount: 80,
      taxable_compensation_amount: 80,
      reimbursement_amount: 15,
      deduction_amount: 0,
      pay_mode: "manual_override",
    });
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        ["is", "payroll_batch_id", null],
        ["eq", "status", "approved"],
      ]),
    );
  });

  it("keeps a reimbursement a reimbursement", async () => {
    const fake = fakeSupabase({
      existing: {
        id: "e1",
        status: "pending",
        payroll_batch_id: null,
        adjustment_type: "reimbursement",
        reimbursement_amount: 20,
        deduction_amount: 0,
      },
      saved: { status: "pending" },
    });
    grant(fake);
    const url = await redirectOf(() =>
      overrideInstructorEarningAction(
        form({
          earningId: "e1",
          overrideAmount: "25",
          overrideReason: "receipt",
        }),
      ),
    );
    expect(url).toContain("status=override_saved");
    expect(
      fake.calls.find((call) => call.op === "update")?.payload,
    ).toMatchObject({
      earning_amount: 25,
      taxable_compensation_amount: 0,
      reimbursement_amount: 25,
      adjustment_type: "reimbursement",
    });
  });

  it.each([
    ["batched", { status: "approved", payroll_batch_id: "b1" }],
    ["paid", { status: "paid", payroll_batch_id: "b1" }],
    ["void", { status: "void", payroll_batch_id: null }],
  ])("rejects an override of a %s earning", async (_label, row) => {
    const fake = fakeSupabase({
      existing: {
        id: "e1",
        adjustment_type: null,
        reimbursement_amount: 0,
        deduction_amount: 0,
        ...row,
      },
    });
    grant(fake);
    const url = await redirectOf(() =>
      overrideInstructorEarningAction(
        form({ earningId: "e1", overrideAmount: "80", overrideReason: "x" }),
      ),
    );
    expect(url).toContain("status=earning_locked");
    expect(fake.calls.some((call) => call.op === "update")).toBe(false);
  });
});

describe("earnings generation is never silently partial", () => {
  it("reports a capped window", async () => {
    grant(fakeSupabase());
    generateInstructorEarningsForCompletedAppointments.mockResolvedValue({
      scanned: 500,
      staged: 480,
      skipped: 20,
      attendanceFailed: 0,
      truncated: true,
      error: null,
    });
    const url = await redirectOf(() =>
      generateInstructorEarningsAction(form({})),
    );
    expect(url).toContain("status=earnings_generated_partial");
    expect(url).toContain("truncated=1");
  });

  it("reports attendance that could not be read", async () => {
    grant(fakeSupabase());
    generateInstructorEarningsForCompletedAppointments.mockResolvedValue({
      scanned: 3,
      staged: 2,
      skipped: 0,
      attendanceFailed: 1,
      truncated: false,
      error: null,
    });
    const url = await redirectOf(() =>
      generateInstructorEarningsAction(form({})),
    );
    expect(url).toContain("status=earnings_generated_partial");
    expect(url).toContain("attendanceFailed=1");
  });

  it("reports a complete run as complete", async () => {
    grant(fakeSupabase());
    generateInstructorEarningsForCompletedAppointments.mockResolvedValue({
      scanned: 3,
      staged: 3,
      skipped: 0,
      attendanceFailed: 0,
      truncated: false,
      error: null,
    });
    const url = await redirectOf(() =>
      generateInstructorEarningsAction(form({})),
    );
    expect(url).toContain("status=earnings_generated&");
  });
});

describe("Instructor Pay page", () => {
  const page = readFileSync(
    path.join(process.cwd(), "src/app/app/instructor-pay/page.tsx"),
    "utf8",
  );

  it("offers no per-earning Mark paid control", () => {
    expect(page).not.toMatch(/name="nextStatus" value="paid"/);
    expect(page).toMatch(/markPayrollBatchPaidAction/);
  });
});

describe("Phase 9A migration", () => {
  const sql = readFileSync(
    path.join(
      process.cwd(),
      "src/lib/supabase/migrations/20261102090000_phase9a_payroll_integrity.sql",
    ),
    "utf8",
  );

  function functionBody(name: string) {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = sql.indexOf("$function$;", start);
    return sql.slice(start, end);
  }

  const rpcs = [
    "create_payroll_pay_period",
    "assign_earnings_to_pay_period",
    "assign_single_earning_to_pay_period",
    "remove_earning_from_pay_period",
    "create_payroll_batch_from_period",
    "approve_payroll_batch",
    "mark_payroll_batch_paid",
    "void_empty_payroll_pay_period",
  ];

  it.each(rpcs)("%s guards with the NULL-safe actor role", (name) => {
    expect(functionBody(name)).toMatch(
      /coalesce\(public\.payroll_actor_role\(p_studio_id\), ''\) not in \(/,
    );
  });

  it.each(rpcs.filter((name) => name !== "create_payroll_pay_period"))(
    "%s fails closed when its lookup finds no row",
    (name) => {
      expect(functionBody(name)).toMatch(/if not found then raise exception/);
    },
  );

  it.each(rpcs.filter((name) => name !== "create_payroll_pay_period"))(
    "%s checks every row lookup for absence before comparing it",
    (name) => {
      // A missing row must raise; a NULL status compared with NOT IN / <> would pass silently.
      const body = functionBody(name);
      const lookups = [
        ...body.matchAll(
          /select (?!count\(|coalesce\(sum\()[^;]*? into [^;]*?from public\.\w+[^;]*;\s*([^\n]*)/g,
        ),
      ];
      expect(lookups.length, name).toBeGreaterThan(0);
      for (const lookup of lookups)
        expect(lookup[1], lookup[0]).toMatch(
          /^if not found then raise exception/,
        );
    },
  );

  it("scopes every approve_payroll_batch write to the caller's studio", () => {
    const body = functionBody("approve_payroll_batch");
    const writes = body.match(/update public\.\w+[\s\S]*?;/g) ?? [];
    expect(writes.length).toBe(2);
    for (const write of writes)
      expect(write).toMatch(/studio_id = p_studio_id/);
  });

  it("disburses only for the owner or a platform admin", () => {
    for (const name of [
      "mark_payroll_batch_paid",
      "void_empty_payroll_pay_period",
    ]) {
      expect(functionBody(name)).toMatch(
        /not in \('studio_owner', 'platform_admin'\)/,
      );
    }
    for (const name of rpcs.filter(
      (n) =>
        !["mark_payroll_batch_paid", "void_empty_payroll_pay_period"].includes(
          n,
        ),
    )) {
      expect(functionBody(name)).toMatch(
        /not in \('studio_owner', 'studio_admin', 'platform_admin'\)/,
      );
    }
  });

  it("locks earnings on INSERT and UPDATE and drops direct period/batch writes", () => {
    expect(sql).toMatch(
      /before insert or update on public\.instructor_earnings/,
    );
    expect(sql).toMatch(
      /Earnings can only be added to a draft payroll batch\./,
    );
    for (const policy of [
      "payroll_pay_periods_insert",
      "payroll_pay_periods_update",
      "payroll_batches_insert",
      "payroll_batches_update",
    ]) {
      expect(sql).toContain(`drop policy ${policy} on`);
    }
  });

  it("returns an approved earning to review when its amount changes", () => {
    expect(sql).toMatch(
      /if new\.status = 'approved' and v_changed then\s+-- Amount or payroll identity changed after approval: review again\.\s+new\.status := 'pending';/,
    );
  });

  it("guards payroll history against DELETE on earnings, pay periods and batches", () => {
    for (const table of ["instructor_earnings", "payroll_pay_periods", "payroll_batches"]) {
      expect(sql).toMatch(
        new RegExp(`before delete on public\\.${table}\\s+for each row execute function public\\.prevent_payroll_history_delete\\(\\);`),
      );
    }
    expect(sql).toMatch(
      /old\.status <> 'pending' or old\.pay_period_id is not null or old\.payroll_batch_id is not null\s+or old\.locked_at is not null or old\.approved_at is not null or old\.paid_at is not null then\s+raise exception 'Payroll history cannot be deleted\.';/,
    );
  });

  it("refuses the ON DELETE SET NULL cascade for payroll history", () => {
    expect(sql).toMatch(/raise exception 'Payroll history must keep its source appointment and client\.';/);
  });
});
