import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("the sink must use the injected queue"); } }));

import { runProviderFeeLifecycleScan, type ProviderFeeAlert, type ProviderFeeLifecycleStore } from "../../providerFeeLifecycle";
import { createProviderFeeAlertSink, type RflAlertQueue } from "../sink";
import type { AlertRecipient, DeliveryOutcome } from "../rpc";
import { RFL_ALERT_KINDS, renderRflAlertEmail, sanitizeRflSummary } from "../templates";

const admin = (n: number, over: Partial<AlertRecipient> = {}): AlertRecipient => ({ recipientKind: "admin", userId: `a${n}`, studioId: "founding-studio", email: `admin${n}@example.test`, emailVerified: true, ...over });
const owner = (n: number, over: Partial<AlertRecipient> = {}): AlertRecipient => ({ recipientKind: "owner", userId: `o${n}`, studioId: "s1", email: `owner${n}@example.test`, emailVerified: true, ...over });
const entityAlert = (over: Partial<ProviderFeeAlert> = {}): ProviderFeeAlert => ({
  id: "inb1", claimToken: "tok1", legalEntityId: "e1", studioId: null, kind: "inbound_absorbed_allowance", audience: "admin", severity: "critical",
  summary: "Absorbed inbound text cost for the pilot business has reached its full allowance. Nothing has been blocked or released; review inbound traffic and decide on any action.", ...over,
});

function harness(recipients: AlertRecipient[]) {
  const queued: Array<Parameters<RflAlertQueue>[0]> = [];
  const records: Array<{ ref: string; kind: string; outcome: DeliveryOutcome }> = [];
  const queue: RflAlertQueue = async (p) => { queued.push(p); return { queued: true, skipped: false }; };
  const ops = {
    alertRecipients: vi.fn(async () => recipients),
    recordDelivery: vi.fn(async (_id: string, _t: string, ref: string, kind: string, outcome: DeliveryOutcome) => { records.push({ ref, kind, outcome }); return { recorded: true, replayed: false }; }),
  };
  const sink = createProviderFeeAlertSink({ ops: ops as never, queue, lookupDelivery: async () => null });
  return { sink, queued, records };
}

describe("entity-level administrator alerts (no location on the alert)", () => {
  it("delivers to the verified administrator using the studio the database names (the business's founding location), with the admin template and no owner copy", async () => {
    const h = harness([admin(1)]);
    await h.sink.deliver(entityAlert());
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toMatchObject({ studioId: "founding-studio", templateKey: "platform_rfl_admin_inbound_absorbed_allowance", recipientEmail: "admin1@example.test", dedupeKey: "rfl:inb1:admin:a1" });
    expect(h.queued[0].bodyText).not.toMatch(/\$|\bcents?\b|\d{3,}/);
    expect(h.records).toEqual([{ ref: "admin:a1", kind: "admin", outcome: "queued" }]);
  });

  it("an unverified administrator, or one with no usable address, is NOT sent (recorded invalid_recipient) and the alert fails visibly when nobody is reached", async () => {
    for (const bad of [admin(1, { emailVerified: false }), admin(1, { email: null }), admin(1, { email: "   " }), admin(1, { email: "not-an-address" })]) {
      const h = harness([bad]);
      await expect(h.sink.deliver(entityAlert())).rejects.toMatchObject({ name: "RflAlert_unreachable" });
      expect(h.queued).toHaveLength(0);
      expect(h.records).toEqual([{ ref: "admin:a1", kind: "admin", outcome: "invalid_recipient" }]);
    }
  });

  it("with a verified and an unverified administrator only the verified one is mailed", async () => {
    const h = harness([admin(1), admin(2, { emailVerified: false })]);
    await h.sink.deliver(entityAlert());
    expect(h.queued.map((q) => q.recipientEmail)).toEqual(["admin1@example.test"]);
    expect(h.records.find((r) => r.ref === "admin:a2")?.outcome).toBe("invalid_recipient");
  });

  it("fails closed when neither the database nor the alert names a studio (the queue row needs one): never sent", async () => {
    const h = harness([admin(1, { studioId: null })]);
    await expect(h.sink.deliver(entityAlert())).rejects.toMatchObject({ name: "RflAlert_unreachable" });
    expect(h.queued).toHaveLength(0);
  });

  it("an owner row is never sent an administrator-audience alert, even if the database returned one", async () => {
    const h = harness([owner(1), admin(1)]);
    await h.sink.deliver(entityAlert());
    expect(h.queued.map((q) => q.recipientEmail)).toEqual(["admin1@example.test"]);
    const onlyOwner = harness([owner(1)]);
    await expect(onlyOwner.sink.deliver(entityAlert())).rejects.toMatchObject({ name: "RflAlert_no_recipient" });
    expect(onlyOwner.queued).toHaveLength(0);
  });
});

