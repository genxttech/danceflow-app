// Request reconciliation (pure, no I/O, no network). Compares what the proof SAYS it sent (its transcript / evidence request ids) with a provider-side log that a
// human obtained INDEPENDENTLY from Stripe (Dashboard Logs / Workbench Logs, or `stripe logs tail` output captured while the run was in progress).
//
// What this proves and what it cannot: it detects a request the app recorded that the provider log lacks, a provider request the app did not record, count and field
// discrepancies, duplicates and replays. It can NOT prove the provider log is complete or authentic: that is why every result carries
// `independentVerification: "STILL_REQUIRED"` and provenance is a mandatory input. See docs/billing/D24-REQUEST-RECONCILIATION.md.

export type SentRequest = {
  n?: number;
  atUtc: string;
  method: string;
  path: string;
  /** Stripe-Account header as recorded (may be masked); "-" or undefined for platform requests */
  stripeAccount?: string;
  /** full key, or the proof's masked form `<first 12>…(<length>)` */
  idempotencyKey?: string;
  status: number | "BLOCKED" | "ERROR";
  requestId?: string;
  replayed?: boolean;
};

export type ProviderEntry = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  /** ISO-8601 UTC */
  createdUtc: string;
  idempotencyKey?: string;
  /** connected account the request applied to; undefined/null = platform */
  account?: string | null;
};

export type Provenance = {
  source: "dashboard_logs" | "workbench_logs" | "stripe_cli_logs_tail" | "events_api_partial";
  obtainedBy: string;
  obtainedAtUtc: string;
  /** exactly how the human filtered (date range, key, endpoints): so a narrow filter cannot masquerade as completeness */
  filterDescription: string;
  /** operator's statement that the filter covered the whole window and every method (GET included) and status; informational, not verifiable here */
  coversWholeWindowAllMethodsAllStatuses: boolean;
};

export type Finding = {
  kind:
    | "missing_in_provider" | "extra_in_provider" | "duplicate_in_provider" | "duplicate_in_sent" | "field_mismatch" | "time_skew" | "count_mismatch"
    | "replay_matched_to_original" | "replay_without_original" | "error_entry_matched" | "error_entry_not_in_provider" | "out_of_window_provider" | "out_of_window_sent" | "transcript_unparsed" | "provenance_problem" | "unusable_input";
  severity: "fail" | "warn" | "info";
  detail: string;
  requestId?: string;
};

/** `window` MUST come from outside the transcript (the operator's own start/end of the supervised run, e.g. CLI args), never from the transcript's timestamps: a truncated transcript would otherwise shrink the window and hide extras. */
export type ReconcileOptions = { window: { fromUtc: string; toUtc: string }; maxSkewMs?: number; unparsedTranscriptLines?: string[] };
export type ReconcileResult = {
  verdict: "CONSISTENT" | "DISCREPANCIES";
  /** Always STILL_REQUIRED: a tool cannot establish that an export is complete or genuine. */
  independentVerification: "STILL_REQUIRED";
  window: { fromUtc: string; toUtc: string } | null;
  counts: { sentNetwork: number; sentBlocked: number; providerInWindow: number; matched: number };
  perEndpoint: Array<{ key: string; sent: number; provider: number }>;
  findings: Finding[];
};

const DEFAULT_MAX_SKEW_MS = 120_000;
const norm = (p: string) => p.split("?")[0];
const sameAccount = (a: string | null | undefined, b: string | null | undefined) => {
  const x = !a || a === "-" ? null : a;
  const y = !b || b === "-" ? null : b;
  if (x === null || y === null) return x === y;
  // the proof masks account ids (acct_abc…yz): compare the visible prefix and suffix
  if (x.includes("…") || y.includes("…")) {
    const [m, f] = x.includes("…") ? [x, y] : [y, x];
    const [pre, suf] = m.split("…");
    return f.startsWith(pre) && f.endsWith(suf);
  }
  return x === y;
};
/** exact equality, or the proof's masked form (`<first 12>…(<length>)`) against a full key */
export function idempotencyMatches(sent: string | undefined, provider: string | undefined): boolean {
  if (!sent || sent === "-") return !provider;
  if (!provider) return false;
  const m = /^(.{1,12})…\((\d+)\)$/.exec(sent);
  if (m) return provider.startsWith(m[1]) && provider.length === Number(m[2]);
  return sent === provider;
}

