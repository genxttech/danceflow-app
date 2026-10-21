import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProviderFeeError } from "../../providerFeeLifecycle";
import { ProviderFeeOpsRpc } from "../rpc";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
const rpcWith = (rpc: Rpc) => new ProviderFeeOpsRpc({ rpc } as never);

describe("ProviderFeeOpsRpc", () => {
  it("maps each call to its function and arguments and parses results conservatively", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const data: Record<string, unknown> = {
      tw4_rfl_alert_recipients: [
        { recipient_kind: "owner", user_id: "u1", studio_id: "s1", email: "o@x.test", email_verified: true },
        { recipient_kind: "admin", user_id: "u2", studio_id: null, email: null, email_verified: false },
        { recipient_kind: "stranger", user_id: "u3" },
        { recipient_kind: "owner", user_id: "" },
      ],
      tw4_rfl_alert_delivery_record: { recorded: true, replayed: true },
      tw4_rfl_scan_begin: { ran: true, reason: null, run_id: "run1" },
      tw4_rfl_scan_finish: { updated: true },
      tw4_rfl_escalate_delivery: { escalated: 3 },
      tw4_rfl_switch_enabled: true,
      tw4_rfl_health: { scan_switch: true, delivery_switch: false, stale: false, alerts_exhausted: 2, oldest_pending_alert_age_seconds: 40 },
    };
    const ops = rpcWith(async (fn, args) => { calls.push({ fn, args }); return { data: data[fn], error: null }; });
    expect(await ops.alertRecipients("a1")).toEqual([
      { recipientKind: "owner", userId: "u1", studioId: "s1", email: "o@x.test", emailVerified: true },
      { recipientKind: "admin", userId: "u2", studioId: null, email: null, emailVerified: false },
    ]);
    expect(await ops.recordDelivery("a1", "t1", "owner:u1", "owner", "queued")).toEqual({ recorded: true, replayed: true });
    expect(await ops.scanBegin("runner")).toEqual({ ran: true, reason: null, runId: "run1" });
    expect(await ops.scanBegin("runner", 120)).toMatchObject({ ran: true });
    expect(await ops.scanFinish("run1", "completed", { a: 1 }, null)).toBe(true);
    expect(await ops.escalateDelivery()).toBe(3);
    expect(await ops.switchEnabled("delivery")).toBe(true);
    expect(await ops.health("admin1")).toMatchObject({ scanSwitch: true, deliverySwitch: false, stale: false, alertsExhausted: 2, oldestPendingAlertAgeSeconds: 40, runsFailed24h: 0 });
    expect(calls.map((c) => c.fn)).toEqual([
      "tw4_rfl_alert_recipients", "tw4_rfl_alert_delivery_record", "tw4_rfl_scan_begin", "tw4_rfl_scan_begin", "tw4_rfl_scan_finish", "tw4_rfl_escalate_delivery", "tw4_rfl_switch_enabled", "tw4_rfl_health",
    ]);
    expect(calls[0].args).toEqual({ p_alert_id: "a1" });
    expect(calls[1].args).toEqual({ p_alert_id: "a1", p_claim_token: "t1", p_recipient_ref: "owner:u1", p_recipient_kind: "owner", p_outcome: "queued" });
    expect(calls[2].args).toEqual({ p_runner: "runner" });
    expect(calls[3].args).toEqual({ p_runner: "runner", p_lease_seconds: 120 });
    expect(calls[4].args).toEqual({ p_run_id: "run1", p_status: "completed", p_summary: { a: 1 }, p_error: null });
    expect(calls[6].args).toEqual({ p_switch: "delivery" });
    expect(calls[7].args).toEqual({ p_actor: "admin1" });
  });

  it("unreadable data is the safe value: no recipients, switch off, nothing recorded, health stale", async () => {
    const ops = rpcWith(async () => ({ data: null, error: null }));
    expect(await ops.alertRecipients("a")).toEqual([]);
    expect(await ops.recordDelivery("a", "t", "owner:u", "owner", "queued")).toEqual({ recorded: false, replayed: false });
    expect(await ops.scanBegin("r")).toEqual({ ran: false, reason: null, runId: null });
    expect(await ops.scanFinish("r", "failed", {}, "x")).toBe(false);
    expect(await ops.escalateDelivery()).toBe(0);
    expect(await ops.switchEnabled("scan")).toBe(false);
    expect(await rpcWith(async () => ({ data: "true", error: null })).switchEnabled("scan")).toBe(false);
    expect(await ops.health("x")).toMatchObject({ scanSwitch: false, deliverySwitch: false, stale: true });
  });

  it("errors carry the SQLSTATE only, never the database message", async () => {
    const ops = rpcWith(async () => ({ data: null, error: { code: "42501", message: "secret detail user@example.com" } }));
    const err = await ops.escalateDelivery().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderFeeError);
    expect((err as ProviderFeeError).code).toBe("42501");
    expect(String((err as Error).message)).not.toContain("secret");
    const unknown = await rpcWith(async () => ({ data: null, error: {} })).switchEnabled("scan").catch((e) => e);
    expect((unknown as ProviderFeeError).code).toBe("unknown");
  });
});
