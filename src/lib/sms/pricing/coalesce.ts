import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence";
import type { EvidenceRow, Finding } from "./types";

/**
 * ALERT POLICY (owner-approved): the first alert of an identity is sent at once; IDENTICAL repeats inside a window (default 5 minutes from the last send of that identity)
 * are coalesced; a distinct identity is never held back by another. Coalescing only affects what is SENT: every event is still a finding in the run's evidence row (the
 * append-only chain records all of them, with a per-identity suppressed count), nothing is deleted or hidden.
 *
 *   identity = kind | subject | first 16 hex of SHA-256(canonical JSON of the detail with volatile keys removed)
 *
 * State lives in the evidence chain (delivery rows list the identities they sent; run rows record the suppressed counts), so it survives restarts and is serverless-safe.
 * FAIL OPEN: when the state cannot be read or the chain is not trusted, nothing is coalesced (everything is sent).
 */
export const COALESCE_WINDOW_MS = 5 * 60_000;

/** Keys that change on every occurrence of the same incident and must not make two identical events look different. */
const VOLATILE = /^(?:.*_)?(?:at|ts|timestamp|time|seq|nonce|request_id|run_id|event_id|attempt|attempts|counter|length|len|size|bytes)$/i; // includes user-controlled sizes such as note_length

export function normalizeDetail(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeDetail);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!VOLATILE.test(k)) o[k] = normalizeDetail(x);
    return o;
  }
  return v;
}

/**
 * The dedup identity must never contain USER-CONTROLLED text (a freeze reason is typed by an administrator, or by whoever holds a stolen session): fifteen different reasons would
 * be fifteen different "incidents" and could fill the top-priority alert budget. The identity is therefore built from a bounded, server-defined projection of the detail:
 *   - a `reason` maps to a code from the closed enumeration REASON_CODES; text this monitor does not recognise maps to the catch-all 'other';
 *   - other free-text keys (note, label, description, message, ...) contribute only the constant 'other';
 *   - any other string is kept only if it has the shape of a server-defined token, a uuid or a hex reference; anything else is 'other';
 *   - numbers, booleans and null are kept; objects and arrays are bounded.
 * The original text stays in the protected audit record and the events table; it is not part of the identity and not part of the alert message.
 */