export function reconcile(sentAll: SentRequest[], providerAll: ProviderEntry[], provenance: Provenance | null, opts: ReconcileOptions): ReconcileResult {
  const maxSkew = opts?.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // provenance: a missing or weak statement is itself a failure, never silently accepted
  if (!provenance) add({ kind: "provenance_problem", severity: "fail", detail: "provider log has no provenance record (who obtained it, how, with which filter)" });
  else {
    if (!provenance.obtainedBy?.trim() || !provenance.filterDescription?.trim() || Number.isNaN(Date.parse(provenance.obtainedAtUtc))) add({ kind: "provenance_problem", severity: "fail", detail: "provenance must name who obtained the log, when, and the exact filter used" });
    if (!provenance.coversWholeWindowAllMethodsAllStatuses) add({ kind: "provenance_problem", severity: "fail", detail: "operator did not attest that the filter covered the whole window, all methods (GET included) and all statuses; a partial export cannot detect extras or missing GETs" });
    if (provenance.source === "events_api_partial") add({ kind: "provenance_problem", severity: "warn", detail: "events API output covers only state-changing operations that emit events: GETs and rejected requests are invisible, so absence of a GET or a 4xx here proves nothing" });
  }

  const sentBlocked = sentAll.filter((s) => s.status === "BLOCKED");
  const sent = sentAll.filter((s) => s.status !== "BLOCKED"); // BLOCKED = refused before any network I/O: must NOT appear at the provider
  for (const s of sent) if (Number.isNaN(Date.parse(s.atUtc))) add({ kind: "unusable_input", severity: "fail", detail: `sent entry ${s.n ?? "?"} has an unparseable time` });
  for (const p of providerAll) if (Number.isNaN(Date.parse(p.createdUtc)) || !p.requestId) add({ kind: "unusable_input", severity: "fail", detail: "provider entry without a request id or a parseable time", requestId: p.requestId });
  for (const line of opts?.unparsedTranscriptLines ?? []) add({ kind: "transcript_unparsed", severity: "fail", detail: `transcript line could not be parsed and was NOT compared: ${line.slice(0, 120)}` });
  const from = Date.parse(opts?.window?.fromUtc ?? "");
  const to = Date.parse(opts?.window?.toUtc ?? "");
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
    add({ kind: "unusable_input", severity: "fail", detail: "an independently supplied run window (start < end, ISO-8601) is required; it is never derived from the transcript" });
    return finish(null, sent, sentBlocked, [], 0, findings);
  }
  if (sent.length === 0) {
    add({ kind: "unusable_input", severity: "fail", detail: "no network requests recorded by the app: nothing to reconcile" });
    return finish({ fromUtc: new Date(from).toISOString(), toUtc: new Date(to).toISOString() }, sent, sentBlocked, [], 0, findings);
  }
  for (const s of sent) {
    const t = Date.parse(s.atUtc);
    if (!Number.isNaN(t) && (t < from || t > to)) add({ kind: "out_of_window_sent", severity: "fail", detail: `app transcript entry ${s.n ?? "?"} (${s.method} ${norm(s.path)}) is outside the independently supplied run window`, requestId: s.requestId });
  }

  const inWin: ProviderEntry[] = [];
  for (const p of providerAll) {
    const t = Date.parse(p.createdUtc);
    if (Number.isNaN(t)) continue;
    // A provider row outside the window is NOT ignorable: it is either a request the app never recorded (a truncated transcript) or evidence the filter was wider than attested.
    if (t < from || t > to) add({ kind: "out_of_window_provider", severity: "fail", detail: `provider entry ${p.method} ${norm(p.path)} -> ${p.status} at ${p.createdUtc} is outside the run window: not in the app transcript; explain or re-filter`, requestId: p.requestId });
    else inWin.push(p);
  }

  // duplicates
  const countBy = <T,>(xs: T[], k: (x: T) => string | undefined) => { const m = new Map<string, number>(); for (const x of xs) { const key = k(x); if (key) m.set(key, (m.get(key) ?? 0) + 1); } return m; };
  for (const [id, c] of countBy(inWin, (p) => p.requestId)) if (c > 1) add({ kind: "duplicate_in_provider", severity: "fail", detail: `request id appears ${c} times in the provider log`, requestId: id });
  for (const [id, c] of countBy(sent, (s) => s.requestId)) if (c > 1) add({ kind: "duplicate_in_sent", severity: "fail", detail: `request id appears ${c} times in the app transcript`, requestId: id });

  const byId = new Map<string, ProviderEntry>();
  for (const p of inWin) if (!byId.has(p.requestId)) byId.set(p.requestId, p);
  const claimed = new Set<ProviderEntry>();
  const claimedBy = new Map<SentRequest, ProviderEntry>();
  let matched = 0;

  const compare = (s: SentRequest, p: ProviderEntry) => {
    if (s.method !== p.method) add({ kind: "field_mismatch", severity: "fail", detail: `method: app ${s.method}, provider ${p.method}`, requestId: p.requestId });
    if (norm(s.path) !== norm(p.path)) add({ kind: "field_mismatch", severity: "fail", detail: `path: app ${norm(s.path)}, provider ${norm(p.path)}`, requestId: p.requestId });
    if (typeof s.status === "number" && s.status !== p.status) add({ kind: "field_mismatch", severity: "fail", detail: `status: app ${s.status}, provider ${p.status}`, requestId: p.requestId });
    if (!sameAccount(s.stripeAccount, p.account)) add({ kind: "field_mismatch", severity: "fail", detail: "Stripe-Account scope differs between app and provider", requestId: p.requestId });
    if (s.method === "POST" && !idempotencyMatches(s.idempotencyKey, p.idempotencyKey)) add({ kind: "field_mismatch", severity: "fail", detail: "idempotency key differs between app and provider", requestId: p.requestId });
    const skew = Math.abs(Date.parse(s.atUtc) - Date.parse(p.createdUtc));
    if (skew > maxSkew) add({ kind: "time_skew", severity: "fail", detail: `app time and provider time differ by ${Math.round(skew / 1000)} s`, requestId: p.requestId });
  };

  const pending: SentRequest[] = [];
  const replayExcluded = new Set<SentRequest>();
  for (const s of sent) {
    const p = s.requestId ? byId.get(s.requestId) : undefined;
    if (p && !claimed.has(p)) {
      claimed.add(p);
      claimedBy.set(s, p);
      matched += 1;
      compare(s, p);
    } else pending.push(s);
  }

  // not found by id: replays, transport errors without a response, or genuinely missing
  for (const s of pending) {
    const free = inWin.filter((p) => !claimed.has(p));
    if (s.replayed) {
      // A replay may only be explained by an EXISTING, already matched original (same method, path and full idempotency key, different request id). It never claims an unmatched provider row.
      const origin = [...claimedBy.entries()].find(([o, p]) => !o.replayed && o.requestId !== s.requestId && o.method === s.method && norm(o.path) === norm(s.path) && !!s.idempotencyKey && o.idempotencyKey === s.idempotencyKey && idempotencyMatches(s.idempotencyKey, p.idempotencyKey));
      if (origin) { add({ kind: "replay_matched_to_original", severity: "info", detail: "idempotent replay: the provider log shows the matched original request (same key, method, path) but not the replay's own id; replay logging is not verified", requestId: origin[1].requestId }); replayExcluded.add(s); continue; }
      add({ kind: "replay_without_original", severity: "fail", detail: `app marked ${s.method} ${norm(s.path)} as a replay but no matched original request with the same idempotency key exists; a replay line cannot explain a provider request`, requestId: s.requestId });
      continue;
    }
    if (s.status === "ERROR" || !s.requestId) {
      const cand = free.find((p) => p.method === s.method && norm(p.path) === norm(s.path) && (s.method !== "POST" || idempotencyMatches(s.idempotencyKey, p.idempotencyKey)) && Math.abs(Date.parse(s.atUtc) - Date.parse(p.createdUtc)) <= maxSkew);
      if (cand) { claimed.add(cand); matched += 1; add({ kind: "error_entry_matched", severity: "warn", detail: `app recorded no response for ${s.method} ${norm(s.path)} but the provider shows it (request ${cand.requestId}): the request DID reach Stripe`, requestId: cand.requestId }); }
      else add({ kind: "error_entry_not_in_provider", severity: "warn", detail: `app recorded ${s.method} ${norm(s.path)} with no response and the provider has no matching entry: probably never reached Stripe (cannot be proven)` });
      continue;
    }
    add({ kind: "missing_in_provider", severity: "fail", detail: `app sent ${s.method} ${norm(s.path)} (status ${String(s.status)}) but the provider log has no such request id`, requestId: s.requestId });
  }

  // anything left at the provider inside the window is an operation the app did not record
  for (const p of inWin) {
    if (claimed.has(p)) continue;
    if (inWin.filter((q) => q.requestId === p.requestId).length > 1 && byId.get(p.requestId) !== p) continue; // already reported as a duplicate
    add({ kind: "extra_in_provider", severity: "fail", detail: `provider shows ${p.method} ${norm(p.path)} -> ${p.status} that the app did not record`, requestId: p.requestId });
  }

  // BLOCKED requests must be absent at the provider (matched by method+path+time is too loose: report only an exact path/method hit inside the window that nothing claimed)
  for (const b of sentBlocked) {
    const hit = inWin.find((p) => !claimed.has(p) && p.method === b.method && norm(p.path) === norm(b.path));
    if (hit) add({ kind: "extra_in_provider", severity: "fail", detail: `the app BLOCKED ${b.method} ${norm(b.path)} before the network, yet the provider shows one`, requestId: hit.requestId });
  }

  return finish({ fromUtc: new Date(from).toISOString(), toUtc: new Date(to).toISOString() }, sent.filter((x) => !replayExcluded.has(x)), sentBlocked, inWin, matched, findings);
}

