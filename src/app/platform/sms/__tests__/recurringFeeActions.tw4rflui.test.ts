import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieWrites: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieWrites.push({ name, value }) }) }));

const ADMIN = "a6000000-0000-4000-8000-000000000501";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));

const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, { data?: unknown; error?: { code?: string; message?: string } }> = {};
let clientsBuilt = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    clientsBuilt += 1;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        const r = replies[fn];
        if (!r) return { data: null, error: { code: "42883", message: "missing" } };
        return { data: r.data ?? null, error: r.error ?? null };
      },
    };
  },
}));

import {
  rflCancelAuthorizeAction, rflCancelBeginAction, rflCancelFinishAction, rflCancelResolveAction, rflCancelWithdrawAction, rflDisposeExposureAction, rflDualApproveAction,
  rflDualRejectAction, rflDualRequestAction, rflPilotCoverAction, rflSetSwitchAction, rflSuspendAction, rflVarianceAckAction,
} from "../recurringFeeActions";

const U = (n: number) => `b${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const RES = U(1);
const STUDIO = U(2);
const ENTITY = U(3);
const OP = U(4);
const REQ = U(5);
const NOTE = "A written note that is long enough.";
const REF = "WRITTEN-REF-2026-10-001";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(action: (f: FormData) => Promise<void>, fields: Record<string, string>): Promise<{ url: string; message: string }> {
  await expect(action(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  const flash = JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { message: string };
  return { url: redirects[redirects.length - 1], message: flash.message };
}
const writes = () => rpc.filter((c) => !["tw4_rfl_admin_overview", "tw4_rfl_dual_list", "tw4_rfl_health", "tw4_rfl_exposure_report", "tw4_rfl_variance_report"].includes(c.fn));

const overviewOf = (kind: string, pilot = false) => ({
  data: {
    resources: [{ resource_id: RES, legal_entity_id: ENTITY, studio_id: STUDIO, kind, fee_kind: "number_rent", provider_state: "active", current_period: pilot ? "uncovered:no_pilot_approval" : "covered:charge", next_period: "covered:charge" }],
  },
});
const dualOf = (action: string, status: string, periodKey: string | null = "2026-10") => ({
  data: [{ request_id: REQ, action, resource_id: RES, requested_by: U(8), status, period_key: periodKey }],
});

beforeEach(() => {
  redirects.length = 0;
  cookieWrites.length = 0;
  rpc.length = 0;
  replies = {};
  clientsBuilt = 0;
  platformAdmin = true;
});

describe("authorization", () => {
  it("every action authorizes first: a non-admin causes no client and no store call", async () => {
    platformAdmin = false;
    const all: [(f: FormData) => Promise<void>, Record<string, string>][] = [
      [rflSetSwitchAction, { switch: "scan", enabled: "on", reason: NOTE, confirm: "yes" }],
      [rflVarianceAckAction, { chargeId: U(6), note: NOTE }],
      [rflDualRequestAction, { action: "cancel_number", resourceId: RES, reason: NOTE, approvalRef: REF }],
      [rflDualApproveAction, { requestId: REQ, note: NOTE }],
      [rflDualRejectAction, { requestId: REQ, note: NOTE }],
      [rflDisposeExposureAction, { resourceId: RES, periodKey: "2026-10", disposition: "not_billed_confirmed", note: NOTE }],
      [rflPilotCoverAction, { resourceId: RES, periodKey: "2026-10", approvalRef: REF, ack: "yes" }],
      [rflSuspendAction, { studioId: STUDIO, reason: NOTE }],
      [rflCancelAuthorizeAction, { resourceId: RES, approvalRef: REF, decidedBy: "owner_written", reason: NOTE, irreversibleAck: "yes" }],
      [rflCancelBeginAction, { operationId: OP }],
      [rflCancelFinishAction, { operationId: OP, outcome: "refused" }],
      [rflCancelResolveAction, { operationId: OP, resolution: "still_active", note: NOTE }],
      [rflCancelWithdrawAction, { operationId: OP, note: NOTE }],
    ];
    for (const [action, fields] of all) {
      await expect(action(form(fields))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    }
    expect(rpc).toHaveLength(0);
    expect(clientsBuilt).toBe(0);
    expect(cookieWrites).toHaveLength(0);
  });

  it("the actor is the session administrator, never a form value", async () => {
    replies.tw4_rfl_set_switch = { data: { switch: "scan", enabled: true } };
    await run(rflSetSwitchAction, { switch: "scan", enabled: "on", reason: NOTE, confirm: "yes", actor: "evil", p_actor: "evil", actorId: "evil" });
    expect(rpc).toEqual([{ fn: "tw4_rfl_set_switch", args: { p_switch: "scan", p_enabled: true, p_actor: ADMIN, p_reason: NOTE } }]);

    replies.tw4_rfl_dual_approve = { data: { status: "approved" } };
    await run(rflDualApproveAction, { requestId: REQ, note: NOTE, actor: "evil" });
    expect(rpc[1].args.p_actor).toBe(ADMIN);
  });
});

describe("switches", () => {
  it("needs a written reason and the confirmation", async () => {
    let r = await run(rflSetSwitchAction, { switch: "scan", enabled: "on", reason: "short", confirm: "yes" });
    expect(r.url).toBe("/platform/sms?rfl_error=1#recurring-fees");
    r = await run(rflSetSwitchAction, { switch: "scan", enabled: "on", reason: NOTE });
    expect(r.message).toContain("Confirm");
    r = await run(rflSetSwitchAction, { switch: "bogus", enabled: "on", reason: NOTE, confirm: "yes" });
    expect(r.url).toContain("rfl_error=1");
    expect(rpc).toHaveLength(0);
  });

  it("success redirects with a notice cookie, never the text in the URL", async () => {
    replies.tw4_rfl_set_switch = { data: { switch: "delivery", enabled: false } };
    const r = await run(rflSetSwitchAction, { switch: "delivery", enabled: "off", reason: NOTE, confirm: "yes" });
    expect(r.url).toBe("/platform/sms?rfl=1#recurring-fees");
    expect(r.message).toContain("OFF");
    expect(cookieWrites[0].name).toBe("tw4_rfl_flash");
    expect(r.url).not.toContain("OFF");
  });
});

describe("input validation", () => {
  it("rejects bad uuids, periods and lengths before any database call", async () => {
    await run(rflVarianceAckAction, { chargeId: "not-a-uuid", note: NOTE });
    await run(rflVarianceAckAction, { chargeId: U(6), note: "too short" });
    await run(rflVarianceAckAction, { chargeId: U(6), note: "x".repeat(501) });
    await run(rflDualRequestAction, { action: "absorb_exposure", resourceId: RES, reason: NOTE, periodKey: "2026-13" });
    await run(rflDualRequestAction, { action: "absorb_exposure", resourceId: RES, reason: NOTE });
    await run(rflDualRequestAction, { action: "cancel_number", resourceId: RES, reason: NOTE, approvalRef: "short", decidedBy: "owner_written" });
    await run(rflDualRequestAction, { action: "cancel_number", resourceId: RES, reason: NOTE, approvalRef: REF });
    await run(rflDualRequestAction, { action: "cancel_number", resourceId: RES, reason: NOTE, approvalRef: REF, decidedBy: "policy_lapse" });
    await run(rflDualRequestAction, { action: "mint_money", resourceId: RES, reason: NOTE });
    await run(rflDualApproveAction, { requestId: "x", note: NOTE });
    await run(rflSuspendAction, { studioId: STUDIO, reason: "no" });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "confirmed" });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "refused", evidenceDigest: "has spaces and is odd" });
    await run(rflCancelResolveAction, { operationId: OP, resolution: "cancelled", note: NOTE });
    await run(rflCancelResolveAction, { operationId: OP, resolution: "still_active", note: NOTE });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "confirmed", evidenceDigest: "sha256:0123456789abcdef" });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "confirmed", evidenceDigest: "0123456789ABCDEF".repeat(4) });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "refused", errorCode: "timeout" });
    await run(rflCancelFinishAction, { operationId: OP, outcome: "refused" });
    await run(rflCancelBeginAction, { operationId: "nope" });
    expect(rpc).toHaveLength(0);
  });

  it("a cancellation authorization needs the irreversibility acknowledgement", async () => {
    const r = await run(rflCancelAuthorizeAction, { resourceId: RES, approvalRef: REF, decidedBy: "owner_written", reason: NOTE });
    expect(r.message).toContain("cannot be undone");
    expect(rpc).toHaveLength(0);
  });

  it("a pilot approval needs the not-standing acknowledgement", async () => {
    const r = await run(rflPilotCoverAction, { resourceId: RES, periodKey: "2026-10", approvalRef: REF });
    expect(r.message).toContain("not a standing authorization");
    expect(rpc).toHaveLength(0);
  });
});

describe("dual control gating", () => {
  it("absorbing is refused without an approved request, and calls the store with one", async () => {
    replies.tw4_rfl_dual_list = dualOf("absorb_exposure", "pending");
    let r = await run(rflDisposeExposureAction, { resourceId: RES, periodKey: "2026-10", disposition: "absorbed", note: NOTE });
    expect(r.message).toContain("approved dual-control request");
    expect(writes()).toHaveLength(0);

    replies.tw4_rfl_dual_list = dualOf("absorb_exposure", "approved");
    replies.tw4_rfl_exposure_dispose = { data: { replayed: false } };
    r = await run(rflDisposeExposureAction, { resourceId: RES, periodKey: "2026-10", disposition: "absorbed", note: NOTE });
    expect(r.url).toContain("rfl=1");
    expect(writes()).toEqual([{ fn: "tw4_rfl_exposure_dispose", args: { p_resource_id: RES, p_period_key: "2026-10", p_actor: ADMIN, p_disposition: "absorbed", p_note: NOTE } }]);
  });

  it("an approved request for a different period does not unlock absorption", async () => {
    replies.tw4_rfl_dual_list = dualOf("absorb_exposure", "approved", "2026-09");
    await run(rflDisposeExposureAction, { resourceId: RES, periodKey: "2026-10", disposition: "absorbed", note: NOTE });
    expect(writes()).toHaveLength(0);
  });

  it("not_billed_confirmed never needs dual control", async () => {
    replies.tw4_rfl_exposure_dispose = { data: {} };
    await run(rflDisposeExposureAction, { resourceId: RES, periodKey: "2026-10", disposition: "not_billed_confirmed", note: NOTE });
    expect(writes()).toHaveLength(1);
    expect(rpc.some((c) => c.fn === "tw4_rfl_dual_list")).toBe(false);
  });

  it("a number cancellation needs an approved cancel_number request; a campaign does not", async () => {
    replies.tw4_rfl_admin_overview = overviewOf("number");
    replies.tw4_rfl_dual_list = dualOf("cancel_number", "pending");
    const fields = { resourceId: RES, approvalRef: REF, decidedBy: "owner_written", reason: NOTE, irreversibleAck: "yes" };
    let r = await run(rflCancelAuthorizeAction, fields);
    expect(r.message).toContain("dual-control");
    expect(writes()).toHaveLength(0);

    replies.tw4_rfl_dual_list = dualOf("cancel_number", "approved");
    replies.tw4_rfl_cancel_authorize = { data: { operation_id: OP } };
    r = await run(rflCancelAuthorizeAction, fields);
    expect(r.message).toContain(OP);
    expect(r.message).toContain("never calls Twilio");
    expect(writes()).toEqual([{ fn: "tw4_rfl_cancel_authorize", args: { p_resource_id: RES, p_actor: ADMIN, p_approval_ref: REF, p_decided_by: "owner_written", p_reason: NOTE, p_irreversible_ack: true } }]);

    rpc.length = 0;
    replies.tw4_rfl_admin_overview = overviewOf("campaign");
    replies.tw4_rfl_dual_list = { data: [] };
    await run(rflCancelAuthorizeAction, fields);
    expect(writes()).toHaveLength(1);
  });

  it("the request and approval go through the contract functions", async () => {
    replies.tw4_rfl_dual_request = { data: { request_id: REQ } };
    await run(rflDualRequestAction, { action: "absorb_exposure", resourceId: RES, periodKey: "2026-10", reason: NOTE });
    expect(rpc[0]).toEqual({ fn: "tw4_rfl_dual_request", args: { p_actor: ADMIN, p_action: "absorb_exposure", p_resource_id: RES, p_period_key: "2026-10", p_reason: NOTE, p_approval_ref: null } });
    expect(rpc[0].args).not.toHaveProperty("p_decided_by");
    rpc.length = 0;
    await run(rflDualRequestAction, { action: "cancel_number", resourceId: RES, reason: NOTE, approvalRef: REF, periodKey: "2026-10", decidedBy: "founder_written" });
    expect(rpc[0].args).toMatchObject({ p_action: "cancel_number", p_period_key: null, p_approval_ref: REF, p_decided_by: "founder_written" });
    // an absorb request sends no decision type (an older database without the parameter still accepts it)
    expect(rpc[0].fn).toBe("tw4_rfl_dual_request");
  });

  it("a number is never authorized on a policy lapse, even if the form says so", async () => {
    replies.tw4_rfl_admin_overview = overviewOf("number");
    replies.tw4_rfl_dual_list = dualOf("cancel_number", "approved");
    const r = await run(rflCancelAuthorizeAction, { resourceId: RES, approvalRef: REF, decidedBy: "policy_lapse", reason: NOTE, irreversibleAck: "yes" });
    expect(r.message).toContain("never cancelled on a policy lapse");
    expect(writes()).toHaveLength(0);
  });

  it("approval statuses other than approved read as failures", async () => {
    replies.tw4_rfl_dual_approve = { data: { status: "invalidated" } };
    expect((await run(rflDualApproveAction, { requestId: REQ, note: NOTE })).url).toContain("rfl_error=1");
    replies.tw4_rfl_dual_approve = { data: { status: "expired" } };
    expect((await run(rflDualApproveAction, { requestId: REQ, note: NOTE })).url).toContain("rfl_error=1");
    replies.tw4_rfl_dual_approve = { data: { status: "approved" } };
    expect((await run(rflDualApproveAction, { requestId: REQ, note: NOTE })).url).toContain("rfl=1");
  });
});

describe("pilot approvals", () => {
  it("only for a live resource of the pilot business", async () => {
    replies.tw4_rfl_admin_overview = overviewOf("number", false);
    let r = await run(rflPilotCoverAction, { resourceId: RES, periodKey: "2026-10", approvalRef: REF, ack: "yes" });
    expect(r.message).toContain("pilot business");
    expect(writes()).toHaveLength(0);

    replies.tw4_rfl_admin_overview = overviewOf("number", true);
    replies.tw4_rfl_pilot_cover = { data: { cover_id: U(7) } };
    r = await run(rflPilotCoverAction, { resourceId: RES, periodKey: "2026-10", approvalRef: REF, ack: "yes" });
    expect(r.message).toContain("does not renew");
    expect(writes()).toEqual([{ fn: "tw4_rfl_pilot_cover", args: { p_resource_id: RES, p_period_key: "2026-10", p_approval_ref: REF, p_actor: ADMIN } }]);
  });
});

describe("cancellation steps and safety suspension", () => {
  it("begin never reveals the provider SID and always says the operator does the console step", async () => {
    replies.tw4_rfl_cancel_begin = { data: { action: "execute", provider_sid: "PN0123456789abcdef0123456789abcdef", resource_kind: "number" } };
    const r = await run(rflCancelBeginAction, { operationId: OP });
    expect(r.message).not.toContain("PN0123456789abcdef0123456789abcdef");
    expect(r.message).not.toContain("cdef");
    expect(r.message).not.toContain("0123456789");
    expect(r.message).toContain("number, operation " + OP.slice(0, 8));
    expect(r.message).toContain("NOT cancelled anything");
  });

  it("finish and resolve forward the evidence digest", async () => {
    replies.tw4_rfl_cancel_finish = { data: { status: "confirmed" } };
    const D = "0123456789abcdef".repeat(4);
    await run(rflCancelFinishAction, { operationId: OP, outcome: "confirmed", evidenceDigest: D });
    expect(rpc[0]).toEqual({ fn: "tw4_rfl_cancel_finish", args: { p_operation_id: OP, p_actor: ADMIN, p_outcome: "confirmed", p_evidence_digest: D, p_error_code: null } });
    replies.tw4_rfl_cancel_resolve = { data: { status: "resolved" } };
    await run(rflCancelResolveAction, { operationId: OP, resolution: "still_active", evidenceDigest: D, note: NOTE });
    expect(rpc[1].args).toMatchObject({ p_resolution: "still_active", p_evidence_digest: D, p_note: NOTE });
    replies.tw4_rfl_cancel_withdraw = { data: {} };
    await run(rflCancelWithdrawAction, { operationId: OP, note: NOTE });
    expect(rpc[2].fn).toBe("tw4_rfl_cancel_withdraw");
  });

  it("the safety suspension never consults dual control and says it stops DanceFlow sending only", async () => {
    replies.tw4_rfl_suspend_df = { data: { provider_fees_continue_for: 2 } };
    const r = await run(rflSuspendAction, { studioId: STUDIO, reason: NOTE });
    expect(rpc).toEqual([{ fn: "tw4_rfl_suspend_df", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_reason: NOTE, p_hold: false } }]);
    expect(r.message).toContain("Nothing was cancelled or released at Twilio");
  });
});

describe("error mapping", () => {
  it("maps SQLSTATEs to fixed sentences and never leaks the database message", async () => {
    replies.tw4_rfl_dual_approve = { error: { code: "42501", message: "approver must differ from requester u-123 secret" } };
    let r = await run(rflDualApproveAction, { requestId: REQ, note: NOTE });
    expect(r.url).toContain("rfl_error=1");
    expect(r.message).toContain("never be approved by the administrator who made it");
    expect(r.message).not.toContain("secret");

    replies.tw4_rfl_cancel_begin = { error: { code: "TW042", message: "raw text with SID PN123" } };
    r = await run(rflCancelBeginAction, { operationId: OP });
    expect(r.message).toContain("approval is missing");
    expect(r.message).not.toContain("PN123");

    replies.tw4_rfl_set_switch = { error: { code: "XX999", message: "internal" } };
    r = await run(rflSetSwitchAction, { switch: "scan", enabled: "on", reason: NOTE, confirm: "yes" });
    expect(r.message).toContain("The action failed");
    expect(r.message).not.toContain("internal");
  });

  it("a function that is not installed reads as not available", async () => {
    const r = await run(rflSetSwitchAction, { switch: "scan", enabled: "on", reason: NOTE, confirm: "yes" });
    expect(r.message).toContain("not available in this environment");
  });
});
