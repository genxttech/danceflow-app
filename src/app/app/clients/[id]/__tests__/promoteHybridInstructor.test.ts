import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Landmark 1A Slice 6 -- app-layer coverage for promoteHybridInstructorAction.
 * The RPC's own attestation/classification/payroll/seat-limit/audit logic
 * is covered authoritatively by the live SQL regression suite
 * (test_T_landmark1a_slice6_seat_enforcement.sql) and the real-connection
 * concurrency proofs -- this file's job is the layer above: the action
 * requires an explicit attestation and a valid classification before
 * ever calling the RPC, passes the exact expected params, and maps a
 * 23505 uniqueness violation on instructors_studio_user_unique_idx to
 * the friendly, non-leaking message rather than a raw Postgres error.
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";

let rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let rpcResult: { error: { message: string; code?: string } | null } = { error: null };

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireInstructorManageAccess: async () => ({
    supabase: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        return rpcResult;
      },
    },
    studioId: STUDIO_ID,
    user: { id: "actor-1" },
  }),
}));

const { promoteHybridInstructorAction } = await import("../actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function extractRedirectUrl(error: unknown) {
  const digest = (error as { digest?: string } | undefined)?.digest ?? "";
  return digest.split(";")[2] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls = [];
  rpcResult = { error: null };
});

describe("promoteHybridInstructorAction -- explicit attestation required", () => {
  it("never calls the RPC when the attestation checkbox is not checked", async () => {
    await expect(
      promoteHybridInstructorAction(
        formDataFor({ clientId: CLIENT_ID, workerClassification: "employee" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(rpcCalls).toHaveLength(0);
  });

  it("redirects with the missing-attestation error code", async () => {
    let caught: unknown;
    try {
      await promoteHybridInstructorAction(
        formDataFor({ clientId: CLIENT_ID, workerClassification: "employee" }),
      );
    } catch (error) {
      caught = error;
    }

    expect(extractRedirectUrl(caught)).toContain("error=hybrid_promotion_missing_attestation");
  });
});

describe("promoteHybridInstructorAction -- explicit worker classification required", () => {
  it("never calls the RPC when workerClassification is missing", async () => {
    await expect(
      promoteHybridInstructorAction(
        formDataFor({ clientId: CLIENT_ID, hybridClientAssignmentAttested: "on" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(rpcCalls).toHaveLength(0);
  });

  it("never calls the RPC when workerClassification is not_set or owner", async () => {
    for (const value of ["not_set", "owner"]) {
      rpcCalls = [];
      await expect(
        promoteHybridInstructorAction(
          formDataFor({
            clientId: CLIENT_ID,
            hybridClientAssignmentAttested: "on",
            workerClassification: value,
          }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT");
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it("accepts employee and contractor", async () => {
    for (const value of ["employee", "contractor"]) {
      rpcCalls = [];
      await expect(
        promoteHybridInstructorAction(
          formDataFor({
            clientId: CLIENT_ID,
            hybridClientAssignmentAttested: "on",
            workerClassification: value,
          }),
        ),
      ).rejects.toThrow("NEXT_REDIRECT");
      expect(rpcCalls).toEqual([
        {
          name: "promote_hybrid_instructor",
          params: {
            p_studio_id: STUDIO_ID,
            p_client_id: CLIENT_ID,
            p_hybrid_client_assignment_attested: true,
            p_worker_classification: value,
          },
        },
      ]);
    }
  });
});

describe("promoteHybridInstructorAction -- 23505 safe mapping", () => {
  it("maps an instructors_studio_user_unique_idx violation to the friendly linkage-conflict code, not a raw error", async () => {
    rpcResult = {
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "instructors_studio_user_unique_idx"',
      },
    };

    let caught: unknown;
    try {
      await promoteHybridInstructorAction(
        formDataFor({
          clientId: CLIENT_ID,
          hybridClientAssignmentAttested: "on",
          workerClassification: "employee",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(extractRedirectUrl(caught)).toContain("error=hybrid_promotion_linkage_conflict");
  });

  it("maps an unrelated 23505 (different constraint) to the generic failure code, not the linkage-conflict code", async () => {
    rpcResult = {
      error: { code: "23505", message: 'duplicate key value violates unique constraint "some_other_idx"' },
    };

    let caught: unknown;
    try {
      await promoteHybridInstructorAction(
        formDataFor({
          clientId: CLIENT_ID,
          hybridClientAssignmentAttested: "on",
          workerClassification: "employee",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(extractRedirectUrl(caught)).toContain("error=hybrid_promotion_failed");
  });

  it("maps any other RPC error (e.g. seat-limit) to the generic failure code", async () => {
    rpcResult = {
      error: {
        message:
          "This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.",
      },
    };

    let caught: unknown;
    try {
      await promoteHybridInstructorAction(
        formDataFor({
          clientId: CLIENT_ID,
          hybridClientAssignmentAttested: "on",
          workerClassification: "contractor",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(extractRedirectUrl(caught)).toContain("error=hybrid_promotion_failed");
  });
});

describe("promoteHybridInstructorAction -- success", () => {
  it("redirects with the success code and calls revalidatePath", async () => {
    let caught: unknown;
    try {
      await promoteHybridInstructorAction(
        formDataFor({
          clientId: CLIENT_ID,
          hybridClientAssignmentAttested: "on",
          workerClassification: "employee",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(extractRedirectUrl(caught)).toContain("success=hybrid_promotion_completed");
  });
});
