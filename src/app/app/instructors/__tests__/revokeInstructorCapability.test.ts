import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Landmark 1A Slice 7 -- app-layer coverage for revokeInstructorCapabilityAction
 * and the RevokeCapabilityControl. The RPC's authorization, exclusive seat
 * lock, future-work blocker, idempotency and audit are covered authoritatively
 * by test_T_landmark1a_slice7_capability_revocation.sql and the real
 * concurrency harness; this file covers the layer above: the action calls
 * only the RPC, passes its safe message through verbatim, and the control is
 * shown only for a capable instructor and an authorized actor behind an
 * explicit confirmation.
 */

const STUDIO_ID = "studio-1";
const INSTRUCTOR_ID = "instructor-1";

let rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
let rpcResult: { error: { message: string } | null } = { error: null };
let tableTouched: string[] = [];
const revalidated: string[] = [];

const redirectMock = vi.fn((url: string) => {
  const error = new Error("NEXT_REDIRECT");
  (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};303;`;
  throw error;
});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireInstructorManageAccess: async () => ({
    supabase: {
      // The action must never write tables directly -- only call the RPC.
      from(table: string) {
        tableTouched.push(table);
        throw new Error(`revoke action must not touch table ${table}`);
      },
      rpc: async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        return rpcResult;
      },
    },
    studioId: STUDIO_ID,
    user: { id: "actor-1" },
  }),
}));

vi.mock("@/lib/security/uploads", () => ({
  getOptionalUploadFile: () => null,
  validateUploadFile: async () => ({ ok: true }),
  IMAGE_UPLOAD_MIME_TYPES: [],
}));
vi.mock("@/lib/instructors/audit", () => ({ writeInstructorAuditEvent: vi.fn() }));

const actionsModule = await import("../actions");
const { revokeInstructorCapabilityAction } = actionsModule;
const { RevokeCapabilityControl } = await import("../[id]/RevokeCapabilityControl");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls = [];
  tableTouched = [];
  revalidated.length = 0;
  rpcResult = { error: null };
});

describe("revokeInstructorCapabilityAction", () => {
  it("calls revoke_instructor_capability with the studio and instructor id, revalidates, then redirects", async () => {
    await expect(
      revokeInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(rpcCalls).toEqual([
      {
        name: "revoke_instructor_capability",
        params: { p_studio_id: STUDIO_ID, p_instructor_id: INSTRUCTOR_ID },
      },
    ]);
    expect(tableTouched).toEqual([]);
    expect(revalidated).toEqual(["/app/instructors", `/app/instructors/${INSTRUCTOR_ID}`]);
    expect(redirectMock).toHaveBeenCalledWith(`/app/instructors/${INSTRUCTOR_ID}`);
  });

  it("passes the RPC's future-work blocker message (safe counts only) through verbatim", async () => {
    const message =
      "Instructional capability cannot be removed while this instructor still has future work: 2 upcoming appointment(s), 1 booking request(s), 0 self-service action request(s). Reassign, cancel, or resolve them first.";
    rpcResult = { error: { message } };

    await expect(
      revokeInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow(message);
    expect(revalidated).toEqual([]);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("passes authorization / not-found RPC messages through unmodified", async () => {
    rpcResult = { error: { message: "Not authorized to manage instructors for this studio." } };
    await expect(
      revokeInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow("Not authorized to manage instructors for this studio.");
  });

  it("treats an already-incapable instructor as success (the RPC is an idempotent no-op)", async () => {
    rpcResult = { error: null };
    await expect(
      revokeInstructorCapabilityAction(formDataFor({ instructorId: INSTRUCTOR_ID })),
    ).rejects.toThrow("NEXT_REDIRECT"); // redirect, not a thrown business error
    expect(rpcCalls).toHaveLength(1);
  });

  it("rejects a missing instructor id without calling the RPC", async () => {
    await expect(revokeInstructorCapabilityAction(formDataFor({}))).rejects.toThrow("Missing instructor ID.");
    expect(rpcCalls).toEqual([]);
  });

  it("is exported as an async function (server-action file requirement)", () => {
    expect(revokeInstructorCapabilityAction.constructor.name).toBe("AsyncFunction");
  });
});

describe("RevokeCapabilityControl", () => {
  const render = (props: { canInstruct: boolean; canManage: boolean }) =>
    renderToStaticMarkup(createElement(RevokeCapabilityControl, { instructorId: INSTRUCTOR_ID, ...props }));

  it("renders for a capable instructor and an authorized actor, behind a closed confirmation", () => {
    const html = render({ canInstruct: true, canManage: true });

    expect(html).toContain("Remove instructional capability");
    expect(html).toContain(`name="instructorId" value="${INSTRUCTOR_ID}"`);
    expect(html).toContain("Confirm: remove instructional capability");
    // Native <details>: closed by default, so nothing can be submitted without opening it.
    expect(html).toMatch(/<details(?![^>]*\bopen\b)/);
    // Confirmation copy: future work, seat, history.
    expect(html).toMatch(/future instructional work/);
    expect(html).toMatch(/frees this instructor(&#x27;|')s instructional seat/);
    expect(html).toMatch(/Past and historical work stays on record/);
  });

  it("does not render for an instructor who is not capable", () => {
    expect(render({ canInstruct: false, canManage: true })).toBe("");
  });

  it("does not render for an actor who cannot manage instructors", () => {
    expect(render({ canInstruct: true, canManage: false })).toBe("");
  });
});
