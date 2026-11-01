import { createHash, randomUUID } from "node:crypto";
import { classifyEvents, classifyVerify, parseDigest, parseEvents } from "./classify";
import { appendEvidence, GENESIS_HASH, parseEvidenceList, verifyChain, type ChainCheck } from "./evidence";
import type { AlertMessage, AlertTransport, EvidenceRow, Finding, PriceMonitorDb, Severity } from "./types";
import type { MonitorConfig } from "./transport";

/**
 * The price-integrity monitor (D4-2). DETECT AND ALERT ONLY.
 *
 *  - It never publishes, repairs, rolls back or overwrites a price; its database surface is db.ts (reads + the append-only evidence function).
 *  - FAIL CLOSED TO ALERTING: a verifier error, a bad result, unreadable events or digest, an unreadable or broken evidence chain, or no configured destination each
 *    become a critical finding; nothing is swallowed and a failing check never reads as "all clear".
 *  - Every run appends a hash-chained evidence row; every alert carries the chain head. Delivery attempts (success or failure) are recorded, failed alerts are re-sent on
 *    every later run until one destination accepts them, and the alert path never throws away a failure.
 *  - Heartbeat: each completed run pings the heartbeat channel (an external dead-man service alerts when pings stop). `runPriceWatchdog` is a second, separately scheduled
 *    check that alerts when no run has been recorded within the allowed age.
 */
const WINDOW = 200;
const SEND_ATTEMPTS = 3;
const MAX_REDELIVERY = 5;

export type MonitorDeps = {
  db: PriceMonitorDb;
  config: MonitorConfig;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
};

