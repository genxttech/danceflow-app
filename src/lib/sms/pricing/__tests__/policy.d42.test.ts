import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyEvents } from "../classify";
import { eventIdentity } from "../coalesce";
import { verifyChain } from "../evidence";
import { runPriceMonitor } from "../monitor";
import { FakeTransport, type MonitorConfig } from "../transport";
import { EVENT_KINDS } from "../types";
import { FakeDb } from "./fakeDb";

/** Every kind the D4-1 / authorization migrations emit as of #384 b84f81fa / #392 03d791bf (grep of emit(' / emit_safe(' literals). */
const EMITTED = [
  "approver_added", "approver_registry_changed", "approver_removed", "credential_compromise_reported", "credential_recovery_used", "credential_replaced", "credential_revocation_accepted",
  "event_emit_failed", "price_authorization_started", "price_integrity_failure", "price_proposed", "pricing_resumed", "pricing_suspended", "recovery_enrollment_started",
];

function setup(transports = [new FakeTransport()], over: Partial<MonitorConfig> = {}) {
  let t = Date.parse("2026-11-06T12:00:00Z");
  const clock = () => new Date(t);
  const db = new FakeDb(clock);
  const config: MonitorConfig = { transports, chainKey: null, since: null, repeatMs: 6 * 3600_000, maxAgeMs: 45 * 60_000, trustedFromSeq: 0, expectHead: null, ...over };
  const mk = () => ({ db, config, now: clock, sleep: async () => undefined });
  let seq = 0;
  const emit = (kind: string, subject: string | null, detail: Record<string, unknown> = {}) => {
    seq += 1;
    (db.eventRows as unknown[]).push({ seq, kind, occurred_at: clock().toISOString(), subject_user_id: subject, detail });
  };
  const run = () => { db.verifyResult = { ok: true, anomalies: [], checked_at: clock().toISOString() }; return runPriceMonitor(mk()); };
  return { db, transports, config, emit, run, advance: (ms: number) => { t += ms; }, clock, deps: mk };
}
const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
/** Events recorded in the evidence chain: collapsed per identity with a count (the events table keeps every row). */
const EVIDENCE_EVENT_COUNT = (db: FakeDb) => db.rows.filter((r) => r.kind === "run").flatMap((r) => (JSON.parse(r.payload).findings as { identity?: string; count?: number }[]).filter((f) => f.identity)).reduce((n, f) => n + (f.count ?? 1), 0);

describe("D4-2 event classification vs what the database emits", () => {
  it("every emitted kind is classified (none falls into unknown_security_event)", () => {
    for (const k of EMITTED) expect(EVENT_KINDS[k], k).toBeDefined();
    const out = classifyEvents(EMITTED.map((kind, i) => ({ seq: i + 1, kind, occurred_at: "2026-11-06T00:00:00Z", subject_user_id: null, detail: {} })), null);
    expect(out.map((f) => f.code)).not.toContain("unknown_security_event");
  });

  it("scan: when the pricing migrations are in the tree, every literal kind they emit is classified", () => {
    const dir = join(__dirname, "../../../supabase/migrations");
    const kinds = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && /price|authoriz/.test(x))) {
      const sql = readFileSync(join(dir, f), "utf8");
      for (const m of sql.matchAll(/\b(?:emit|emit_safe|_tw4pricemon_emit_event)\(\s*'([a-z0-9_]+)'/g)) kinds.add(m[1]);
    }
    for (const k of kinds) expect(EVENT_KINDS[k], `unclassified emitted kind ${k}`).toBeDefined();
  });

  it("an unknown kind is CRITICAL, alerted at once and never coalesced into a different identity", async () => {
    const s = setup();
    s.emit("brand_new_recovery_thing", U1, { a: 1 });
    const out = await s.run();
    expect(out.findings[0]).toMatchObject({ code: "unknown_security_event", severity: "critical" });
    expect(s.transports[0].sent).toHaveLength(1);
    expect(s.transports[0].sent[0].severity).toBe("critical");
  });

  it("recovery kinds are critical", () => {
    const f = classifyEvents([
      { seq: 1, kind: "credential_recovery_used", occurred_at: "x", subject_user_id: null, detail: {} },
      { seq: 2, kind: "recovery_enrollment_started", occurred_at: "x", subject_user_id: null, detail: {} },
    ], null);
    expect(f.map((x) => x.severity)).toEqual(["critical", "critical"]);
  });
});

