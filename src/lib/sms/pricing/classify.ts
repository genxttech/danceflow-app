import { EVENT_KINDS, type Finding, type SecurityEvent } from "./types";

const MAX_REFS = 20;
const VERIFY_MAX_AGE_MS = 5 * 60 * 1000;

const failure = (message: string): Finding => ({ code: "verification_failure", severity: "critical", message, refs: [] });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 80) : "?");

/**
 * Classifies the result of public.tw4_price_verify(p_since) (D4-1). FAIL CLOSED: anything that is not exactly the documented shape is a verification failure, an unknown anomaly
 * code is a verification failure, and a result that contradicts itself (ok = true with anomalies, ok = false without) or is stale is a verification failure.
 *   price_unattested, several_active_prices -> unauthorized_price_change
 *   request_anomaly                          -> missing_approval
 */
export function classifyVerify(raw: unknown, now: Date): Finding[] {
  if (!isObj(raw) || typeof raw.ok !== "boolean" || !Array.isArray(raw.anomalies)) return [failure("the verifier returned an unintelligible result")];
  const anomalies = raw.anomalies;
  if (raw.ok !== (anomalies.length === 0)) return [failure("the verifier result contradicts itself")];
  if (typeof raw.checked_at !== "string" || !Number.isFinite(Date.parse(raw.checked_at)) || Math.abs(now.getTime() - Date.parse(raw.checked_at)) > VERIFY_MAX_AGE_MS) {
    return [failure("the verifier result is stale or has no timestamp")];
  }
  const unauthorized: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const a of anomalies) {
    if (!isObj(a)) { unknown.push("non-object"); continue; }
    if (a.code === "price_unattested") unauthorized.push(`price:${str(a.price_id)}:${str(a.kind)}`);
    else if (a.code === "several_active_prices") unauthorized.push(`active:${str(a.kind)}:${typeof a.count === "number" ? a.count : "?"}`);
    else if (a.code === "request_anomaly") missing.push(`request:${str(a.request_id)}:${str(a.status)}`);
    else unknown.push(str(a.code));
  }
  const out: Finding[] = [];
  if (unauthorized.length) out.push({ code: "unauthorized_price_change", severity: "critical", message: `${unauthorized.length} published price(s) without a valid two-person approval`, refs: unauthorized.slice(0, MAX_REFS).sort() });
  if (missing.length) out.push({ code: "missing_approval", severity: "critical", message: `${missing.length} price change request(s) with a missing or incoherent approval record`, refs: missing.slice(0, MAX_REFS).sort() });
  if (unknown.length) out.push({ ...failure(`the verifier reported ${unknown.length} anomaly code(s) this monitor does not know`), refs: unknown.slice(0, MAX_REFS).sort() });
  return out;
}

export type DigestState = { digest: string; rows: number; activeRows: number; guardsBad: string[]; guardNames: string[]; guardsMissing: string[]; guardsDisabled: string[]; guardsWrongFn: string[]; expectedButAbsent: string[]; guardsReported: boolean };

export function parseDigest(raw: unknown): DigestState | null {
  if (!isObj(raw) || typeof raw.digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.digest)) return null;
  const rows = Number(raw.rows), active = Number(raw.active_rows);
  if (!Number.isFinite(rows) || !Number.isFinite(active)) return null;
  const bad = Array.isArray(raw.guards_bad) ? raw.guards_bad.filter((x): x is string => typeof x === "string") : [];
  const names = isObj(raw.guards) ? Object.keys(raw.guards).sort() : [];
  // a digest without guard information (older function) reads as "guards unknown": reported by the monitor as digest_unavailable only when guards are absent AND previously present
  const list = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return { digest: raw.digest, rows, activeRows: active, guardsBad: bad, guardNames: names, guardsMissing: list("guards_missing"), guardsDisabled: list("guards_disabled"), guardsWrongFn: list("guards_wrong_function"), expectedButAbsent: list("expected_but_absent"), guardsReported: typeof raw.guards_ok === "boolean" };

}

export function parseEvents(raw: unknown): { headSeq: number; events: SecurityEvent[]; suspended: { seq: number; kind: string } | null } | null {
  if (!isObj(raw) || typeof raw.head_seq !== "number" || !Array.isArray(raw.events)) return null;
  const events: SecurityEvent[] = [];
  for (const e of raw.events) {
    if (!isObj(e) || typeof e.seq !== "number" || typeof e.kind !== "string" || typeof e.occurred_at !== "string") return null;
    events.push({ seq: e.seq, kind: e.kind, occurred_at: e.occurred_at, subject_user_id: typeof e.subject_user_id === "string" ? e.subject_user_id : null, detail: isObj(e.detail) ? e.detail : {} });
  }
  const s = raw.last_suspension_event;
  const suspended = isObj(s) && typeof s.seq === "number" && typeof s.kind === "string" ? { seq: s.seq, kind: s.kind } : null;
  return { headSeq: raw.head_seq, events, suspended };
}

/** Security events (generic) plus the standing suspension state. Each new event is reported once (the cursor advances only after the run is recorded). */
export function classifyEvents(events: SecurityEvent[], suspended: { seq: number; kind: string } | null): Finding[] {
  const out: Finding[] = [];
  for (const e of events) {
    const m = EVENT_KINDS[e.kind];
    const ref = `event:${e.seq}:${e.kind}`;
    // the second-channel fingerprint (16 hex of the signed hash) is shown in the alert text so the owner can compare it with the other channel
    const fp = typeof e.detail.fingerprint === "string" && /^[0-9a-f]{16}$/.test(e.detail.fingerprint) ? e.detail.fingerprint : null;
    if (m) out.push({ code: m.code, severity: m.severity, message: `security event ${e.kind} at ${e.occurred_at}${fp ? ` (fingerprint ${fp})` : ""}`, refs: fp ? [ref, `fingerprint:${fp}`] : [ref] });
    else out.push({ code: "unknown_security_event", severity: "warning", message: `unrecognized security event kind ${e.kind.slice(0, 60)} at ${e.occurred_at}`, refs: [ref] });
  }
  if (suspended && suspended.kind === "pricing_suspended") {
    out.push({ code: "pricing_suspended", severity: "critical", message: "emergency pricing suspension is in force (no price may change until it is lifted)", refs: [`suspension:${suspended.seq}`] });
  }
  return out;
}
