import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("the sink must use the injected queue"); } }));

import { runProviderFeeLifecycleScan, type ProviderFeeAlert, type ProviderFeeLifecycleStore } from "../../providerFeeLifecycle";
import { ProviderFeeAlertDeliveryError, createProviderFeeAlertSink, type RflAlertQueue } from "../sink";
import type { AlertRecipient, DeliveryOutcome } from "../rpc";

const SID = /\b(?:AC|PN|QE|MG|SM)[0-9a-fA-F]{32}\b/;

const owner = (n: number, over: Partial<AlertRecipient> = {}): AlertRecipient => ({ recipientKind: "owner", userId: `o${n}`, studioId: "s1", email: `Owner${n}@Example.test`, emailVerified: true, ...over });
const admin = (n: number, over: Partial<AlertRecipient> = {}): AlertRecipient => ({ recipientKind: "admin", userId: `a${n}`, studioId: null, email: `admin${n}@example.test`, emailVerified: true, ...over });
const alert = (over: Partial<ProviderFeeAlert> = {}): ProviderFeeAlert => ({
  id: "alert1", claimToken: "tok1", legalEntityId: "e1", studioId: "s1", kind: "authorization_expiring", audience: "both", severity: "warning", summary: "Your authorization ends soon.", ...over,
});

/** A fake of the database + queue contract: unique dedupe keys, claim-token-checked delivery records unique per (alert, ref). */
function harness(opts: { recipients?: AlertRecipient[]; currentToken?: () => string } = {}) {
  const queued: Array<Parameters<RflAlertQueue>[0]> = [];
  const dedupe = new Map<string, { related_table: string | null; related_id: string | null; template_key: string | null }>();
  const records = new Map<string, DeliveryOutcome>();
  const recordCalls: Array<{ ref: string; kind: string; outcome: DeliveryOutcome; token: string }> = [];
  const state = { queueThrowsFor: new Set<string>(), recipients: opts.recipients ?? [owner(1), admin(1)], currentToken: opts.currentToken ?? (() => "tok1"), recipientCalls: 0 };
  const queue: RflAlertQueue = async (p) => {
    if (state.queueThrowsFor.has(p.recipientEmail ?? "")) throw new Error(`smtp down for ${p.recipientEmail}`);
    await Promise.resolve();   // yield: lets concurrent workers interleave like real I/O
    if (p.dedupeKey && dedupe.has(p.dedupeKey)) return { queued: false, skipped: true, reason: "duplicate" };
    if (p.dedupeKey) dedupe.set(p.dedupeKey, { related_table: p.relatedTable ?? null, related_id: p.relatedId ?? null, template_key: p.templateKey });
    queued.push(p);
    return { queued: true, skipped: false };
  };
  const ops = {
    alertRecipients: vi.fn(async () => { state.recipientCalls += 1; return state.recipients; }),
    recordDelivery: vi.fn(async (alertId: string, token: string, ref: string, kind: string, outcome: DeliveryOutcome) => {
      recordCalls.push({ ref, kind, outcome, token });
      if (token !== state.currentToken()) return { recorded: false, replayed: false };
      const key = `${alertId}|${ref}`;
      const replayed = records.has(key);
      if (!replayed) records.set(key, outcome);
      return { recorded: true, replayed };
    }),
  };
  const sink = createProviderFeeAlertSink({ ops: ops as never, queue, studioName: async () => "Rhythm Studio", lookupDelivery: async (key) => dedupe.get(key) ?? null });
  return { sink, queued, records, recordCalls, state, ops, dedupe };
}