describe("the new alert kinds", () => {
  it("are known kinds with their own admin template key, and their summaries pass the sensitivity filter unchanged (no amounts)", () => {
    for (const kind of ["inbound_absorbed_allowance", "inbound_volume_high"]) {
      expect(RFL_ALERT_KINDS).toContain(kind);
      const summary = "Absorbed inbound text cost for the pilot business has reached 80 percent of its allowance. Nothing has been blocked or released.";
      expect(sanitizeRflSummary(kind, summary)).toBe(summary);
      const mail = renderRflAlertEmail({ kind, summary, recipientKind: "admin" });
      expect(mail.templateKey).toBe(`platform_rfl_admin_${kind}`);
      expect(mail.subject).not.toBe("Texting provider fee notice");
      expect(mail.bodyText).toContain("/platform/sms");
    }
  });

  it("an amount in a summary is replaced by the generic sentence", () => {
    expect(sanitizeRflSummary("inbound_absorbed_allowance", "Absorbed inbound cost reached $16.00")).toMatch(/allowance/);
  });
});

describe("the scheduled pass runs the check in the existing scan", () => {
  const ops = () => ({ scanBegin: vi.fn(async () => ({ ran: true, reason: null, runId: "r1" })), scanFinish: vi.fn(async () => true), escalateDelivery: vi.fn(async () => 0), releaseAlert: vi.fn(async () => true) });
  const store = (inboundAllowanceCheck: () => Promise<number>) =>
    ({ scanEntities: async () => [], scanEntity: vi.fn(), inboundAllowanceCheck, inventoryGaps: async () => 0, claimAlerts: async () => [], finishAlert: async () => true }) as unknown as ProviderFeeLifecycleStore;

  it("counts the new alerts, runs before escalation, and still runs when delivery is off (no sink)", async () => {
    const order: string[] = [];
    const o = ops();
    o.escalateDelivery = vi.fn(async () => { order.push("escalate"); return 0; });
    const out = await runProviderFeeLifecycleScan(store(async () => { order.push("inbound"); return 2; }), null, o as never);
    expect(out).toMatchObject({ ran: true, inboundAlerts: 2, errors: 0, deliveryEnabled: false });
    expect(order).toEqual(["inbound", "escalate"]);
    expect(o.scanFinish).toHaveBeenCalledWith("r1", "completed", expect.objectContaining({ inboundAlerts: 2 }), null);
  });

  it("a failing check is an error in the run (visible) but never stops escalation or the rest of the pass", async () => {
    const o = ops();
    const out = await runProviderFeeLifecycleScan(store(async () => { throw new Error("db"); }), null, o as never);
    expect(out).toMatchObject({ ran: true, inboundAlerts: 0, errors: 1 });
    expect(o.escalateDelivery).toHaveBeenCalledTimes(1);
    expect(o.scanFinish).toHaveBeenCalledWith("r1", "failed", expect.anything(), "scan_errors");
  });

  it("the store wrapper sums the counts and sends no argument", async () => {
    const { ProviderFeeLifecycleStore: Store } = await import("../../providerFeeLifecycle");
    const rpc = vi.fn(async () => ({ data: { allowance_warnings: 1, allowance_critical: 1, volume: 2 }, error: null }));
    expect(await new Store({ rpc } as never).inboundAllowanceCheck()).toBe(4);
    expect(rpc).toHaveBeenCalledWith("tw4_rfl_inbound_allowance_check", {});
    const bad = new Store({ rpc: async () => ({ data: null, error: { code: "42501" } }) } as never);
    await expect(bad.inboundAllowanceCheck()).rejects.toMatchObject({ code: "42501" });
  });
});