function finish(window: ReconcileResult["window"], sent: SentRequest[], blocked: SentRequest[], inWin: ProviderEntry[], matched: number, findings: Finding[]): ReconcileResult {
  const sentCount = new Map<string, number>();
  const provCount = new Map<string, number>();
  for (const s of sent) { const k = `${s.method} ${norm(s.path)}`; sentCount.set(k, (sentCount.get(k) ?? 0) + 1); }
  for (const p of inWin) { const k = `${p.method} ${norm(p.path)}`; provCount.set(k, (provCount.get(k) ?? 0) + 1); }
  const keys = [...new Set([...sentCount.keys(), ...provCount.keys()])].sort();
  const perEndpoint = keys.map((key) => ({ key, sent: sentCount.get(key) ?? 0, provider: provCount.get(key) ?? 0 }));
  // count discrepancies are reported once per endpoint, in addition to the per-request findings, so an operator sees the arithmetic
  for (const e of perEndpoint) if (e.sent !== e.provider) findings.push({ kind: "count_mismatch", severity: "fail", detail: `${e.key}: app recorded ${e.sent}, provider shows ${e.provider}` });
  const fails = findings.some((f) => f.severity === "fail");
  return { verdict: fails ? "DISCREPANCIES" : "CONSISTENT", independentVerification: "STILL_REQUIRED", window, counts: { sentNetwork: sent.length, sentBlocked: blocked.length, providerInWindow: inWin.length, matched }, perEndpoint, findings };
}

