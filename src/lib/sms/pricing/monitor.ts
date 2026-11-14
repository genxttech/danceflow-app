import { createHash, randomUUID } from "node:crypto";
import { classifyEvents, classifyVerify, parseDigest, parseEvents } from "./classify";
import { CLASS_RANK, COALESCE_WINDOW_MS, attemptsLastHour, availableAttempts, classOfMessage, decide, deriveState, rateNoticeSentLastHour, usageLastHour, type AlertClass, type CoalesceState, type Usage } from "./coalesce";
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
const WINDOW = 500;
const SEND_ATTEMPTS = 3;
const MAX_REDELIVERY = 20;

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
export const parse = (p: string): Record<string, unknown> => { try { const v = JSON.parse(p); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } };

export type Head = { seq: number; hash: string };
export type Delivery = { ok: boolean; results: { transport: string; ok: boolean; code?: string; attempts: number }[] };

/** `budget`: remaining attempts per transport name this hour (mutated). A transport without budget is skipped with code rate_limited (recorded, alert stays pending). */
export async function deliver(transports: AlertTransport[], msg: AlertMessage, sleep: (ms: number) => Promise<void>, budget?: Map<string, number>): Promise<Delivery> {
  const results: Delivery["results"] = [];
  for (const t of transports.filter((x) => x.canAlert)) {
    let code = "unknown", attempts = 0, ok = false;
    const allowed = budget ? Math.min(SEND_ATTEMPTS, budget.get(t.name) ?? 0) : SEND_ATTEMPTS;
    if (allowed <= 0) { results.push({ transport: t.name, ok: false, code: "rate_limited", attempts: 0 }); continue; }
    for (let i = 0; i < allowed && !ok; i++) {
      attempts += 1;
      try { await t.send(msg); ok = true; } catch (e) {
        code = e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "error";
        if (i < allowed - 1) await sleep(250 * 2 ** i);
      }
    }
    if (budget) budget.set(t.name, Math.max(0, (budget.get(t.name) ?? 0) - attempts));
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

/** Loads the evidence window and verifies it. Never throws. */
export async function loadChain(db: PriceMonitorDb, cfg: MonitorConfig): Promise<{ rows: EvidenceRow[]; check: ChainCheck | null; head: Head | null; finding: Finding | null }> {
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
export async function append(db: PriceMonitorDb, head: Head, entry: { runId: string; kind: "run" | "delivery" | "watchdog"; payload: unknown; now: Date }, cfg: MonitorConfig): Promise<{ ok: boolean; head: Head }> {
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

/** One alert MESSAGE of an earlier run that no destination accepted. A run sends one message per distinct security-event identity plus one batch for everything else. */
export type HeldMessage = { runSeq: number; kind: string; msg: number; findings: Finding[] };

/** Groups of indices into `send` that travel together: every event identity of warning or critical severity is its OWN message (own immediate alert); the rest is one batch. */
export function messageGroups(send: Finding[]): number[][] {
  const own = (f: Finding) => !!f.identity && f.severity !== "info";
  const events = send.map((f, i) => ({ f, i })).filter((x) => own(x.f)).sort((a, b) => CLASS_RANK[classOfMessage([a.f])] - CLASS_RANK[classOfMessage([b.f])] || a.i - b.i);
  const rest = send.map((_, i) => i).filter((i) => !own(send[i]));
  const groups = [...events.map((x) => [x.i]), ...(rest.length ? [rest] : [])];
  return groups.sort((a, b) => CLASS_RANK[classOfMessage(a.map((i) => send[i]))] - CLASS_RANK[classOfMessage(b.map((i) => send[i]))]); // stable: priority class first, original order inside a class
}

/** The evidence copy of the findings: events collapsed per identity with a count (the events table itself keeps every row), so a flood cannot overflow the evidence payload. */
export function compactFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    if (!f.identity) { if (out.length < 80) out.push(f); continue; }
    const g = byId.get(f.identity);
    if (g) { g.count = (g.count ?? 1) + 1; if (g.refs.length < 8) g.refs = [...g.refs, ...f.refs.slice(0, 1)]; } else { const c = { ...f, count: 1, refs: f.refs.slice(0, 4) }; byId.set(f.identity, c); out.push(c); }
  }
  return out;
}

/** Messages of earlier runs without an accepted delivery row, oldest first. Legacy delivery rows without `msg` cover their whole run. */
export function heldMessages(rows: EvidenceRow[]): HeldMessage[] {
  const ok = new Map<number, Set<number>>();
  const allOk = new Set<number>();
  for (const r of rows) {
    if (r.kind !== "delivery") continue;
    const p = parse(r.payload);
    if (p.alert_ok !== true || typeof p.run_seq !== "number") continue;
    if (typeof p.msg === "number") { const s = ok.get(p.run_seq) ?? new Set<number>(); s.add(p.msg); ok.set(p.run_seq, s); } else allOk.add(p.run_seq);
  }
  const out: HeldMessage[] = [];
  for (const r of rows) {
    if (r.kind !== "run" && r.kind !== "watchdog") continue;
    const pl = parse(r.payload);
    if (pl.alert_required !== true || allOk.has(r.seq)) continue;
    const send = Array.isArray(pl.send_findings) ? (pl.send_findings as Finding[]) : Array.isArray(pl.findings) ? (pl.findings as Finding[]) : [];
    const groups = Array.isArray(pl.groups) ? (pl.groups as number[][]) : [send.map((_, i) => i)];
    groups.forEach((g, msg) => { if (!ok.get(r.seq)?.has(msg)) out.push({ runSeq: r.seq, kind: r.kind, msg, findings: g.map((i) => send[i]).filter(Boolean) }); });
  }
  return out;
}

export type AlertState = { lastKeys: Set<string>; lastAt: number | null; pending: HeldMessage[] };

export function alertState(rows: EvidenceRow[], source: "run" | "watchdog"): AlertState {
  const byRun = new Map<number, Set<string>>();
  let lastAt: number | null = null, lastRun = -1;
  for (const r of rows) {
    if (r.kind !== "delivery") continue;
    const p = parse(r.payload);
    if (p.alert_ok === true && p.source === source && Array.isArray(p.keys) && typeof p.run_seq === "number") {
      const s = byRun.get(p.run_seq) ?? new Set<string>();
      for (const k of p.keys) if (typeof k === "string") s.add(k);
      byRun.set(p.run_seq, s);
      lastAt = Date.parse(r.recorded_at); lastRun = Math.max(lastRun, p.run_seq);
    }
  }
  return { lastKeys: byRun.get(lastRun) ?? new Set<string>(), lastAt, pending: heldMessages(rows) };
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
  if (state.pending.length) findings.push({ code: "alert_delivery_failed", severity: "warning", message: `${state.pending.length} earlier alert message(s) were not delivered and are being re-sent`, refs: ["pending"] }); // stable ref: a changing count must not look like a new finding (it would spend the send cap every run)

  // ALERT POLICY: persistent findings keep the repeat-interval rule; security events are coalesced per identity (coalesce.ts) and fail OPEN when the state is not trusted
  const persistent = findings.filter((f) => !f.identity);
  const events = findings.filter((f) => f.identity);
  const trusted = !chain.finding && (chain.check ? chain.check.ok : false);
  const emptyState: CoalesceState = { sentAt: new Map(), pending: new Map() };
  let cstate = emptyState;
  if (trusted) { try { cstate = deriveState(chain.rows); } catch { cstate = emptyState; } }
  const heldSummaries = new Set<string>(state.pending.flatMap((h) => h.findings.flatMap((f) => f.refs.filter((r) => r.startsWith("identity:")).map((r) => r.slice(9)))));
  const dec = decide(events, cstate, now, config.coalesceMs ?? COALESCE_WINDOW_MS, heldSummaries);
  const fingerprint = fingerprintOf(findings);
  const stale = state.lastAt === null || now.getTime() - state.lastAt >= config.repeatMs;
  // persistent: alert on any finding not covered by the last delivered alert (a shrinking set is quiet), and again on the repeat interval while findings persist
  // keys already waiting in a HELD (undelivered) message are not queued again every run: that would spiral while sends are rate limited
  const heldKeys = new Set(findingKeys(state.pending.flatMap((h) => h.findings)));
  const pKeys = findingKeys(persistent);
  const persistentRequired = persistent.length > 0 && (pKeys.some((k) => !state.lastKeys.has(k) && !heldKeys.has(k)) || (stale && pKeys.some((k) => !heldKeys.has(k))));
  let toSend: Finding[] = [...(persistentRequired ? persistent : []), ...dec.send];
  let groups = messageGroups(toSend);
  const alertRequired = toSend.length > 0;

  // 1. record the run (when the chain head is known): all findings (events collapsed per identity with a count), the subset to send and its message groups, and what was coalesced
  let head: Head | null = chain.head;
  let evidenceRecorded = false;
  let runSeq = 0;
  if (head) {
    const res = await append(db, head, { runId, kind: source, now, payload: { v: 1, ...args.extraPayload, findings: compactFindings(findings), send_findings: compactFindings(toSend), groups: messageGroups(compactFindings(toSend)), coalesced: dec.coalesced, fingerprint, alert_required: alertRequired } }, config);
    evidenceRecorded = res.ok; head = res.head; runSeq = res.ok ? res.head.seq : 0;
    if (!res.ok) { errors.push("evidence_append_failed"); findings.push({ code: "evidence_unavailable", severity: "critical", message: "the run could not be recorded in the evidence chain", refs: ["append_failed"] }); }
  } else errors.push("evidence_unreadable");

  const headSeq = head?.seq ?? 0, headHash = head?.hash ?? GENESIS_HASH;
  const chainStatus: AlertMessage["chainStatus"] = !chain.check ? "unavailable" : chain.check.ok ? "ok" : "broken";
  const finalFindings = findings;
  // recording failure is itself a reason to alert (fail open toward sending): every finding is sent, one message per event identity, nothing is coalesced
  if (!evidenceRecorded && finalFindings.length > 0) {
    toSend = [...persistent, ...compactFindings(events), ...(finalFindings.filter((f) => !persistent.includes(f) && !f.identity))];
    groups = messageGroups(toSend);
    dec.ids.length = 0; dec.summarized.length = 0;
  }
  const mustAlert = toSend.length > 0;
  const MAX_IN_MESSAGE = 50;
  const mk = (f: Finding[], redeliveryOfSeq?: number): AlertMessage => {
    const shown = f.length > MAX_IN_MESSAGE ? [...f.slice(0, MAX_IN_MESSAGE), { code: "alert_coalesced" as const, severity: "info" as const, message: `+${f.length - MAX_IN_MESSAGE} more finding(s): see the evidence chain`, refs: [] }] : f;
    return {
      runId, severity: worst(f), generatedAt: now.toISOString(), findings: shown, chainHeadHash: headHash, chainHeadSeq: headSeq, chainStatus,
      subject: `${f.filter((x) => x.severity === "critical").length ? "CRITICAL" : "Notice"}: ${[...new Set(f.map((x) => x.code))].join(", ")}`.slice(0, 180),
      ...(redeliveryOfSeq ? { redeliveryOfSeq } : {}),
    };
  };

  // per-transport hourly attempt budget (cost bound); the last slot of each hour is reserved for the rate-limit notice
  const used = attemptsLastHour(chain.rows, now);
  const capOf = (name: string) => config.sendCaps?.[name] ?? config.defaultSendCap ?? 12;
  // class-aware capacity: warn/info messages can use at most half of the hourly slots, crit+warn+info leave a reserve that only top-priority messages (recovery used, integrity failure, unknown kind, standing critical conditions) can spend
  const usage = usageLastHour(chain.rows, now);
  const alertTransports = config.transports.filter((x) => x.canAlert);
  const budgetFor = (cls: AlertClass) => new Map<string, number>(alertTransports.map((x) => [x.name, availableAttempts(capOf(x.name), usage.get(x.name), cls)]));
  const account = (cls: AlertClass, results: Delivery["results"]) => {
    for (const r of results) {
      const u: Usage = usage.get(r.transport) ?? { all: 0, nonTop: 0, warnInfo: 0 };
      u.all += r.attempts; if (cls !== "top") u.nonTop += r.attempts; if (cls === "warn" || cls === "info") u.warnInfo += r.attempts;
      usage.set(r.transport, u);
    }
  };
  let limited = false;

  // 2. this run's alerts FIRST (a new incident is never starved by held ones): one message per event identity (critical first), then one batch for the rest
  let alertDelivered: boolean | null = null;
  if (mustAlert) {
    let allOk = true;
    for (let i = 0; i < groups.length; i++) {
      const msgFindings = groups[i].map((k) => toSend[k]);
      const cls = classOfMessage(msgFindings);
      const d: Delivery = hasDestination ? await deliver(config.transports, mk(msgFindings), sleep, budgetFor(cls)) : { ok: false, results: [] };
      account(cls, d.results);
      const rateLimited = d.results.length > 0 && d.results.every((r) => r.code === "rate_limited");
      if (d.results.some((r) => r.code === "rate_limited")) limited = true;
      if (!d.ok) allOk = false;
      if (head && !rateLimited) {
        const ids = msgFindings.filter((f) => f.identity).map((f) => f.identity!);
        const summ = dec.summarized.filter((id) => ids.includes(id) || msgFindings.some((f) => f.refs.includes(`identity:${id}`)));
        const a = await append(db, head, { runId, kind: "delivery", now, payload: { v: 1, source, run_seq: runSeq, msg: i, cls, alert_ok: d.ok, fingerprint, keys: findingKeys(msgFindings), ids: d.ok ? ids : [], summarized: d.ok ? summ : [], results: d.results } }, config);
        head = a.head; if (!a.ok) errors.push("delivery_record_failed");
      }
    }
    alertDelivered = allOk;
    if (!allOk) errors.push("alert_delivery_failed");
  }

  // 3. re-send earlier messages that no destination accepted, oldest first, with whatever budget is left
  let redelivered = 0;
  if (hasDestination) {
    // oldest first WITHIN each priority class; classes in priority order
    const held = [...state.pending].map((h) => ({ h, cls: classOfMessage(h.findings) })).sort((a, b) => CLASS_RANK[a.cls] - CLASS_RANK[b.cls] || a.h.runSeq - b.h.runSeq || a.h.msg - b.h.msg).slice(0, MAX_REDELIVERY);
    for (const { h, cls } of held) {
      const b = budgetFor(cls);
      if ([...b.values()].every((v) => v <= 0)) { limited = true; continue; }
      const d = await deliver(config.transports, mk(h.findings, h.runSeq), sleep, b);
      account(cls, d.results);
      if (d.results.some((r) => r.code === "rate_limited")) limited = true;
      if (head && !d.results.every((r) => r.code === "rate_limited")) {
        const a = await append(db, head, { runId, kind: "delivery", now, payload: { v: 1, source, run_seq: h.runSeq, msg: h.msg, cls, alert_ok: d.ok, results: d.results, redelivery: true } }, config);
        head = a.head; if (!a.ok) errors.push("delivery_record_failed");
      }
      if (d.ok) redelivered += 1; else errors.push("redelivery_failed");
    }
  }

  // 3b. the cap was hit: ONE notice per hour from the reserved slot; the alerts themselves stay held in the evidence chain
  if (limited) {
    errors.push("alert_rate_limited");
    if (!rateNoticeSentLastHour(chain.rows, now)) {
      const results: Delivery["results"] = [];
      const notice: Finding = { code: "alert_rate_limited", severity: "warning", message: "the hourly alert send cap was reached: further alerts are held (not lost) and delivered as capacity returns; run 'npm run qa:price-monitor -- list-undelivered'", refs: [] };
      for (const t of config.transports.filter((x) => x.canAlert)) {
        if (capOf(t.name) - (used.get(t.name) ?? 0) <= 0) { results.push({ transport: t.name, ok: false, code: "rate_limited", attempts: 0 }); continue; }
        try { await t.send(mk([notice])); results.push({ transport: t.name, ok: true, attempts: 1 }); } catch { results.push({ transport: t.name, ok: false, code: "error", attempts: 1 }); }
      }
      if (head) {
        const a = await append(db, head, { runId, kind: "delivery", now, payload: { v: 1, source, rate_notice: true, results } }, config);
        head = a.head; if (!a.ok) errors.push("delivery_record_failed");
      }
    }
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
  const prevGuards = Array.isArray(prev.guards) ? prev.guards.filter((g): g is string => typeof g === "string") : [];
  let guardNames: string[] = prevGuards;

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
      guardNames = d.guardNames;
      // the database checks an EXPECTED list (name, table, function, ENABLE ALWAYS) for this migration, D4-1 and the authorization migration: findings are immediate, not 'seen before'
      if (!d.guardsReported) findings.push({ code: "digest_unavailable", severity: "critical", message: "the digest carries no guard inventory", refs: ["guards_unreported"] });
      if (d.guardsMissing.length) findings.push({ code: "guard_missing", severity: "critical", message: `${d.guardsMissing.length} expected guard trigger(s) do not exist`, refs: d.guardsMissing.map((g) => `guard:${g}`) });
      const off = [...new Set([...d.guardsDisabled, ...d.guardsWrongFn])];
      if (off.length) findings.push({ code: "guard_disabled", severity: "critical", message: "an expected guard trigger is not ENABLE ALWAYS or runs the wrong function", refs: off.map((g) => `guard:${g}`) });
      if (d.expectedButAbsent.length) findings.push({ code: "pricing_tables_partial", severity: "critical", message: "a pricing migration is partially present: expected tables are absent", refs: d.expectedButAbsent.map((x) => `table:${x}`) });
      const gone = prevGuards.filter((g) => !d.guardNames.includes(g) && !d.guardsMissing.includes(g));
      if (gone.length) findings.push({ code: "guard_missing", severity: "critical", message: "a guard trigger seen on an earlier run no longer exists", refs: gone.map((g) => `guard:${g}`) });
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

  return reportFlow({ deps, source: "run", runId, now, findings, chain, errors, extraPayload: { events_cursor: cursor, digest, guards: guardNames } });
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
    // the DATABASE's own insert time wins over the (writer-supplied) recorded time
    const age = lastRun ? now.getTime() - Date.parse(lastRun.inserted_at ?? lastRun.recorded_at) : null;
    if (!lastRun) findings.push({ code: "monitor_stale", severity: "critical", message: "no monitor run has ever been recorded", refs: ["never_ran"] });
    else if (age !== null && age > deps.config.maxAgeMs) findings.push({ code: "monitor_stale", severity: "critical", message: `the last monitor run was ${Math.round(age / 60000)} minutes ago (allowed ${Math.round(deps.config.maxAgeMs / 60000)})`, refs: [`last_run:${lastRun.seq}`] });
  }
  return reportFlow({ deps, source: "watchdog", runId, now, findings, chain, errors: [], extraPayload: {} });
}
