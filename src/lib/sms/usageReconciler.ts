import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSmsPhone } from "./compliance";
import { SMS_FALLBACK_HELP_KEYWORDS, SMS_FALLBACK_OPT_IN_KEYWORDS, SMS_FALLBACK_OPT_OUT_KEYWORDS, classifyInboundKeywordBody } from "./inboundKeywords";
import type { BilledSmsProvider, InboundMessageEvidence, InboundMessageLister } from "./usageProvider";

/**
 * TW-4F scheduled SMS usage reconciliation (design docs/twilio/TW-4F_Usage_Reconciliation_Design.md). SERVER ONLY. The DATABASE decides every money
 * outcome; this module only moves provider evidence to it and counts what happened.
 *
 *   1. stale reservations: attempts still 'reserved' (no dispatch marker, so never sent) for 10+ minutes are released;
 *   2. outbound evidence: each due submitted text's Message resource is read through ITS OWN subaccount and settled (charge / release / pending / review);
 *      a read that fails is recorded with backoff (definite failures go to review at once, transient ones after a bounded number of tries);
 *   3. escalation: texts that only a platform admin can resolve (marker without SID, review, overdue) are stamped for the panel; never released;
 *   4. inbound recovery: each subaccount's inbound texts the webhook did not record are recorded from the provider's own list with the webhook's rules,
 *      classified fail-safe (anything not provably ordinary is compliance, never charged); its checkpoint moves only after a complete scan.
 *
 * One run at a time per job (a database lease), every write a run makes is fenced by that lease, every step is idempotent, and one item's failure
 * never stops the others. Results are counts only: no body, number, SID or amount per business. Nothing here schedules anything.
 */

type Client = Pick<SupabaseClient, "rpc">;

export type UsageReconcileSummary = {
  releasedUnsent: number;
  due: number;
  settled: number;
  chargedCents: number;
  pending: number;
  review: number;
  retrying: number;
  errors: number;
  /** false when no evidence provider was available (reads switched off): nothing was read, nothing counted as a failure */
  evidenceRead: boolean;
  /** stopped early at the time budget; the rest is picked up by the next run */
  truncated: boolean;
};

type DueRow = { attempt_id: string; account_sid: string; provider_sid: string };

function isDueRow(value: unknown): value is DueRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return [row.attempt_id, row.account_sid, row.provider_sid].every((v) => typeof v === "string" && v !== "");
}

function errorCode(error: { code?: string } | null | undefined): string {
  return String(error?.code ?? "unknown");
}

const missingFunction = (error: { code?: string } | null | undefined) => error?.code === "PGRST202" || error?.code === "42883";

class LeaseLost extends Error {
  constructor() {
    super("usage reconcile: the run lost its lease");
  }
}

/** The provider's error as a stored code, and whether it is DEFINITE (the provider answered that this message is not readable as ours). */
export function classifyEvidenceFailure(error: unknown): { code: string; definite: boolean } {
  const message = error instanceof Error ? error.message : "";
  const code = /^usage_evidence_[a-z0-9_]{1,40}$/.test(message) ? message : "usage_evidence_unknown";
  const definite = code === "usage_evidence_http_404" || code === "usage_evidence_mismatch" || code === "usage_evidence_invalid_input";
  return { code, definite };
}

const emptyOutbound = (evidenceRead: boolean): UsageReconcileSummary => ({
  releasedUnsent: 0, due: 0, settled: 0, chargedCents: 0, pending: 0, review: 0, retrying: 0, errors: 0, evidenceRead, truncated: false,
});

/**
 * One outbound pass. With a `runId` (the scheduled path) the stale release is the bounded, lease-fenced `tw4_usage_release_stale`; without one (a
 * manual or test pass) the 20261201 `tw4_usage_release_unsent`. With `provider: null` no evidence is read at all.
 */