export type RunOutcome = {
  ok: boolean; // no finding at all, evidence recorded, and every required alert delivered
  runId: string;
  findings: Finding[];
  chain: { status: ChainCheck["status"] | "unavailable"; headSeq: number; headHash: string };
  alertRequired: boolean;
  alertDelivered: boolean | null;
  redelivered: number;
  evidenceRecorded: boolean;
  destinationConfigured: boolean;
  errors: string[];
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const worst = (f: Finding[]): Severity => (f.some((x) => x.severity === "critical") ? "critical" : f.some((x) => x.severity === "warning") ? "warning" : "info");
export const findingKeys = (f: Finding[]) => f.map((x) => `${x.code}:${[...x.refs].sort().join(",")}`).sort();
export const fingerprintOf = (f: Finding[]) => sha(findingKeys(f).join("|"));
const parse = (p: string): Record<string, unknown> => { try { const v = JSON.parse(p); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } };

type Delivery = { ok: boolean; results: { transport: string; ok: boolean; code?: string; attempts: number }[] };

async function deliver(transports: AlertTransport[], msg: AlertMessage, sleep: (ms: number) => Promise<void>): Promise<Delivery> {
  const results: Delivery["results"] = [];
  for (const t of transports.filter((x) => x.canAlert)) {
    let code = "unknown", attempts = 0, ok = false;
    for (let i = 0; i < SEND_ATTEMPTS && !ok; i++) {
      attempts += 1;
      try { await t.send(msg); ok = true; } catch (e) {
        code = e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "error";
        if (i < SEND_ATTEMPTS - 1) await sleep(250 * 2 ** i);
      }
    }
    results.push({ transport: t.name, ok, ...(ok ? {} : { code }), attempts });
  }
  return { ok: results.some((r) => r.ok), results };
}

async function pingHeartbeat(transports: AlertTransport[], m: { runId: string; chainHeadHash: string; chainHeadSeq: number; generatedAt: string }): Promise<{ transport: string; ok: boolean }[]> {
  const out: { transport: string; ok: boolean }[] = [];
  for (const t of transports.filter((x) => x.canHeartbeat)) {
    try { await t.heartbeat(m); out.push({ transport: t.name, ok: true }); } catch { out.push({ transport: t.name, ok: false }); }
  }
  return out;
}

type Head = { seq: number; hash: string };

/** Loads the evidence window and verifies it. Never throws. */
async function loadChain(db: PriceMonitorDb, cfg: MonitorConfig): Promise<{ rows: EvidenceRow[]; check: ChainCheck | null; head: Head | null; finding: Finding | null }> {
  try {
    const parsed = parseEvidenceList(await db.evidenceList(WINDOW));
    if (!parsed) return { rows: [], check: null, head: null, finding: { code: "evidence_unavailable", severity: "critical", message: "the evidence list is unintelligible", refs: [] } };
    const check = verifyChain(parsed.rows, { chainKey: cfg.chainKey, trustedFromSeq: cfg.trustedFromSeq, expectHead: cfg.expectHead ?? undefined });
    const dbHeadMismatch = parsed.rows.length > 0 && parsed.rows[parsed.rows.length - 1].seq !== parsed.headSeq;
    const head = parsed.rows.length ? { seq: parsed.rows[parsed.rows.length - 1].seq, hash: parsed.rows[parsed.rows.length - 1].entry_hash } : { seq: 0, hash: GENESIS_HASH };
    const finding: Finding | null = !check.ok || dbHeadMismatch
      ? { code: "evidence_chain_broken", severity: "critical", message: `the evidence chain failed verification (${check.reason ?? "head"})${cfg.trustedFromSeq ? `; rows up to #${cfg.trustedFromSeq} were acknowledged by the owner` : ""}`, refs: [`seq:${check.brokenAtSeq ?? parsed.headSeq}`] }
      : null;
    return { rows: parsed.rows, check, head, finding };
  } catch {
    return { rows: [], check: null, head: null, finding: { code: "evidence_unavailable", severity: "critical", message: "the evidence store could not be read", refs: [] } };
  }
}

/** Appends with one re-link when another writer moved the head. */
async function append(db: PriceMonitorDb, head: Head, entry: { runId: string; kind: "run" | "delivery" | "watchdog"; payload: unknown; now: Date }, cfg: MonitorConfig): Promise<{ ok: boolean; head: Head }> {
  let r = await appendEvidence(db, head, entry, cfg.chainKey);
  if (!r.appended && r.reason === "chain_mismatch") {
    try {
      const parsed = parseEvidenceList(await db.evidenceList(1));
      const last = parsed?.rows[parsed.rows.length - 1];
      if (last) r = await appendEvidence(db, { seq: last.seq, hash: last.entry_hash }, entry, cfg.chainKey);
    } catch { /* recorded as a failed append below */ }
  }
  return r.appended ? { ok: true, head: { seq: r.seq, hash: r.hash } } : { ok: false, head };
}

type AlertState = { lastKeys: Set<string>; lastAt: number | null; pending: EvidenceRow[] };

function alertState(rows: EvidenceRow[], source: "run" | "watchdog"): AlertState {
  const okRuns = new Set<number>();
  let lastKeys = new Set<string>(), lastAt: number | null = null;
  for (const r of rows) {
    if (r.kind !== "delivery") continue;
    const p = parse(r.payload);
    if (p.alert_ok === true && typeof p.run_seq === "number") okRuns.add(p.run_seq);
    if (p.alert_ok === true && p.source === source && Array.isArray(p.keys)) { lastKeys = new Set(p.keys.filter((k): k is string => typeof k === "string")); lastAt = Date.parse(r.recorded_at); }
  }
  const pending = rows.filter((r) => (r.kind === "run" || r.kind === "watchdog") && parse(r.payload).alert_required === true && !okRuns.has(r.seq)).slice(-MAX_REDELIVERY);
  return { lastKeys, lastAt, pending };
}

function noDestinationFinding(): Finding {
  return { code: "alert_delivery_failed", severity: "critical", message: "no alert destination is configured: this monitor cannot report (set the PRICE_MONITOR_* environment values)", refs: ["no_destination"] };
}

async function reportFlow(args: {
  deps: MonitorDeps; source: "run" | "watchdog"; runId: string; now: Date; findings: Finding[]; chain: Awaited<ReturnType<typeof loadChain>>; extraPayload: Record<string, unknown>; errors: string[];
}): Promise<RunOutcome> {
  const { deps, source, runId, now, chain } = args;
  const { db, config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const findings = [...args.findings];
  const errors = [...args.errors];
  const hasDestination = config.transports.some((t) => t.canAlert);
  const state = alertState(chain.rows, source);

  if (chain.finding) findings.push(chain.finding);
  if (!hasDestination) findings.push(noDestinationFinding());
  if (state.pending.length) findings.push({ code: "alert_delivery_failed", severity: "warning", message: `${state.pending.length} earlier alert(s) were not delivered and are being re-sent`, refs: state.pending.map((p) => `evidence:${p.seq}`) });

  const fingerprint = fingerprintOf(findings);
  const stale = state.lastAt === null || now.getTime() - state.lastAt >= config.repeatMs;
  // alert on any finding not covered by the last delivered alert (a shrinking set is quiet), and again on the repeat interval while findings persist
  const alertRequired = findings.length > 0 && (findingKeys(findings).some((k) => !state.lastKeys.has(k)) || stale);

  // 1. record the run (when the chain head is known)
  let head: Head | null = chain.head;
  let evidenceRecorded = false;
  let runSeq = 0;
  if (head) {
    const res = await append(db, head, { runId, kind: source, now, payload: { v: 1, ...args.extraPayload, findings, fingerprint, alert_required: alertRequired } }, config);
    evidenceRecorded = res.ok; head = res.head; runSeq = res.ok ? res.head.seq : 0;
    if (!res.ok) { errors.push("evidence_append_failed"); findings.push({ code: "evidence_unavailable", severity: "critical", message: "the run could not be recorded in the evidence chain", refs: ["append_failed"] }); }
  } else errors.push("evidence_unreadable");

  const headSeq = head?.seq ?? 0, headHash = head?.hash ?? GENESIS_HASH;
  const chainStatus: AlertMessage["chainStatus"] = !chain.check ? "unavailable" : chain.check.ok ? "ok" : "broken";
  const finalFindings = findings;
  // recording failure is itself a reason to alert (fail closed), even when the earlier fingerprint check said no
  const mustAlert = alertRequired || (!evidenceRecorded && finalFindings.length > 0);
  const mk = (f: Finding[], redeliveryOfSeq?: number): AlertMessage => ({
    runId, severity: worst(f), generatedAt: now.toISOString(), findings: f, chainHeadHash: headHash, chainHeadSeq: headSeq, chainStatus,
    subject: `${f.filter((x) => x.severity === "critical").length ? "CRITICAL" : "Notice"}: ${[...new Set(f.map((x) => x.code))].join(", ")}`.slice(0, 180),
    ...(redeliveryOfSeq ? { redeliveryOfSeq } : {}),
  });

  // 2. re-send earlier alerts that no destination accepted
  let redelivered = 0;
  if (hasDestination) {
    for (const p of state.pending) {
      const old = parse(p.payload);
      const oldFindings = Array.isArray(old.findings) ? (old.findings as Finding[]) : [];
      const d = await deliver(config.transports, mk(oldFindings, p.seq), sleep);
      if (head) {
        const a = await append(db, head, { runId, kind: "delivery", now, payload: { v: 1, source, run_seq: p.seq, alert_ok: d.ok, results: d.results, redelivery: true } }, config);
        head = a.head; if (!a.ok) errors.push("delivery_record_failed");
      }
      if (d.ok) redelivered += 1; else errors.push("redelivery_failed");
    }
  }

  // 3. this run's alert
  let alertDelivered: boolean | null = null;
  if (mustAlert) {
    const d: Delivery = hasDestination ? await deliver(config.transports, mk(finalFindings), sleep) : { ok: false, results: [] };
    alertDelivered = d.ok;
    if (head) {
      const a = await append(db, head, { runId, kind: "delivery", now, payload: { v: 1, source, run_seq: runSeq, alert_ok: d.ok, fingerprint, keys: findingKeys(finalFindings), results: d.results } }, config);
      head = a.head; if (!a.ok) errors.push("delivery_record_failed");
    }
    if (!d.ok) errors.push("alert_delivery_failed");
  }

  // 4. heartbeat (dead-man): a completed run proves the monitor is alive
  const hb = await pingHeartbeat(config.transports, { runId, chainHeadHash: head?.hash ?? headHash, chainHeadSeq: head?.seq ?? headSeq, generatedAt: now.toISOString() });
  if (hb.some((h) => !h.ok)) errors.push("heartbeat_failed");

  return {
    ok: finalFindings.length === 0 && errors.length === 0 && (alertDelivered === null || alertDelivered),
    runId, findings: finalFindings,
    chain: { status: chain.check ? chain.check.status : "unavailable", headSeq: head?.seq ?? headSeq, headHash: head?.hash ?? headHash },
    alertRequired: mustAlert, alertDelivered, redelivered, evidenceRecorded, destinationConfigured: hasDestination, errors,
  };
}

export async function runPriceMonitor(deps: MonitorDeps): Promise<RunOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const runId = (deps.newRunId ?? randomUUID)();
  const { db, config } = deps;
  const findings: Finding[] = [];
  const errors: string[] = [];

  const chain = await loadChain(db, config);
  const lastRun = [...chain.rows].reverse().find((r) => r.kind === "run");
  const prev = lastRun ? parse(lastRun.payload) : {};
  const prevCursor = typeof prev.events_cursor === "number" ? prev.events_cursor : 0;
  const prevDigest = typeof prev.digest === "string" ? prev.digest : null;

  // verifier (fail closed)
  try { findings.push(...classifyVerify(await db.verify(config.since), now)); } catch {
    findings.push({ code: "verification_failure", severity: "critical", message: "the price verifier could not be run", refs: [] });
  }

  // price list digest (independent of the verifier: a neutered verifier cannot hide a change)
  let digest: string | null = null;
  try {
    const d = parseDigest(await db.digest());
    if (!d) findings.push({ code: "digest_unavailable", severity: "warning", message: "the price list digest was unintelligible", refs: [] });
    else {
      digest = d.digest;
      if (prevDigest && prevDigest !== d.digest) findings.push({ code: "price_changed", severity: "info", message: `the price list changed since the previous run (${d.rows} rows, ${d.activeRows} active); confirm it was an approved change`, refs: [`digest:${d.digest.slice(0, 12)}`] });
    }
  } catch { findings.push({ code: "digest_unavailable", severity: "warning", message: "the price list digest could not be read", refs: [] }); }

  // security events (generic)
  let cursor = prevCursor;
  try {
    const ev = parseEvents(await db.events(prevCursor));
    if (!ev) findings.push({ code: "verification_failure", severity: "critical", message: "the security event feed was unintelligible", refs: ["events"] });
    else {
      findings.push(...classifyEvents(ev.events, ev.suspended));
      cursor = ev.events.length ? ev.events[ev.events.length - 1].seq : prevCursor;
    }
  } catch { findings.push({ code: "verification_failure", severity: "critical", message: "the security event feed could not be read", refs: ["events"] }); }

  return reportFlow({ deps, source: "run", runId, now, findings, chain, errors, extraPayload: { events_cursor: cursor, digest } });
}

/**
 * Second, separately scheduled check: alerts when the monitor has not completed a run within `config.maxAgeMs`, when the chain is broken, or when alerts stay undelivered.
 * It reads only evidence (no verifier). Like every check it is itself recorded and its alerts are retried.
 */
export async function runPriceWatchdog(deps: MonitorDeps): Promise<RunOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const runId = (deps.newRunId ?? randomUUID)();
  const chain = await loadChain(deps.db, deps.config);
  const findings: Finding[] = [];
  if (chain.head) {
    const lastRun = [...chain.rows].reverse().find((r) => r.kind === "run");
    const age = lastRun ? now.getTime() - Date.parse(lastRun.recorded_at) : null;
    if (!lastRun) findings.push({ code: "monitor_stale", severity: "critical", message: "no monitor run has ever been recorded", refs: ["never_ran"] });
    else if (age !== null && age > deps.config.maxAgeMs) findings.push({ code: "monitor_stale", severity: "critical", message: `the last monitor run was ${Math.round(age / 60000)} minutes ago (allowed ${Math.round(deps.config.maxAgeMs / 60000)})`, refs: [`last_run:${lastRun.seq}`] });
  }
  return reportFlow({ deps, source: "watchdog", runId, now, findings, chain, errors: [], extraPayload: {} });
}
