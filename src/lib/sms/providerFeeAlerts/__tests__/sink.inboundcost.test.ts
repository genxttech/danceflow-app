import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RFL_ALERT_KINDS, renderRflAlertEmail, sanitizeRflSummary } from "../templates";
import { ProviderFeeLifecycleStore } from "../../providerFeeLifecycle";

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