export async function reconcileSmsUsage(
  admin: Client,
  provider: Pick<BilledSmsProvider, "fetchMessage"> | null,
  options: { limit?: number; runId?: string; deadline?: number } = {},
): Promise<UsageReconcileSummary> {
  const summary = emptyOutbound(provider !== null);
  const overBudget = () => options.deadline !== undefined && Date.now() > options.deadline;

  const released = options.runId
    ? await admin.rpc("tw4_usage_release_stale", { p_run_id: options.runId, p_limit: 200 })
    : await admin.rpc("tw4_usage_release_unsent");
  if (released.error) {
    if (released.error.code === "TW023") throw new LeaseLost();
    throw new Error(`usage reconcile: stale release failed (${errorCode(released.error)})`);
  }
  const releasedCount = (released.data as { released?: unknown } | null)?.released;
  summary.releasedUnsent = typeof releasedCount === "number" ? releasedCount : 0;

  if (provider === null) return summary;

  const due = await admin.rpc("tw4_usage_due", { p_limit: options.limit ?? 100 });
  if (due.error) throw new Error(`usage reconcile: due failed (${errorCode(due.error)})`);
  const rows = Array.isArray(due.data) ? (due.data as unknown[]).filter(isDueRow) : [];
  summary.due = rows.length;

  // a read that failed is recorded with backoff; before 20261205 (function missing) the attempt is only stamped to the back of the queue (best effort)
  const failed = async (attemptId: string, failure: { code: string; definite: boolean }) => {
    try {
      const recorded = await admin.rpc("tw4_usage_evidence_failed", { p_attempt_id: attemptId, p_code: failure.code, p_definite: failure.definite });
      if (recorded.error && missingFunction(recorded.error)) {
        await admin.rpc("tw4_usage_touch", { p_attempt_id: attemptId });
        return;
      }
      const outcome = (recorded.data as { outcome?: unknown } | null)?.outcome;
      if (outcome === "review") summary.review += 1;
      else if (outcome === "retry") summary.retrying += 1;
    } catch {
      // the next run simply sees it again
    }
  };

  for (const row of rows) {
    if (overBudget()) {
      summary.truncated = true;
      break;
    }
    let evidence;
    try {
      evidence = await provider.fetchMessage(row.account_sid, row.provider_sid);
    } catch (error) {
      summary.errors += 1;
      await failed(row.attempt_id, classifyEvidenceFailure(error));
      continue;
    }
    let settled;
    try {
      settled = await admin.rpc("tw4_usage_settle", { p_attempt_id: row.attempt_id, p_evidence: evidence });
    } catch {
      summary.errors += 1;
      await failed(row.attempt_id, { code: "usage_settle_unavailable", definite: false });
      continue;
    }
    if (settled.error) {
      summary.errors += 1;
      // 42501: the database refused the evidence as another message's or account's (definite); anything else (lock timeout, outage) is transient
      const code = errorCode(settled.error);
      await failed(row.attempt_id, code === "42501" ? { code: "usage_settle_refused", definite: true } : { code: "usage_settle_failed", definite: false });
      continue;
    }
    const result = (settled.data ?? {}) as { outcome?: unknown; charged_cents?: unknown; replayed?: unknown };
    if (result.outcome === "settled") {
      summary.settled += 1;
      if (result.replayed !== true && typeof result.charged_cents === "number") summary.chargedCents += result.charged_cents;
    } else if (result.outcome === "pending") summary.pending += 1;
    else if (result.outcome === "review") summary.review += 1;
    else summary.errors += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------
// inbound recovery
// ---------------------------------------------------------------------------------------------------------------

const KEYWORDS: ReadonlySet<string> = new Set([...SMS_FALLBACK_OPT_OUT_KEYWORDS, ...SMS_FALLBACK_OPT_IN_KEYWORDS, ...SMS_FALLBACK_HELP_KEYWORDS]);

/**
 * Fail-safe classification of a recovered inbound body (the webhook's OptOutType is not in the provider's record, and Advanced Opt-Out may know keywords
 * the fallback list does not). Punctuation and emoji are ignored. Compliance (a keyword): the exact fallback match, or the whole text spelling one
 * ("Stop!!", "STOP 🛑", "stop all"). UNCERTAIN, which the database records as compliance (never charged): a missing or empty body, three words or
 * fewer, any keyword word anywhere ("please stop texting"), or an unrecognizable sender (the webhook would not have recorded it). Only the rest is ordinary.
 */
export function classifyRecoveredBody(body: string | null, senderOk = true): { classification: "ordinary" | "uncertain" | "compliance"; keyword: boolean } {
  if (body === null) return { classification: "uncertain", keyword: false };
  const words = body.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (classifyInboundKeywordBody(body) !== "message" || (words.length > 0 && (KEYWORDS.has(words.join("")) || (words.length <= 2 && words.every((w) => KEYWORDS.has(w)))))) {
    return { classification: "compliance", keyword: true };
  }
  if (!senderOk || words.length <= 3 || words.some((w) => KEYWORDS.has(w))) return { classification: "uncertain", keyword: false };
  return { classification: "ordinary", keyword: false };
}

export type InboundRecoverySummary = {
  accounts: number;
  scanned: number;
  recovered: number;
  recoveredOrdinary: number;
  alreadyRecorded: number;
  unrouted: number;
  keywordsUnseen: number;
  incomplete: number;
  /** permanently refused by the database: kept as unresolved evidence, never blocking the checkpoint */
  refused: number;
  /** a subaccount whose listing could not be completed even for a one-hour window (very high volume): its checkpoint did not move */
  stalled: number;
  errors: number;
  truncated: boolean;
};

type ScanTarget = { account_sid: string; scanned_through: string; numbers: string[] };

function asScanTarget(value: unknown): ScanTarget | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.account_sid !== "string" || !/^AC[0-9a-fA-F]{32}$/.test(row.account_sid) || typeof row.scanned_through !== "string" || !Number.isFinite(Date.parse(row.scanned_through))) return null;
  const numbers = Array.isArray(row.numbers) ? row.numbers.filter((n): n is string => typeof n === "string" && /^\+1[2-9][0-9]{9}$/.test(n)) : [];
  return { account_sid: row.account_sid, scanned_through: row.scanned_through, numbers };
}

