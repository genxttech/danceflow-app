import { describe, expect, it } from "vitest";
import { classifyEvents } from "../classify";
import { listUndelivered, redeliverUndelivered } from "../ops";
import { runPriceMonitor, runPriceWatchdog } from "../monitor";
import { FakeTransport, TransportError, renderAlertText, type MonitorConfig } from "../transport";
import { ackToken, confirmDeliveryVerification, startDeliveryVerification } from "../verifyDelivery";
import { MONITOR_RPCS } from "../types";
import { FakeDb } from "./fakeDb";

function setup(transports = [new FakeTransport()], over: Partial<MonitorConfig> = {}) {
  let t = Date.parse("2026-11-01T12:00:00Z");
  const clock = () => new Date(t);
  const db = new FakeDb(clock);
  const config: MonitorConfig = { transports, chainKey: null, since: null, repeatMs: 6 * 3600_000, maxAgeMs: 45 * 60_000, trustedFromSeq: 0, expectHead: null, ...over };
  const deps = { db, config, now: clock, sleep: async () => undefined };
  return { db, config, transports, deps, advance: (ms: number) => { t += ms; }, fresh: () => { db.verifyResult = { ok: true, anomalies: [], checked_at: clock().toISOString() }; } };
}

describe("D4-2 audit: event kinds from the authorization workstream", () => {
  it("recovery use and enrolment are critical; revocation accepted is a warning; emit failure is critical", () => {
    const ev = (kind: string) => classifyEvents([{ seq: 1, kind, occurred_at: "2026-11-01T00:00:00Z", subject_user_id: null, detail: {} }], null)[0];
    expect(ev("credential_recovery_used")).toMatchObject({ code: "credential_recovery_used", severity: "critical" });
    expect(ev("recovery_enrollment_started")).toMatchObject({ code: "recovery_enrollment_started", severity: "critical" });
    expect(ev("credential_revocation_accepted")).toMatchObject({ code: "credential_revocation_accepted", severity: "warning" });
    expect(ev("event_emit_failed")).toMatchObject({ code: "event_emit_failed", severity: "critical" });
    expect(ev("credential_compromise_reported").severity).toBe("critical");
    expect(ev("price_integrity_failure")).toMatchObject({ code: "price_integrity_failure", severity: "critical" });
    expect(ev("price_authorization_started")).toMatchObject({ code: "price_authorization_started", severity: "info" });
  });

  it("price_authorization_started shows a valid 16-hex fingerprint in the alert text, and ignores a malformed one", async () => {
    const s = setup();
    s.db.eventRows = [
      { seq: 1, kind: "price_authorization_started", occurred_at: "2026-11-01T11:00:00Z", subject_user_id: null, detail: { fingerprint: "0123456789abcdef" } },
      { seq: 2, kind: "price_authorization_started", occurred_at: "2026-11-01T11:01:00Z", subject_user_id: null, detail: { fingerprint: "not-hex" } },
    ];
    const out = await runPriceMonitor(s.deps);
    expect(out.findings.map((f) => f.code)).toEqual(["price_authorization_started", "price_authorization_started"]);
    expect(out.findings[0].message).toContain("fingerprint 0123456789abcdef");
    expect(out.findings[1].message).not.toContain("fingerprint");
    const text = renderAlertText(s.transports[0].sent[0]);
    expect(text).toContain("0123456789abcdef");
    expect(s.transports[0].sent[0].severity).toBe("info");
  });
});