describe("D4-2 alert policy: identity and coalescing", () => {
  it("identity ignores volatile keys, but a different subject, kind or detail is a different identity", () => {
    const a = eventIdentity("credential_replaced", U1, { credential: "k1", occurred_at: "2026-11-06T00:00:00Z", request_id: "r1", seq: 4 });
    expect(eventIdentity("credential_replaced", U1, { credential: "k1", occurred_at: "2026-11-06T00:05:00Z", request_id: "r2", seq: 9 })).toBe(a);
    expect(eventIdentity("credential_replaced", U2, { credential: "k1" })).not.toBe(a);
    expect(eventIdentity("credential_replaced", U1, { credential: "k2" })).not.toBe(a);
    expect(eventIdentity("credential_revocation_accepted", U1, { credential: "k1" })).not.toBe(a);
  });

  it("first critical alert is immediate; an identical repeat inside 5 minutes is not sent but is fully recorded; a different identity is sent independently", async () => {
    const s = setup();
    s.emit("credential_compromise_reported", U1, { reason: "lost" });
    await s.run();
    expect(s.transports[0].sent).toHaveLength(1);
    s.advance(60_000);
    s.emit("credential_compromise_reported", U1, { reason: "lost", occurred_at: "later" });
    const rep = await s.run();
    expect(rep.alertRequired).toBe(false);
    expect(s.transports[0].sent).toHaveLength(1);
    // the evidence still has BOTH events and the suppressed count
    expect(EVIDENCE_EVENT_COUNT(s.db)).toBe(2);
    const lastRun = JSON.parse(s.db.rows.filter((r) => r.kind === "run").at(-1)!.payload);
    expect(Object.values(lastRun.coalesced)).toEqual([1]);
    // a different subject, and a different kind, inside the same window: each is sent
    s.advance(60_000);
    s.emit("credential_compromise_reported", U2, { reason: "lost" });
    s.emit("credential_recovery_used", U1, {});
    const other = await s.run();
    expect(other.alertRequired).toBe(true);
    // each distinct incident is its OWN message (own immediate alert), never batched with another
    const last2 = s.transports[0].sent.slice(-2);
    expect(last2.map((m) => m.findings.length)).toEqual([1, 1]);
    expect(last2.map((m) => m.findings[0].code).sort()).toEqual(["credential_compromise", "credential_recovery_used"]);
    expect(last2.every((m) => m.severity === "critical")).toBe(true);
  });

  it("when the window closes the suppressed repeats are summarised (once), then the next identical event is a fresh first alert", async () => {
    const s = setup();
    s.emit("credential_replaced", U1, { credential: "k1" });
    await s.run();
    for (let i = 0; i < 3; i++) { s.advance(30_000); s.emit("credential_replaced", U1, { credential: "k1" }); await s.run(); }
    expect(s.transports[0].sent).toHaveLength(1);
    s.advance(6 * 60_000); // window closed, no new event
    const sum = await s.run();
    expect(sum.alertRequired).toBe(true);
    const m = s.transports[0].sent.at(-1)!;
    expect(m.findings.map((f) => f.code)).toEqual(["alert_coalesced"]);
    expect(m.findings[0].message).toContain("3 identical repeat");
    // the summary is not repeated
    s.advance(60_000);
    expect((await s.run()).alertRequired).toBe(false);
    // and the next identical event after the window is sent again as a fresh alert
    s.emit("credential_replaced", U1, { credential: "k1" });
    s.advance(1000);
    await s.run();
    expect(s.transports[0].sent).toHaveLength(3);
  });

  it("repeats carried by the next send are summarised in that send", async () => {
    const s = setup();
    s.emit("credential_replaced", U1, { credential: "k1" });
    await s.run();
    s.advance(60_000); s.emit("credential_replaced", U1, { credential: "k1" }); await s.run();
    s.advance(6 * 60_000); s.emit("credential_replaced", U1, { credential: "k1" }); await s.run();
    const last = s.transports[0].sent.at(-1)!;
    expect(last.findings[0].message).toContain("+1 identical repeat(s) were suppressed earlier");
  });

  it("state is in the evidence chain: a brand-new process with the same database still coalesces", async () => {
    const s = setup();
    s.emit("credential_replaced", U1, { credential: "k1" });
    await s.run();
    s.advance(60_000);
    s.emit("credential_replaced", U1, { credential: "k1" });
    const freshTransport = new FakeTransport();
    const out = await runPriceMonitor({ ...s.deps(), config: { ...s.config, transports: [freshTransport] } });
    expect(out.alertRequired).toBe(false);
    expect(freshTransport.sent).toHaveLength(0);
  });

  it("fails OPEN: an unreadable or tampered chain disables coalescing (everything is sent), a failed delivery is not treated as sent", async () => {
    const s = setup();
    s.emit("credential_replaced", U1, { credential: "k1" });
    await s.run();
    s.advance(60_000);
    s.emit("credential_replaced", U1, { credential: "k1" });
    // tamper with an earlier row
    s.db.rows[0] = { ...s.db.rows[0], payload: "{\"x\":1}" };
    expect(verifyChain(s.db.rows).ok).toBe(false);
    const out = await s.run();
    expect(out.alertRequired).toBe(true);
    expect(s.transports[0].sent.length).toBeGreaterThanOrEqual(2);
    // unreadable evidence list
    const s2 = setup();
    s2.emit("credential_replaced", U1, { credential: "k1" });
    await s2.run();
    s2.advance(60_000);
    s2.emit("credential_replaced", U1, { credential: "k1" });
    s2.db.evidenceList = async () => { throw new Error("down"); };
    const o2 = await s2.run();
    expect(o2.alertRequired).toBe(true);
    // delivery failure: the identity was never sent, so the next identical event is not suppressed
    const s3 = setup();
    s3.transports[0].failSends = 3;
    s3.emit("credential_replaced", U1, { credential: "k1" });
    await s3.run();
    s3.advance(60_000);
    s3.emit("credential_replaced", U1, { credential: "k1" });
    const o3 = await s3.run();
    expect(o3.alertRequired).toBe(true);
    expect(s3.transports[0].sent.length).toBeGreaterThanOrEqual(1);
  });
});

