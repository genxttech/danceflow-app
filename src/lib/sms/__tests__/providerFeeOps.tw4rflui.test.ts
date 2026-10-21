import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadRecurringFeeOps, parseDual, parseExposures, parseHealth, parseOverview, parseVariances, ProviderFeeOpsError, ProviderFeeOpsStore } from "../providerFeeOps";

const U = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const ACTOR = U(9);

type Reply = { data?: unknown; error?: { code?: string; message?: string } | null } | "throw";
function client(replies: Record<string, Reply>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const r = replies[fn];
      if (r === "throw") throw new Error("boom");
      if (!r) return { data: null, error: { code: "42883", message: "function does not exist" } };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
}

describe("parsers", () => {
  it("parseHealth fails closed: switches off and stale unless explicitly otherwise", () => {
    expect(parseHealth("x")).toBeNull();
    expect(parseHealth([])).toBeNull();
    const h = parseHealth({});
    expect(h).toMatchObject({ scanSwitch: false, deliverySwitch: false, stale: true, runsFailed24h: 0, alertsExhausted: 0, oldestPendingAlertAgeSeconds: null });
    expect(parseHealth({ scan_switch: "true", stale: false, runs_failed_24h: -4, alerts_failed: "3" })).toMatchObject({ scanSwitch: false, stale: false, runsFailed24h: 0, alertsFailed: 0 });
    expect(parseHealth({ scan_switch: true, delivery_switch: true, stale: false, alerts_exhausted: 2, oldest_pending_alert_age_seconds: 90 })).toMatchObject({ scanSwitch: true, deliverySwitch: true, alertsExhausted: 2, oldestPendingAlertAgeSeconds: 90 });
  });

  it("parseOverview drops unknown values and marks the pilot business from the cover states", () => {
    expect(parseOverview({})).toBeNull();
    const o = parseOverview({
      resources: [
        { resource_id: U(1), legal_entity_id: U(2), studio_id: U(3), kind: "number", fee_kind: "number_rent", provider_state: "active", df_sending: true, current_period: "uncovered:no_pilot_approval", next_period: "uncovered:no_pilot_approval", open_cancel_operation: null },
        { resource_id: U(4), legal_entity_id: U(2), studio_id: U(3), kind: "campaign", provider_state: "active", current_period: "covered:charge", next_period: "covered:charge", open_cancel_operation: "in_flight" },
        { resource_id: U(5), legal_entity_id: U(2), studio_id: U(3), kind: "mystery", provider_state: "active" },
        { resource_id: "not-a-uuid", legal_entity_id: U(2), studio_id: U(3), kind: "number", provider_state: "active" },
        { resource_id: U(6), legal_entity_id: U(2), studio_id: U(3), kind: "number", provider_state: "weird" },
        { resource_id: U(7), legal_entity_id: U(2), studio_id: U(3), kind: "number", provider_state: "active", open_cancel_operation: "zzz" },
      ],
      alerts_waiting: 4,
      cancel_operations_open: 1,
    });
    expect(o?.resources.map((r) => r.resourceId)).toEqual([U(1), U(4), U(7)]);
    expect(o?.resources[0]).toMatchObject({ pilot: true, kind: "number" });
    expect(o?.resources[1]).toMatchObject({ pilot: false, openCancelOperation: "in_flight" });
    expect(o?.resources[2].openCancelOperation).toBeNull();
    expect(o).toMatchObject({ alertsWaiting: 4, cancelOperationsOpen: 1 });
  });

  it("parseExposures skips malformed rows and unknown buckets", () => {
    expect(parseExposures({})).toBeNull();
    const rows = parseExposures([
      { legal_entity_id: U(2), resource_id: U(1), period_key: "2026-10", reason: "no_pilot_approval", aging_bucket: "8-30", expected_provider_cents: 100, provider_billed_cents: 0, dual_request_status: "approved", age_days: 12 },
      { legal_entity_id: U(2), resource_id: U(1), period_key: "2026-13" },
      { legal_entity_id: U(2), resource_id: U(8), period_key: "2026-09", aging_bucket: "forever", dual_request_status: "consumed", resource_kind: "other" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows?.[0]).toMatchObject({ agingBucket: "8-30", dualRequestStatus: "approved", expectedProviderCents: 100, ageDays: 12 });
    expect(rows?.[1]).toMatchObject({ agingBucket: null, dualRequestStatus: null, resourceKind: null, reason: "unknown" });
  });

  it("parseVariances does not carry the provider reference or the acknowledging user", () => {
    const rows = parseVariances([{ charge_id: U(1), legal_entity_id: U(2), kind: "number_rent", provider_ref: "SECRETREF", expected_cost_cents: 100, provider_cost_cents: 150, variance_cents: 50, acknowledged: true, acknowledged_by: U(9), note: "ok" }, { charge_id: "x" }]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("SECRETREF");
    expect(JSON.stringify(rows)).not.toContain(U(9));
    expect(rows?.[0]).toMatchObject({ varianceCents: 50, acknowledged: true });
  });

  it("parseDual keeps only pending / approved requests of known actions", () => {
    const rows = parseDual([
      { request_id: U(1), action: "absorb_exposure", resource_id: U(2), requested_by: U(3), status: "pending", period_key: "2026-10", reason: "r" },
      { request_id: U(4), action: "cancel_number", resource_id: U(2), requested_by: U(3), status: "approved" },
      { request_id: U(5), action: "other", resource_id: U(2), requested_by: U(3), status: "pending" },
      { request_id: U(6), action: "cancel_number", resource_id: U(2), requested_by: U(3), status: "consumed" },
      { request_id: U(7), action: "cancel_number", resource_id: U(2), status: "pending" },
    ]);
    expect(rows?.map((r) => r.requestId)).toEqual([U(1), U(4)]);
  });
});

describe("loadRecurringFeeOps", () => {
  it("reads everything with the session actor", async () => {
    const c = client({
      tw4_rfl_health: { data: { scan_switch: true, stale: false } },
      tw4_rfl_admin_overview: { data: { resources: [] } },
      tw4_rfl_exposure_report: { data: [] },
      tw4_rfl_variance_report: { data: [] },
      tw4_rfl_dual_list: { data: [] },
    });
    const out = await loadRecurringFeeOps(c as never, ACTOR);
    expect(out.health?.scanSwitch).toBe(true);
    expect(out.overview).toEqual({ resources: [], alertsWaiting: 0, cancelOperationsOpen: 0 });
    expect(out.exposures).toEqual([]);
    expect(out.variances).toEqual([]);
    expect(out.dual).toEqual([]);
    expect(c.calls.every((x) => x.args.p_actor === ACTOR)).toBe(true);
  });

  it("a missing function, a thrown error or a wrong shape reads as null (not available), independently", async () => {
    const c = client({
      tw4_rfl_health: "throw",
      tw4_rfl_admin_overview: { data: { resources: [] } },
      tw4_rfl_exposure_report: { data: { not: "an array" } },
      tw4_rfl_dual_list: { error: { code: "42501", message: "not authorized: secret detail" } },
    });
    const out = await loadRecurringFeeOps(c as never, ACTOR);
    expect(out.health).toBeNull();
    expect(out.overview).not.toBeNull();
    expect(out.exposures).toBeNull();
    expect(out.variances).toBeNull();
    expect(out.dual).toBeNull();
  });
});

describe("ProviderFeeOpsStore", () => {
  it("maps arguments to the contract and returns typed results", async () => {
    const c = client({
      tw4_rfl_set_switch: { data: { switch: "scan", enabled: true } },
      tw4_rfl_variance_ack: { data: { acknowledged: true, replayed: true } },
      tw4_rfl_dual_request: { data: { request_id: U(1) } },
      tw4_rfl_dual_approve: { data: { status: "approved" } },
      tw4_rfl_dual_reject: { data: { status: "rejected" } },
    });
    const s = new ProviderFeeOpsStore(c as never);
    expect(await s.setSwitch("scan", true, "a long enough reason", ACTOR)).toEqual({ enabled: true });
    expect(await s.varianceAck(U(1), "a long enough note", ACTOR)).toEqual({ replayed: true });
    expect(await s.dualRequest({ action: "cancel_number", resourceId: U(2), periodKey: null, reason: "r".repeat(12), approvalRef: "ref-1234567" }, ACTOR)).toEqual({ requestId: U(1) });
    expect(await s.dualApprove(U(1), "a long enough note", ACTOR)).toEqual({ status: "approved" });
    expect(await s.dualReject(U(1), "a long enough note", ACTOR)).toEqual({ status: "rejected" });
    expect(c.calls[0]).toEqual({ fn: "tw4_rfl_set_switch", args: { p_switch: "scan", p_enabled: true, p_actor: ACTOR, p_reason: "a long enough reason" } });
    expect(c.calls[2].args).toMatchObject({ p_actor: ACTOR, p_action: "cancel_number", p_resource_id: U(2), p_period_key: null, p_approval_ref: "ref-1234567" });
  });

  it("errors expose the SQLSTATE only, never the database message", async () => {
    const c = client({ tw4_rfl_dual_approve: { error: { code: "42501", message: "approver must differ: confidential detail" } }, tw4_rfl_set_switch: "throw" });
    const s = new ProviderFeeOpsStore(c as never);
    const e = await s.dualApprove(U(1), "a long enough note", ACTOR).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderFeeOpsError);
    expect((e as ProviderFeeOpsError).code).toBe("42501");
    expect((e as Error).message).not.toContain("confidential");
    const t = await s.setSwitch("scan", true, "a long enough reason", ACTOR).catch((x) => x);
    expect((t as ProviderFeeOpsError).code).toBe("unknown");
  });
});