describe("D4-2 audit: guards and watchdog", () => {
  it("a disabled guard trigger is a critical finding; a vanished guard is critical too", async () => {
    const s = setup();
    s.db.guards = { studio_sms_price_monitor_evidence_immutable: "A", studio_sms_price_list_00_activation: "A" };
    await runPriceMonitor(s.deps);
    s.advance(60_000); s.fresh();
    s.db.guards = { studio_sms_price_monitor_evidence_immutable: "D", studio_sms_price_list_00_activation: "A" };
    const bad = await runPriceMonitor(s.deps);
    expect(bad.findings.map((f) => f.code)).toContain("guard_disabled");
    s.advance(60_000); s.fresh();
    s.db.guards = { studio_sms_price_monitor_evidence_immutable: "A" };
    const gone = await runPriceMonitor(s.deps);
    expect(gone.findings.map((f) => f.code)).toContain("guard_missing");
    expect(gone.findings.find((f) => f.code === "guard_missing")!.refs).toEqual(["guard:studio_sms_price_list_00_activation"]);
  });

  it("expected guards missing or tables absent are reported at once on the FIRST run (no earlier run needed); a digest without a guard inventory is critical", async () => {
    const s = setup();
    s.db.missingGuards = ["studio_sms_price_list_00_activation"];
    s.db.absentTables = ["studio_sms_price_audit"];
    const out = await runPriceMonitor(s.deps);
    const codes = out.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["guard_missing", "pricing_tables_partial"]));
    expect(out.findings.find((f) => f.code === "guard_missing")!.refs).toEqual(["guard:studio_sms_price_list_00_activation"]);
    expect(out.findings.find((f) => f.code === "pricing_tables_partial")!.refs).toEqual(["table:studio_sms_price_audit"]);
    const s2 = setup();
    s2.db.noGuardInventory = true;
    expect((await runPriceMonitor(s2.deps)).findings.map((f) => f.code)).toContain("digest_unavailable");
  });

  it("the watchdog trusts the database insert time, not the writer-supplied recorded time", async () => {
    const s = setup();
    await runPriceMonitor(s.deps);
    // a forged future recorded_at would look fresh forever; the database's own inserted_at shows the truth
    s.db.rows[0] = { ...s.db.rows[0], recorded_at: "2099-01-01T00:00:00.000Z", inserted_at: "2026-11-01T12:00:00.000Z" };
    s.advance(3 * 3600_000);
    const out = await runPriceWatchdog(s.deps);
    expect(out.findings.map((f) => f.code)).toContain("monitor_stale");
  });
});

describe("D4-2 audit: undelivered alerts are listed and re-delivered without altering evidence", () => {
  it("lists every undelivered alert and re-sends them, adding rows only", async () => {
    const s = setup();
    s.transports[0].failSends = 99;
    for (let i = 0; i < 7; i++) {
      s.db.anomalies([{ code: "price_unattested", price_id: `00000000-0000-4000-8000-00000000000${i}`, kind: "number", created_at: "2026-11-01T11:00:00Z" }]);
      await runPriceMonitor(s.deps);
      s.advance(60_000);
    }
    const before = JSON.stringify(s.db.rows);
    const listed = await listUndelivered(s.deps);
    expect(listed.undelivered.length).toBe(7);
    expect(listed.undelivered[0].codes).toContain("unauthorized_price_change");
    s.transports[0].failSends = 0;
    const out = await redeliverUndelivered(s.deps);
    expect(out).toMatchObject({ attempted: 7, delivered: 7, failed: 0, recorded: true });
    // append-only: every earlier row is byte-identical
    expect(JSON.stringify(s.db.rows.slice(0, JSON.parse(before).length))).toBe(before);
    expect((await listUndelivered(s.deps)).undelivered).toEqual([]);
  });
});