describe("D4-2 alert policy: rate and cost protection", () => {
  const sendsInAnyHour = (t: FakeTransport) => {
    const times = t.sent.map((m) => Date.parse(m.generatedAt)).sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i < times.length; i++) max = Math.max(max, times.filter((x) => x >= times[i] && x < times[i] + 3600_000).length);
    return max;
  };

  it("flood: hundreds of identical and distinct events produce a bounded number of sends, one rate notice, and complete evidence; held alerts are delivered later within the cap", { timeout: 120_000 }, async () => {
    const CAP = 12;
    const s = setup([new FakeTransport()], { defaultSendCap: CAP });
    let events = 0;
    for (let minute = 0; minute < 30; minute++) {
      for (let i = 0; i < 20; i++) { s.emit("credential_replaced", U1, { credential: "same" }); events += 1; }
      s.emit("credential_replaced", `00000000-0000-4000-8000-${String(minute).padStart(12, "0")}`, { credential: `c${minute}` }); events += 1;
      await s.run();
      s.advance(60_000);
    }
    const t = s.transports[0];
    // cost bound: attempts in the first hour never exceed the cap (the last slot is the one-per-hour rate notice)
    const attempts = s.db.rows.filter((r) => r.kind === "delivery").flatMap((r) => (JSON.parse(r.payload).results ?? []) as { attempts: number }[]).reduce((n, x) => n + x.attempts, 0);
    expect(attempts).toBeLessThanOrEqual(CAP);
    expect(t.sent.length).toBeLessThanOrEqual(CAP);
    expect(t.sent.filter((m) => m.findings.some((f) => f.code === "alert_rate_limited"))).toHaveLength(1);
    // evidence is complete: every one of the events is a finding in some run row
    expect(EVIDENCE_EVENT_COUNT(s.db)).toBe(events);
    expect(verifyChain(s.db.rows).ok).toBe(true);
    // keep running with no new events: held alerts drain at the capped rate
    for (let i = 0; i < 90; i++) { s.advance(600_000); await s.run(); } // warn-class capacity is half of the hourly slots, so the backlog drains over hours
    expect(sendsInAnyHour(t)).toBeLessThanOrEqual(CAP);
    const { listUndelivered } = await import("../ops");
    expect((await listUndelivered(s.deps())).undelivered).toEqual([]);
  });

  it("the cap is per transport", async () => {
    const a = new FakeTransport("webhook"), b = new FakeTransport("resend_email");
    const s = setup([a, b], { defaultSendCap: 12, sendCaps: { resend_email: 4 } });
    for (let i = 0; i < 30; i++) { s.emit("credential_replaced", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { credential: `c${i}` }); await s.run(); s.advance(30_000); }
    expect(b.sent.length).toBeLessThanOrEqual(4);
    expect(a.sent.length).toBeLessThanOrEqual(12);
    expect(a.sent.length).toBeGreaterThan(b.sent.length);
  });
});

