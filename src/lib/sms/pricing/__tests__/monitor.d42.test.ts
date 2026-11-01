import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyVerify } from "../classify";
import { createPriceMonitorDb } from "../db";
import { GENESIS_HASH, canonicalJson, entryHash, parseEvidenceList, verifyChain } from "../evidence";
import { runPriceMonitor, runPriceWatchdog } from "../monitor";
import { FakeTransport, loadMonitorConfig, renderAlertText, resendTransport, webhookTransport, type MonitorConfig } from "../transport";
import type { EvidenceRow } from "../types";
import { FakeDb } from "./fakeDb";

function setup(over: Partial<MonitorConfig> = {}, transports = [new FakeTransport()]) {
  let t = Date.parse("2026-11-01T12:00:00Z");
  const clock = () => new Date(t);
  const db = new FakeDb(clock);
  const config: MonitorConfig = { transports, chainKey: null, since: null, repeatMs: 6 * 3600_000, maxAgeMs: 45 * 60_000, trustedFromSeq: 0, expectHead: null, ...over };
  const run = () => runPriceMonitor({ db, config, now: clock, sleep: async () => undefined });
  const watch = () => runPriceWatchdog({ db, config, now: clock, sleep: async () => undefined });
  const advance = (ms: number) => { t += ms; };
  return { db, config, transports, run, watch, advance, clock };
}
const refresh = (s: ReturnType<typeof setup>) => { // keep the verifier timestamp fresh for a clean result
  s.db.verifyResult = { ok: true, anomalies: [], checked_at: s.clock().toISOString() };
};
const forged = [{ code: "price_unattested", price_id: "11111111-1111-4111-8111-111111111111", kind: "sms_usage", created_at: "2026-11-01T11:59:00Z" }];

