import { createHmac } from "node:crypto";
import type { AlertMessage, AlertTransport, HeartbeatMessage, TestMessage, TestResult } from "./types";

/**
 * Alert transports for the price monitor.
 *
 * INDEPENDENT DESTINATION. Where an alert goes is configured ONLY from environment values read here (`loadTransportsFromEnv`). Nothing is read from the database, from an
 * admin screen, from a studio / platform setting or from any table: neither a platform administrator nor service_role can change the destination, the recipient, the
 * webhook or the signing secret. The values live in a SEPARATE secret scope of the hosting project (owner-only; production scope only; never Preview / Development), and
 * should point at an account the platform administrators do not control: a mailbox / webhook / dead-man service owned by the business owner, not by an approver.
 *
 *   PRICE_MONITOR_WEBHOOK_URL            https POST, JSON body, signed with PRICE_MONITOR_WEBHOOK_HMAC_SECRET (hex HMAC-SHA256 in the x-df-signature header)
 *   PRICE_MONITOR_HEARTBEAT_URL          https GET/POST ping on every completed run (dead-man switch: the SERVICE alerts when the pings stop)
 *   PRICE_MONITOR_RESEND_API_KEY / PRICE_MONITOR_EMAIL_FROM / PRICE_MONITOR_EMAIL_TO    a dedicated Resend key (NOT the application's), a sender and the owner's own mailbox
 *   PRICE_MONITOR_CHAIN_KEY              optional HMAC key for the evidence chain (separate secret)
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

const TIMEOUT_MS = 8000;

export class TransportError extends Error {
  constructor(readonly transport: string, readonly code: string) {
    super(`alert transport ${transport}: ${code}`);
    this.name = "TransportError";
  }
}

async function call(name: string, fetchImpl: FetchLike, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new TransportError(name, `http_${res.status}`);
    return res.text ? (await res.text()).slice(0, 2000) : "";
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw new TransportError(name, "network"); // never carries the URL, a header or a secret
  } finally {
    clearTimeout(timer);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** https only. http is accepted solely for a loopback host AND only when PRICE_MONITOR_ALLOW_LOOPBACK_HTTP=1 (local end-to-end tests); a remote http URL is never accepted. */
const httpsUrl = (v: string | undefined, allowLoopback = false): string | null => {
  const s = (v ?? "").trim();
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return s;
    return allowLoopback && u.protocol === "http:" && LOOPBACK.has(u.hostname) ? s : null;
  } catch {
    return null;
  }
};

export function renderAlertText(m: AlertMessage): string {
  const lines = [
    m.subject,
    `run ${m.runId} at ${m.generatedAt}${m.redeliveryOfSeq ? ` (re-delivery of the alert from evidence #${m.redeliveryOfSeq})` : ""}`,
    `EVIDENCE CHAIN HEAD: seq ${m.chainHeadSeq} hash ${m.chainHeadHash} (chain ${m.chainStatus}). Compare with the database head: a different hash or a lower seq means history was altered.`,
    "",
    ...m.findings.flatMap((f) => [`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`, ...f.refs.map((r) => `    - ${r}`)]),
    "",
    "This monitor only detects and reports. It changed nothing. Follow docs/twilio/TW-4F_Price_Monitoring_Runbook.md.",
  ];
  return lines.join("\n");
}

export function webhookTransport(url: string, hmacSecret: string | null, fetchImpl: FetchLike = fetch as unknown as FetchLike): AlertTransport {
  const post = (kind: string, payload: unknown): Promise<string> => {
    const body = JSON.stringify({ kind, ...(payload as object) });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (hmacSecret) headers["x-df-signature"] = createHmac("sha256", hmacSecret).update(body).digest("hex");
    return call("webhook", fetchImpl, url, { method: "POST", headers, body });
  };
  return {
    name: "webhook", canAlert: true, canHeartbeat: true,
    send: async (m) => { await post("price_monitor_alert", { ...m, text: renderAlertText(m) }); },
    sendTest: async (m: TestMessage): Promise<TestResult> => {
      // the receiver proves it read the SIGNED request by answering {"ack": hmac(secret, "ack:" + nonce)}; the token is NOT sent
      const body = await post("price_monitor_test", { nonce: m.nonce, generatedAt: m.generatedAt, chainHeadHash: m.chainHeadHash, chainHeadSeq: m.chainHeadSeq });
      try { const j = JSON.parse(body) as { ack?: unknown }; return typeof j.ack === "string" ? { ack: j.ack } : {}; } catch { return {}; }
    },
    heartbeat: async (m) => { await post("price_monitor_heartbeat", m); },
  };
}

export function heartbeatUrlTransport(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): AlertTransport {
  return {
    name: "heartbeat_url", canAlert: false, canHeartbeat: true,
    send: async () => undefined, // pings only
    sendTest: async () => ({}),
    heartbeat: async (m) => { await call("heartbeat_url", fetchImpl, url, { method: "POST", headers: { "content-type": "text/plain" }, body: `seq=${m.chainHeadSeq} head=${m.chainHeadHash}` }); },
  };
}

export function resendTransport(apiKey: string, from: string, to: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): AlertTransport {
  return {
    name: "resend_email", canAlert: true, canHeartbeat: false,
    send: async (m) => { await call("resend_email", fetchImpl, "https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [to], subject: `[DanceFlow pricing ${m.severity.toUpperCase()}] ${m.subject}`.slice(0, 200), text: renderAlertText(m) }),
    }); },
    sendTest: async (m: TestMessage): Promise<TestResult> => {
      await call("resend_email", fetchImpl, "https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to: [to], subject: "[DanceFlow pricing TEST] delivery verification", text: `Delivery verification (not an alert).\nNonce: ${m.nonce}\nConfirmation token: ${m.token}\nChain head: seq ${m.chainHeadSeq} ${m.chainHeadHash}\nRun: npm run qa:price-monitor -- confirm --nonce <nonce> --token <token>` }),
      });
      return {};
    },
    heartbeat: async () => undefined, // email is not a dead-man channel
  };
}

