import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFPage } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9B: approved payroll exports read the immutable approval snapshot
 * (never the live, still-mutable earning / instructor / client rows), batches
 * approved before snapshots existed are exported from current records and say
 * so, every successful approved-batch export appends export evidence after the
 * file is generated, and a failed load or failed evidence write returns no file.
 *
 * Batch exports load through the trusted get_payroll_batch_export reader. The
 * fake below implements its contract (explicit studio, owner/admin/platform
 * admin, batch must belong to the named studio) while direct payroll-table
 * reads return nothing for a platform admin, mirroring the owner/admin-only
 * SELECT policies -- so platform-admin exports are proven not to depend on
 * direct table reads.
 */

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

let tables: Tables = {};
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let recordError: { message: string } | null = null;
let readerError: { message: string } | null = null;
let context: { studioId: string; studioRole: string; isPlatformAdmin: boolean } = {
  studioId: "studio-a",
  studioRole: "studio_owner",
  isPlatformAdmin: false,
};
// Studio-scoped role the database's payroll_actor_role would resolve, per studio.
let dbRoles: Record<string, string | null> = {};

// Tables a platform admin cannot read directly (owner/admin RLS); studios included
// so the PDF is proven to take its studio identity from the trusted payload.
const PAYROLL_TABLES = new Set([
  "studios",
  "payroll_batches",
  "payroll_pay_periods",
  "instructor_earnings",
  "payroll_batch_approval_snapshots",
  "payroll_batch_approval_snapshot_lines",
  "payroll_batch_payment_evidence",
  "payroll_export_events",
]);

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const run = () => {
    // RLS: payroll tables are readable only by an owner/admin of the row's studio.
    const rows = (tables[table] ?? []).filter(
      (row) =>
        filters.every(([column, value]) => row[column] === value) &&
        (!PAYROLL_TABLES.has(table) ||
          ["studio_owner", "studio_admin"].includes(dbRoles[String(table === "studios" ? row.id : row.studio_id)] ?? "")),
    );
    return { data: rows, error: null };
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => {
    filters.push([column, value]);
    return chain;
  };
  chain.neq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => {
    const result = run();
    return { data: result.data[0] ?? null, error: result.error };
  };
  chain.then = (resolve: (value: unknown) => unknown) => resolve(run());
  return chain;
}

// Contract of public.get_payroll_batch_export (SECURITY DEFINER, explicit studio).
function exportReader(args: Record<string, unknown>) {
  if (readerError) return { data: null, error: readerError };
  const studioId = String(args.p_studio_id);
  const role = dbRoles[studioId] ?? null;
  if (!role || !["studio_owner", "studio_admin", "platform_admin"].includes(role)) {
    return { data: null, error: { message: "Payroll access denied." } };
  }
  const batch = tables.payroll_batches.find((row) => row.id === args.p_batch_id && row.studio_id === studioId);
  if (!batch) return { data: null, error: { message: "Payroll batch not found." } };
  const snapshot = tables.payroll_batch_approval_snapshots.find(
    (row) => row.payroll_batch_id === batch.id && row.studio_id === studioId,
  );
  const studio = tables.studios.find((row) => row.id === studioId);
  return {
    data: {
      batch,
      studio: studio ? { name: studio.name, public_name: studio.public_name, public_logo_url: studio.public_logo_url } : null,
      period: tables.payroll_pay_periods.find((row) => row.id === batch.pay_period_id && row.studio_id === studioId) ?? null,
      snapshot: snapshot ?? null,
      lines: snapshot
        ? tables.payroll_batch_approval_snapshot_lines
            .filter((row) => row.snapshot_id === snapshot.id && row.studio_id === studioId)
            .sort((a, b) => Number(a.line_number) - Number(b.line_number))
        : [],
      payment: tables.payroll_batch_payment_evidence.find((row) => row.payroll_batch_id === batch.id && row.studio_id === studioId) ?? null,
      earnings: snapshot
        ? []
        : tables.instructor_earnings
            .filter((row) => row.payroll_batch_id === batch.id && row.studio_id === studioId)
            .sort((a, b) => String(a.earning_date).localeCompare(String(b.earning_date))),
    },
    error: null,
  };
}

const supabase = {
  from: (table: string) => query(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "get_payroll_batch_export") return exportReader(args);
    return { data: recordError ? null : "event-1", error: recordError };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => context }));

const { GET: exportCsv } = await import("../export/route");
const { GET: exportPdf } = await import("../batches/[batchId]/pdf/route");

