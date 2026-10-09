import { describe, expect, it, vi } from "vitest";

/**
 * Phase 9D: accountant-delivery CSVs are serialized by the shared formula-safe
 * helper. Column order and values are unchanged except for the required
 * escaping; formula-like text behind leading whitespace is now neutralized.
 */

let paymentRows: Array<Record<string, unknown>> = [];
let expenseRows: Array<Record<string, unknown>> = [];

function builder(rows: () => Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lte", "order", "not", "limit"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => builder(() => (table === "payments" ? paymentRows : table === "expenses" ? expenseRows : [])),
  }),
}));
vi.mock("@/lib/accounting/entries", () => ({ getStudioAccountingEntries: async () => [] }));
vi.mock("server-only", () => ({}));

const { buildAccountantReport } = await import("../reports");

describe("accountant CSV uses the shared formula-safe helper", () => {
  it("expenses: keeps column order, neutralizes hidden formulas, quotes CR, leaves numbers numeric", async () => {
    expenseRows = [
      {
        id: "x1", expense_date: "2026-10-01", vendor_name: "  =HYPERLINK(\"u\")", category: "\t+1+1", amount: -12.5,
        currency: "USD", payment_method: "card", notes: "a\rb,c", created_at: "2026-10-01T00:00:00Z",
      },
    ];
    const { csv, filename } = await buildAccountantReport({ studioId: "s1", reportType: "expenses", range: "month" });
    expect(filename).toBe("danceflow-expenses-month.csv");
    const [header, row] = csv.split("\n");
    expect(header).toBe("Expense ID,Expense Date,Vendor,Category,Amount,Currency,Payment Method,Notes,Created At");
    expect(row).toBe("x1,2026-10-01,\"'  =HYPERLINK(\"\"u\"\")\",'\t+1+1,-12.5,USD,card,\"a\rb,c\",2026-10-01T00:00:00Z");
  });

  it("payments: numeric-looking money text stays unchanged while real formulas are neutralized", async () => {
    paymentRows = [
      { id: "p1", amount: "-5.00", payment_method: "=cmd", status: "ok", created_at: "t", notes: " @SUM(A1)", refunded_amount: 2, refund_amount: 3 },
    ];
    const { csv } = await buildAccountantReport({ studioId: "s1", reportType: "payments_refunds", range: "month" });
    const [header, row] = csv.split("\n");
    expect(header).toBe("Payment ID,Amount,Refunded Amount,Payment Method,Status,Created At,Notes");
    expect(row).toBe("p1,-5.00,3,'=cmd,ok,t,' @SUM(A1)");
  });
});
