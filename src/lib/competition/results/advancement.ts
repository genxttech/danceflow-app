/**
 * CF1 package B: pure application layer for callback-to-Final advancement.
 *
 * Nothing here decides anything. The database functions of A0..A6 are the authority; this module (1) repeats a call once when the
 * database says "try again" (deadlock 40P01, lock wait 55P03), (2) reads the jsonb the RPCs return into small typed models, and
 * (3) derives what the page offers. Every RPC repeated here takes a request id, so a repeat is idempotent.
 */
import { isRetryableText, resultErrorMessage } from "./messages";

export type RpcError = { message: string; code?: string | null };
export type RpcResult = { data: unknown; error: RpcError | null };
export type RpcCall = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

/** True for 40P01 (deadlock), 55P03 (lock not available), also the A0 mapping COMP_ADVANCEMENT_CONCURRENT_CHANGE and a statement timeout 57014. */
export function isRetryableError(error: RpcError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && /^(40P01|55P03|57014)$/.test(error.code)) return true;
  return isRetryableText(error.message ?? "") || /COMP_ADVANCEMENT_CONCURRENT_CHANGE/.test(error.message ?? "");
}

/**
 * Calls once, and once more if the first answer is retryable. The same arguments (and so the same request id) are sent, so a call
 * whose answer was lost is replayed by the database instead of applied twice. A second retryable answer is returned as is; the
 * message mapping then shows the "try again" copy.
 */
export async function callWithRetryOnce(call: RpcCall, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  const first = await call(name, args);
  if (!isRetryableError(first.error)) return first;
  return call(name, args);
}

/** Wraps an rpc so every call retries once. The CF1 actions use it because each of their RPCs carries a request id. */
export function withRetryOnce(call: RpcCall): RpcCall {
  return (name, args) => callWithRetryOnce(call, name, args);
}

/** The text shown for an RPC error: mapped copy, never the raw database message. */
export function errorText(error: RpcError | null | undefined): string {
  return resultErrorMessage(error ? `${error.code ?? ""} ${error.message}` : null);
}

// ----- advancement preview (competition_round_advancement_preview) -----

export type AdvancementState = "ready" | "blocked" | "applied" | "revoked" | "not_applicable";
export type AdvancementBlocker = { code: string; detail: unknown };
export type AdvancementPreview = {
  state: AdvancementState;
  blockers: AdvancementBlocker[];
  advancedEntries: number | null;
  targetRoundId: string | null;
  targetCapacity: number | null;
  heats: number | null;
  generation: number | null;
  carriedWithdrawals: number;
};

const STATES: readonly string[] = ["ready", "blocked", "applied", "revoked", "not_applicable"];

function count(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return null;
}

/** Defensive: an unreadable preview is `not_applicable`, so the page offers nothing rather than an apply button. */
export function parseAdvancementPreview(raw: unknown): AdvancementPreview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = typeof r.state === "string" && STATES.includes(r.state) ? (r.state as AdvancementState) : "not_applicable";
  const blockers = Array.isArray(r.blockers)
    ? r.blockers
        .filter((b): b is { code: string; detail?: unknown } => !!b && typeof (b as { code?: unknown }).code === "string")
        .map((b) => ({ code: b.code, detail: b.detail }))
    : [];
  return {
    state,
    blockers,
    advancedEntries: count(r.advanced_entries),
    targetRoundId: typeof r.target_round_id === "string" ? r.target_round_id : null,
    targetCapacity: typeof r.target_capacity === "number" ? r.target_capacity : null,
    heats: count(r.heats),
    generation: typeof r.generation === "number" ? r.generation : null,
    carriedWithdrawals: count(r.carried_withdrawals) ?? 0,
  };
}

export type AdvancementPanel = {
  show: boolean;
  /** The apply button is offered only for `ready`, to a manager, against an approved version. */
  canApply: boolean;
  headline: string;
  /** Mapped copy per blocker code. Per-entry payment reasons in `detail` are never shown. */
  blockerMessages: string[];
};