describe("D4-2 audit: delivery verification", () => {
  const SECRET = "verify-secret";
  const withSecret = (s: ReturnType<typeof setup>) => ({ ...s.deps, secret: SECRET, newNonce: () => "n0nce" });

  it("a webhook that answers the correct ack is confirmed and recorded; a wrong or missing ack fails", async () => {
    const s = setup();
    s.transports[0].testAck = (m) => ackToken(SECRET, m.nonce);
    const ok = await startDeliveryVerification(withSecret(s));
    expect(ok.status).toBe("confirmed");
    expect(ok.recorded).toBe(true);
    const row = JSON.parse(s.db.rows.at(-1)!.payload);
    expect(row).toMatchObject({ source: "verification", phase: "sent", status: "confirmed" });
    expect(row.alert_ok).toBeUndefined(); // can never mark a real alert as delivered
    expect(JSON.stringify(s.db.rows)).not.toContain("n0nce"); // only the nonce hash is stored
    s.transports[0].testAck = () => "0".repeat(32);
    expect((await startDeliveryVerification(withSecret(s))).verdicts[0].receipt).toBe("mismatch");
    s.transports[0].testAck = null;
    expect((await startDeliveryVerification(withSecret(s))).status).toBe("pending"); // FakeTransport name is not "webhook": out-of-band
  });

  it("send failure, no secret, no destination: failed, never a pass", async () => {
    const s = setup();
    s.transports[0].failSends = 1;
    expect((await startDeliveryVerification(withSecret(s))).verdicts[0]).toMatchObject({ receipt: "send_failed", code: "network" });
    expect((await startDeliveryVerification({ ...s.deps, secret: null })).reason).toBe("no_verification_secret");
    const none = setup([]);
    expect((await startDeliveryVerification({ ...none.deps, secret: SECRET })).reason).toBe("no_destination");
  });

  it("out-of-band confirmation: right token confirms once; wrong token, unknown nonce, expired and replay are refused", async () => {
    const s = setup();
    const sent = await startDeliveryVerification(withSecret(s));
    expect(sent.status).toBe("pending");
    const dep = withSecret(s);
    expect((await confirmDeliveryVerification(dep, { nonce: "n0nce", token: "bad" })).reason).toBe("token_mismatch");
    expect((await confirmDeliveryVerification(dep, { nonce: "other", token: ackToken(SECRET, "other") })).reason).toBe("no_matching_verification");
    const good = await confirmDeliveryVerification(dep, { nonce: "n0nce", token: ackToken(SECRET, "n0nce") });
    expect(good).toMatchObject({ confirmed: true, recorded: true });
    expect(JSON.parse(s.db.rows.at(-1)!.payload)).toMatchObject({ phase: "confirmed" });
    expect((await confirmDeliveryVerification(dep, { nonce: "n0nce", token: ackToken(SECRET, "n0nce") })).reason).toBe("already_confirmed");
    const s2 = setup();
    await startDeliveryVerification(withSecret(s2));
    s2.advance(25 * 3600_000);
    expect((await confirmDeliveryVerification(withSecret(s2), { nonce: "n0nce", token: ackToken(SECRET, "n0nce") })).reason).toBe("expired");
  });
});

describe("D4-2 audit: the monitor never repairs or overwrites prices", () => {
  it("across every scenario the only database calls are the allow-listed read RPCs and the evidence append", async () => {
    const s = setup();
    const names: string[] = [];
    const orig = { verify: s.db.verify.bind(s.db), digest: s.db.digest.bind(s.db), events: s.db.events.bind(s.db), list: s.db.evidenceList.bind(s.db), append: s.db.evidenceAppend.bind(s.db) };
    s.db.verify = async (x) => { names.push("tw4_price_verify"); return orig.verify(x); };
    s.db.digest = async () => { names.push("tw4_price_monitor_digest"); return orig.digest(); };
    s.db.events = async (x) => { names.push("tw4_price_monitor_events"); return orig.events(x); };
    s.db.evidenceList = async (a, b) => { names.push("tw4_price_monitor_evidence_list"); return orig.list(a, b); };
    s.db.evidenceAppend = async (r) => { names.push("tw4_price_monitor_evidence_append"); return orig.append(r); };
    s.db.anomalies([{ code: "price_unattested", price_id: "p", kind: "number", created_at: "x" }]);
    await runPriceMonitor(s.deps);
    s.db.verifyThrows = true;
    await runPriceMonitor(s.deps);
    await runPriceWatchdog(s.deps);
    await redeliverUndelivered(s.deps);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(MONITOR_RPCS as readonly string[]).toContain(n);
    expect(names).not.toContain("tw4_price_set");
  });

  it("TransportError is exported for adapters", () => {
    expect(new TransportError("x", "network").message).toBe("alert transport x: network");
  });
});