const STUDIO = "studio-a";
const OTHER = "studio-b";

function batch(id: string, status: string, overrides: Row = {}): Row {
  return {
    id,
    studio_id: STUDIO,
    pay_period_id: `period-${id}`,
    batch_number: 7,
    provider: "manual",
    provider_batch_reference: null,
    status,
    compensation_total: 150,
    reimbursement_total: 20,
    deduction_total: 0,
    net_payment_total: 170,
    earning_count: 2,
    approved_at: "2026-01-20T10:00:00Z",
    paid_at: null,
    payment_method: null,
    created_at: "2026-01-16T10:00:00Z",
    ...overrides,
  };
}

function period(batchId: string, studioId = STUDIO): Row {
  return { id: `period-${batchId}`, studio_id: studioId, period_start: "2026-01-01", period_end: "2026-01-15", pay_date: "2026-01-20", status: "approved" };
}

function snapshotFor(batchId: string, studioId = STUDIO): Row {
  return {
    id: `snap-${batchId}`,
    studio_id: studioId,
    payroll_batch_id: batchId,
    pay_period_id: `period-${batchId}`,
    batch_number: 7,
    provider: "manual",
    provider_batch_reference: null,
    period_start: "2026-01-01",
    period_end: "2026-01-15",
    pay_date: "2026-01-20",
    approved_at: "2026-01-20T10:00:00Z",
    approved_by_name: "Ada Admin",
    approved_by_role: "studio_admin",
    worker_count: 1,
    earning_count: 2,
    compensation_total: 150,
    reimbursement_total: 20,
    deduction_total: 0,
    net_payment_total: 170,
    fingerprint: "0123456789abcdef0123456789abcdef",
  };
}

function snapshotLines(batchId: string, studioId = STUDIO): Row[] {
  const base = {
    snapshot_id: `snap-${batchId}`,
    studio_id: studioId,
    instructor_id: "inst-1",
    instructor_name: "Nina Alpha",
    client_name: "Cara Client",
    appointment_id: "appt-1",
    appointment_type: "private_lesson",
    source_type: "appointment",
    gross_revenue_basis: 100,
    pay_mode: "flat",
    pay_rate_amount: 100,
    pay_percentage: 0,
    attendance_count: 0,
    worker_classification_snapshot: "contractor",
    accounting_category_snapshot: "contract_labor_expense",
    deduction_amount: 0,
  };
  return [
    { ...base, line_number: 1, earning_id: "e1", earning_date: "2026-01-05", earning_amount: 150, taxable_compensation_amount: 150, reimbursement_amount: 0, net_amount: 150, notes: "snapshot note" },
    { ...base, line_number: 2, earning_id: "e2", earning_date: "2026-01-06", earning_amount: 20, taxable_compensation_amount: 0, reimbursement_amount: 20, net_amount: 20, notes: null },
  ];
}

// The live rows disagree with the snapshot everywhere it matters.
function liveEarnings(batchId: string, studioId = STUDIO): Row[] {
  return [
    {
      id: "e1", studio_id: studioId, payroll_batch_id: batchId, pay_period_id: `period-${batchId}`, instructor_id: "inst-1",
      earning_date: "2026-01-05", source_type: "appointment", appointment_type: "private_lesson", gross_revenue_basis: 999,
      pay_mode: "flat", pay_rate_amount: 999, pay_percentage: 0, attendance_count: 0, earning_amount: 999, status: "approved",
      paid_at: null, payment_method: null, notes: "LIVE NOTE", appointment_id: "appt-1", worker_classification_snapshot: "contractor",
      accounting_category_snapshot: "contract_labor_expense", taxable_compensation_amount: 999, reimbursement_amount: 0,
      deduction_amount: 0, instructors: { first_name: "LIVE", last_name: "NAME" }, clients: { first_name: "Live", last_name: "Client" },
    },
  ];
}

function csvRequest(batchId: string) {
  return exportCsv(new Request(`https://app.test/app/instructor-pay/export?batchId=${batchId}`));
}

function pdfRequest(batchId: string) {
  return exportPdf(new Request(`https://app.test/app/instructor-pay/batches/${batchId}/pdf`), { params: Promise.resolve({ batchId }) });
}

function recordCalls() {
  return rpcCalls.filter((call) => call.fn === "record_payroll_export");
}

function asOwner() {
  context = { studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false };
  dbRoles = { [STUDIO]: "studio_owner", [OTHER]: null };
}

