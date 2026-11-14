import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { append, loadChain, parse, type MonitorDeps } from "./monitor";
import type { AlertTransport } from "./types";

/**
 * ALERT DELIVERY VERIFICATION (run before activation, and after any destination change). It sends a SIGNED TEST message (never a real alert) to every configured
 * destination and requires a CONFIRMED RECEIPT, recorded in the evidence chain:
 *
 *   - webhook: the receiver must answer {"ack": hmac_sha256(secret, "ack:" + nonce)} (hex, first 32 chars). Only a receiver holding the shared secret that actually read the signed
 *     request can compute it, so a 200 from a catch-all proxy is not a receipt. Verified synchronously.
 *   - email (out of band): the message carries the confirmation token; the owner reads it in the mailbox and runs `confirm --nonce <n> --token <t>`.
 *   - heartbeat URL: pinged; its receipt is the dead-man service showing the ping (confirm by looking, then `confirm`).
 *
 * The verification secret is PRICE_MONITOR_WEBHOOK_HMAC_SECRET, else PRICE_MONITOR_CHAIN_KEY. Without one, verification is refused (an unsigned receipt proves nothing).
 * Evidence rows are `delivery` rows with source "verification" and never set alert_ok, so they cannot mark a real pending alert as delivered.
 */
export const ackToken = (secret: string, nonce: string): string => createHmac("sha256", secret).update(`ack:${nonce}`).digest("hex").slice(0, 32);
const nonceHash = (nonce: string) => createHash("sha256").update(nonce).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MAX_AGE_MS = 24 * 3600_000;

export type VerifyDeps = MonitorDeps & { secret: string | null; newNonce?: () => string };
export type TransportVerdict = { transport: string; sent: boolean; receipt: "verified" | "pending_out_of_band" | "missing" | "mismatch" | "send_failed"; code?: string };
export type VerifyOutcome = { status: "confirmed" | "pending" | "failed"; nonce: string | null; verdicts: TransportVerdict[]; recorded: boolean; reason?: string };

export async function startDeliveryVerification(deps: VerifyDeps): Promise<VerifyOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.secret) return { status: "failed", nonce: null, verdicts: [], recorded: false, reason: "no_verification_secret" };
  const alertTransports = deps.config.transports.filter((t) => t.canAlert);
  if (!alertTransports.length) return { status: "failed", nonce: null, verdicts: [], recorded: false, reason: "no_destination" };
  const nonce = (deps.newNonce ?? (() => randomBytes(12).toString("hex")))();
  const token = ackToken(deps.secret, nonce);
  const chain = await loadChain(deps.db, deps.config);
  const head = chain.head ?? { seq: 0, hash: "0".repeat(64) };
  const msg = { nonce, token, generatedAt: now.toISOString(), chainHeadHash: head.hash, chainHeadSeq: head.seq };
  const verdicts: TransportVerdict[] = [];
  for (const t of [...alertTransports, ...deps.config.transports.filter((x) => !x.canAlert && x.canHeartbeat)]) verdicts.push(await verifyOne(t, msg, deps.secret));
  const anyBad = verdicts.some((v) => v.receipt === "missing" || v.receipt === "mismatch" || v.receipt === "send_failed");
  const pending = verdicts.some((v) => v.receipt === "pending_out_of_band");
  const status: VerifyOutcome["status"] = anyBad ? "failed" : pending ? "pending" : "confirmed";
  let recorded = false;
  if (chain.head) {
    const a = await append(deps.db, chain.head, { runId: randomUUID(), kind: "delivery", now, payload: { v: 1, source: "verification", phase: "sent", nonce_hash: nonceHash(nonce), status, verdicts } }, deps.config);
    recorded = a.ok;
  }
  return { status, nonce, verdicts, recorded };
}

async function verifyOne(t: AlertTransport, msg: Parameters<NonNullable<AlertTransport["sendTest"]>>[0], secret: string): Promise<TransportVerdict> {
  try {
    if (!t.canAlert) { await t.heartbeat({ runId: "verification", chainHeadHash: msg.chainHeadHash, chainHeadSeq: msg.chainHeadSeq, generatedAt: msg.generatedAt }); return { transport: t.name, sent: true, receipt: "pending_out_of_band" }; }
    if (!t.sendTest) return { transport: t.name, sent: false, receipt: "missing", code: "no_test_support" };
    const res = await t.sendTest(msg);
    if (res.ack === undefined) return { transport: t.name, sent: true, receipt: t.name === "webhook" ? "missing" : "pending_out_of_band" };
    return { transport: t.name, sent: true, receipt: same(res.ack, ackToken(secret, msg.nonce)) ? "verified" : "mismatch" };
  } catch (e) {
    return { transport: t.name, sent: false, receipt: "send_failed", code: e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error" };
  }
}

/** Out-of-band confirmation (mailbox / dead-man page): the token must match the nonce and a `sent` verification row from the last 24 hours must exist and not be confirmed yet. */
export async function confirmDeliveryVerification(deps: VerifyDeps, input: { nonce: string; token: string }): Promise<{ confirmed: boolean; reason?: string; recorded: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.secret) return { confirmed: false, reason: "no_verification_secret", recorded: false };
  const chain = await loadChain(deps.db, deps.config);
  if (!chain.head) return { confirmed: false, reason: "evidence_unavailable", recorded: false };
  if (!same(input.token, ackToken(deps.secret, input.nonce))) return { confirmed: false, reason: "token_mismatch", recorded: false };
  const h = nonceHash(input.nonce);
  const sent = chain.rows.find((r) => { const p = parse(r.payload); return r.kind === "delivery" && p.source === "verification" && p.phase === "sent" && p.nonce_hash === h; });
  if (!sent) return { confirmed: false, reason: "no_matching_verification", recorded: false };
  if (now.getTime() - Date.parse(sent.inserted_at ?? sent.recorded_at) > MAX_AGE_MS) return { confirmed: false, reason: "expired", recorded: false };
  if (chain.rows.some((r) => { const p = parse(r.payload); return r.kind === "delivery" && p.source === "verification" && p.phase === "confirmed" && p.nonce_hash === h; })) return { confirmed: false, reason: "already_confirmed", recorded: false };
  const a = await append(deps.db, chain.head, { runId: randomUUID(), kind: "delivery", now, payload: { v: 1, source: "verification", phase: "confirmed", nonce_hash: h, sent_seq: sent.seq } }, deps.config);
  return { confirmed: a.ok, recorded: a.ok, ...(a.ok ? {} : { reason: "evidence_append_failed" }) };
}