/** A webhook arriving late must win the race against recovery (it knows OptOutType): only texts older than this are recovered. */
export const INBOUND_GRACE_MS = 30 * 60 * 1000;
/** Re-examined behind the checkpoint on every scan (provider listing lag); already-recorded texts are filtered in one call. */
export const INBOUND_OVERLAP_MS = 60 * 60 * 1000;
/** At most this much history per subaccount per run, so a long outage catches up in bounded steps; one hour when a listing is too long. */
export const INBOUND_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INBOUND_NARROW_WINDOW_MS = 60 * 60 * 1000;
/** No subaccount may use more of a run than this, so a busy one never starves the rest. */
export const INBOUND_ACCOUNT_BUDGET_MS = 15_000;

const PERMANENT = new Set(["22023", "42501"]);
const messageTime = (m: InboundMessageEvidence) => Date.parse(m.date_created ?? m.date_sent ?? "");

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function recoverInboundUsage(
  admin: Client,
  lister: InboundMessageLister,
  options: { runId: string; now?: Date; deadline?: number; maxAccounts?: number; maxPages?: number },
): Promise<InboundRecoverySummary> {
  const summary: InboundRecoverySummary = {
    accounts: 0, scanned: 0, recovered: 0, recoveredOrdinary: 0, alreadyRecorded: 0, unrouted: 0, keywordsUnseen: 0, incomplete: 0, refused: 0, stalled: 0, errors: 0, truncated: false,
  };
  const runDeadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? new Date();
  const targets = await admin.rpc("tw4_inbound_scan_targets", { p_limit: options.maxAccounts ?? 50 });
  if (targets.error) throw new Error(`inbound recovery: targets failed (${errorCode(targets.error)})`);
  // shuffled: a subaccount that cannot finish must not come first in every run and starve the others
  const rows = shuffled((Array.isArray(targets.data) ? (targets.data as unknown[]) : []).map(asScanTarget).filter((t): t is ScanTarget => t !== null));

  const advance = async (account: string, through: number) => {
    const advanced = await admin.rpc("tw4_inbound_scan_advance", { p_run_id: options.runId, p_account_sid: account, p_through: new Date(through).toISOString() });
    if (advanced.error) {
      if (advanced.error.code === "TW023") throw new LeaseLost();
      summary.errors += 1;
    }
  };

  for (const target of rows) {
    if (Date.now() > runDeadline) {
      summary.truncated = true;
      break;
    }
    const deadline = Math.min(runDeadline, Date.now() + INBOUND_ACCOUNT_BUDGET_MS);
    const checkpoint = new Date(target.scanned_through).getTime();
    const since = checkpoint - INBOUND_OVERLAP_MS;
    let until = Math.min(now.getTime() - INBOUND_GRACE_MS, checkpoint + INBOUND_MAX_WINDOW_MS);
    if (until <= checkpoint) continue;
    summary.accounts += 1;
    // no recorded sender number on this subaccount: nothing could be routed, so there is nothing to recover
    if (target.numbers.length === 0) {
      await advance(target.account_sid, until);
      continue;
    }

    // list every location number's inbound texts for the window; a listing too long for one run is retried once for one hour
    const list = async (end: number) => {
      const bySid = new Map<string, InboundMessageEvidence>();
      for (const to of target.numbers) {
        const listed = await lister.listInbound(target.account_sid, { since: new Date(since), until: new Date(end), maxPages: options.maxPages ?? 10, to, deadline });
        if (!listed.complete) return null;
        for (const m of listed.messages) bySid.set(m.sid, m);
      }
      return [...bySid.values()];
    };
    let messages: InboundMessageEvidence[] | null;
    try {
      messages = await list(until);
      if (messages === null && until > checkpoint + INBOUND_NARROW_WINDOW_MS) {
        until = checkpoint + INBOUND_NARROW_WINDOW_MS;
        messages = await list(until);
      }
    } catch {
      summary.errors += 1;
      continue;   // checkpoint unchanged: the same window is read again next run
    }
    if (messages === null) {
      summary.stalled += 1;
      summary.truncated = true;
      continue;
    }

    // inside the window only (a webhook may still be in flight for anything newer), oldest first, so the checkpoint can move up to what was processed;
    // a text with no time at all counts as the window's start (and is recorded as compliance by the database)
    const inWindow = messages
      .map((m) => ({ m, at: Number.isFinite(messageTime(m)) ? messageTime(m) : since }))
      .filter(({ at }) => at >= since && at <= until)
      .sort((a, b) => a.at - b.at || (a.m.sid < b.m.sid ? -1 : 1));
    summary.scanned += inWindow.length;

    // one call per 500 for "which are not recorded yet": the webhook's own records are never re-sent one by one
    const unrecorded = new Set<string>();
    let lookupFailed = false;
    for (let i = 0; i < inWindow.length; i += 500) {
      const { data, error } = await admin.rpc("tw4_inbound_unrecorded", { p_account_sid: target.account_sid, p_sids: inWindow.slice(i, i + 500).map(({ m }) => m.sid) });
      if (error || !Array.isArray(data)) {
        lookupFailed = true;
        break;
      }
      for (const sid of data) if (typeof sid === "string") unrecorded.add(sid);
    }
    if (lookupFailed) {
      summary.errors += 1;
      continue;
    }

    let processedThrough = until;   // moved back to just before the first text that could not be processed
    for (const { m, at } of inWindow) {
      if (!unrecorded.has(m.sid)) {
        summary.alreadyRecorded += 1;
        continue;
      }
      if (Date.now() > deadline) {
        summary.truncated = true;
        processedThrough = at - 1000;
        break;
      }
      const { classification, keyword } = classifyRecoveredBody(m.body, normalizeSmsPhone(String(m.from ?? "")) !== null);
      const { data, error } = await admin.rpc("tw4_inbound_recover", {
        p_run_id: options.runId,
        p_account_sid: target.account_sid,
        p_evidence: {
          sid: m.sid, account_sid: m.account_sid, direction: m.direction, to: m.to, messaging_service_sid: m.messaging_service_sid,
          num_segments: m.num_segments, num_media: m.num_media, date_created: m.date_created ?? m.date_sent, classification, keyword,
        },
      });
      if (error) {
        if (error.code === "TW023") throw new LeaseLost();
        if (PERMANENT.has(String(error.code))) {
          // the same answer every time: kept as unresolved evidence for a person, never blocking the checkpoint
          summary.refused += 1;
          const noted = await admin.rpc("tw4_inbound_note_unresolved", { p_run_id: options.runId, p_account_sid: target.account_sid, p_provider_sid: m.sid, p_code: String(error.code) });
          if (!noted.error) continue;
          if (noted.error.code === "TW023") throw new LeaseLost();
        }
        summary.errors += 1;
        processedThrough = at - 1000;   // transient: this text and everything after it is read again next run (idempotent per SID)
        break;
      }
      const d = (data ?? {}) as { outcome?: unknown; classification?: unknown; basis?: unknown; webhook_seen?: unknown };
      if (d.outcome === "recovered") {
        summary.recovered += 1;
        if (d.classification === "ordinary") summary.recoveredOrdinary += 1;
        if (d.basis === "incomplete") summary.incomplete += 1;
        if (d.basis === "keyword") summary.keywordsUnseen += 1;
      } else if (d.outcome === "already_recorded") summary.alreadyRecorded += 1;
      else if (d.outcome === "unrouted") summary.unrouted += 1;   // kept as unresolved evidence by the database; never attributed to a guess
      else if (d.outcome !== "skipped") {
        summary.errors += 1;
        processedThrough = at - 1000;
        break;
      }
    }
    if (processedThrough > checkpoint) await advance(target.account_sid, processedThrough);
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------
// the scheduled run
// ---------------------------------------------------------------------------------------------------------------

export type ScheduledReconcileOutcome =
  | { ran: false; reason: "busy" | "unavailable" }
  | { ran: true; runId: string; outbound: UsageReconcileSummary; escalated: number; inbound: InboundRecoverySummary | null; failed: boolean; summary: Record<string, number | boolean> };

/** Run budget: well inside the lease and the route's maxDuration. */
export const RECONCILE_BUDGET_MS = 45_000;
/** Twice the route's maxDuration: a run killed by the platform frees the lease for the next tick. */
export const RECONCILE_LEASE_SECONDS = 120;

const FAILURE_TEXT = /^(usage reconcile|inbound recovery): [a-z ]+( \([A-Za-z0-9_]+\))?$/;

export async function runScheduledUsageReconciliation(
  admin: Client,
  provider: (BilledSmsProvider & InboundMessageLister) | null,
  options: { runner: string; budgetMs?: number; now?: Date; limit?: number },
): Promise<ScheduledReconcileOutcome> {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? RECONCILE_BUDGET_MS);
  const begin = await admin.rpc("tw4_reconcile_run_begin", { p_job: "usage_reconcile", p_runner: options.runner, p_lease_seconds: RECONCILE_LEASE_SECONDS });
  if (begin.error) return { ran: false, reason: "unavailable" };
  const lease = (begin.data ?? {}) as { acquired?: unknown; run_id?: unknown };
  if (lease.acquired !== true || typeof lease.run_id !== "string") return { ran: false, reason: "busy" };
  const runId = lease.run_id;

  let outbound = emptyOutbound(provider !== null);
  let escalated = 0;
  let inbound: InboundRecoverySummary | null = null;
  let failure: string | null = null;
  try {
    outbound = await reconcileSmsUsage(admin, provider, { limit: options.limit, runId, deadline });
    const esc = await admin.rpc("tw4_usage_escalate", { p_run_id: runId, p_limit: 200 });
    if (esc.error) {
      if (esc.error.code === "TW023") throw new LeaseLost();
      throw new Error(`usage reconcile: escalate failed (${errorCode(esc.error)})`);
    }
    const n = (esc.data as { escalated?: unknown } | null)?.escalated;
    escalated = typeof n === "number" ? n : 0;
    if (provider !== null) inbound = await recoverInboundUsage(admin, provider, { runId, now: options.now, deadline });
  } catch (error) {
    // a fixed message only (never provider text): the run is recorded as failed; the next run starts over idempotently
    failure = error instanceof Error && FAILURE_TEXT.test(error.message) ? error.message : "usage reconcile: unexpected failure";
  }
  const summary: Record<string, number | boolean> = {
    released_unsent: outbound.releasedUnsent, due: outbound.due, settled: outbound.settled, charged_cents: outbound.chargedCents, pending: outbound.pending,
    review: outbound.review, retrying: outbound.retrying, errors: outbound.errors + (inbound?.errors ?? 0), evidence_read: outbound.evidenceRead,
    truncated: outbound.truncated || (inbound?.truncated ?? false), escalated,
    inbound_accounts: inbound?.accounts ?? 0, inbound_scanned: inbound?.scanned ?? 0, inbound_recovered: inbound?.recovered ?? 0,
    inbound_recovered_ordinary: inbound?.recoveredOrdinary ?? 0, inbound_already_recorded: inbound?.alreadyRecorded ?? 0, inbound_unrouted: inbound?.unrouted ?? 0,
    inbound_keywords_unseen: inbound?.keywordsUnseen ?? 0, inbound_incomplete: inbound?.incomplete ?? 0, inbound_refused: inbound?.refused ?? 0, inbound_stalled: inbound?.stalled ?? 0, duration_ms: Date.now() - started,
  };
  try {
    await admin.rpc("tw4_reconcile_run_finish", { p_run_id: runId, p_status: failure ? "failed" : "completed", p_summary: summary, p_error: failure });
  } catch {
    // an unfinished run's lease expires and the next begin closes it as failed
  }
  return { ran: true, runId, outbound, escalated, inbound, failed: failure !== null, summary };
}