export const REASON_CODES = ["compromise_reported", "recovery_credential", "sign_counter_regression", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
/** The only reason texts the database itself emits (exact, case-insensitive match). A freeze typed by a person is never one of these by construction of the freeze function's own wording. */
const TRUSTED_REASONS: Record<string, ReasonCode> = {
  "compromise reported": "compromise_reported",
  "recovery credential": "recovery_credential",
  "sign counter did not increase": "sign_counter_regression",
};
export function reasonCode(text: unknown): ReasonCode {
  return typeof text === "string" ? (TRUSTED_REASONS[text.trim().toLowerCase()] ?? "other") : "other";
}
const USER_TEXT_KEY = /^(?:reason|note|notes|label|description|message|text|comment|detail|details|error|summary|title|name)$/i;
const TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXREF = /^[0-9a-f]{8,64}$/i;
const MAX_KEYS = 24;
const MAX_ITEMS = 20;
export function identityDetail(v: unknown, key = "", depth = 0): unknown {
  if (typeof v === "string") {
    if (key.toLowerCase() === "reason") return reasonCode(v);
    if (USER_TEXT_KEY.test(key)) return "other";
    return TOKEN.test(v) || UUID.test(v) || HEXREF.test(v) ? v.toLowerCase() : "other";
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : "other";
  if (typeof v === "boolean" || v === null) return v;
  if (depth >= 3) return "other";
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => identityDetail(x, key, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort().slice(0, MAX_KEYS)) o[k] = identityDetail((v as Record<string, unknown>)[k], k, depth + 1);
    return o;
  }
  return "other";
}

export function eventIdentity(kind: string, subject: string | null, detail: Record<string, unknown>): string {
  return `${kind}|${subject ?? "-"}|${createHash("sha256").update(canonicalJson(identityDetail(normalizeDetail(detail)))).digest("hex").slice(0, 16)}`;
}

const parse = (p: string): Record<string, unknown> => { try { const v = JSON.parse(p); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } };
const at = (r: EvidenceRow) => Date.parse(r.inserted_at ?? r.recorded_at); // the database's own insert time wins over the writer-supplied time

export type CoalesceState = { sentAt: Map<string, number>; pending: Map<string, number> };

/** Derives the coalescing state from the evidence window. Pure; throws nothing for odd rows (they are ignored, which fails open). */
export function deriveState(rows: EvidenceRow[]): CoalesceState {
  const sentAt = new Map<string, number>();
  const resetSeq = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "delivery") continue;
    const p = parse(r.payload);
    if (p.alert_ok !== true) continue;
    const ids = Array.isArray(p.ids) ? p.ids.filter((x): x is string => typeof x === "string") : [];
    const sum = Array.isArray(p.summarized) ? p.summarized.filter((x): x is string => typeof x === "string") : [];
    for (const id of ids) { sentAt.set(id, Math.max(sentAt.get(id) ?? 0, at(r))); resetSeq.set(id, Math.max(resetSeq.get(id) ?? 0, r.seq)); }
    for (const id of sum) resetSeq.set(id, Math.max(resetSeq.get(id) ?? 0, r.seq));
  }
  const pending = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "run" && r.kind !== "watchdog") continue;
    const c = parse(r.payload).coalesced;
    if (!c || typeof c !== "object") continue;
    for (const [id, n] of Object.entries(c as Record<string, unknown>)) if (typeof n === "number" && r.seq > (resetSeq.get(id) ?? 0)) pending.set(id, (pending.get(id) ?? 0) + n);
  }
  return { sentAt, pending };
}

export type Decision = { send: Finding[]; coalesced: Record<string, number>; ids: string[]; summarized: string[] };

/** Event findings (with an identity) are grouped per identity; everything else is passed through by the caller. */
/** `heldSummaries`: identities whose summary is already waiting undelivered (do not queue another one every run while sends are held). */
export function decide(events: Finding[], state: CoalesceState, now: Date, windowMs: number = COALESCE_WINDOW_MS, heldSummaries: Set<string> = new Set()): Decision {
  const groups = new Map<string, { f: Finding; n: number }>();
  for (const f of events) {
    const g = groups.get(f.identity!);
    if (g) g.n += 1; else groups.set(f.identity!, { f, n: 1 });
  }
  const send: Finding[] = [];
  const coalesced: Record<string, number> = {};
  const ids: string[] = [];
  const summarized: string[] = [];
  for (const [id, g] of groups) {
    const last = state.sentAt.get(id);
    if (last !== undefined && now.getTime() - last < windowMs) { coalesced[id] = g.n; continue; }
    const earlier = state.pending.get(id) ?? 0;
    send.push({ ...g.f, message: `${g.f.message}${g.n > 1 ? ` (x${g.n} in this run)` : ""}${earlier ? ` (+${earlier} identical repeat(s) were suppressed earlier)` : ""}` });
    ids.push(id);
    if (earlier) summarized.push(id);
  }
  // windows that closed with suppressed repeats and no new occurrence now: deliver the summary
  for (const [id, n] of state.pending) {
    if (groups.has(id) || n <= 0 || heldSummaries.has(id)) continue;
    const last = state.sentAt.get(id);
    if (last !== undefined && now.getTime() - last < windowMs) continue;
    send.push({ code: "alert_coalesced", severity: "info", message: `${n} identical repeat(s) of ${id.split("|")[0]} were suppressed inside the ${Math.round(windowMs / 60000)}-minute window (all are in the evidence chain)`, refs: [`identity:${id}`] });
    summarized.push(id);
  }
  return { send, coalesced, ids, summarized };
}