describe("createProviderFeeAlertSink", () => {
  it("queues one platform_ email per verified recipient with the deterministic dedupe key and records each outcome with the claim token", async () => {
    const h = harness();
    await h.sink.deliver(alert());
    expect(h.queued).toHaveLength(2);
    const byEmail = Object.fromEntries(h.queued.map((q) => [q.recipientEmail, q]));
    expect(byEmail["owner1@example.test"]).toMatchObject({ studioId: "s1", channel: "email", templateKey: "platform_rfl_authorization_expiring", dedupeKey: "rfl:alert1:owner:o1", relatedId: "alert1" });
    expect(byEmail["admin1@example.test"]).toMatchObject({ studioId: "s1", templateKey: "platform_rfl_admin_authorization_expiring", dedupeKey: "rfl:alert1:admin:a1" });   // admin: the alert's studio
    expect(byEmail["owner1@example.test"].bodyText).toContain("Studio: Rhythm Studio");
    expect(byEmail["admin1@example.test"].bodyText).not.toContain("Rhythm Studio");
    expect(h.recordCalls).toEqual([
      { ref: "owner:o1", kind: "owner", outcome: "queued", token: "tok1" },
      { ref: "admin:a1", kind: "admin", outcome: "queued", token: "tok1" },
    ]);
    // the reference is never an address
    expect(h.recordCalls.every((r) => !r.ref.includes("@"))).toBe(true);
  });

  it("admin-addressed mail NEVER uses an owner-visible template key and owner-addressed mail NEVER uses the admin prefix (staff must not read admin alerts)", async () => {
    const h = harness({ recipients: [owner(1), owner(2), admin(1), admin(2)] });
    for (const kind of ["authorization_expiring", "exposure_open", "alert_delivery_exhausted", "some_future_kind"]) await h.sink.deliver(alert({ kind, id: `a-${kind}` }));
    expect(h.queued.length).toBe(16);
    for (const q of h.queued) {
      if (q.dedupeKey?.includes(":admin:")) expect(q.templateKey.startsWith("platform_rfl_admin_")).toBe(true);
      else expect(q.templateKey.startsWith("platform_rfl_admin_")).toBe(false);
    }
  });

  it("no queued email contains a SID, amount, token or balance even if the summary tried to", async () => {
    const h = harness();
    await h.sink.deliver(alert({ summary: `AC${"a".repeat(32)} owes $4.00, balance low, 400 cents` }));
    for (const q of h.queued) {
      for (const part of [q.subject ?? "", q.bodyText, (q.bodyHtml ?? "").replace(/<style[\s\S]*?<\/style>/g, "")]) {
        expect(part).not.toMatch(SID);
        expect(part).not.toMatch(/\$|cents|token|balance/i);
      }
    }
  });

  it("a legitimate duplicate (the existing row is this alert's RFL row for this recipient) counts as reached", async () => {
    const h = harness({ recipients: [owner(1)] });
    await h.sink.deliver(alert());
    await expect(h.sink.deliver(alert())).resolves.toBeUndefined();
    expect(h.recordCalls.map((r) => r.outcome)).toEqual(["queued", "duplicate"]);
  });

  it("a squatted dedupe key (a staff-made row under rfl:<alert>:<ref>) is NOT reached: nothing recorded for it, the alert fails, others still go out", async () => {
    const squats: Array<{ related_table: string | null; related_id: string | null; template_key: string | null }> = [
      { related_table: null, related_id: null, template_key: "appointment_confirmed" },
      { related_table: "studio_sms_provider_alerts", related_id: "other-alert", template_key: "platform_rfl_authorization_expiring" },
      { related_table: "studio_sms_provider_alerts", related_id: "alert1", template_key: "platform_rfl_admin_authorization_expiring" },   // wrong template for an owner
      { related_table: "clients", related_id: "alert1", template_key: "platform_rfl_authorization_expiring" },
    ];
    for (const row of squats) {
      const h = harness({ recipients: [owner(1), owner(2)] });
      h.dedupe.set("rfl:alert1:owner:o1", row);
      const err = await h.sink.deliver(alert()).catch((e) => e);
      expect(err.name).toBe("RflAlert_queue_failed");
      expect(h.recordCalls.map((r) => r.ref)).toEqual(["owner:o2"]);   // nothing recorded for the squatted recipient
      expect(h.queued.map((q) => q.dedupeKey)).toEqual(["rfl:alert1:owner:o2"]);
    }
  });

  it("an unreadable existing row (lookup error or missing) is also not reached", async () => {
    const h = harness({ recipients: [owner(1)] });
    h.dedupe.set("rfl:alert1:owner:o1", { related_table: "studio_sms_provider_alerts", related_id: "alert1", template_key: "platform_rfl_authorization_expiring" });
    const sink = createProviderFeeAlertSink({ ops: h.ops as never, queue: async () => ({ queued: false, skipped: true, reason: "duplicate" }), lookupDelivery: async () => { throw new Error("db"); } });
    expect((await sink.deliver(alert()).catch((e) => e)).name).toBe("RflAlert_queue_failed");
    const missing = createProviderFeeAlertSink({ ops: h.ops as never, queue: async () => ({ queued: false, skipped: true, reason: "duplicate" }), lookupDelivery: async () => null });
    expect((await missing.deliver(alert()).catch((e) => e)).name).toBe("RflAlert_queue_failed");
    expect(h.recordCalls).toHaveLength(0);
  });

  it("replaying the same alert (another claim) queues nothing new: duplicates are recorded, replays are harmless", async () => {
    const h = harness();
    await h.sink.deliver(alert());
    await h.sink.deliver(alert());
    expect(h.queued).toHaveLength(2);
    expect(h.recordCalls.slice(2).map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
    expect(h.dedupe.size).toBe(2);
  });

  it("two concurrent workers on the same alert produce exactly one queued email per recipient", async () => {
    const h = harness({ recipients: [owner(1), owner(2), admin(1)] });
    await Promise.all([h.sink.deliver(alert()), h.sink.deliver(alert()), h.sink.deliver(alert())]);
    expect(h.queued).toHaveLength(3);
    expect(new Set(h.queued.map((q) => q.dedupeKey)).size).toBe(3);
    const outcomes = h.recordCalls.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "queued")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(6);
  });

  it("invalid recipient addresses are recorded invalid_recipient and never queued; the others are still sent", async () => {
    const h = harness({ recipients: [owner(1, { email: "not-an-address" }), owner(2, { email: null }), owner(3, { email: "x@y" }), owner(4, { emailVerified: false }), owner(5)] });
    await h.sink.deliver(alert());
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0].dedupeKey).toBe("rfl:alert1:owner:o5");
    expect(h.recordCalls.filter((r) => r.outcome === "invalid_recipient").map((r) => r.ref)).toEqual(["owner:o1", "owner:o2", "owner:o3", "owner:o4"]);
  });

  it("when nobody valid could be reached the alert fails (so attempts are counted) and the invalid outcome is on record", async () => {
    const h = harness({ recipients: [owner(1, { email: "garbage" })] });
    await expect(h.sink.deliver(alert())).rejects.toMatchObject({ name: "RflAlert_unreachable" });
    expect(h.queued).toHaveLength(0);
    expect(h.recordCalls.map((r) => r.outcome)).toEqual(["invalid_recipient"]);
  });

  it("missing authorization (the database returns no recipients) fails the alert and records no_recipient", async () => {
    const h = harness({ recipients: [] });
    const err = await h.sink.deliver(alert()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderFeeAlertDeliveryError);
    expect(err.name).toBe("RflAlert_no_recipient");
    expect(h.queued).toHaveLength(0);
    expect(h.recordCalls).toEqual([{ ref: "owner:none", kind: "owner", outcome: "no_recipient", token: "tok1" }]);
    const adminOnly = harness({ recipients: [] });
    await adminOnly.sink.deliver(alert({ audience: "admin" })).catch(() => {});
    expect(adminOnly.recordCalls[0]).toMatchObject({ ref: "admin:none", kind: "admin" });
  });

  it("rows outside the alert's audience are ignored even if the database returned them", async () => {
    const h = harness({ recipients: [owner(1), admin(1)] });
    await h.sink.deliver(alert({ audience: "admin" }));
    expect(h.queued.map((q) => q.dedupeKey)).toEqual(["rfl:alert1:admin:a1"]);
    const o = harness({ recipients: [owner(1), admin(1)] });
    await o.sink.deliver(alert({ audience: "owner" }));
    expect(o.queued.map((q) => q.dedupeKey)).toEqual(["rfl:alert1:owner:o1"]);
  });

  it("is capped at 5 owners and 10 admins whatever the database returns", async () => {
    const h = harness({ recipients: [...Array.from({ length: 9 }, (_, i) => owner(i)), ...Array.from({ length: 14 }, (_, i) => admin(i))] });
    await h.sink.deliver(alert());
    expect(h.queued.filter((q) => q.dedupeKey?.includes(":owner:"))).toHaveLength(5);
    expect(h.queued.filter((q) => q.dedupeKey?.includes(":admin:"))).toHaveLength(10);
  });

  it("an entity-level alert (no studio) uses the studio the owner row names; an admin row with no studio anywhere is not sent", async () => {
    const h = harness({ recipients: [owner(1, { studioId: "s9" }), admin(1)] });
    await h.sink.deliver(alert({ studioId: null }));
    expect(h.queued.map((q) => [q.dedupeKey, q.studioId])).toEqual([["rfl:alert1:owner:o1", "s9"]]);
    expect(h.recordCalls.find((r) => r.ref === "admin:a1")?.outcome).toBe("invalid_recipient");
  });

  it("a queue failure throws without recording that recipient, never blocks the others, and the retry sends only what is missing (attempts are the database's to bound)", async () => {
    const h = harness({ recipients: [owner(1), owner(2), admin(1)] });
    h.state.queueThrowsFor.add("owner1@example.test");
    const first = await h.sink.deliver(alert()).catch((e) => e);
    expect(first.name).toBe("RflAlert_queue_failed");
    expect(first.message).not.toContain("@");
    expect(h.queued.map((q) => q.dedupeKey).sort()).toEqual(["rfl:alert1:admin:a1", "rfl:alert1:owner:o2"]);
    expect(h.recordCalls.map((r) => r.ref)).toEqual(["owner:o2", "admin:a1"]);
    h.state.queueThrowsFor.clear();
    await h.sink.deliver(alert());
    expect(h.queued).toHaveLength(3);
    expect(h.recordCalls.slice(2).map((r) => [r.ref, r.outcome])).toEqual([["owner:o1", "queued"], ["owner:o2", "duplicate"], ["admin:a1", "duplicate"]]);
  });

  it("a stale claim token (recorded:false) stops at once, throws, and sends nothing further", async () => {
    const h = harness({ recipients: [owner(1), owner(2), owner(3)], currentToken: () => "someone-else" });
    const err = await h.sink.deliver(alert()).catch((e) => e);
    expect(err.name).toBe("RflAlert_claim_lost");
    expect(h.queued).toHaveLength(1);   // only the first recipient was reached before the claim was found stale
    expect(h.recordCalls).toHaveLength(1);
  });

  it("a record failure and a recipient-read failure fail the alert with a code only", async () => {
    const h = harness();
    h.ops.recordDelivery.mockRejectedValueOnce(new Error("db password=hunter2"));
    const err = await h.sink.deliver(alert()).catch((e) => e);
    expect(err.name).toBe("RflAlert_record_failed");
    expect(String(err.message)).not.toContain("hunter2");
    h.ops.alertRecipients.mockRejectedValueOnce(new Error("db"));
    expect((await h.sink.deliver(alert()).catch((e) => e)).name).toBe("RflAlert_record_failed");
  });

  it("never logs (no console output, addresses never leave the queue call)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = harness();
    h.state.queueThrowsFor.add("owner1@example.test");
    await h.sink.deliver(alert()).catch(() => {});
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    spies.forEach((s) => s.mockRestore());
  });
});

