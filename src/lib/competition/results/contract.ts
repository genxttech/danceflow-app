/**
 * K0: scoring -> results contract (machine-readable mirror of docs/competition/scoring-results-contract.md).
 *
 * Fixes the round result state machine, the single writer of each transition, the engine input/output boundary,
 * the reader matrix that RLS and read RPCs must match, and the audit event kinds. No scoring algorithm lives here:
 * engines are specified in docs/competition/engine-spec-*.md and implemented under src/lib/competition/scoring.
 */

// -----------------------------------------------------------------------------------------------------
// Round result states (event_competition_rounds.status check constraint, 20260620 foundation)
// -----------------------------------------------------------------------------------------------------

export const ROUND_STATES = [
  "draft",
  "scheduled",
  "active",
  "ballots_locked",
  "calculated",
  "approved",
  "published",
  "complete",
  "cancelled",
] as const;

export type RoundState = (typeof ROUND_STATES)[number];

export type ResultActor = "manager" | "chair" | "scorer";

export type RoundTransition = {
  from: RoundState;
  to: RoundState;
  /** The only RPC allowed to make this transition. */
  rpc: string;
  /** Slice that owns the RPC. */
  owner: "E2" | "F2" | "F3" | "O1";
  actors: ResultActor[];
  reasonRequired: boolean;
};

const NON_TERMINAL: RoundState[] = ["draft", "scheduled", "active", "ballots_locked", "calculated", "approved"];

export const ROUND_TRANSITIONS: RoundTransition[] = [
  // No SQL writes round status before K0 (verified at 973f36da); O1 owns the first transition.
  { from: "draft", to: "scheduled", rpc: "schedule_competition_round", owner: "O1", actors: ["manager"], reasonRequired: false },
  { from: "scheduled", to: "active", rpc: "start_competition_round", owner: "O1", actors: ["manager"], reasonRequired: false },
  { from: "active", to: "ballots_locked", rpc: "lock_competition_round_ballots", owner: "E2", actors: ["manager", "chair"], reasonRequired: false },
  { from: "ballots_locked", to: "active", rpc: "reopen_competition_round_ballots", owner: "E2", actors: ["manager"], reasonRequired: true },
  { from: "ballots_locked", to: "calculated", rpc: "calculate_competition_round", owner: "F2", actors: ["manager", "scorer"], reasonRequired: false },
  { from: "calculated", to: "approved", rpc: "approve_competition_round_result", owner: "F2", actors: ["manager"], reasonRequired: false },
  { from: "approved", to: "published", rpc: "publish_competition_round_result", owner: "F3", actors: ["manager"], reasonRequired: false },
  { from: "published", to: "complete", rpc: "complete_competition_round", owner: "F2", actors: ["manager"], reasonRequired: false },
  // Corrections re-enter the lifecycle; a published result stays visible until superseded or withdrawn.
  { from: "calculated", to: "ballots_locked", rpc: "open_competition_round_correction", owner: "F2", actors: ["manager"], reasonRequired: true },
  { from: "approved", to: "ballots_locked", rpc: "open_competition_round_correction", owner: "F2", actors: ["manager"], reasonRequired: true },
  { from: "published", to: "ballots_locked", rpc: "open_competition_round_correction", owner: "F2", actors: ["manager"], reasonRequired: true },
  ...NON_TERMINAL.map(
    (from): RoundTransition => ({ from, to: "cancelled", rpc: "cancel_competition_round", owner: "O1", actors: ["manager"], reasonRequired: true }),
  ),
];

