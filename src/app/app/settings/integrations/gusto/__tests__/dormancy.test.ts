import { describe, expect, it, vi } from "vitest";

/**
 * Proves all 6 Gusto settings actions are blocked at their single shared
 * chokepoint (gustoContext()) while the integration is dormant -- before
 * any permission check, any studio_gusto_connections read, or any Gusto
 * client/token call. requireSettingsManageAccess and every Gusto
 * client/token export are mocked to throw if reached at all, so a
 * regression that moves the dormancy check later fails loudly here.
 */

function redirectError(url: string) {
  const error = new Error("NEXT_REDIRECT");
  (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
  return error;
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw redirectError(url);
  },
}));

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireSettingsManageAccess: () => {
    throw new Error("Unexpected call to requireSettingsManageAccess while dormant");
  },
}));

function throwingClientExport(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(`Unexpected call to Gusto client export "${name}" while dormant`);
  };
}

vi.mock("@/lib/integrations/gusto/client", () => ({
  createGustoDemoEmployee: throwingClientExport("createGustoDemoEmployee"),
  getGustoCompany: throwingClientExport("getGustoCompany"),
  gustoEnvironment: throwingClientExport("gustoEnvironment"),
  getGustoWorkers: throwingClientExport("getGustoWorkers"),
}));

vi.mock("@/lib/integrations/gusto/token", () => ({
  getValidGustoAccessToken: throwingClientExport("getValidGustoAccessToken"),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("Unexpected admin client creation while dormant");
  },
}));

const {
  checkGustoConnectionAction,
  disconnectGustoAction,
  syncGustoWorkersAction,
  saveGustoWorkerMatchAction,
  clearGustoWorkerMatchAction,
  createGustoDemoWorkerAction,
} = await import("../actions");

const DORMANT_URL = "/app/settings/integrations/gusto?status=gusto_not_available";

function formData(fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectDormantRedirect(run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({
    digest: `NEXT_REDIRECT;replace;${DORMANT_URL};307;`,
  });
}

describe("Gusto settings actions while dormant", () => {
  it("checkGustoConnectionAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => checkGustoConnectionAction());
  });

  it("disconnectGustoAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => disconnectGustoAction());
  });

  it("syncGustoWorkersAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() => syncGustoWorkersAction());
  });

  it("saveGustoWorkerMatchAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() =>
      saveGustoWorkerMatchAction(formData({ instructorId: "i-1", workerUuid: "w-1" })),
    );
  });

  it("clearGustoWorkerMatchAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() =>
      clearGustoWorkerMatchAction(formData({ instructorId: "i-1" })),
    );
  });

  it("createGustoDemoWorkerAction redirects to the dormant status", async () => {
    await expectDormantRedirect(() =>
      createGustoDemoWorkerAction(formData({ instructorId: "i-1" })),
    );
  });
});