/** Attempts made per transport in the last hour, from the delivery rows (verification rows carry no `results`). */
export function attemptsLastHour(rows: EvidenceRow[], now: Date): Map<string, number> {
  const used = new Map<string, number>();
  const since = now.getTime() - 3600_000;
  for (const r of rows) {
    if (r.kind !== "delivery" || at(r) < since) continue;
    const res = parse(r.payload).results;
    if (!Array.isArray(res)) continue;
    for (const x of res as { transport?: unknown; attempts?: unknown }[]) if (typeof x.transport === "string" && typeof x.attempts === "number") used.set(x.transport, (used.get(x.transport) ?? 0) + x.attempts);
  }
  return used;
}

/** Priority classes of an alert message: top > crit > warn > info. */
export type AlertClass = "top" | "crit" | "warn" | "info";
export const CLASS_RANK: Record<AlertClass, number> = { top: 0, crit: 1, warn: 2, info: 3 };
/** Highest-priority kinds: a recovery path used or started, an integrity failure, an unclassified kind, a failed emit, a freeze. Standing critical conditions (non-event findings) are top too. */
const TOP_CODES = new Set(["credential_recovery_used", "recovery_enrollment_started", "price_integrity_failure", "unknown_security_event", "event_emit_failed", "pricing_suspended"]);
export function classOfFinding(f: Finding): AlertClass {
  if (f.severity === "critical") return !f.identity || TOP_CODES.has(f.code) ? "top" : "crit";
  return f.severity === "warning" ? "warn" : "info";
}
export function classOfMessage(fs: Finding[]): AlertClass {
  return fs.map(classOfFinding).sort((a, b) => CLASS_RANK[a] - CLASS_RANK[b])[0] ?? "info";
}

/** Hourly capacity per transport and class (attempts). N = cap - 1 (the last slot is the rate notice). Top may use all N; crit+warn+info at most N - R (R slots are reserved for top); warn+info at most half of N. */
export function classLimits(cap: number): { n: number; nonTop: number; warnInfo: number } {
  const n = Math.max(1, cap - 1);
  const reserve = n >= 4 ? Math.ceil(n / 4) : 0;
  return { n, nonTop: n - reserve, warnInfo: n >= 2 ? Math.floor(n / 2) : n };
}
export type Usage = { all: number; nonTop: number; warnInfo: number };
/** Attempts per transport in the last hour, by class (delivery rows record `cls`; older rows count as crit; rate notices are excluded). */
export function usageLastHour(rows: EvidenceRow[], now: Date): Map<string, Usage> {
  const out = new Map<string, Usage>();
  const since = now.getTime() - 3600_000;
  for (const r of rows) {
    if (r.kind !== "delivery" || at(r) < since) continue;
    const p = parse(r.payload);
    if (p.rate_notice === true || !Array.isArray(p.results)) continue;
    const cls = (typeof p.cls === "string" && p.cls in CLASS_RANK ? p.cls : "crit") as AlertClass;
    for (const x of p.results as { transport?: unknown; attempts?: unknown }[]) {
      if (typeof x.transport !== "string" || typeof x.attempts !== "number") continue;
      const u = out.get(x.transport) ?? { all: 0, nonTop: 0, warnInfo: 0 };
      u.all += x.attempts; if (cls !== "top") u.nonTop += x.attempts; if (cls === "warn" || cls === "info") u.warnInfo += x.attempts;
      out.set(x.transport, u);
    }
  }
  return out;
}
export function availableAttempts(cap: number, u: Usage | undefined, cls: AlertClass): number {
  const l = classLimits(cap);
  const used = u ?? { all: 0, nonTop: 0, warnInfo: 0 };
  if (cls === "top") return Math.max(0, l.n - used.all);
  const room = Math.min(l.nonTop - used.nonTop, l.n - used.all);
  return Math.max(0, cls === "crit" ? room : Math.min(room, l.warnInfo - used.warnInfo));
}

export function rateNoticeSentLastHour(rows: EvidenceRow[], now: Date): boolean {
  return rows.some((r) => r.kind === "delivery" && at(r) >= now.getTime() - 3600_000 && parse(r.payload).rate_notice === true);
}