export function findTransition(from: RoundState, to: RoundState): RoundTransition | null {
  return ROUND_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

/** Second-person approval (owner D3): the calculator may approve only with an audited override reason. */
export function approvalAllowed(input: {
  calculatedBy: string;
  approverId: string;
  overrideReason?: string | null;
  inputHashMatchesCurrentBallots: boolean;
}): { ok: true; override: boolean } | { ok: false; code: "COMP_RESULT_STALE" | "COMP_SECOND_APPROVER_REQUIRED" } {
  if (!input.inputHashMatchesCurrentBallots) return { ok: false, code: "COMP_RESULT_STALE" };
  if (input.calculatedBy !== input.approverId) return { ok: true, override: false };
  if (input.overrideReason && input.overrideReason.trim().length > 0) return { ok: true, override: true };
  return { ok: false, code: "COMP_SECOND_APPROVER_REQUIRED" };
}

// -----------------------------------------------------------------------------------------------------
// Engine boundary
// -----------------------------------------------------------------------------------------------------

/** Studio v1 engine keys (event_competition_rounds.scoring_method, 10B). */
export const V1_ENGINE_KEYS = ["ordinal_majority", "proficiency_rating", "callback_tally"] as const;
export type V1EngineKey = (typeof V1_ENGINE_KEYS)[number];

export type EngineMark = { officialId: string; entryId: string; role?: "leader" | "follower" | null; value: unknown };

export type EngineInput = {
  engineKey: string;
  engineVersion: string;
  profile: { key: string; version: number };
  round: {
    id: string;
    roundType: string;
    targetAdvancementCount: number | null;
    advancementMethod: string | null;
  };
  markScheme: unknown;
  tieBreakChain: string[];
  entries: Array<{ entryId: string }>;
  judges: Array<{ officialId: string; letter: string }>;
  marks: EngineMark[];
};

export type EngineResultRow = {
  entryId: string;
  placement?: number | null;
  tieGroup?: string | null;
  advanced?: boolean | null;
  ratingBand?: string | null;
  output?: Record<string, unknown>;
};

export type EngineOutput = { rows: EngineResultRow[]; trace: unknown[]; warnings: string[] };

export type EngineFailureCode = "COMP_ENGINE_NOT_AVAILABLE" | "COMP_ENGINE_UNSPECIFIED_CASE" | "COMP_ENGINE_INVALID_INPUT";

/** An engine is callable only for a v1 key whose K1 spec the owner has approved. */
export function engineAvailable(engineKey: string, approvedSpecs: ReadonlySet<string>): boolean {
  return (V1_ENGINE_KEYS as readonly string[]).includes(engineKey) && approvedSpecs.has(engineKey);
}

/**
 * Canonical serialization that is hashed (input_hash, trace_hash). Object keys sorted; entries, judges and marks
 * sorted by their identities so the same ballots always hash the same regardless of read order.
 */
export function canonicalEngineInput(input: EngineInput): string {
  const roleKey = (r: EngineMark["role"]) => r ?? "";
  const normalized: EngineInput = {
    ...input,
    entries: [...input.entries].sort((a, b) => cmp(a.entryId, b.entryId)),
    judges: [...input.judges].sort((a, b) => cmp(a.officialId, b.officialId)),
    marks: [...input.marks].sort(
      (a, b) => cmp(a.officialId, b.officialId) || cmp(a.entryId, b.entryId) || cmp(roleKey(a.role), roleKey(b.role)),
    ),
  };
  return canonicalJson(normalized);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(cmp);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -----------------------------------------------------------------------------------------------------
// Reader matrix (RLS and F3 read RPCs must match exactly)
// -----------------------------------------------------------------------------------------------------

export type ResultReader = "manager" | "assigned_judge" | "scorer" | "entrant" | "public" | "other_tenant";

export type ResultArtifact =
  | "ballots"
  | "unpublished_result"
  | "published_current"
  | "published_superseded_or_withdrawn";

/** "own" = only the reader's own ballots or own entries (plus placements of the same round for entrants). */
export type ReadAccess = "all" | "own" | "if_public" | "none";

export const RESULT_READER_MATRIX: Record<ResultReader, Record<ResultArtifact, ReadAccess>> = {
  manager: { ballots: "all", unpublished_result: "all", published_current: "all", published_superseded_or_withdrawn: "all" },
  // A judge who is also an entrant reads their entries through the entrant rule.
  assigned_judge: { ballots: "own", unpublished_result: "none", published_current: "if_public", published_superseded_or_withdrawn: "none" },
  scorer: { ballots: "all", unpublished_result: "all", published_current: "all", published_superseded_or_withdrawn: "none" },
  entrant: { ballots: "none", unpublished_result: "none", published_current: "own", published_superseded_or_withdrawn: "none" },
  public: { ballots: "none", unpublished_result: "none", published_current: "if_public", published_superseded_or_withdrawn: "none" },
  other_tenant: { ballots: "none", unpublished_result: "none", published_current: "if_public", published_superseded_or_withdrawn: "none" },
};

export function readAccess(reader: ResultReader, artifact: ResultArtifact): ReadAccess {
  return RESULT_READER_MATRIX[reader][artifact];
}

// -----------------------------------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------------------------------

/** Fixed audit kinds for event_competition_result_events; callers never supply free-text kinds. */
export const RESULT_EVENT_KINDS = [
  "round_state_changed",
  "ballot_submitted",
  "ballot_corrected",
  "judge_absence_recorded",
  "result_calculated",
  "result_approved",
  "result_approval_override",
  "result_published",
  "result_superseded",
  "result_withdrawn",
  "advancement_applied",
] as const;

export type ResultEventKind = (typeof RESULT_EVENT_KINDS)[number];

/** Error codes the result RPCs raise (shared so app copy and SQL tests agree). */
export const RESULT_ERROR_CODES = [
  "COMP_RESULT_INVALID_TRANSITION",
  "COMP_RESULT_REASON_REQUIRED",
  "COMP_RESULT_STALE",
  "COMP_SECOND_APPROVER_REQUIRED",
  "COMP_BALLOTS_INCOMPLETE",
  "COMP_BALLOT_IMMUTABLE",
  "COMP_JUDGE_NOT_ASSIGNED",
  "COMP_ENGINE_NOT_AVAILABLE",
  "COMP_ENGINE_UNSPECIFIED_CASE",
  "COMP_ENGINE_INVALID_INPUT",
  "COMP_ADVANCEMENT_NOT_APPROVED",
  "COMP_PUBLICATION_REQUIRES_APPROVAL",
] as const;

export type ResultErrorCode = (typeof RESULT_ERROR_CODES)[number];