// ---------- input parsing ----------

/** One line of the proof's printed transcript (`run.ts report`): `NN. <iso> METHOD path[?q] acct=<x> idem=<x> -> <status> req=<id>[ replayed] {…}` */
const LINE = /^\s*(\d+)\.\s+(\S+)\s+(GET|POST|DELETE)\s+(\S+)\s+acct=(\S*)\s+idem=(\S*)\s+->\s+(\d{3}|BLOCKED|ERROR)\s+req=(\S*)(\s+replayed)?/;
export function parseProofTranscript(text: string): { requests: SentRequest[]; unparsed: string[] } {
  const requests: SentRequest[] = [];
  const unparsed: string[] = [];
  let declared: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const calls = /^\s*Calls used:\s*(\d+)/.exec(line);
    if (calls) declared = Number(calls[1]);
    const m = LINE.exec(line);
    if (!m) {
      if (/^\s*\d+\.\s/.test(line)) unparsed.push(line.trim()); // looks like a numbered request line but is not in the known format: never dropped silently
      continue;
    }
    const status = /^\d+$/.test(m[7]) ? Number(m[7]) : (m[7] as "BLOCKED" | "ERROR");
    requests.push({ n: Number(m[1]), atUtc: m[2], method: m[3], path: m[4].split("?")[0], stripeAccount: m[5] === "-" ? undefined : m[5], idempotencyKey: m[6] === "-" ? undefined : m[6], status, requestId: m[8] && m[8] !== "-" ? m[8] : undefined, replayed: m[9] ? true : undefined });
  }
  if (declared !== null && declared !== requests.length + unparsed.length) unparsed.push(`transcript says "Calls used: ${declared}" but ${requests.length + unparsed.length} request lines were found`);
  return { requests, unparsed };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const toIso = (v: unknown): string => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isNaN(t) ? "" : new Date(t).toISOString(); }
  return "";
};