export function advancementPanel(preview: AdvancementPreview, input: { isManager: boolean; roundStatus: string }): AdvancementPanel {
  if (!input.isManager || preview.state === "not_applicable") return { show: false, canApply: false, headline: "", blockerMessages: [] };
  const seen = new Set<string>();
  const blockerMessages: string[] = [];
  for (const blocker of preview.blockers) {
    const message = resultErrorMessage(blocker.code);
    if (seen.has(message)) continue;
    seen.add(message);
    blockerMessages.push(message);
  }
  const couples = preview.advancedEntries === null ? "" : `${preview.advancedEntries} couple${preview.advancedEntries === 1 ? "" : "s"}`;
  switch (preview.state) {
    case "ready":
      return {
        show: true,
        canApply: input.roundStatus === "approved",
        headline: `Ready to advance${couples ? ` ${couples}` : ""} to the Final. This creates the Final's heat in the running order.`,
        blockerMessages,
      };
    case "blocked":
      return { show: true, canApply: false, headline: "Advancement is blocked.", blockerMessages };
    case "applied":
      return {
        show: true,
        canApply: false,
        headline: `Advanced${couples ? ` ${couples}` : ""} to the Final${preview.generation && preview.generation > 1 ? ` (generation ${preview.generation})` : ""}.${
          preview.carriedWithdrawals > 0 ? ` ${preview.carriedWithdrawals} withdrawn couple${preview.carriedWithdrawals === 1 ? " was" : "s were"} carried over without a place.` : ""
        }`,
        blockerMessages,
      };
    default:
      return {
        show: true,
        canApply: false,
        headline: "An earlier advancement was revoked by a correction. Recalculate and approve the corrected result, then advance again.",
        blockerMessages,
      };
  }
}

// ----- exclusions (A5: competition_round_exclusions) -----

export const EXCLUSION_REASON_KINDS = ["ineligible", "refunded", "other"] as const;
export type ExclusionReasonKind = (typeof EXCLUSION_REASON_KINDS)[number];
export type ExclusionRowKind = "exclude_requested" | "exclude_cosigned" | "reverse_requested" | "reverse_cosigned";

export type ExclusionRow = {
  id: string;
  seq: number;
  kind: ExclusionRowKind;
  entryId: string;
  reasonKind: ExclusionReasonKind;
  reason: string;
  actor: string;
  actorRole: string | null;
  at: string;
  decisionId: string | null;
  reversesId: string | null;
  completed: boolean;
};

const ROW_KINDS: readonly string[] = ["exclude_requested", "exclude_cosigned", "reverse_requested", "reverse_cosigned"];

