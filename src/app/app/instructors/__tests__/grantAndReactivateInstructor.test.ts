import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Landmark 1A Slice 6 -- app-layer coverage for grantInstructorCapabilityAction
 * and updateInstructorAction's reactivation branch. The RPCs' own
 * seat-limit/lock/renter-guard/audit logic is covered authoritatively by
 * the live SQL regression suite
 * (test_T_landmark1a_slice6_seat_enforcement.sql) and the real-connection
 * concurrency proofs -- this file's job is the layer above: that the
 * action calls the right RPC with the right params, surfaces the RPC's
 * own friendly error message, and that updateInstructorAction only
 * invokes reactivate_instructor on a genuine inactive->active edge, never
 * on an unrelated field edit or an already-active row.
 */

const STUDIO_ID = "studio-1";
const ACTOR_ID = "actor-1";
const INSTRUCTOR_ID = "instructor-1";

let rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let rpcResult: { error: { message: string } | null } = { error: null };
let instructorRow: { active: boolean } | null = { active: false };

const redirectMock = vi.fn((url: string) => {
  const error = new Error("NEXT_REDIRECT");
  (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`;
  throw error;
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function buildSupabaseStub() {
  return {
    from(table: string) {
      if (table !== "instructors") throw new Error(`Unexpected table: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: instructorRow, error: null }),
                  };
                },
              };
            },
          };
        },
        update() {
          return {
            eq() {
              return {
                eq: async () => ({ error: null }),
              };
            },
          };
        },
      };
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return rpcResult;
    },
  };
}

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireInstructorManageAccess: async () => ({
    supabase: buildSupabaseStub(),
    studioId: STUDIO_ID,
    user: { id: ACTOR_ID },
  }),
}));

vi.mock("@/lib/security/uploads", () => ({
  getOptionalUploadFile: () => null,
  validateUploadFile: async () => ({ ok: true }),
  IMAGE_UPLOAD_MIME_TYPES: [],
}));

vi.mock("@/lib/instructors/audit", () => ({
  writeInstructorAuditEvent: vi.fn(),
}));

const { grantInstructorCapabilityAction, updateInstructorAction } = await import("../actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirect(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow("NEXT_REDIRECT");
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls = [];
  rpcResult = { error: null };
  instructorRow = { active: false };
});

describe("grantInstructorCapabilityAction", () => {
  it("calls grant_instructor_capability with the studio and instructor id, then redirects", async () => {
    await expectRedirect(
      grantInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    );

    expect(rpcCalls).toEqual([
      {
        name: "grant_instructor_capability",
        params: { p_studio_id: STUDIO_ID, p_instructor_id: INSTRUCTOR_ID },
      },
    ]);
  });

  it("throws with the RPC's own friendly seat-limit message rather than a generic error", async () => {
    rpcResult = {
      error: {
        message:
          "This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.",
      },
    };

    await expect(
      grantInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow(/reached its instructor seat limit/);
  });

  it("throws the RPC's renter-guard message unmodified, pointing at hybrid promotion", async () => {
    rpcResult = {
      error: {
        message:
          "This instructor has an independent/floor-rental relationship at this studio. Use the hybrid promotion action, which also establishes the required formal instructional relationship.",
      },
    };

    await expect(
      grantInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow(/hybrid promotion action/);
  });

  it("throws the RPC's account-required message unmodified", async () => {
    rpcResult = {
      error: {
        message: "This instructor must have a linked DanceFlow account before capability can be granted.",
      },
    };

    await expect(
      grantInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow(/linked DanceFlow account/);
  });

  it("throws before ever calling the RPC when instructorId is missing", async () => {
    await expect(grantInstructorCapabilityAction(formDataFor({}))).rejects.toThrow(
      /Missing instructor ID/,
    );
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("updateInstructorAction -- reactivation routing", () => {
  const baseFields = {
    instructorId: INSTRUCTOR_ID,
    firstName: "Jane",
    lastName: "Doe",
    active: "true",
  };

  it("calls reactivate_instructor when the row is currently inactive and the form requests active=true", async () => {
    instructorRow = { active: false };

    await expectRedirect(updateInstructorAction({ error: "" }, formDataFor(baseFields)));

    expect(rpcCalls).toEqual([
      {
        name: "reactivate_instructor",
        params: { p_studio_id: STUDIO_ID, p_instructor_id: INSTRUCTOR_ID },
      },
    ]);
  });

  it("never calls reactivate_instructor when the row is already active", async () => {
    instructorRow = { active: true };

    await expectRedirect(updateInstructorAction({ error: "" }, formDataFor(baseFields)));

    expect(rpcCalls).toHaveLength(0);
  });

  it("never calls reactivate_instructor for a deactivation (active=false submitted)", async () => {
    instructorRow = { active: true };

    await expectRedirect(
      updateInstructorAction({ error: "" }, formDataFor({ ...baseFields, active: "false" })),
    );

    expect(rpcCalls).toHaveLength(0);
  });

  it("returns the RPC's friendly seat-limit message as {error} instead of redirecting when reactivation is blocked", async () => {
    instructorRow = { active: false };
    rpcResult = {
      error: {
        message:
          "This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.",
      },
    };

    const result = await updateInstructorAction({ error: "" }, formDataFor(baseFields));

    expect(result.error).toMatch(/reached its instructor seat limit/);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