describe("D4-2 alert policy: one alert per distinct incident", () => {
  it("two independent incidents in the same run are two messages; identical events in the same run collapse into one message that says so; an info event is batched", async () => {
    const s = setup();
    s.emit("credential_compromise_reported", U1, { reason: "lost" });
    s.emit("credential_compromise_reported", U1, { reason: "lost" });
    s.emit("price_integrity_failure", null, { check: "digest" });
    s.emit("credential_replaced", U2, { credential: "k9" });
    s.emit("price_proposed", U1, { kind: "number" });
    await s.run();
    const sent = s.transports[0].sent;
    expect(sent).toHaveLength(4);
    expect(sent.slice(0, 2).map((m) => m.findings[0].code).sort()).toEqual(["credential_compromise", "price_integrity_failure"]);
    expect(sent[0].severity).toBe("critical");
    expect(sent[2].findings.map((f) => f.code)).toEqual(["credential_replaced"]);
    expect(sent[3].findings.map((f) => f.code)).toEqual(["price_proposed"]);
    const compromise = sent.find((m) => m.findings[0].code === "credential_compromise")!;
    expect(compromise.findings[0].message).toContain("(x2 in this run)");
    expect(EVIDENCE_EVENT_COUNT(s.db)).toBe(5);
  });

  it("different credentials of the same kind are different incidents: each gets its own alert", async () => {
    const s = setup();
    s.emit("credential_replaced", U1, { credential: "k1" });
    s.emit("credential_replaced", U1, { credential: "k2" });
    s.emit("credential_replaced", U2, { credential: "k1" });
    await s.run();
    expect(s.transports[0].sent).toHaveLength(3);
  });

  it("per-message delivery evidence: a failed message is held and re-sent alone; delivered messages are never repeated", async () => {
    const s = setup();
    const t = s.transports[0];
    s.emit("credential_compromise_reported", U1, { reason: "a" });
    s.emit("credential_compromise_reported", U2, { reason: "b" });
    // first message goes out; the second fails all 3 attempts
    const origSend = t.send.bind(t);
    let calls = 0;
    t.send = async (m) => { calls += 1; if (calls >= 2 && calls <= 4) throw Object.assign(new Error("x"), { code: "network" }); return origSend(m); };
    const first = await s.run();
    expect(first.alertDelivered).toBe(false);
    expect(t.sent).toHaveLength(1);
    const rows = s.db.rows.filter((r) => r.kind === "delivery").map((r) => JSON.parse(r.payload));
    expect(rows.map((r) => [r.msg, r.alert_ok])).toEqual([[0, true], [1, false]]);
    s.advance(60_000);
    const second = await s.run();
    expect(second.redelivered).toBe(1);
    const real = () => t.sent.filter((m) => !m.findings.every((f) => f.code === "alert_delivery_failed")); // the one-off 'held alerts exist' notice is not an incident alert
    expect(real()).toHaveLength(2);
    expect(real()[1].redeliveryOfSeq).toBeDefined();
    expect(real()[1].findings).toHaveLength(1);
    s.advance(60_000);
    await s.run();
    expect(real()).toHaveLength(2);
  });
});