/** Test double: records messages; can be told to fail. No network. */
export class FakeTransport implements AlertTransport {
  readonly sent: AlertMessage[] = [];
  readonly heartbeats: HeartbeatMessage[] = [];
  failSends = 0;
  failHeartbeats = false;
  readonly canAlert: boolean = true;
  readonly canHeartbeat: boolean = true;
  constructor(readonly name = "fake") {}
  async send(m: AlertMessage) {
    if (this.failSends > 0) { this.failSends -= 1; throw new TransportError(this.name, "network"); }
    this.sent.push(m);
  }
  testAck: ((m: TestMessage) => string | undefined) | null = null;
  readonly tests: TestMessage[] = [];
  async sendTest(m: TestMessage): Promise<TestResult> {
    if (this.failSends > 0) { this.failSends -= 1; throw new TransportError(this.name, "network"); }
    this.tests.push(m);
    const ack = this.testAck?.(m);
    return ack ? { ack } : {};
  }
  async heartbeat(m: HeartbeatMessage) {
    if (this.failHeartbeats) throw new TransportError(this.name, "network");
    this.heartbeats.push(m);
  }
}

export type MonitorConfig = { transports: AlertTransport[]; chainKey: string | null; since: string | null; repeatMs: number; maxAgeMs: number; trustedFromSeq: number; expectHead: { seq: number; hash: string } | null };

/** Environment only. Returns no transport when no destination is configured: the monitor then fails closed (it cannot report), see monitor.ts. */
export function loadMonitorConfig(env: Record<string, string | undefined>, fetchImpl?: FetchLike): MonitorConfig {
  const transports: AlertTransport[] = [];
  const loop = env.PRICE_MONITOR_ALLOW_LOOPBACK_HTTP === "1";
  const hook = httpsUrl(env.PRICE_MONITOR_WEBHOOK_URL, loop);
  if (hook) transports.push(webhookTransport(hook, env.PRICE_MONITOR_WEBHOOK_HMAC_SECRET?.trim() || null, fetchImpl));
  const hb = httpsUrl(env.PRICE_MONITOR_HEARTBEAT_URL, loop);
  if (hb) transports.push(heartbeatUrlTransport(hb, fetchImpl));
  const key = env.PRICE_MONITOR_RESEND_API_KEY?.trim(), from = env.PRICE_MONITOR_EMAIL_FROM?.trim(), to = env.PRICE_MONITOR_EMAIL_TO?.trim();
  if (key && from && to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) transports.push(resendTransport(key, from, to, fetchImpl));
  const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const head = (env.PRICE_MONITOR_EXPECT_HEAD ?? "").match(/^(\d+):([0-9a-f]{64})$/);
  return {
    transports,
    chainKey: env.PRICE_MONITOR_CHAIN_KEY?.trim() || null,
    since: env.PRICE_MONITOR_SINCE?.trim() || null,
    repeatMs: num(env.PRICE_MONITOR_REPEAT_MINUTES, 360) * 60_000,
    maxAgeMs: num(env.PRICE_MONITOR_MAX_AGE_MINUTES, 45) * 60_000,
    trustedFromSeq: Math.max(0, Math.trunc(Number(env.PRICE_MONITOR_TRUST_CHAIN_FROM_SEQ) || 0)),
    expectHead: head ? { seq: Number(head[1]), hash: head[2] } : null,
  };
}