describe("D4-2 price monitor", () => {
  it("a clean run records evidence, sends no alert and pings the heartbeat", async () => {
    const s = setup();
    const out = await s.run();
    expect(out.ok).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.alertRequired).toBe(false);
    expect(s.transports[0].sent).toHaveLength(0);
    expect(s.transports[0].heartbeats).toHaveLength(1);
    expect(s.db.rows).toHaveLength(1);
    expect(verifyChain(s.db.rows).ok).toBe(true);
    expect(s.transports[0].heartbeats[0].chainHeadHash).toBe(s.db.rows[0].entry_hash);
  });

  it("a forged price row raises a critical alert carrying the chain head", async () => {
    const s = setup();
    s.db.anomalies(forged);
    const out = await s.run();
    expect(out.ok).toBe(false);
    expect(out.findings.map((f) => f.code)).toEqual(["unauthorized_price_change"]);
    const m = s.transports[0].sent[0];
    expect(m.severity).toBe("critical");
    expect(m.chainHeadSeq).toBe(1);
    expect(m.chainHeadHash).toBe(s.db.rows[0].entry_hash);
    expect(renderAlertText(m)).toContain(s.db.rows[0].entry_hash);
    expect(renderAlertText(m)).toContain("changed nothing");
  });

  it("classifies missing approval, several active prices, and unknown codes (fail closed)", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const mk = (anomalies: unknown[]) => classifyVerify({ ok: anomalies.length === 0, anomalies, checked_at: now.toISOString() }, now).map((f) => f.code);
    expect(mk([{ code: "request_anomaly", request_id: "r", status: "approved", kind: "sms_usage" }])).toEqual(["missing_approval"]);
    expect(mk([{ code: "several_active_prices", kind: "number", count: 2 }])).toEqual(["unauthorized_price_change"]);
    expect(mk([{ code: "brand_new_code" }])).toEqual(["verification_failure"]);
    expect(mk([])).toEqual([]);
  });

  it("verification failure: thrown, unintelligible, contradictory or stale results all alert", async () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(classifyVerify(null, now)[0].code).toBe("verification_failure");
    expect(classifyVerify({ ok: true, anomalies: [{ code: "price_unattested" }], checked_at: now.toISOString() }, now)[0].code).toBe("verification_failure");
    expect(classifyVerify({ ok: false, anomalies: [], checked_at: now.toISOString() }, now)[0].code).toBe("verification_failure");
    expect(classifyVerify({ ok: true, anomalies: [], checked_at: "2026-11-01T11:00:00Z" }, now)[0].code).toBe("verification_failure");
    expect(classifyVerify({ ok: true, anomalies: [] }, now)[0].code).toBe("verification_failure");
    const s = setup();
    s.db.verifyThrows = true;
    const out = await s.run();
    expect(out.findings.map((f) => f.code)).toContain("verification_failure");
    expect(out.ok).toBe(false);
    expect(s.transports[0].sent).toHaveLength(1);
  });

  it("consumes security events generically: compromise, replacement, suspension, unknown kinds; each event once", async () => {
    const s = setup();
    s.db.eventRows = [
      { seq: 1, kind: "credential_compromise_reported", occurred_at: "2026-11-01T11:00:00Z", subject_user_id: null, detail: {} },
      { seq: 2, kind: "mfa_factor_changed", occurred_at: "2026-11-01T11:01:00Z", subject_user_id: null, detail: {} },
      { seq: 3, kind: "pricing_suspended", occurred_at: "2026-11-01T11:02:00Z", subject_user_id: null, detail: {} },
      { seq: 4, kind: "something_new", occurred_at: "2026-11-01T11:03:00Z", subject_user_id: null, detail: {} },
    ];
    s.db.suspension = { seq: 3, kind: "pricing_suspended", occurred_at: "2026-11-01T11:02:00Z" };
    const first = await s.run();
    const codes = first.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["credential_compromise", "credential_replaced", "pricing_suspended", "unknown_security_event"]));
    // second run: events were consumed (cursor in the evidence), the suspension STATE still alerts only on the repeat interval
    s.advance(60_000); refresh(s);
    const second = await s.run();
    expect(second.findings.map((f) => f.code)).toEqual(["pricing_suspended"]);
    expect(second.alertRequired).toBe(false);
    s.advance(7 * 3600_000); refresh(s);
    const third = await s.run();
    expect(third.alertRequired).toBe(true);
    // lifted
    s.db.suspension = { seq: 5, kind: "pricing_resumed", occurred_at: "2026-11-01T19:00:00Z" };
    s.advance(60_000); refresh(s);
    expect((await s.run()).findings).toEqual([]);
  });

  it("a changed price-list digest is reported as info even when the verifier is clean", async () => {
    const s = setup();
    await s.run();
    s.advance(60_000); refresh(s);
    s.db.digestValue = "b".repeat(64);
    const out = await s.run();
    expect(out.findings.map((f) => f.code)).toEqual(["price_changed"]);
    expect(out.findings[0].severity).toBe("info");
    expect(s.transports[0].sent).toHaveLength(1);
  });

  it("an unchanged finding is not re-alerted until the repeat interval", async () => {
    const s = setup();
    s.db.anomalies(forged);
    await s.run();
    s.advance(60_000); s.db.anomalies(forged);
    const second = await s.run();
    expect(second.alertRequired).toBe(false);
    expect(second.ok).toBe(false); // still a finding: the route answers 500
    s.advance(7 * 3600_000); s.db.anomalies(forged);
    expect((await s.run()).alertRequired).toBe(true);
    expect(s.transports[0].sent).toHaveLength(2);
  });

  it("tampered evidence chain (edited payload, broken link, hash) is detected and alerted", async () => {
    const s = setup();
    await s.run(); s.advance(60_000); refresh(s); await s.run(); s.advance(60_000); refresh(s); await s.run();
    expect(verifyChain(s.db.rows).ok).toBe(true);
    s.db.rows[1] = { ...s.db.rows[1], payload: canonicalJson({ v: 1, findings: [], tampered: true }) };
    s.advance(60_000); refresh(s);
    const out = await s.run();
    expect(out.findings.map((f) => f.code)).toContain("evidence_chain_broken");
    expect(out.chain.status).toBe("broken");
    expect(out.ok).toBe(false);
    expect(s.transports[0].sent.at(-1)?.chainStatus).toBe("broken");
  });

  it("verifyChain: gap, relink, forged row without the chain key, truncation against the published head", () => {
    const mk = (rows: EvidenceRow[], seq: number, kind: EvidenceRow["kind"], key?: string): EvidenceRow[] => {
      const prev = rows.length ? rows[rows.length - 1].entry_hash : GENESIS_HASH;
      const base = { seq, run_id: "00000000-0000-4000-8000-000000000001", kind, recorded_at: "2026-11-01T12:00:00.000Z", payload: "{}", prev_hash: prev };
      return [...rows, { ...base, entry_hash: entryHash(base, key) }];
    };
    let rows: EvidenceRow[] = [];
    for (let i = 1; i <= 4; i++) rows = mk(rows, i, "run", "k");
    expect(verifyChain(rows, { chainKey: "k" }).ok).toBe(true);
    expect(verifyChain(rows, { chainKey: "wrong" }).brokenAtSeq).toBe(1);
    expect(verifyChain([rows[0], rows[2], rows[3]], { chainKey: "k" }).reason).toBe("gap");
    const forgedRow = { ...rows[3], payload: "{\"x\":1}" };
    expect(verifyChain([...rows.slice(0, 3), forgedRow], { chainKey: "k" }).reason).toBe("hash");
    // an attacker without the key appends a row with a plain SHA-256: refused when a key is configured
    const plain = mk(rows, 5, "run");
    expect(verifyChain(plain, { chainKey: "k" }).ok).toBe(false);
    // tail truncation: the last alert published seq 4; the database now ends at seq 3
    expect(verifyChain(rows.slice(0, 3), { chainKey: "k", expectHead: { seq: 4, hash: rows[3].entry_hash } }).reason).toBe("truncated");
    expect(verifyChain(rows, { chainKey: "k", expectHead: { seq: 3, hash: "f".repeat(64) } }).reason).toBe("head_mismatch");
    // an owner acknowledgement lets the chain be judged from after the break
    const tamperedEarly = [{ ...rows[0], payload: "{\"x\":1}" }, ...rows.slice(1)];
    expect(verifyChain(tamperedEarly, { chainKey: "k", trustedFromSeq: 1 }).ok).toBe(true);
  });

  it("alert transport failure is recorded, reported and retried on the next run (never swallowed)", async () => {
    const s = setup();
    s.transports[0].failSends = 3; // all attempts of the first alert fail
    s.db.anomalies(forged);
    const first = await s.run();
    expect(first.alertDelivered).toBe(false);
    expect(first.ok).toBe(false);
    expect(first.errors).toContain("alert_delivery_failed");
    const delivery = s.db.rows.filter((r) => r.kind === "delivery").map((r) => JSON.parse(r.payload));
    expect(delivery).toHaveLength(1);
    expect(delivery[0].alert_ok).toBe(false);
    expect(delivery[0].results[0]).toMatchObject({ transport: "fake", ok: false, code: "network", attempts: 3 });
    // next run: the transport is healthy again: the earlier alert is re-delivered and the new one carries a delivery-failure warning
    s.advance(60_000); s.db.anomalies(forged);
    const second = await s.run();
    expect(second.redelivered).toBe(1);
    expect(second.alertDelivered).toBe(true);
    expect(s.transports[0].sent.some((m) => m.redeliveryOfSeq === 1)).toBe(true);
    expect(second.findings.map((f) => f.code)).toContain("alert_delivery_failed");
    // third run: nothing pending any more
    s.advance(60_000); s.db.anomalies(forged);
    expect((await s.run()).redelivered).toBe(0);
  });

  it("with a second destination, delivery succeeds if either accepts and the failure is still recorded", async () => {
    const a = new FakeTransport("a"), b = new FakeTransport("b");
    a.failSends = 3;
    const s = setup({}, [a, b]);
    s.db.anomalies(forged);
    const out = await s.run();
    expect(out.alertDelivered).toBe(true);
    const d = JSON.parse(s.db.rows.find((r) => r.kind === "delivery")!.payload);
    expect(d.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true]);
  });

  it("no configured destination fails closed: critical finding, evidence recorded, not ok", async () => {
    const s = setup({}, []);
    const out = await s.run();
    expect(out.destinationConfigured).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.findings.map((f) => f.code)).toContain("alert_delivery_failed");
    expect(out.evidenceRecorded).toBe(true);
  });

  it("heartbeat-only channels never count as an alert delivery", async () => {
    const hb = new FakeTransport("hb") as FakeTransport & { canAlert: boolean };
    (hb as { canAlert: boolean }).canAlert = false;
    const s = setup({}, [hb]);
    s.db.anomalies(forged);
    const out = await s.run();
    expect(out.destinationConfigured).toBe(false);
    expect(out.alertDelivered).toBe(false);
    expect(hb.sent).toHaveLength(0);
    expect(hb.heartbeats).toHaveLength(1);
  });

  it("evidence store down: still alerts (fail closed) and reports the evidence failure", async () => {
    const s = setup();
    s.db.appendFails = true;
    const out = await s.run();
    expect(out.evidenceRecorded).toBe(false);
    expect(out.findings.map((f) => f.code)).toContain("evidence_unavailable");
    expect(s.transports[0].sent).toHaveLength(1);
    expect(out.ok).toBe(false);
  });

  it("heartbeat failure is reported in the outcome", async () => {
    const s = setup();
    s.transports[0].failHeartbeats = true;
    const out = await s.run();
    expect(out.errors).toContain("heartbeat_failed");
    expect(out.ok).toBe(false);
  });

  it("monitor-down: the watchdog alerts when no run is recent, and stays quiet when the monitor is alive", async () => {
    const s = setup();
    const never = await s.watch();
    expect(never.findings.map((f) => f.code)).toContain("monitor_stale");
    expect(s.transports[0].sent).toHaveLength(1);
    await s.run();
    s.advance(10 * 60_000);
    const alive = await s.watch();
    expect(alive.findings.map((f) => f.code)).not.toContain("monitor_stale");
    s.advance(60 * 60_000); // the monitor stopped
    const stale = await s.watch();
    expect(stale.findings.map((f) => f.code)).toContain("monitor_stale");
    expect(stale.alertRequired).toBe(true);
    expect(s.transports[0].sent.at(-1)?.severity).toBe("critical");
    expect(verifyChain(s.db.rows).ok).toBe(true);
  });

  it("the monitor database adapter is read-only: only allow-listed RPCs and no table access", async () => {
    const seen: string[] = [];
    const client = { rpc: async (fn: string) => { seen.push(fn); return { data: {}, error: null }; } };
    const db = createPriceMonitorDb(client);
    await db.verify(null); await db.digest(); await db.events(0); await db.evidenceList(5);
    await db.evidenceAppend({ seq: 1, run_id: "r", kind: "run", recorded_at: "2026-11-01T00:00:00Z", payload: "{}", prev_hash: GENESIS_HASH, entry_hash: GENESIS_HASH });
    expect(seen).toEqual(["tw4_price_verify", "tw4_price_monitor_digest", "tw4_price_monitor_events", "tw4_price_monitor_evidence_list", "tw4_price_monitor_evidence_append"]);
    const failing = createPriceMonitorDb({ rpc: async () => ({ data: null, error: { message: "secret detail" } }) });
    await expect(failing.verify(null)).rejects.toThrow(/^rpc_failed:tw4_price_verify$/);
  });

  it("source scan: nothing under src/lib/sms/pricing or the routes touches a table or a price mutation function", () => {
    const dirs = [join(__dirname, ".."), join(__dirname, "../../../../app/api/cron/sms-price-monitor"), join(__dirname, "../../../../app/api/cron/sms-price-monitor-watchdog")];
    const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(d, f), "utf8")));
    expect(files.length).toBeGreaterThanOrEqual(8);
    const code = files.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.from\(\s*["'`]/); // a table access (Buffer.from / Array.from are fine)
    expect(code).not.toMatch(/tw4_price_(set|propose|approve|reject)/);
    expect(code).not.toMatch(/studio_sms_price_(list|change_requests|approvers|limits)/);
  });

  it("destination config comes from environment only, requires https, and failures never leak the URL or secrets", async () => {
    expect(loadMonitorConfig({}).transports).toEqual([]);
    expect(loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: "http://example.invalid/hook" }).transports).toEqual([]);
    expect(loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: "https://user:pw@example.invalid/hook" }).transports).toEqual([]);
    const cfg = loadMonitorConfig({
      PRICE_MONITOR_WEBHOOK_URL: "https://hooks.example.invalid/x", PRICE_MONITOR_WEBHOOK_HMAC_SECRET: "s3", PRICE_MONITOR_HEARTBEAT_URL: "https://hc.example.invalid/ping",
      PRICE_MONITOR_RESEND_API_KEY: "re_x", PRICE_MONITOR_EMAIL_FROM: "alerts@example.invalid", PRICE_MONITOR_EMAIL_TO: "owner@example.invalid", PRICE_MONITOR_EXPECT_HEAD: `7:${"a".repeat(64)}`,
    });
    expect(cfg.transports.map((t) => t.name)).toEqual(["webhook", "heartbeat_url", "resend_email"]);
    expect(cfg.expectHead).toEqual({ seq: 7, hash: "a".repeat(64) });
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const ok = async (url: string, init: { headers: Record<string, string>; body?: string }) => { calls.push({ url, ...init }); return { ok: true, status: 200 }; };
    const msg = { runId: "r", severity: "critical" as const, subject: "s", findings: [], chainHeadHash: "c".repeat(64), chainHeadSeq: 2, chainStatus: "ok" as const, generatedAt: "2026-11-01T00:00:00Z" };
    await webhookTransport("https://hooks.example.invalid/x", "s3", ok).send(msg);
    expect(calls[0].headers["x-df-signature"]).toBe(createHmac("sha256", "s3").update(calls[0].body!).digest("hex"));
    expect(JSON.parse(calls[0].body!).chainHeadHash).toBe("c".repeat(64));
    await resendTransport("re_x", "a@example.invalid", "o@example.invalid", ok).send(msg);
    expect(calls[1].url).toBe("https://api.resend.com/emails");
    const bad = async () => ({ ok: false, status: 503 });
    const err = await webhookTransport("https://secret-host.example.invalid/tok", "s3", bad).send(msg).catch((e: Error) => e);
    expect((err as Error).message).toBe("alert transport webhook: http_503");
    const boom = async () => { throw new Error("connect https://secret-host.example.invalid/tok failed"); };
    const err2 = await webhookTransport("https://secret-host.example.invalid/tok", null, boom).send(msg).catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain("secret-host");
  });

  it("evidence parsing refuses malformed lists", () => {
    expect(parseEvidenceList({ head_seq: 1, rows: [{ seq: 1 }] })).toBeNull();
    expect(parseEvidenceList(null)).toBeNull();
    expect(parseEvidenceList({ head_seq: 0, rows: [] })).toEqual({ headSeq: 0, rows: [] });
  });
});
