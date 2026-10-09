import { describe, expect, it, vi } from "vitest";

/** Phase 9D: a migrated report export (expenses) serializes through the shared helper. */

let expenseRows: Array<Record<string, unknown>> = [];

function chain(rows: () => Array<Record<string, unknown>>) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lte", "order", "limit", "in"]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => chain(() => (table === "expenses" ? expenseRows : [])) }),
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "studio_owner", isPlatformAdmin: false }),
}));

const { GET } = await import("../expenses/route");

describe("expenses report export CSV", () => {
  it("keeps column order and values, neutralizes formulas, quotes CR/CRLF/commas", async () => {
    expenseRows = [
      {
        id: "e1", expense_date: "2026-10-01", vendor_name: "\r=1+1", category: "  -1+2", amount: -20,
        currency: "USD", payment_method: "card", related_event_id: null, related_client_id: null,
        related_appointment_id: null, notes: 'He said "hi",\r\nbye', created_at: "2026-10-01T00:00:00Z",
      },
    ];
    const response = await GET(new Request("https://app.test/app/reports/export/expenses?range=month"));
    expect(response.status).toBe(200);
    const csv = await response.text();
    const header = csv.split("\n")[0];
    expect(header).toBe(
      "Expense Date,Vendor,Category,Amount,Currency,Payment Method,Related Event ID,Related Event,Related Event Type,Related Event Date,Related Client ID,Related Appointment ID,Notes,Created At,Expense ID",
    );
    const body = csv.slice(header.length + 1);
    expect(body).toBe(
      "2026-10-01,\"'\r=1+1\",'  -1+2,-20,USD,card,,,,,,,\"He said \"\"hi\"\",\r\nbye\",2026-10-01T00:00:00Z,e1",
    );
  });
});
