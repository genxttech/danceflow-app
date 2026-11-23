import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RFL_ALERT_KINDS, renderRflAlertEmail, sanitizeRflSummary } from "../templates";
import { ProviderFeeLifecycleStore, runProviderFeeLifecycleScan } from "../../providerFeeLifecycle";

/** TW-4F absorbed inbound cost controls (migration 20270222190000): the four new alert kinds and the scan wrapper. */

const NEW_KINDS = ["sms_in_volume_high", "sms_in_absorbed_high", "sms_in_anomaly", "sms_in_daily_cap"];

describe("alert kinds and copy", () => {
  it("the four kinds are known, render administrator mail with a distinct admin template key, and carry no amount", () => {
    for (const kind of NEW_KINDS) {
      expect(RFL_ALERT_KINDS).toContain(kind);
      const mail = renderRflAlertEmail({ kind, summary: "Inbound text volume for a business passed its daily threshold.", recipientKind: "admin" });
      expect(mail.templateKey).toBe(`platform_rfl_admin_${kind}`);
      expect(mail.subject).not.toMatch(/\$|\d/);
      expect(mail.bodyText).not.toMatch(/\$|\bcents?\b/i);
    }
  });

  it("an amount in a summary is replaced by the kind's generic sentence, which says nothing was refused", () => {
    expect(sanitizeRflSummary("sms_in_daily_cap", "Absorbed $95.00 today")).toMatch(/No text is refused/);
    expect(sanitizeRflSummary("sms_in_absorbed_high", "9000 cents absorbed")).toMatch(/Nothing has been blocked/);
  });
});

describe("the scan wrapper", () => {
  it("adds the new check's counts to the pilot check's counts", async () => {
    const rpc = vi.fn(async (fn: string) =>
      fn === "tw4_rfl_inbound_allowance_check"
        ? { data: { allowance_warnings: 1, allowance_critical: 0, volume: 1 }, error: null }
        : { data: { volume_alerts: 1, absorbed_alerts: 2, anomaly_alerts: 1, cap_alerts: 1, suppressed: 7 }, error: null });
    expect(await new ProviderFeeLifecycleStore({ rpc } as never).inboundAllowanceCheck()).toBe(2 + 5);   // suppressions are not alerts
    expect(rpc).toHaveBeenCalledWith("tw4_inbound_cost_controls_check", {});
  });

  it.each(["PGRST202", "42883"])("a database without the migration (%s) counts as 0, so the app can ship before the SQL", async (code) => {
    const rpc = vi.fn(async (fn: string) => (fn === "tw4_rfl_inbound_allowance_check" ? { data: { volume: 1 }, error: null } : { data: null, error: { code } }));
    expect(await new ProviderFeeLifecycleStore({ rpc } as never).inboundAllowanceCheck()).toBe(1);
  });

  it("any other error is raised (the run records it), and junk counts are ignored", async () => {
    const failing = vi.fn(async (fn: string) => (fn === "tw4_rfl_inbound_allowance_check" ? { data: {}, error: null } : { data: null, error: { code: "57014" } }));
    await expect(new ProviderFeeLifecycleStore({ rpc: failing } as never).inboundAllowanceCheck()).rejects.toMatchObject({ code: "57014" });
    const junk = vi.fn(async () => ({ data: { volume_alerts: -3, absorbed_alerts: "9", anomaly_alerts: 1.5, cap_alerts: null }, error: null }));
    expect(await new ProviderFeeLifecycleStore({ rpc: junk } as never).inboundCostControlsCheck()).toBe(0);
  });
});

describe("a failing or partial new check keeps the pilot alerts in the run's count (review item 5)", () => {
  const ops = () => ({ scanBegin: vi.fn(async () => ({ ran: true, reason: null, runId: "r1" })), scanFinish: vi.fn(async () => true), escalateDelivery: vi.fn(async () => 0), releaseAlert: vi.fn(async () => true) });
  const storeWith = (second: { data: unknown; error: unknown }) =>
    new ProviderFeeLifecycleStore({
      rpc: async (fn: string) => {
        if (fn === "tw4_rfl_inbound_allowance_check") return { data: { allowance_warnings: 1, allowance_critical: 1, volume: 1 }, error: null };
        if (fn === "tw4_inbound_cost_controls_check") return second;
        if (fn === "tw4_rfl_scan_entities") return { data: [], error: null };
        if (fn === "tw4_rfl_inventory_gaps") return { data: { gaps: 0 }, error: null };
        return { data: null, error: { code: "unexpected" } };
      },
    } as never);

  it("the new check failing: the 3 pilot alerts still count, the run is an error, escalation still runs", async () => {
    const o = ops();
    const out = await runProviderFeeLifecycleScan(storeWith({ data: null, error: { code: "57014" } }), null, o as never);
    expect(out).toMatchObject({ ran: true, inboundAlerts: 3, errors: 1 });
    expect(o.escalateDelivery).toHaveBeenCalledTimes(1);
    expect(o.scanFinish).toHaveBeenCalledWith("r1", "failed", expect.objectContaining({ inboundAlerts: 3 }), "scan_errors");
  });

  it("a partial new check (one business could not be checked): its raised alerts and the pilot's count, and the run is an error", async () => {
    const out = await runProviderFeeLifecycleScan(storeWith({ data: { volume_alerts: 2, absorbed_alerts: 0, anomaly_alerts: 0, cap_alerts: 1, errors: 1 }, error: null }), null, ops() as never);
    expect(out).toMatchObject({ inboundAlerts: 3 + 3, errors: 1 });
  });

  it("a clean new check adds its alerts and is not an error", async () => {
    const out = await runProviderFeeLifecycleScan(storeWith({ data: { volume_alerts: 1, absorbed_alerts: 1, anomaly_alerts: 0, cap_alerts: 0, errors: 0 }, error: null }), null, ops() as never);
    expect(out).toMatchObject({ inboundAlerts: 5, errors: 0 });
  });
});
