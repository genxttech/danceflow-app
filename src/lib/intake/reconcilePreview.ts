/**
 * New Student Intake (NSI) I2 -- reconciliation PREVIEW (read-only).
 *
 * Evaluates which future appointments WOULD create or attach an intake obligation, using the M6 SQL functions
 * `intake_reconcile_status` / `intake_reconcile_preview` (service_role only, STABLE, no writes). It never calls
 * `intake_ensure_request`, never writes, never queues an outbound delivery and exposes no persistent mode: Gate A
 * (platform retention approval) is closed, and persistent creation stays a later slice (NSI I4).
 *
 * Safety properties (spec 3.4): bounded per pass (studio cap, page size, page cap, per-studio time budget),
 * stateless and idempotent, per-studio failure isolation, entitlement fails closed (a failed lookup skips the
 * studio), and error reports carry an error class only (never a message, id list or personal data).
 */

export const RECONCILE_MODE = "preview_only" as const;

export const RECONCILE_OUTCOMES = [
  "studio_not_enabled",
  "appointment_not_found",
  "appointment_not_live",
  "imported_source",
  "studio_not_entitled",
  "type_not_selected",
  "appointment_started",
  "before_enablement",
  "settling",
  "erasure_barrier",
  "type_not_qualifying",
  "no_template",
  "no_published_version",
  "already_completed",
  "already_attached",
  "detached_from_request",
  "would_attach",
  "predates_reintake_floor",
  "would_create_reintake",
  "existing_student",
  "earlier_appointment_pending",
  "would_create",
] as const;

export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export type OutcomeClass =
  | "would_create"
  | "would_attach"
  | "already_satisfied"
  | "deferred"
  | "needs_configuration"
  | "not_applicable";

const OUTCOME_CLASS: Record<ReconcileOutcome, OutcomeClass> = {
  would_create: "would_create",
  would_create_reintake: "would_create",
  would_attach: "would_attach",
  already_attached: "already_satisfied",
  detached_from_request: "not_applicable",
  already_completed: "already_satisfied",
  settling: "deferred",
  earlier_appointment_pending: "deferred",
  no_template: "needs_configuration",
  no_published_version: "needs_configuration",
  studio_not_enabled: "not_applicable",
  appointment_not_found: "not_applicable",
  appointment_not_live: "not_applicable",
  imported_source: "not_applicable",
  studio_not_entitled: "not_applicable",
  type_not_selected: "not_applicable",
  appointment_started: "not_applicable",
  before_enablement: "not_applicable",
  erasure_barrier: "not_applicable",
  type_not_qualifying: "not_applicable",
  predates_reintake_floor: "not_applicable",
  existing_student: "not_applicable",
};

export function isReconcileOutcome(value: unknown): value is ReconcileOutcome {
  return typeof value === "string" && (RECONCILE_OUTCOMES as readonly string[]).includes(value);
}

export function classifyOutcome(outcome: ReconcileOutcome): OutcomeClass {
  return OUTCOME_CLASS[outcome];
}

export type PreviewRow = {
  appointmentId: string;
  clientId: string;
  apptCreatedAt: string;
  outcome: ReconcileOutcome;
  templateId: string | null;
  versionNumber: number | null;
};

export type StudioGateStatus = {
  enabled: boolean;
  enabledAt: string | null;
  gateAOpen: boolean;
  newObligationAllowed: boolean;
  defaultTemplateConfigured: boolean;
  assignmentCount: number;
};

export type PreviewCursor = { createdAt: string; id: string };

export interface ReconcilePreviewRpc {
  status(studioId: string): Promise<StudioGateStatus>;
  preview(studioId: string, limit: number, cursor: PreviewCursor | null): Promise<PreviewRow[]>;
}

export type ReconcileBudget = {
  maxStudios: number;
  pageSize: number;
  maxPagesPerStudio: number;
  studioTimeBudgetMs: number;
};

export const DEFAULT_RECONCILE_BUDGET: ReconcileBudget = {
  maxStudios: 50,
  pageSize: 100,
  maxPagesPerStudio: 5,
  studioTimeBudgetMs: 10_000,
};

export type StudioPreviewState =
  | "previewed"
  | "skipped_not_entitled"
  | "skipped_entitlement_unknown"
  | "skipped_not_enabled"
  | "failed";

export type PersistenceBlocker = "gate_a_closed" | "new_obligation_not_allowed";

export type StudioPreviewResult = {
  studioId: string;
  state: StudioPreviewState;
  examined: number;
  counts: Partial<Record<ReconcileOutcome, number>>;
  classes: Partial<Record<OutcomeClass, number>>;
  /** True when the page, page-count or time budget stopped the scan before the candidate list was exhausted. */
  truncated: boolean;
  /** Why a persistent run could not create obligations right now (empty = nothing blocks persistence). */
  persistenceBlockedBy: PersistenceBlocker[];
  /** Error class name only. */
  errorClass?: string;
};

export type ReconcilePreviewReport = {
  mode: typeof RECONCILE_MODE;
  studios: StudioPreviewResult[];
  /** Studios beyond `maxStudios`, not examined in this pass. */
  studiosNotExamined: number;
};