/**
 * The provider-log file is OUR normalised wrapper `{ provenance, entries:[…] }`. Entry fields accept the obvious aliases (request_id|id|requestId, http_method|method,
 * endpoint|path|url, status|status_code, created|created_at|createdUtc|timestamp, idempotency_key, account|stripe_account|connected_account). The export format of
 * the Dashboard is NOT documented, so a human converts what they saw into this shape; this parser never invents a field.
 */
export function parseProviderLog(json: unknown): { provenance: Provenance | null; entries: ProviderEntry[]; problems: string[] } {
  const problems: string[] = [];
  const root = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (!root) return { provenance: null, entries: [], problems: ["provider log must be a JSON object { provenance, entries }"] };
  const pr = root.provenance && typeof root.provenance === "object" ? (root.provenance as Record<string, unknown>) : null;
  const provenance: Provenance | null = pr ? { source: pr.source as Provenance["source"], obtainedBy: str(pr.obtainedBy) ?? "", obtainedAtUtc: str(pr.obtainedAtUtc) ?? "", filterDescription: str(pr.filterDescription) ?? "", coversWholeWindowAllMethodsAllStatuses: pr.coversWholeWindowAllMethodsAllStatuses === true } : null;
  if (provenance && !["dashboard_logs", "workbench_logs", "stripe_cli_logs_tail", "events_api_partial"].includes(String(provenance.source))) problems.push("provenance.source must be dashboard_logs | workbench_logs | stripe_cli_logs_tail | events_api_partial (app-collected request ids are not an independent source)");
  const raw = Array.isArray(root.entries) ? root.entries : [];
  if (!Array.isArray(root.entries)) problems.push("entries must be an array");
  const entries: ProviderEntry[] = [];
  raw.forEach((e, i) => {
    if (!e || typeof e !== "object") return void problems.push(`entry ${i} is not an object`);
    const o = e as Record<string, unknown>;
    const requestId = str(o.requestId) ?? str(o.request_id) ?? str(o.id) ?? "";
    const method = (str(o.method) ?? str(o.http_method) ?? "").toUpperCase();
    const path = str(o.path) ?? str(o.endpoint) ?? str(o.url) ?? "";
    const status = Number(o.status ?? o.status_code);
    const createdUtc = toIso(o.createdUtc ?? o.created ?? o.created_at ?? o.timestamp);
    if (!/^req_[A-Za-z0-9]+$/.test(requestId) || !method || !path || !Number.isInteger(status) || !createdUtc) return void problems.push(`entry ${i} is missing a valid request id, method, path, status or time`);
    const account = str(o.account) ?? str(o.stripe_account) ?? str(o.connected_account);
    entries.push({ requestId, method, path, status, createdUtc, idempotencyKey: str(o.idempotencyKey) ?? str(o.idempotency_key), account: account ?? null });
  });
  return { provenance, entries, problems };
}
