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
const VOLATILE = /^(?:.*_)?(?:at|ts|timestamp|time|seq|nonce|request_id|run_id|event_id|attempt|attempts|counter)$/i;

export function normalizeDetail(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeDetail);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!VOLATILE.test(k)) o[k] = normalizeDetail(x);
    return o;
  }
  return v;
}

export function eventIdentity(kind: string, subject: string | null, detail: Record<string, unknown>): string {
  return `${kind}|${subject ?? "-"}|${createHash("sha256").update(canonicalJson(normalizeDetail(detail))).digest("hex").slice(0, 16)}`;
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

export function rateNoticeSentLastHour(rows: EvidenceRow[], now: Date): boolean {
  return rows.some((r) => r.kind === "delivery" && at(r) >= now.getTime() - 3600_000 && parse(r.payload).rate_notice === true);
}