function asAdmin() {
  context = { studioId: STUDIO, studioRole: "studio_admin", isPlatformAdmin: false };
  dbRoles = { [STUDIO]: "studio_admin", [OTHER]: null };
}

// A platform admin who explicitly selected studio A as the target studio.
function asPlatformAdmin() {
  context = { studioId: STUDIO, studioRole: "platform_admin", isPlatformAdmin: true };
  dbRoles = { [STUDIO]: "platform_admin", [OTHER]: "platform_admin" };
}

beforeEach(() => {
  tables = {
    payroll_batches: [],
    payroll_pay_periods: [],
    payroll_batch_approval_snapshots: [],
    payroll_batch_approval_snapshot_lines: [],
    payroll_batch_payment_evidence: [],
    instructor_earnings: [],
    studios: [
      { id: STUDIO, name: "Studio A Legal LLC", public_name: "Studio A Dance", public_logo_url: "https://cdn.test/studio-a.png" },
      { id: OTHER, name: "Studio B Legal LLC", public_name: "Studio B Dance", public_logo_url: "https://cdn.test/studio-b.png" },
    ],
  };
  rpcCalls = [];
  recordError = null;
  readerError = null;
  asOwner();
  drawnText.length = 0;
  fetchedUrls.length = 0;
  // Calls through to the real drawText, recording the text drawn on the packet.
  const realDrawText = PDFPage.prototype.drawText;
  drawSpy = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, ...args: Parameters<PDFPage["drawText"]>) {
    drawnText.push(args[0]);
    return realDrawText.apply(this, args);
  });
  vi.stubGlobal("fetch", async (url: string) => {
    fetchedUrls.push(url);
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  drawSpy.mockRestore();
  vi.unstubAllGlobals();
});

const drawnText: string[] = [];
const fetchedUrls: string[] = [];
let drawSpy: ReturnType<typeof vi.spyOn>;

function seedSnapshotBatch(id: string, status = "approved", studioId = STUDIO) {
  tables.payroll_batches.push(batch(id, status, { studio_id: studioId }));
  tables.payroll_pay_periods.push(period(id, studioId));
  tables.payroll_batch_approval_snapshots.push(snapshotFor(id, studioId));
  tables.payroll_batch_approval_snapshot_lines.push(...snapshotLines(id, studioId));
  tables.instructor_earnings.push(...liveEarnings(id, studioId));
}