describe("D4-2 alert policy: priority classes and capacity reservation", () => {
  const recoverySent = (t: FakeTransport) => t.sent.filter((m) => m.findings.some((f) => f.code === "credential_recovery_used"));

  it("15 distinct WARNING identities cannot delay a genuine credential_recovery_used: it is sent immediately; the warnings stay held, none lost", async () => {
    const s = setup();
    const t = s.transports[0];
    for (let i = 0; i < 15; i++) s.emit("credential_replaced", U1, { credential: "k" + i, change_id: "c" + i });
    await s.run();
    const warnSent = t.sent.filter((m) => m.findings.every((f) => f.code === "credential_replaced")).length;
    expect(warnSent).toBe(5); // warn/info may use at most half of the 11 alert slots
    expect(recoverySent(t)).toHaveLength(0);
    s.advance(60_000);
    s.emit("credential_recovery_used", U1, { action: "recovery_completed" });
    await s.run();
    expect(recoverySent(t)).toHaveLength(1);
    expect(recoverySent(t)[0].severity).toBe("critical");
    // the held warnings are recorded (evidence has all 16), not lost
    expect(EVIDENCE_EVENT_COUNT(s.db)).toBe(16);
    const { listUndelivered } = await import("../ops");
    expect((await listUndelivered(s.deps())).undelivered.filter((u) => u.codes.includes("credential_replaced")).length).toBe(10);
  });

  it("15 distinct CRITICAL (non-top) incidents cannot starve credential_recovery_used either: the reserve is only for top-priority kinds", async () => {
    const s = setup();
    const t = s.transports[0];
    for (let i = 0; i < 15; i++) s.emit("credential_compromise_reported", U1, { target: "key" + i });
    await s.run();
    const critSent = t.sent.filter((m) => m.findings.every((f) => f.code === "credential_compromise")).length;
    expect(critSent).toBe(8); // N=11 minus the 3 slots reserved for top priority
    s.advance(30_000);
    s.emit("credential_recovery_used", U1, { action: "recover_freeze" });
    s.emit("price_integrity_failure", null, { check: "digest" });
    await s.run();
    expect(recoverySent(t)).toHaveLength(1);
    expect(t.sent.some((m) => m.findings.some((f) => f.code === "price_integrity_failure"))).toBe(true);
    // top priority never exceeds the hourly cap
    const attempts = s.db.rows.filter((r) => r.kind === "delivery").flatMap((r) => (JSON.parse(r.payload).results ?? []) as { attempts: number }[]).reduce((n, x) => n + x.attempts, 0);
    expect(attempts).toBeLessThanOrEqual(12);
  });

  it("user-controlled sizes (note_length) are not part of the identity: variants of one report collapse into one alert while every event is still counted", async () => {
    const s = setup();
    for (let i = 0; i < 15; i++) s.emit("credential_compromise_reported", U1, { reason: "lost", note_length: 10 + i });
    await s.run();
    expect(s.transports[0].sent).toHaveLength(1);
    expect(s.transports[0].sent[0].findings[0].message).toContain("(x15 in this run)");
    expect(EVIDENCE_EVENT_COUNT(s.db)).toBe(15);
  });

  it("held messages drain by priority class, oldest first inside a class, when capacity returns", async () => {
    const s = setup();
    const t = s.transports[0];
    for (let i = 0; i < 10; i++) s.emit("credential_compromise_reported", U1, { target: "k" + String(i).padStart(2, "0") }); // crit: 8 sent, 2 held (k08, k09)
    for (let i = 0; i < 8; i++) s.emit("credential_replaced", U2, { credential: "w" + i }); // warn: 3 slots left under the warn+crit limit... all but few held
    await s.run();
    const firstHour = t.sent.length;
    s.advance(61 * 60_000);
    await s.run();
    const after = t.sent.slice(firstHour).filter((m) => m.redeliveryOfSeq !== undefined);
    expect(after.length).toBeGreaterThan(0);
    // crit messages come before warn messages in the re-delivery order
    const order = after.map((m) => m.findings[0].code);
    const firstWarn = order.indexOf("credential_replaced");
    if (firstWarn >= 0) expect(order.slice(0, firstWarn).every((c) => c === "credential_compromise")).toBe(true);
    expect(order.indexOf("credential_compromise")).toBeLessThan(firstWarn < 0 ? order.length : firstWarn);
    const seqs = after.filter((m) => m.findings[0].code === "credential_compromise").map((m) => Number(/event:(\d+):/.exec(m.findings[0].refs.join(" "))?.[1] ?? NaN));
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((n) => Number.isFinite(n))).toBe(true);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
