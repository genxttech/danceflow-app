/**
 * D4-2 alert path end to end against a REAL local HTTP receiver (127.0.0.1, ephemeral port): signature check, retries, outage and recovery, delivery verification with a
 * receipt ack, and the dead-man heartbeat. No Resend, no Twilio, no external network. The receiver stands in for the owner's webhook and dead-man service.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runPriceMonitor, runPriceWatchdog } from "../monitor";
import { loadMonitorConfig } from "../transport";
import { ackToken, startDeliveryVerification } from "../verifyDelivery";
import { FakeDb } from "./fakeDb";

const SECRET = "local-e2e-secret";
type Hit = { path: string; body: string; signatureOk: boolean; json: Record<string, unknown> };

class Receiver {
  hits: Hit[] = [];
  failNext = 0; // answer 503 this many times
  badAck = false;
  server!: Server;
  port = 0;
  pings: number[] = [];
  async start(port = 0) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/ping") { this.pings.push(Date.now()); res.writeHead(200).end("ok"); return; }
        const sig = String(req.headers["x-df-signature"] ?? "");
        const want = createHmac("sha256", SECRET).update(body).digest("hex");
        const signatureOk = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body); } catch { /* keep {} */ }
        this.hits.push({ path: req.url ?? "", body, signatureOk, json });
        if (!signatureOk) { res.writeHead(401).end(); return; }
        if (this.failNext > 0) { this.failNext -= 1; res.writeHead(503).end(); return; }
        if (json.kind === "price_monitor_test") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ack: this.badAck ? "f".repeat(32) : ackToken(SECRET, String(json.nonce)) })); return; }
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop() { return new Promise<void>((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); }); }
  get url() { return `http://127.0.0.1:${this.port}`; }
}

const rcv = new Receiver();
afterEach(async () => { await rcv.stop().catch(() => undefined); rcv.hits = []; rcv.pings = []; rcv.failNext = 0; rcv.badAck = false; });

function build() {
  let t = Date.parse("2026-11-01T12:00:00Z");
  const clock = () => new Date(t);
  const db = new FakeDb(clock);
  const config = loadMonitorConfig({
    PRICE_MONITOR_WEBHOOK_URL: `${rcv.url}/hook`, PRICE_MONITOR_WEBHOOK_HMAC_SECRET: SECRET, PRICE_MONITOR_HEARTBEAT_URL: `${rcv.url}/ping`, PRICE_MONITOR_ALLOW_LOOPBACK_HTTP: "1",
  });
  return { db, config, deps: { db, config, now: clock, sleep: async () => undefined }, advance: (ms: number) => { t += ms; }, clock };
}
const forged = [{ code: "price_unattested", price_id: "11111111-1111-4111-8111-111111111111", kind: "number", created_at: "2026-11-01T11:59:00Z" }];

