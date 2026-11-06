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
const FAKE_RUN_EVENT_FINDINGS = (db: FakeDb) => db.rows.filter((r) => r.kind === "run").flatMap((r) => (JSON.parse(r.payload).findings as { identity?: string }[]).filter((f) => f.identity));

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
    expect(FAKE_RUN_EVENT_FINDINGS(s.db)).toHaveLength(2);
    const lastRun = JSON.parse(s.db.rows.filter((r) => r.kind === "run").at(-1)!.payload);
    expect(Object.values(lastRun.coalesced)).toEqual([1]);
    // a different subject, and a different kind, inside the same window: each is sent
    s.advance(60_000);
    s.emit("credential_compromise_reported", U2, { reason: "lost" });
    s.emit("credential_recovery_used", U1, {});
    const other = await s.run();
    expect(other.alertRequired).toBe(true);
    const codes = s.transports[0].sent.at(-1)!.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["credential_compromise", "credential_recovery_used"]));
    expect(s.transports[0].sent.at(-1)!.findings.filter((f) => f.identity)).toHaveLength(2);
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
    for (let minute = 0; minute < 45; minute++) {
      for (let i = 0; i < 20; i++) { s.emit("credential_replaced", U1, { credential: "same" }); events += 1; }
      for (let i = 0; i < 5; i++) { s.emit("credential_replaced", `00000000-0000-4000-8000-${String(minute * 10 + i).padStart(12, "0")}`, { credential: `c${minute}-${i}` }); events += 1; }
      await s.run();
      s.advance(60_000);
    }
    const t = s.transports[0];
    // cost bound: attempts in the first hour never exceed the cap (the last slot is the one-per-hour rate notice)
    const attempts = s.db.rows.filter((r) => r.kind === "delivery").flatMap((r) => (JSON.parse(r.payload).results ?? []) as { attempts: number }[]).reduce((n, x) => n + x.attempts, 0);
    expect(attempts).toBeLessThanOrEqual(CAP);
    expect(t.sent.length).toBeLessThanOrEqual(CAP);
    expect(t.sent.filter((m) => m.findings.some((f) => f.code === "alert_rate_limited"))).toHaveLength(1);
    // evidence is complete: every one of the 1125 events is a finding in some run row
    expect(FAKE_RUN_EVENT_FINDINGS(s.db)).toHaveLength(events);
    expect(verifyChain(s.db.rows).ok).toBe(true);
    // keep running with no new events: held alerts drain at the capped rate
    for (let i = 0; i < 400; i++) { s.advance(60_000); await s.run(); }
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