export function parseExclusionRows(raw: unknown): ExclusionRow[] {
  const rows = (raw as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  const out: ExclusionRow[] = [];
  for (const item of rows) {
    const r = item as Record<string, unknown> | null;
    if (!r || typeof r.id !== "string" || typeof r.entry_id !== "string" || typeof r.kind !== "string" || !ROW_KINDS.includes(r.kind)) continue;
    if (typeof r.reason_kind !== "string" || !(EXCLUSION_REASON_KINDS as readonly string[]).includes(r.reason_kind)) continue;
    out.push({
      id: r.id,
      seq: typeof r.seq === "number" ? r.seq : 0,
      kind: r.kind as ExclusionRowKind,
      entryId: r.entry_id,
      reasonKind: r.reason_kind as ExclusionReasonKind,
      reason: typeof r.reason === "string" ? r.reason : "",
      actor: typeof r.actor === "string" ? r.actor : "",
      actorRole: typeof r.actor_role === "string" ? r.actor_role : null,
      at: typeof r.at === "string" ? r.at : "",
      decisionId: typeof r.decision_id === "string" ? r.decision_id : null,
      reversesId: typeof r.reverses_id === "string" ? r.reverses_id : null,
      completed: r.completed === true,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Requests with no co-sign yet. A request stays listed even if stale: the database refuses its co-sign with COMP_EXCLUSION_REQUEST_STALE. */
export function pendingExclusionRequests(rows: readonly ExclusionRow[]): ExclusionRow[] {
  return rows.filter((row) => (row.kind === "exclude_requested" || row.kind === "reverse_requested") && !row.completed);
}

/** A pending request can be co-signed by someone other than the requester; the database re-checks everything. */
export function canCosign(row: ExclusionRow, viewerId: string): boolean {
  return row.actor !== viewerId && !row.completed;
}

/** Entries whose latest co-signed decision is an exclusion (`exclude_cosigned` with no later `reverse_cosigned`). */
export function effectivelyExcludedEntryIds(rows: readonly ExclusionRow[]): Set<string> {
  const latest = new Map<string, ExclusionRow>();
  for (const row of rows) {
    if (row.kind !== "exclude_cosigned" && row.kind !== "reverse_cosigned") continue;
    const seen = latest.get(row.entryId);
    if (!seen || row.seq > seen.seq) latest.set(row.entryId, row);
  }
  return new Set([...latest].filter(([, row]) => row.kind === "exclude_cosigned").map(([entryId]) => entryId));
}

/** Exclusion is offered only in the window A5 allows, to a manager. Reversal is offered only for an excluded couple. */
export function exclusionWindowOpen(roundStatus: string): boolean {
  return roundStatus === "active" || roundStatus === "ballots_locked";
}

export function exclusionReasonLabel(kind: ExclusionReasonKind): string {
  return kind === "ineligible" ? "Ineligible" : kind === "refunded" ? "Refunded" : "Other";
}

export function validateExclusionReason(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim();
  if (value.length < 3 || value.length > 500) return { ok: false, message: resultErrorMessage("COMP_EXCLUSION_REASON_REQUIRED") };
  return { ok: true, value };
}

export function parseExclusionReasonKind(raw: string): ExclusionReasonKind | null {
  return (EXCLUSION_REASON_KINDS as readonly string[]).includes(raw) ? (raw as ExclusionReasonKind) : null;
}

// ----- Final withdrawals (A6: competition_final_withdrawal_state) -----

export type WithdrawalState = {
  withdrawn: Array<{ entryId: string; withdrawalId: string }>;
  pending: Array<{ requestId: string; kind: "withdraw" | "reinstate"; entryId: string; requestedBy: string; reason: string; at: string; stale: boolean }>;
  cancelled: CancelledWithdrawal[];
};

export function parseWithdrawalState(raw: unknown): WithdrawalState {
  const r = (raw ?? {}) as { withdrawn?: unknown; pending?: unknown };
  const withdrawn = Array.isArray(r.withdrawn)
    ? r.withdrawn
        .filter((w): w is { entry_id: string; withdrawal_id: string } => !!w && typeof (w as { entry_id?: unknown }).entry_id === "string")
        .map((w) => ({ entryId: w.entry_id, withdrawalId: String(w.withdrawal_id ?? "") }))
    : [];
  const pending = Array.isArray(r.pending)
    ? r.pending
        .filter((p): p is Record<string, unknown> => !!p && typeof (p as { request_id?: unknown }).request_id === "string" && typeof (p as { entry_id?: unknown }).entry_id === "string")
        .filter((p) => p.kind === "withdraw" || p.kind === "reinstate")
        .map((p) => ({
          requestId: String(p.request_id),
          kind: p.kind as "withdraw" | "reinstate",
          entryId: String(p.entry_id),
          requestedBy: typeof p.requested_by === "string" ? p.requested_by : "",
          reason: typeof p.reason === "string" ? p.reason : "",
          at: typeof p.at === "string" ? p.at : "",
          stale: p.stale === true,
        }))
    : [];
  return { withdrawn, pending, cancelled: parseCancelledWithdrawals(raw) };
}

/** Client-side hint only; `_cf1_reason_is_substantive` is the authority (20-500 chars, 4 words, 3 distinct). */
export function withdrawalReasonLooksSubstantive(raw: string): boolean {
  const value = raw.trim();
  if (value.length < 20 || value.length > 500) return false;
  const words = value.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 4 && new Set(words).size >= 3;
}

// ----- A6 D-A / D-B: stale flag, cancelled requests, and the "no approved result" window -----

export type CancelledWithdrawal = { requestId: string; kind: "withdraw" | "reinstate"; entryId: string; cancelledBy: string; byRequester: boolean; reason: string; at: string };

export function parseCancelledWithdrawals(raw: unknown): CancelledWithdrawal[] {
  const list = (raw as { cancelled?: unknown } | null | undefined)?.cancelled;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof (c as { request_id?: unknown }).request_id === "string" && typeof (c as { entry_id?: unknown }).entry_id === "string")
    .filter((c) => c.kind === "withdraw" || c.kind === "reinstate")
    .map((c) => ({
      requestId: String(c.request_id),
      kind: c.kind as "withdraw" | "reinstate",
      entryId: String(c.entry_id),
      cancelledBy: typeof c.cancelled_by === "string" ? c.cancelled_by : "",
      byRequester: c.by_requester === true,
      reason: typeof c.reason === "string" ? c.reason : "",
      at: typeof c.at === "string" ? c.at : "",
    }));
}

/** Pending request ids the state reader flags `stale` (their co-sign would be refused). */
export function staleRequestIds(raw: unknown): Set<string> {
  const pending = (raw as { pending?: unknown } | null | undefined)?.pending;
  if (!Array.isArray(pending)) return new Set();
  return new Set(pending.filter((p) => p && (p as { stale?: unknown }).stale === true && typeof (p as { request_id?: unknown }).request_id === "string").map((p) => String((p as { request_id: string }).request_id)));
}

/**
 * D-A mirror (the database is the authority, `_cf1_a6_roster_blocked`): no new withdrawal or reinstatement while the Final has no active
 * advancement and its callback round has no approved result. `sourceStatus` is the callback round's status.
 */
export function withdrawalControlsBlocked(input: { advancementState: AdvancementState; sourceStatus: string | null }): boolean {
  if (input.advancementState === "applied") return false;
  return !(input.sourceStatus && ["approved", "published", "complete"].includes(input.sourceStatus));
}