describe("D4-2 local end-to-end alert path", () => {
  it("loopback http is accepted only with the explicit flag and only for loopback hosts", () => {
    expect(loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: "http://127.0.0.1:9/h" }).transports).toEqual([]);
    expect(loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: "http://example.com/h", PRICE_MONITOR_ALLOW_LOOPBACK_HTTP: "1" }).transports).toEqual([]);
    expect(loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: "http://127.0.0.1:9/h", PRICE_MONITOR_ALLOW_LOOPBACK_HTTP: "1" }).transports).toHaveLength(1);
  });

  it("a forged price raises a correctly signed alert carrying the chain head; the heartbeat arrives on every run", async () => {
    await rcv.start();
    const s = build();
    s.db.anomalies(forged);
    const out = await runPriceMonitor(s.deps);
    expect(out.alertDelivered).toBe(true);
    const alert = rcv.hits.find((h) => h.json.kind === "price_monitor_alert")!;
    expect(alert.signatureOk).toBe(true);
    expect(alert.json.chainHeadHash).toBe(s.db.rows[0].entry_hash);
    expect(String(alert.json.text)).toContain("unauthorized_price_change");
    expect(rcv.hits.filter((h) => h.json.kind === "price_monitor_heartbeat")).toHaveLength(1);
    expect(rcv.hits.every((h) => h.signatureOk)).toBe(true);
    expect(rcv.pings).toHaveLength(1); // the dead-man URL
  });

  it("a wrong secret is rejected by the receiver (401), recorded as a failed delivery and reported", async () => {
    await rcv.start();
    const s = build();
    const bad = loadMonitorConfig({ PRICE_MONITOR_WEBHOOK_URL: `${rcv.url}/hook`, PRICE_MONITOR_WEBHOOK_HMAC_SECRET: "other", PRICE_MONITOR_ALLOW_LOOPBACK_HTTP: "1" });
    s.db.anomalies(forged);
    const out = await runPriceMonitor({ ...s.deps, config: bad });
    expect(out.alertDelivered).toBe(false);
    expect(rcv.hits.every((h) => !h.signatureOk)).toBe(true);
    expect(JSON.parse(s.db.rows.find((r) => r.kind === "delivery")!.payload).results[0]).toMatchObject({ ok: false, code: "http_401" });
  });

  it("retries: two 503s then success is delivered on attempt 3 and recorded with the attempt count", async () => {
    await rcv.start();
    const s = build();
    rcv.failNext = 2;
    s.db.anomalies(forged);
    const out = await runPriceMonitor(s.deps);
    expect(out.alertDelivered).toBe(true);
    expect(JSON.parse(s.db.rows.find((r) => r.kind === "delivery")!.payload).results[0]).toMatchObject({ ok: true, attempts: 3 });
    expect(rcv.hits.filter((h) => h.json.kind === "price_monitor_alert")).toHaveLength(3);
  });

  it("outage: receiver down, the failure is recorded and reported; when it returns the alert is re-delivered with the original findings", async () => {
    await rcv.start();
    const s = build();
    const port = rcv.port;
    await rcv.stop();
    s.db.anomalies(forged);
    const down = await runPriceMonitor(s.deps);
    expect(down.alertDelivered).toBe(false);
    expect(down.ok).toBe(false);
    expect(down.errors).toEqual(expect.arrayContaining(["alert_delivery_failed", "heartbeat_failed"]));
    await rcv.start(port);
    s.advance(60_000); s.db.anomalies(forged);
    const up = await runPriceMonitor(s.deps);
    expect(up.redelivered).toBe(1);
    const re = rcv.hits.find((h) => h.json.redeliveryOfSeq === 1)!;
    expect(re.signatureOk).toBe(true);
    expect(JSON.stringify(re.json.findings)).toContain("unauthorized_price_change");
  });

  it("dead-man: when the monitor stops, the pings stop (the receiver's own timer would fire) and the watchdog alerts on a separate schedule", async () => {
    await rcv.start();
    const s = build();
    await runPriceMonitor(s.deps);
    s.advance(15 * 60_000); s.db.verifyResult = { ok: true, anomalies: [], checked_at: s.clock().toISOString() };
    await runPriceMonitor(s.deps);
    expect(rcv.pings).toHaveLength(2);
    // the monitor stops here: no more pings. A dead-man service alerts when now - lastPing exceeds its window; modelled with the receiver's own record.
    const lastPing = rcv.pings.at(-1)!;
    await new Promise((r) => setTimeout(r, 25));
    expect(Date.now() - lastPing > 20).toBe(true);
    expect(rcv.pings).toHaveLength(2);
    s.advance(2 * 3600_000);
    const w = await runPriceWatchdog(s.deps);
    expect(w.findings.map((f) => f.code)).toContain("monitor_stale");
    expect(rcv.hits.some((h) => h.json.kind === "price_monitor_alert" && String(h.json.text).includes("monitor_stale") && h.signatureOk)).toBe(true);
  });

  it("delivery verification against the real receiver: ack verified; a receiver that answers a wrong ack fails; an outage fails", async () => {
    await rcv.start();
    const s = build();
    const dep = { ...s.deps, secret: SECRET };
    const ok = await startDeliveryVerification(dep);
    expect(ok.verdicts.map((v) => `${v.transport}:${v.receipt}`)).toEqual(["webhook:verified", "heartbeat_url:pending_out_of_band"]);
    expect(rcv.hits.find((h) => h.json.kind === "price_monitor_test")!.signatureOk).toBe(true);
    rcv.badAck = true;
    expect((await startDeliveryVerification(dep)).verdicts[0].receipt).toBe("mismatch");
    await rcv.stop();
    expect((await startDeliveryVerification(dep)).status).toBe("failed");
  });
});
