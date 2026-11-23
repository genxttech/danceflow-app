/**
 * TW-4F audit F-11 (migration 20270223090000): the funding-exposure check is part of the EXISTING hourly provider-fee lifecycle pass. These unit tests pin the
 * application side: the store wrapper's contract, where the check runs in the pass, that it only runs inside a pass the heartbeat (env flag + database scan
 * switch) allowed, that a failure is counted and never stops delivery, and that the pass reports counts only. The database behaviour is pinned by
 * src/lib/sms/twilioIsv/__tests__/localStack.tw4fx.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProviderFeeError, ProviderFeeLifecycleStore, runProviderFeeLifecycleScan, type ProviderFeeAlert } from "@/lib/sms/providerFeeLifecycle";

const alert = (n: number): ProviderFeeAlert => ({ id: `a${n}`, claimToken: `t${n}`, legalEntityId: "e1", studioId: null, kind: "funding_exposure_unfunded", audience: "admin", severity: "critical", summary: "summary" });

function harness(over: { check?: () => Promise<{ alerts: number; unattributed: number }>; begin?: { ran: boolean; reason: string | null; runId: string | null } } = {}) {
  const order: string[] = [];
  const store = {
    scanEntities: vi.fn(async () => { order.push("entities"); return ["e1"]; }),
    scanEntity: vi.fn(async () => { order.push("scan"); return { opened: 1, closed: 0, alerts: 0 }; }),
    inventoryGaps: vi.fn(async () => { order.push("gaps"); return 0; }),
    inboundAllowanceCheck: vi.fn(async () => { order.push("inbound"); return 0; }),
    fundingExposureCheck: vi.fn(over.check ?? (async () => { order.push("exposure"); return { alerts: 3, unattributed: 1 }; })),
    claimAlerts: vi.fn(async () => { order.push("claim"); return [alert(1)]; }),
    finishAlert: vi.fn(async () => true),
  };
  const finishes: Array<{ status: string; summary: Record<string, unknown> }> = [];
  const ops = {
    scanBegin: vi.fn(async () => over.begin ?? { ran: true, reason: null, runId: "run1" }),
    escalateDelivery: vi.fn(async () => { order.push("escalate"); return 0; }),
    releaseAlert: vi.fn(async () => true),
    scanFinish: vi.fn(async (_id: string, status: string, summary: Record<string, unknown>) => {
      if (!Object.values(summary).every((v) => typeof v === "number" && Number.isFinite(v))) throw new ProviderFeeError("22023");
      finishes.push({ status, summary });
      return true;
    }),
  };
  const sink = { deliver: vi.fn(async () => { order.push("deliver"); }) };
  return { store, ops, sink, order, finishes };
}

describe("ProviderFeeLifecycleStore.fundingExposureCheck", () => {
  it("calls tw4_rfl_funding_exposure_check with no arguments and sums the four alert counts; unattributed is reported separately", async () => {
    const rpc = vi.fn(async () => ({ data: { unfunded: 2, unauthorized: 3, grace_ending: 1, threshold: 1, unattributed: 4 }, error: null }));
    expect(await new ProviderFeeLifecycleStore({ rpc } as never).fundingExposureCheck()).toEqual({ alerts: 7, unattributed: 4 });
    expect(rpc).toHaveBeenCalledWith("tw4_rfl_funding_exposure_check", {});
  });

  it("ignores missing, negative, fractional-garbage and non-numeric counts (never NaN into the heartbeat summary)", async () => {
    const rpc = vi.fn(async () => ({ data: { unfunded: -5, unauthorized: "9", grace_ending: Number.NaN, threshold: 2.7, unattributed: null }, error: null }));
    expect(await new ProviderFeeLifecycleStore({ rpc } as never).fundingExposureCheck()).toEqual({ alerts: 2, unattributed: 0 });
    const empty = vi.fn(async () => ({ data: null, error: null }));
    expect(await new ProviderFeeLifecycleStore({ rpc: empty } as never).fundingExposureCheck()).toEqual({ alerts: 0, unattributed: 0 });
  });

  it("an error carries the SQLSTATE only, never the database message", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "function public.tw4_rfl_funding_exposure_check() secret detail" } }));
    const err = await new ProviderFeeLifecycleStore({ rpc } as never).fundingExposureCheck().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderFeeError);
    expect((err as ProviderFeeError).code).toBe("PGRST202");
    expect(String((err as Error).message)).not.toContain("secret");
  });
});

describe("runProviderFeeLifecycleScan with the funding-exposure check", () => {
  it("runs after the business scans (which open exposures) and before escalation and delivery, so a new alert is delivered in the same pass", async () => {
    const h = harness();
    const out = await runProviderFeeLifecycleScan(h.store as unknown as ProviderFeeLifecycleStore, h.sink, h.ops as never);
    expect(h.order).toEqual(["entities", "scan", "gaps", "inbound", "exposure", "escalate", "claim", "deliver"]);
    expect(out).toMatchObject({ ran: true, exposureAlerts: 3, exposureUnattributed: 1, errors: 0, delivered: 1 });
    expect(h.finishes).toEqual([{ status: "completed", summary: expect.objectContaining({ exposureAlerts: 3, exposureUnattributed: 1 }) }]);
  });

  it("is never called when the heartbeat refuses the pass (scan switch off or another run holds the lease)", async () => {
    for (const reason of ["switched_off", "busy"]) {
      const h = harness({ begin: { ran: false, reason, runId: null } });
      const out = await runProviderFeeLifecycleScan(h.store as unknown as ProviderFeeLifecycleStore, h.sink, h.ops as never);
      expect(h.store.fundingExposureCheck).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ran: false, ranReason: reason, exposureAlerts: 0 });
    }
  });

  it("a failing check is counted as an error and marks the run failed, but escalation and delivery still happen", async () => {
    const h = harness({ check: async () => { throw new ProviderFeeError("42883"); } });
    const out = await runProviderFeeLifecycleScan(h.store as unknown as ProviderFeeLifecycleStore, h.sink, h.ops as never);
    expect(out).toMatchObject({ ran: true, exposureAlerts: 0, exposureUnattributed: 0, errors: 1, delivered: 1 });
    expect(h.ops.escalateDelivery).toHaveBeenCalledTimes(1);
    expect(h.finishes[0].status).toBe("failed");
  });

  it("the pass summary is counts only: every value a finite number or a boolean, never a business, number or amount", async () => {
    const h = harness();
    const out = await runProviderFeeLifecycleScan(h.store as unknown as ProviderFeeLifecycleStore, null, h.ops as never);
    for (const [key, value] of Object.entries(out)) {
      if (key === "ranReason") expect(value).toBeNull();
      else expect(["number", "boolean"]).toContain(typeof value);
    }
    expect(h.store.claimAlerts).not.toHaveBeenCalled();   // no sink: nothing claimed, the new alerts stay pending and visible
  });
});