export type ReconcileDeps = {
  rpc: ReconcilePreviewRpc;
  /** Must resolve true only for a studio with an active rollout (pilot) grant for intake; this is not a billing entitlement; a throw is treated as "unknown" (skip). */
  hasEntitlement: (studioId: string) => Promise<boolean>;
  nowMs?: () => number;
};

function errorClassOf(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

export async function previewStudio(
  studioId: string,
  deps: ReconcileDeps,
  budget: ReconcileBudget = DEFAULT_RECONCILE_BUDGET,
): Promise<StudioPreviewResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const base: StudioPreviewResult = {
    studioId,
    state: "previewed",
    examined: 0,
    counts: {},
    classes: {},
    truncated: false,
    persistenceBlockedBy: [],
  };

  try {
    let entitled: boolean;
    try {
      entitled = await deps.hasEntitlement(studioId);
    } catch {
      return { ...base, state: "skipped_entitlement_unknown" };
    }
    if (!entitled) return { ...base, state: "skipped_not_entitled" };

    const status = await deps.rpc.status(studioId);
    if (!status.enabled || !status.enabledAt) return { ...base, state: "skipped_not_enabled" };
    if (!status.gateAOpen) base.persistenceBlockedBy.push("gate_a_closed");
    if (!status.newObligationAllowed) base.persistenceBlockedBy.push("new_obligation_not_allowed");

    const startedAt = nowMs();
    let cursor: PreviewCursor | null = null;
    for (let page = 0; page < budget.maxPagesPerStudio; page += 1) {
      if (nowMs() - startedAt >= budget.studioTimeBudgetMs) {
        base.truncated = true;
        break;
      }
      const rows = await deps.rpc.preview(studioId, budget.pageSize, cursor);
      for (const row of rows) {
        base.examined += 1;
        base.counts[row.outcome] = (base.counts[row.outcome] ?? 0) + 1;
        const cls = classifyOutcome(row.outcome);
        base.classes[cls] = (base.classes[cls] ?? 0) + 1;
      }
      if (rows.length < budget.pageSize) return base;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.apptCreatedAt, id: last.appointmentId };
      if (page === budget.maxPagesPerStudio - 1) base.truncated = true;
    }
    return base;
  } catch (error) {
    return { ...base, state: "failed", errorClass: errorClassOf(error) };
  }
}

/**
 * One bounded, read-only pass over the given studios (sequential: one slow studio cannot starve others beyond its
 * own time budget, and a failure never aborts the pass).
 */
export async function runReconcilePreview(
  studioIds: readonly string[],
  deps: ReconcileDeps,
  budget: ReconcileBudget = DEFAULT_RECONCILE_BUDGET,
): Promise<ReconcilePreviewReport> {
  const unique = Array.from(new Set(studioIds));
  const selected = unique.slice(0, Math.max(0, budget.maxStudios));
  const studios: StudioPreviewResult[] = [];
  for (const studioId of selected) {
    studios.push(await previewStudio(studioId, deps, budget));
  }
  return { mode: RECONCILE_MODE, studios, studiosNotExamined: unique.length - selected.length };
}

// ---- Supabase adapter (service-role client; RPC only) ------------------------------------------------------------

type RpcResult = PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
export type RpcCapableClient = { rpc: (fn: string, args: Record<string, unknown>) => RpcResult };

export class ReconcileRpcError extends Error {
  constructor(public readonly code: string) {
    super(`reconcile rpc failed (${code})`);
    this.name = "ReconcileRpcError";
  }
}

export function createSupabaseReconcileRpc(client: RpcCapableClient): ReconcilePreviewRpc {
  return {
    async status(studioId) {
      const { data, error } = await client.rpc("intake_reconcile_status", { p_studio_id: studioId });
      if (error) throw new ReconcileRpcError(error.code ?? "unknown");
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row) throw new ReconcileRpcError("empty_status");
      return {
        enabled: row.enabled === true,
        enabledAt: typeof row.enabled_at === "string" ? row.enabled_at : null,
        gateAOpen: row.gate_a_open === true,
        newObligationAllowed: row.new_obligation_allowed === true,
        defaultTemplateConfigured: row.default_template_configured === true,
        assignmentCount: typeof row.assignment_count === "number" ? row.assignment_count : 0,
      };
    },
    async preview(studioId, limit, cursor) {
      const { data, error } = await client.rpc("intake_reconcile_preview", {
        p_studio_id: studioId,
        p_limit: limit,
        p_after_created_at: cursor?.createdAt ?? null,
        p_after_id: cursor?.id ?? null,
      });
      if (error) throw new ReconcileRpcError(error.code ?? "unknown");
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      return rows.map((row) => {
        if (!isReconcileOutcome(row.outcome)) throw new ReconcileRpcError("unknown_outcome");
        return {
          appointmentId: String(row.appointment_id),
          clientId: String(row.client_id),
          apptCreatedAt: String(row.appt_created_at),
          outcome: row.outcome,
          templateId: typeof row.template_id === "string" ? row.template_id : null,
          versionNumber: typeof row.version_number === "number" ? row.version_number : null,
        };
      });
    },
  };
}
