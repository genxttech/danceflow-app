import { describe, expect, it, vi } from "vitest";

/**
 * Proves the 9 Gusto-specific pay-period actions are blocked before any
 * payroll permission check, Gusto client/token call, or Gusto-table
 * mutation while the integration is dormant, and that the 4 vendor-neutral
 * actions in the same file are completely unaffected -- they still run
 * through to a real success status via the mocked payroll-permission
 * guards and a fake Supabase client, proving the guard was scoped
 * correctly rather than accidentally blocking the whole file.
 */

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

function throwingClientExport(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(`Unexpected call to Gusto client export "${name}" while dormant`);
  };
}

vi.mock("@/lib/integrations/gusto/client", () => ({
  createGustoEmployeeJob: throwingClientExport("createGustoEmployeeJob"),
  createGustoPayrollSync: throwingClientExport("createGustoPayrollSync"),
  approveGustoTimeSheet: throwingClientExport("approveGustoTimeSheet"),
  createGustoTimeSheet: throwingClientExport("createGustoTimeSheet"),
  getGustoPayrollEmployees: throwingClientExport("getGustoPayrollEmployees"),
  getGustoPayrollSync: throwingClientExport("getGustoPayrollSync"),
  getGustoTimeSheet: throwingClientExport("getGustoTimeSheet"),
  getGustoUnprocessedPayrolls: throwingClientExport("getGustoUnprocessedPayrolls"),
  gustoEnvironment: throwingClientExport("gustoEnvironment"),
  findGustoTimeSheetByDanceFlowKey: throwingClientExport("findGustoTimeSheetByDanceFlowKey"),
  getGustoEmployeeJobs: throwingClientExport("getGustoEmployeeJobs"),
  getGustoPayPeriods: throwingClientExport("getGustoPayPeriods"),
  getGustoPaySchedules: throwingClientExport("getGustoPaySchedules"),
}));

vi.mock("@/lib/integrations/gusto/token", () => ({
  getValidGustoAccessToken: throwingClientExport("getValidGustoAccessToken"),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("Unexpected admin client creation while dormant");
  },
}));

const requirePayrollPrepareAccess = vi.fn();
const requirePayrollDisbursementAccess = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requirePayrollPrepareAccess: () => requirePayrollPrepareAccess(),
  requirePayrollDisbursementAccess: () => requirePayrollDisbursementAccess(),
}));

const {
  generateGustoReadinessAction,
  generateGustoTimeSheetPreviewAction,
  sendGustoTimeSheetsAction,
  createMissingGustoDemoJobAction,
  alignPayPeriodToGustoDemoAction,
  initiateGustoPayrollSyncAction,
  refreshGustoPayrollSyncAction,
  refreshGustoTimeSheetStatusesAction,
  approveDeliveredGustoTimeSheetsAction,
  assignSingleEarningAction,
  removeEarningFromPeriodAction,
  approvePeriodEarningAction,
  voidEmptyPayPeriodAction,
} = await import("../actions");

const PAY_PERIOD_ID = "period-1";
const DORMANT_URL = `/app/instructor-pay/periods/${PAY_PERIOD_ID}?status=gusto_not_available`;

function formData(fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("payPeriodId", PAY_PERIOD_ID);
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectDormantRedirect(run: () => Promise<unknown>) {
  requirePayrollPrepareAccess.mockClear();
  requirePayrollDisbursementAccess.mockClear();
  await expect(run()).rejects.toMatchObject({
    digest: `NEXT_REDIRECT;replace;${DORMANT_URL};307;`,
  });
  expect(requirePayrollPrepareAccess).not.toHaveBeenCalled();
  expect(requirePayrollDisbursementAccess).not.toHaveBeenCalled();
}

describe("Gusto pay-period actions while dormant", () => {
  it("generateGustoReadinessAction redirects to the dormant status without checking payroll access", async () => {
    await expectDormantRedirect(() => generateGustoReadinessAction(formData()));
  });

  it("generateGustoTimeSheetPreviewAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => generateGustoTimeSheetPreviewAction(formData()));
  });

  it("sendGustoTimeSheetsAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => sendGustoTimeSheetsAction(formData()));
  });

  it("createMissingGustoDemoJobAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => createMissingGustoDemoJobAction(formData({ instructorId: "i-1" })));
  });

  it("alignPayPeriodToGustoDemoAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => alignPayPeriodToGustoDemoAction(formData()));
  });

  it("initiateGustoPayrollSyncAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => initiateGustoPayrollSyncAction(formData()));
  });

  it("refreshGustoPayrollSyncAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => refreshGustoPayrollSyncAction(formData()));
  });

  it("refreshGustoTimeSheetStatusesAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => refreshGustoTimeSheetStatusesAction(formData()));
  });

  it("approveDeliveredGustoTimeSheetsAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() =>
      approveDeliveredGustoTimeSheetsAction(formData({ confirmation: "approve" })),
    );
  });
});

describe("provider-neutral pay-period actions remain fully functional", () => {
  function chainableFake(terminalResult: unknown) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.update = self;
    chain.eq = self;
    chain.is = self;
    chain.select = self;
    chain.maybeSingle = () => Promise.resolve(terminalResult);
    return chain;
  }

  it("assignSingleEarningAction still runs the RPC and redirects to success", async () => {
    requirePayrollPrepareAccess.mockResolvedValue({
      supabase: { rpc: async () => ({ error: null }) },
      studioId: "studio-1",
    });

    await expect(
      assignSingleEarningAction(formData({ earningId: "earning-1" })),
    ).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/app/instructor-pay/periods/${PAY_PERIOD_ID}?status=earning_assigned;307;`,
    });
  });

  it("removeEarningFromPeriodAction still runs the RPC and redirects to success", async () => {
    requirePayrollPrepareAccess.mockResolvedValue({
      supabase: { rpc: async () => ({ error: null }) },
      studioId: "studio-1",
    });

    await expect(
      removeEarningFromPeriodAction(formData({ earningId: "earning-1" })),
    ).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/app/instructor-pay/periods/${PAY_PERIOD_ID}?status=earning_removed;307;`,
    });
  });

  it("approvePeriodEarningAction still updates the earning and redirects to success", async () => {
    requirePayrollPrepareAccess.mockResolvedValue({
      supabase: { from: () => chainableFake({ data: { id: "earning-1" }, error: null }) },
      studioId: "studio-1",
      user: { id: "user-1" },
    });

    await expect(
      approvePeriodEarningAction(formData({ earningId: "earning-1" })),
    ).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/app/instructor-pay/periods/${PAY_PERIOD_ID}?status=earning_approved;307;`,
    });
  });

  it("voidEmptyPayPeriodAction still runs the RPC and redirects to success", async () => {
    requirePayrollDisbursementAccess.mockResolvedValue({
      supabase: { rpc: async () => ({ error: null }) },
      studioId: "studio-1",
    });

    await expect(voidEmptyPayPeriodAction(formData())).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/app/instructor-pay?status=pay_period_voided;307;",
    });
  });
});
