import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * Package Refund P0, Slice 2c-2: coverage for resolvePartialRefundCreditReviewAction
 * (server action) and buildVoidsFromFormData (its pure form-parsing helper).
 * The RPC's own state machine, locking, and validation are covered
 * separately and authoritatively by the local-Docker SQL regression suite
 * (test_N_refund_credit_review_resolution.sql) and the two-session
 * concurrency harness (test_N_concurrency_two_session.sh) -- this file's
 * job is the layer above: role gating, the trusted server-bound client
 * context, the decline/apply intent split, and RPC-error surfacing.
 */

const STUDIO_ID = "studio-1";
const CLIENT_A_ID = "client-a";
const CLIENT_B_ID = "client-b";
const REVIEWER_ID = "reviewer-1";

let currentTables: ReturnType<typeof buildTables>;
let currentRole = "studio_admin";
let currentIsPlatformAdmin = false;
let rpcCalls: Record<string, unknown>[] = [];
let rpcResult: { error: { message: string } | null } = { error: null };

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function buildTables(reconciliations: Row[]) {
  return { package_refund_reconciliations: table(reconciliations) };
}

function setFixture(reconciliations: Row[]) {
  currentTables = buildTables(reconciliations);
  return currentTables;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...createFakeEntitlementClient(currentTables),
    auth: {
      getUser: async () => ({ data: { user: { id: REVIEWER_ID } } }),
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: STUDIO_ID,
    studioRole: currentRole,
    isPlatformAdmin: currentIsPlatformAdmin,
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, ...params });
      return rpcResult;
    },
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { resolvePartialRefundCreditReviewAction, buildVoidsFromFormData } = await import(
  "@/app/app/clients/[id]/actions"
);

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = "studio_admin";
  currentIsPlatformAdmin = false;
  rpcCalls = [];
  rpcResult = { error: null };
});

describe("buildVoidsFromFormData", () => {
  it("collects every void_<itemId> field with a positive integer value", () => {
    const fd = formDataFor({
      "void_item-1": "2",
      "void_item-2": "1",
      unrelated: "5",
    });
    expect(buildVoidsFromFormData(fd)).toEqual([
      { client_package_item_id: "item-1", quantity: 2 },
      { client_package_item_id: "item-2", quantity: 1 },
    ]);
  });

  it("skips zero, empty, and non-numeric entries -- never sends a 0-quantity void", () => {
    const fd = formDataFor({
      "void_item-1": "0",
      "void_item-2": "",
      "void_item-3": "not-a-number",
      "void_item-4": "3",
    });
    expect(buildVoidsFromFormData(fd)).toEqual([{ client_package_item_id: "item-4", quantity: 3 }]);
  });

  it("returns an empty array when no void_ fields are present", () => {
    expect(buildVoidsFromFormData(formDataFor({ intent: "decline" }))).toEqual([]);
  });
});

describe("resolvePartialRefundCreditReviewAction -- role gate", () => {
  it("rejects front_desk before the RPC is ever reached", async () => {
    currentRole = "front_desk";
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);

    const result = await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({ reconciliationId: "recon-1", intent: "decline" }),
    );

    expect(result.error).toMatch(/permission/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it("allows a platform admin through even without an explicit studio role match", async () => {
    currentRole = "";
    currentIsPlatformAdmin = true;
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);

    const result = await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({ reconciliationId: "recon-1", intent: "decline" }),
    );

    expect(result.error).toBe("");
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("resolvePartialRefundCreditReviewAction -- trusted server-bound client context", () => {
  it("rejects a reconciliation belonging to a different client in the same studio, before invoking the RPC", async () => {
    // The reconciliation genuinely belongs to Client B. The bound context
    // is Client A -- simulating a tampered form submitted from Client A's
    // rendered page but naming Client B's reconciliationId.
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_B_ID }]);

    const result = await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({ reconciliationId: "recon-1", intent: "decline" }),
    );

    expect(result.error).toBe("Reconciliation not found for this client.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("succeeds when the bound client id matches the reconciliation's real client_id", async () => {
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);

    const result = await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({ reconciliationId: "recon-1", intent: "decline" }),
    );

    expect(result.error).toBe("");
    expect(rpcCalls[0]).toMatchObject({ p_reconciliation_id: "recon-1", p_studio_id: STUDIO_ID });
  });
});

describe("resolvePartialRefundCreditReviewAction -- decline cannot leak quantities", () => {
  it("forces p_voids=[] for a decline submission even when quantity fields are populated", async () => {
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);

    await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({
        reconciliationId: "recon-1",
        intent: "decline",
        "void_item-1": "3",
        "void_item-2": "1",
      }),
    );

    expect(rpcCalls[0].p_voids).toEqual([]);
  });
});

describe("resolvePartialRefundCreditReviewAction -- apply maps form fields to p_voids", () => {
  it("builds the correct p_voids JSON shape from a well-formed apply submission", async () => {
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);

    await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({
        reconciliationId: "recon-1",
        intent: "apply",
        "void_item-1": "2",
        reviewerNotes: "Reviewed and approved",
      }),
    );

    expect(rpcCalls[0]).toMatchObject({
      p_voids: [{ client_package_item_id: "item-1", quantity: 2 }],
      p_reviewer_notes: "Reviewed and approved",
      p_reviewer_id: REVIEWER_ID,
    });
  });
});

describe("resolvePartialRefundCreditReviewAction -- RPC error surfacing", () => {
  it("surfaces an RPC error as { error } rather than throwing", async () => {
    setFixture([{ id: "recon-1", studio_id: STUDIO_ID, client_id: CLIENT_A_ID }]);
    rpcResult = { error: { message: "This package has already reached a full refund; this review is no longer actionable." } };

    const result = await resolvePartialRefundCreditReviewAction(
      CLIENT_A_ID,
      { error: "" },
      formDataFor({ reconciliationId: "recon-1", intent: "decline" }),
    );

    expect(result.error).toBe(
      "This package has already reached a full refund; this review is no longer actionable.",
    );
  });
});