describe("CSV export of an approved batch reads the approval snapshot", () => {
  it("uses frozen snapshot values, never the live rows, and records CSV evidence", async () => {
    seedSnapshotBatch("b1");
    const response = await csvRequest("b1");
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("Nina Alpha");
    expect(csv).toContain("snapshot note");
    expect(csv).toContain("Cara Client");
    expect(csv).toContain("Approval snapshot");
    expect(csv).not.toContain("LIVE NOTE");
    expect(csv).not.toContain("999");
    expect(csv).not.toContain("LIVE NAME");
    expect(recordCalls()).toEqual([
      {
        fn: "record_payroll_export",
        args: { p_studio_id: STUDIO, p_batch_id: "b1", p_export_type: "csv", p_line_count: 2, p_net_payment_total: 170 },
      },
    ]);
  });

  it("takes the paid details from the immutable payment evidence", async () => {
    seedSnapshotBatch("b1", "paid");
    tables.payroll_batch_payment_evidence.push({
      studio_id: STUDIO, payroll_batch_id: "b1", paid_at: "2026-01-25T12:00:00Z", paid_by_name: "Olive Owner",
      paid_by_role: "studio_owner", payment_method: "check", provider_batch_reference: "CHK-1",
    });
    const csv = await (await csvRequest("b1")).text();
    expect(csv).toContain("2026-01-25T12:00:00Z");
    expect(csv).toContain("Check");
    expect(csv.split("\n")[1]).toContain("Paid");
  });

  it("appends one evidence event per export (repeat exports are not merged)", async () => {
    seedSnapshotBatch("b1");
    await csvRequest("b1");
    await csvRequest("b1");
    expect(recordCalls()).toHaveLength(2);
  });

  it("returns no file when the evidence cannot be recorded", async () => {
    seedSnapshotBatch("b1");
    recordError = { message: "Payroll export does not match the approval snapshot." };
    const response = await csvRequest("b1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Nina Alpha");
  });

  it("records nothing when the batch cannot be loaded", async () => {
    seedSnapshotBatch("b1");
    readerError = { message: "connection reset" };
    const response = await csvRequest("b1");
    expect(response.status).toBe(500);
    expect(recordCalls()).toHaveLength(0);
  });

  it("fails closed when the snapshot lines do not match the header", async () => {
    seedSnapshotBatch("b1");
    tables.payroll_batch_approval_snapshot_lines.pop();
    const response = await csvRequest("b1");
    expect(response.status).toBe(500);
    expect(recordCalls()).toHaveLength(0);
  });

  it("does not export another studio's batch", async () => {
    seedSnapshotBatch("b1", "approved", OTHER);
    const response = await csvRequest("b1");
    expect(response.status).toBe(404);
    expect(recordCalls()).toHaveLength(0);
  });

  it("works the same for a studio admin", async () => {
    asAdmin();
    seedSnapshotBatch("b1");
    const response = await csvRequest("b1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("snapshot note");
    expect(recordCalls()).toHaveLength(1);
  });
});

describe("legacy and unapproved batches", () => {
  it("exports a pre-snapshot approved batch from current records, labels it, and records legacy evidence", async () => {
    tables.payroll_batches.push(batch("legacy", "approved", { earning_count: 1, net_payment_total: 999 }));
    tables.payroll_pay_periods.push(period("legacy"));
    tables.instructor_earnings.push(...liveEarnings("legacy"));
    const response = await csvRequest("legacy");
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("Current records (approved before snapshots)");
    expect(csv).toContain("LIVE NOTE");
    expect(recordCalls()).toEqual([
      {
        fn: "record_payroll_export",
        args: { p_studio_id: STUDIO, p_batch_id: "legacy", p_export_type: "csv", p_line_count: 1, p_net_payment_total: 999 },
      },
    ]);
  });

  it("exports a draft batch as a working copy without export evidence", async () => {
    tables.payroll_batches.push(batch("draft", "draft"));
    tables.payroll_pay_periods.push(period("draft"));
    tables.instructor_earnings.push(...liveEarnings("draft"));
    const response = await csvRequest("draft");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Current records");
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("PDF packet", () => {
  it("builds from the approval snapshot and records PDF evidence with snapshot totals", async () => {
    seedSnapshotBatch("b1");
    const response = await pdfRequest("b1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(recordCalls()).toEqual([
      {
        fn: "record_payroll_export",
        args: { p_studio_id: STUDIO, p_batch_id: "b1", p_export_type: "pdf", p_line_count: 2, p_net_payment_total: 170 },
      },
    ]);
  });

  it("returns no packet when the evidence cannot be recorded", async () => {
    seedSnapshotBatch("b1");
    recordError = { message: "Payroll approval snapshot failed verification." };
    const response = await pdfRequest("b1");
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).not.toBe("application/pdf");
  });

  it("records legacy evidence for a pre-snapshot approved batch", async () => {
    tables.payroll_batches.push(batch("legacy", "approved", { earning_count: 1, net_payment_total: 999 }));
    tables.instructor_earnings.push(...liveEarnings("legacy"));
    tables.payroll_pay_periods.push({ id: "period-legacy", studio_id: STUDIO, period_start: "2025-12-01", period_end: "2025-12-15", pay_date: null, status: "approved" });
    const response = await pdfRequest("legacy");
    expect(response.status).toBe(200);
    expect(recordCalls()[0]?.args).toMatchObject({ p_export_type: "pdf", p_line_count: 1, p_net_payment_total: 999 });
  });

  it("does not record evidence for a draft batch", async () => {
    tables.payroll_batches.push(batch("draft", "draft"));
    tables.instructor_earnings.push(...liveEarnings("draft"));
    tables.payroll_pay_periods.push({ id: "period-draft", studio_id: STUDIO, period_start: "2026-01-01", period_end: "2026-01-15", pay_date: null, status: "in_review" });
    const response = await pdfRequest("draft");
    expect(response.status).toBe(200);
    expect(recordCalls()).toHaveLength(0);
  });

  it("does not render another studio's batch", async () => {
    seedSnapshotBatch("b1", "approved", OTHER);
    const response = await pdfRequest("b1");
    expect(response.status).toBe(404);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("platform admin exports through the trusted, explicitly studio-scoped reader", () => {
  it("has no direct read of the payroll tables (RLS stays owner/admin)", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b1");
    const direct = await (supabase.from("payroll_batch_approval_snapshots") as unknown as Promise<{ data: Row[] }>);
    expect(direct.data).toEqual([]);
  });

  it("exports an approved batch's CSV from the snapshot for the explicit target studio", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b1");
    const response = await csvRequest("b1");
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("snapshot note");
    expect(csv).not.toContain("LIVE NOTE");
    expect(rpcCalls[0]).toEqual({ fn: "get_payroll_batch_export", args: { p_studio_id: STUDIO, p_batch_id: "b1" } });
    expect(recordCalls()).toEqual([
      {
        fn: "record_payroll_export",
        args: { p_studio_id: STUDIO, p_batch_id: "b1", p_export_type: "csv", p_line_count: 2, p_net_payment_total: 170 },
      },
    ]);
  });

  it("exports an approved batch's PDF packet from the snapshot for the explicit target studio", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b1");
    const response = await pdfRequest("b1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(recordCalls()).toEqual([
      {
        fn: "record_payroll_export",
        args: { p_studio_id: STUDIO, p_batch_id: "b1", p_export_type: "pdf", p_line_count: 2, p_net_payment_total: 170 },
      },
    ]);
  });

  it("cannot export a studio B batch while the explicit target studio is A", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b-other", "approved", OTHER);
    const csv = await csvRequest("b-other");
    const pdf = await pdfRequest("b-other");
    expect(csv.status).toBe(404);
    expect(pdf.status).toBe(404);
    expect(recordCalls()).toHaveLength(0);
    expect(rpcCalls.every((call) => call.args.p_studio_id === STUDIO)).toBe(true);
  });
});

describe("approved-batch PDF studio identity comes from the trusted export payload", () => {
  it("platform admin: target studio's actual name and logo, no direct studio read, snapshot data, evidence", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b1");
    const direct = await (supabase.from("studios") as unknown as Promise<{ data: Row[] }>);
    expect(direct.data).toEqual([]);
    const response = await pdfRequest("b1");
    expect(response.status).toBe(200);
    expect(drawnText).toContain("Studio A Dance");
    expect(drawnText.join("|")).not.toContain("Dance studio");
    expect(drawnText.join("|")).toContain("Nina Alpha");
    expect(drawnText.join("|")).not.toContain("LIVE");
    expect(fetchedUrls).toEqual(["https://cdn.test/studio-a.png"]);
    expect(recordCalls()).toHaveLength(1);
    expect(recordCalls()[0]?.args).toMatchObject({ p_studio_id: STUDIO, p_export_type: "pdf" });
  });

  it("platform admin naming studio A cannot get studio B's batch or branding", async () => {
    asPlatformAdmin();
    seedSnapshotBatch("b-other", "approved", OTHER);
    const response = await pdfRequest("b-other");
    expect(response.status).toBe(404);
    expect(drawnText.join("|")).not.toContain("Studio B");
    expect(fetchedUrls).toEqual([]);
    expect(recordCalls()).toHaveLength(0);
  });

  it.each([
    ["owner", asOwner],
    ["admin", asAdmin],
  ])("%s: same studio identity as before", async (_label, as) => {
    as();
    seedSnapshotBatch("b1");
    const response = await pdfRequest("b1");
    expect(response.status).toBe(200);
    expect(drawnText).toContain("Studio A Dance");
    expect(fetchedUrls).toEqual(["https://cdn.test/studio-a.png"]);
  });

  it("an absent logo keeps the no-logo layout and the studio's own name", async () => {
    asPlatformAdmin();
    tables.studios[0].public_logo_url = null;
    tables.studios[0].public_name = null;
    seedSnapshotBatch("b1");
    const response = await pdfRequest("b1");
    expect(response.status).toBe(200);
    expect(fetchedUrls).toEqual([]);
    expect(drawnText).toContain("Studio A Legal LLC");
  });

  it("a missing studio is an error, not an invented name", async () => {
    seedSnapshotBatch("b1");
    tables.studios = tables.studios.filter((row) => row.id !== STUDIO);
    const response = await pdfRequest("b1");
    expect(response.status).toBe(500);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("denied roles", () => {
  it.each(["front_desk", "instructor", ""])("route guard refuses %s before any payroll read", async (role) => {
    context = { studioId: STUDIO, studioRole: role, isPlatformAdmin: false };
    seedSnapshotBatch("b1");
    expect((await csvRequest("b1")).status).toBe(403);
    expect((await pdfRequest("b1")).status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a database access denial from the reader is a 403 with no evidence", async () => {
    context = { studioId: STUDIO, studioRole: "studio_admin", isPlatformAdmin: false };
    dbRoles = { [STUDIO]: null };
    seedSnapshotBatch("b1");
    expect((await csvRequest("b1")).status).toBe(403);
    expect((await pdfRequest("b1")).status).toBe(403);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("Phase 9B migration shape", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "src/lib/supabase/migrations/20261103090000_phase9b_payroll_approval_evidence.sql"),
    "utf8",
  );

  it("snapshots inside approve_payroll_batch before the batch becomes approved", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.approve_payroll_batch("));
    const snapshotInsert = body.indexOf("insert into public.payroll_batch_approval_snapshots");
    const linesInsert = body.indexOf("insert into public.payroll_batch_approval_snapshot_lines");
    const approve = body.indexOf("set status = 'approved'");
    expect(snapshotInsert).toBeGreaterThan(-1);
    expect(linesInsert).toBeGreaterThan(snapshotInsert);
    expect(approve).toBeGreaterThan(linesInsert);
  });

  it("records payment evidence inside mark_payroll_batch_paid before the batch becomes paid", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.mark_payroll_batch_paid("));
    expect(body.indexOf("insert into public.payroll_batch_payment_evidence")).toBeGreaterThan(-1);
    expect(body.indexOf("set status = 'paid', paid_at = v_now, paid_by = auth.uid(), payment_method = v_method,\n      provider_batch_reference"))
      .toBeGreaterThan(body.indexOf("insert into public.payroll_batch_payment_evidence"));
  });

  it("adds no new payroll lifecycle status", () => {
    expect(sql).not.toMatch(/'exported'|'finalized'/);
  });

  it("keeps evidence tables append-only and RPC-written, with owner/admin-only SELECT", () => {
    expect(sql).toMatch(/before update or delete on public\.%I for each row execute function public\.prevent_payroll_evidence_change\(\)/);
    expect(sql).toMatch(/revoke all on public\.%I from public, anon, authenticated/);
    expect(sql).not.toMatch(/for insert to authenticated|for update to authenticated|for delete to authenticated/);
    expect(sql).toMatch(/usr\.role = any \(array\['studio_owner'::app_role, 'studio_admin'::app_role\]\)/);
    expect(sql).not.toMatch(/platform_role = 'platform_admin'.*\n.*create policy/);
  });

  it("scopes the trusted export reader to the explicit studio", () => {
    const body = sql.slice(sql.indexOf("create function public.get_payroll_batch_export("));
    expect(body).toMatch(/coalesce\(v_role, ''\) not in \('studio_owner', 'studio_admin', 'platform_admin'\)/);
    expect(body).toMatch(/where id = p_batch_id and studio_id = p_studio_id/);
    expect(body).toMatch(/if v_batch is null then raise exception 'Payroll batch not found\.'/);
  });

  it("stores actor evidence without a foreign key to profiles", () => {
    expect(sql).not.toMatch(/approved_by uuid references|paid_by uuid references|exported_by uuid references/);
    expect(sql).toMatch(/approved_by_name text/);
    expect(sql).toMatch(/paid_by_name text/);
    expect(sql).toMatch(/exported_by_name text/);
  });
});

describe("Phase 9D: approved-batch CSV uses the shared formula-safe helper", () => {
  it("neutralizes formula-like snapshot text, quotes CR/CRLF, and keeps columns and numbers unchanged", async () => {
    seedSnapshotBatch("b9d");
    const lines = tables.payroll_batch_approval_snapshot_lines;
    lines[0].notes = "  =HYPERLINK(\"http://x\",\"y\")";
    lines[0].client_name = "\t+SUM(A1)";
    lines[0].instructor_name = "@Nina";
    lines[1].notes = "line1\r\nline2";

    const response = await csvRequest("b9d");
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("\"'  =HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
    expect(csv).toContain("'\t+SUM(A1)");
    expect(csv).toContain("'@Nina");
    expect(csv).toContain("\"line1\r\nline2\"");
    // Numbers stay numbers; column order is the unchanged header order.
    const header = csv.split("\n")[0].split(",");
    expect(header[0]).toBe("Earning Date");
    expect(header[5]).toBe("Revenue Basis");
    expect(csv).toContain("2026-01-05,'@Nina,");
    expect(csv).toContain(",100,Flat,100,0,0,150,Approved,");
    // Snapshot remains the source of truth and evidence is still recorded.
    expect(csv).not.toContain("LIVE NOTE");
    expect(recordCalls()).toHaveLength(1);
  });
});