describe("runner + sink end to end (fakes)", () => {
  function fixture() {
    const h = harness({ recipients: [owner(1), admin(1)] });
    const attempts = { n: 0 };
    const finishes: Array<{ delivered: boolean; error: string | null }> = [];
    const store = {
      scanEntities: vi.fn(async () => []),
      scanEntity: vi.fn(),
      inventoryGaps: vi.fn(async () => 0),
      claimAlerts: vi.fn(async () => {
        if (attempts.n >= 5) return [];   // the database bounds attempts at 5
        attempts.n += 1;
        return [alert()];
      }),
      finishAlert: vi.fn(async (_id: string, _t: string, delivered: boolean, error: string | null) => { finishes.push({ delivered, error }); return true; }),
    };
    const ops = {
      scanBegin: vi.fn(async () => ({ ran: true, reason: null, runId: "run1" })),
      escalateDelivery: vi.fn(async () => 0),
      scanFinish: vi.fn(async () => true),
    };
    return { h, store: store as unknown as ProviderFeeLifecycleStore, ops: ops as never, rawOps: ops, finishes, attempts };
  }

  it("a throwing queue is marked failed with the error NAME only, then the next pass succeeds with exactly one email per recipient; escalation is called every pass", async () => {
    const f = fixture();
    f.h.state.queueThrowsFor.add("owner1@example.test");
    const first = await runProviderFeeLifecycleScan(f.store, f.h.sink, f.ops);
    expect(first).toMatchObject({ failed: 1, delivered: 0 });
    expect(f.finishes[0]).toEqual({ delivered: false, error: "RflAlert_queue_failed" });
    f.h.state.queueThrowsFor.clear();
    const second = await runProviderFeeLifecycleScan(f.store, f.h.sink, f.ops);
    expect(second).toMatchObject({ failed: 0, delivered: 1 });
    expect(f.h.queued).toHaveLength(2);
    expect(f.rawOps.escalateDelivery).toHaveBeenCalledTimes(2);
  });

  it("a permanently failing alert keeps failing through the database's attempt bound and sends nothing; one failing alert never blocks the others", async () => {
    const f = fixture();
    f.h.state.recipients = [];
    for (let i = 0; i < 7; i += 1) await runProviderFeeLifecycleScan(f.store, f.h.sink, f.ops);
    expect(f.attempts.n).toBe(5);
    expect(f.finishes.every((x) => !x.delivered && x.error === "RflAlert_no_recipient")).toBe(true);
    expect(f.h.queued).toHaveLength(0);
    expect(f.rawOps.escalateDelivery).toHaveBeenCalledTimes(7);

    // one bad alert among good ones
    const g = harness({ recipients: [owner(1)] });
    const alerts = [alert({ id: "bad", audience: "admin" }), alert({ id: "good1" }), alert({ id: "good2" })];
    const store = {
      scanEntities: async () => [], scanEntity: vi.fn(), inventoryGaps: async () => 0,
      claimAlerts: vi.fn(async () => alerts.splice(0)), finishAlert: vi.fn(async () => true),
    } as unknown as ProviderFeeLifecycleStore;
    const out = await runProviderFeeLifecycleScan(store, g.sink, { scanBegin: async () => ({ ran: true, reason: null, runId: "r" }), escalateDelivery: async () => 0, scanFinish: async () => true } as never);
    expect(out).toMatchObject({ delivered: 2, failed: 1 });
    expect(g.queued.map((q) => q.relatedId).sort()).toEqual(["good1", "good2"]);
  });

  it("without a sink (flag or switch off) nothing is claimed or queued", async () => {
    const f = fixture();
    const out = await runProviderFeeLifecycleScan(f.store, null, f.ops);
    expect(out.deliveryEnabled).toBe(false);
    expect((f.store as unknown as { claimAlerts: ReturnType<typeof vi.fn> }).claimAlerts).not.toHaveBeenCalled();
    expect(f.h.queued).toHaveLength(0);
  });
});
