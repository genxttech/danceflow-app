import type { SupabaseClient } from "@supabase/supabase-js";
import { ARIA_C2_LIFECYCLE_HANDLERS } from "./lifecycleHandlers";
import {
  ariaPackageHasReplacementCoverage,
  type AriaPackageWarningItem,
  type AriaPackageWarningRow,
} from "@/app/app/automations/ariaPackageWarnings";

/*
  Cleanup PR C: ARIA condition reconciliation.

  Stored ARIA actions (automation_actions) are created by candidate generation, but generation never closed a row when
  the underlying business condition went away, so the Operations Center and the Morning Briefing kept showing stale
  work (e.g. "package renewal" for a client who had already bought a new package).

  This module re-checks the AUTHORITATIVE DanceFlow record behind each open action of an objectively verifiable rule and
  completes the action only when that record definitively shows the condition that created it no longer holds.

  Rules:
  - Never infer resolution from a candidate missing out of a (bounded) generation batch: each reconciler loads the exact
    related rows by id, scoped to the studio.
  - Missing / unreadable / unknown source state is ambiguous: the action stays open.
  - Only actions that have not started an external effect are eligible (suggested, drafted, approved, snoozed).
    `queued` / `failed` / `awaiting_outcome` belong to the delivery + outcome lifecycle: a queued email cannot be safely
    recalled (outbound_deliveries has no claimed/sending state and delivery sync rewrites the action on send).
  - Terminal rows (completed, dismissed, skipped) are never touched.
  - The status update is guarded on the status that was read, so concurrent runs converge and only the run that actually
    transitioned a row records the completion event.
*/

export const ARIA_CONDITION_RECONCILIATION_SOURCE =
  "aria_condition_reconciliation";

/** Open statuses with no external effect in flight. */
export const ARIA_RECONCILABLE_STATUSES = [
  "suggested",
  "drafted",
  "approved",
  "snoozed",
] as const;

export const ARIA_RECONCILED_RULE_KEYS = [
  "aria_low_package_balance",
  "aria_intro_no_purchase",
  "aria_payment_exception",
  "aria_membership_past_due",
  "aria_booking_request_aging",
  "aria_external_payment_missing",
  // legacy "Evaluate now" package alert (studio-configurable threshold); same incident model as the ARIA rule
  "low_package_balance",
] as const;

export type AriaReconciledRuleKey = (typeof ARIA_RECONCILED_RULE_KEYS)[number];

// Generic client so the cron (service role) and in-app (RLS) clients can both be used; every query is studio-scoped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export type ReconcilableAriaAction = {
  id: string;
  rule_key: string;
  related_table: string | null;
  related_id: string | null;
  client_id: string | null;
  status: string;
};

export type AriaActionResolution = {
  actionId: string;
  /** Machine-readable reason, stored in event metadata. */
  reason: string;
  /** Staff-facing explanation, stored as review_note / event note. */
  note: string;
  evidence: Record<string, unknown>;
  /**
   * Cleanup PR C2: complete (condition definitively false; default), expire (actionable window ended, stored as the
   * existing `skipped` status) or refresh (stays open for a human; stored wording superseded with current facts).
   */
  kind?: "complete" | "expire" | "refresh";
  /** refresh only: the current-fact body to store. */
  body?: string;
};

type ReconcilerContext = {
  supabase: AnySupabaseClient;
  studioId: string;
  now: Date;
  actions: ReconcilableAriaAction[];
};

type AriaConditionReconciler = {
  relatedTable: string;
  resolve: (context: ReconcilerContext) => Promise<AriaActionResolution[]>;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shared generation conditions (the generator and the reconciler must agree, or a resolved action would be re-created) */
/* ------------------------------------------------------------------------------------------------------------------ */

export const ARIA_LOW_PACKAGE_REMAINING_THRESHOLD = 2;
export const ARIA_PACKAGE_EXPIRING_SOON_DAYS = 14;

function finiteOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Non-unlimited items at or below the proactive renewal threshold (same rule the ARIA generator uses). */
export function ariaLowPackageItems<T extends AriaPackageWarningItem>(
  items: readonly T[] | null | undefined,
): T[] {
  return (items ?? []).filter((item) => {
    if (item.is_unlimited) return false;
    const remaining = finiteOr(
      item.quantity_remaining,
      Number.POSITIVE_INFINITY,
    );
    return (
      Number.isFinite(remaining) &&
      remaining <= ARIA_LOW_PACKAGE_REMAINING_THRESHOLD
    );
  });
}

export function ariaPackageExpiringSoon(
  expirationDate: string | null | undefined,
  now: Date,
) {
  if (!expirationDate) return false;
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + ARIA_PACKAGE_EXPIRING_SOON_DAYS);
  return new Date(`${expirationDate}T00:00:00`) <= horizon;
}

/**
 * Does this ACTIVE package still warrant an `aria_low_package_balance` action? True when it has low items that are not
 * covered by another active package of the same client for the same usage type, or (with no low items) when it expires
 * within the window.
 */
export function ariaLowPackageConditionHolds(params: {
  targetPackage: AriaPackageWarningRow;
  clientActivePackages: AriaPackageWarningRow[];
  now: Date;
}) {
  const { targetPackage, clientActivePackages, now } = params;
  const lowItems = ariaLowPackageItems(targetPackage.client_package_items);
  if (lowItems.length > 0) {
    return !ariaPackageHasReplacementCoverage({
      targetPackage,
      allPackages: clientActivePackages,
      lowItems,
    });
  }
  return ariaPackageExpiringSoon(targetPackage.expiration_date, now);
}

export const LEGACY_LOW_PACKAGE_DEFAULT_THRESHOLD = 2;

/** Legacy low_package_balance item rule: non-unlimited items with a known balance at or below the studio threshold. */
export function legacyLowPackageItems<T extends AriaPackageWarningItem>(
  items: readonly T[] | null | undefined,
  threshold: number,
): T[] {
  return (items ?? []).filter((item) => {
    if (item.is_unlimited) return false;
    if (
      item.quantity_remaining === null ||
      item.quantity_remaining === undefined
    )
      return false;
    return Number(item.quantity_remaining) <= threshold;
  });
}

export function legacyLowPackageConditionHolds(params: {
  targetPackage: AriaPackageWarningRow;
  clientActivePackages: AriaPackageWarningRow[];
  threshold: number;
}) {
  const lowItems = legacyLowPackageItems(
    params.targetPackage.client_package_items,
    params.threshold,
  );
  if (lowItems.length === 0) return false;
  return !ariaPackageHasReplacementCoverage({
    targetPackage: params.targetPackage,
    allPackages: params.clientActivePackages,
    lowItems,
  });
}

export const ARIA_PAYMENT_EXCEPTION_STATUSES = ["pending", "failed"] as const;
const PAYMENT_COMPLETED_STATUSES = [
  "paid",
  "processed",
  "complete",
  "completed",
];
const PAYMENT_CLOSED_STATUSES = ["refunded", "voided"];

export const ARIA_MEMBERSHIP_PAST_DUE_STATUSES = [
  "past_due",
  "unpaid",
] as const;
const MEMBERSHIP_KNOWN_STATUSES = [
  "active",
  "paused",
  "cancelled",
  "expired",
  "pending",
  "past_due",
  "unpaid",
];
/** Membership statuses that count as "has a membership" for intro conversion (as loaded by the generator). */
export const ARIA_INTRO_MEMBERSHIP_STATUSES = [
  "active",
  "pending",
  "past_due",
  "unpaid",
] as const;

const BOOKING_REQUEST_CLOSED_STATUSES = ["approved", "declined", "cancelled"];

export const ARIA_EXTERNAL_PAYMENT_OPEN_STATUSES = [
  "unpaid",
  "partial",
  "pending",
] as const;
const APPOINTMENT_SETTLED_PAYMENT_STATUSES = ["paid", "waived", "refunded"];
const APPOINTMENT_NOT_BILLABLE_STATUSES = ["cancelled", "canceled", "no_show"];

function normalized(value: string | null | undefined) {
  return `${value ?? ""}`.trim().toLowerCase().replaceAll(" ", "_");
}

function relatedIds(actions: ReconcilableAriaAction[]) {
  return Array.from(
    new Set(
      actions
        .map((action) => action.related_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reconcilers                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

type PackageRow = {
  id: string;
  client_id: string | null;
  active: boolean | null;
  expiration_date: string | null;
};

type PackageItemRow = AriaPackageWarningItem & { client_package_id: string };

function packageReconciler(
  conditionHolds: (params: {
    targetPackage: AriaPackageWarningRow;
    clientActivePackages: AriaPackageWarningRow[];
    now: Date;
    threshold: number;
  }) => boolean,
  lowItemsOf: (
    row: AriaPackageWarningRow,
    threshold: number,
  ) => AriaPackageWarningItem[],
  loadThreshold?: (
    supabase: AnySupabaseClient,
    studioId: string,
  ) => Promise<number | null>,
): AriaConditionReconciler {
  return {
    relatedTable: "client_packages",
    async resolve({ supabase, studioId, now, actions }) {
      const ids = relatedIds(actions);
      if (ids.length === 0) return [];
      const threshold = loadThreshold
        ? await loadThreshold(supabase, studioId)
        : ARIA_LOW_PACKAGE_REMAINING_THRESHOLD;
      if (threshold === null) return []; // configuration unreadable: ambiguous

      const { data: targets, error } = await supabase
        .from("client_packages")
        .select("id, client_id, active, expiration_date")
        .eq("studio_id", studioId)
        .in("id", ids);
      if (error) throw new Error(error.message);

      const targetById = new Map(
        ((targets ?? []) as PackageRow[]).map((row) => [row.id, row]),
      );
      const clientIds = Array.from(
        new Set(
          ((targets ?? []) as PackageRow[])
            .map((row) => row.client_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      // Every active package of the affected clients (replacement coverage), plus their items.
      const { data: clientPackages, error: clientPackagesError } =
        clientIds.length
          ? await supabase
              .from("client_packages")
              .select("id, client_id, active, expiration_date")
              .eq("studio_id", studioId)
              .eq("active", true)
              .in("client_id", clientIds)
          : { data: [], error: null };
      if (clientPackagesError) throw new Error(clientPackagesError.message);

      const packageIds = Array.from(
        new Set([
          ...ids,
          ...((clientPackages ?? []) as PackageRow[]).map((row) => row.id),
        ]),
      );
      const { data: items, error: itemsError } = await supabase
        .from("client_package_items")
        .select(
          "client_package_id, usage_type, quantity_remaining, is_unlimited",
        )
        .eq("studio_id", studioId)
        .in("client_package_id", packageIds);
      if (itemsError) throw new Error(itemsError.message);

      const itemsByPackage = new Map<string, AriaPackageWarningItem[]>();
      for (const item of (items ?? []) as PackageItemRow[]) {
        const list = itemsByPackage.get(item.client_package_id) ?? [];
        list.push({
          usage_type: item.usage_type,
          quantity_remaining: item.quantity_remaining,
          is_unlimited: item.is_unlimited,
        });
        itemsByPackage.set(item.client_package_id, list);
      }
      const toWarningRow = (row: PackageRow): AriaPackageWarningRow => ({
        id: row.id,
        client_id: row.client_id,
        expiration_date: row.expiration_date,
        client_package_items: itemsByPackage.get(row.id) ?? [],
      });
      const activeByClient = new Map<string, AriaPackageWarningRow[]>();
      for (const row of (clientPackages ?? []) as PackageRow[]) {
        if (!row.client_id) continue;
        const list = activeByClient.get(row.client_id) ?? [];
        list.push(toWarningRow(row));
        activeByClient.set(row.client_id, list);
      }

      const resolutions: AriaActionResolution[] = [];
      for (const action of actions) {
        const target = action.related_id
          ? targetById.get(action.related_id)
          : undefined;
        if (!target) continue; // not visible / not found: ambiguous

        if (target.active === false) {
          resolutions.push({
            actionId: action.id,
            reason: "package_no_longer_active",
            note: "Completed automatically: this package is no longer active, so the renewal follow-up no longer applies.",
            evidence: { package_active: false },
          });
          continue;
        }
        if (target.active !== true || !target.client_id) continue; // unknown state: ambiguous

        const targetRow = toWarningRow(target);
        const holds = conditionHolds({
          targetPackage: targetRow,
          clientActivePackages: activeByClient.get(target.client_id) ?? [
            targetRow,
          ],
          now,
          threshold,
        });
        if (holds) continue;

        const lowItems = lowItemsOf(targetRow, threshold);
        resolutions.push(
          lowItems.length > 0
            ? {
                actionId: action.id,
                reason: "package_replacement_coverage",
                note: "Completed automatically: the client now has another active package covering this balance.",
                evidence: {
                  low_item_count: lowItems.length,
                  replacement_coverage: true,
                },
              }
            : {
                actionId: action.id,
                reason: "package_balance_restored",
                note: "Completed automatically: this package's balance and expiration no longer meet the renewal alert condition.",
                evidence: { low_item_count: 0, expiring_soon: false },
              },
        );
      }
      return resolutions;
    },
  };
}

const lowPackageReconciler = packageReconciler(
  ({ targetPackage, clientActivePackages, now }) =>
    ariaLowPackageConditionHolds({ targetPackage, clientActivePackages, now }),
  (row) => ariaLowPackageItems(row.client_package_items),
);

const legacyLowPackageReconciler = packageReconciler(
  ({ targetPackage, clientActivePackages, threshold }) =>
    legacyLowPackageConditionHolds({
      targetPackage,
      clientActivePackages,
      threshold,
    }),
  (row, threshold) =>
    legacyLowPackageItems(row.client_package_items, threshold),
  async (supabase, studioId) => {
    const { data, error } = await supabase
      .from("automation_rules")
      .select("trigger_config")
      .eq("studio_id", studioId)
      .eq("rule_key", "low_package_balance")
      .maybeSingle();
    if (error) return null;
    const configured = Number(
      (data as { trigger_config?: { threshold?: unknown } } | null)
        ?.trigger_config?.threshold,
    );
    return Number.isFinite(configured)
      ? configured
      : LEGACY_LOW_PACKAGE_DEFAULT_THRESHOLD;
  },
);

const introNoPurchaseReconciler: AriaConditionReconciler = {
  relatedTable: "clients",
  async resolve({ supabase, studioId, actions }) {
    // The action is keyed to the client (related_id); never matched by email.
    const clientIds = relatedIds(actions);
    if (clientIds.length === 0) return [];

    const [
      { data: packages, error: packagesError },
      { data: memberships, error: membershipsError },
    ] = await Promise.all([
      supabase
        .from("client_packages")
        .select("id, client_id")
        .eq("studio_id", studioId)
        .eq("active", true)
        .in("client_id", clientIds),
      supabase
        .from("client_memberships")
        .select("id, client_id, status")
        .eq("studio_id", studioId)
        .in("status", [...ARIA_INTRO_MEMBERSHIP_STATUSES])
        .in("client_id", clientIds),
    ]);
    if (packagesError) throw new Error(packagesError.message);
    if (membershipsError) throw new Error(membershipsError.message);

    const packageClients = new Set(
      ((packages ?? []) as Array<{ client_id: string | null }>)
        .map((row) => row.client_id)
        .filter(Boolean),
    );
    const membershipClients = new Set(
      ((memberships ?? []) as Array<{ client_id: string | null }>)
        .map((row) => row.client_id)
        .filter(Boolean),
    );

    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const clientId = action.related_id;
      if (!clientId) continue;
      if (packageClients.has(clientId)) {
        resolutions.push({
          actionId: action.id,
          reason: "intro_client_has_active_package",
          note: "Completed automatically: this client now has an active package.",
          evidence: { active_package: true },
        });
      } else if (membershipClients.has(clientId)) {
        resolutions.push({
          actionId: action.id,
          reason: "intro_client_has_membership",
          note: "Completed automatically: this client now has a membership.",
          evidence: { membership: true },
        });
      }
    }
    return resolutions;
  },
};

const paymentExceptionReconciler: AriaConditionReconciler = {
  relatedTable: "payments",
  async resolve({ supabase, studioId, actions }) {
    const ids = relatedIds(actions);
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from("payments")
      .select("id, status")
      .eq("studio_id", studioId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    const statusById = new Map(
      ((data ?? []) as Array<{ id: string; status: string | null }>).map(
        (row) => [row.id, normalized(row.status)],
      ),
    );

    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const status = action.related_id
        ? statusById.get(action.related_id)
        : undefined;
      if (!status) continue;
      if (PAYMENT_COMPLETED_STATUSES.includes(status)) {
        resolutions.push({
          actionId: action.id,
          reason: "payment_completed",
          note: "Completed automatically: this payment is now recorded as paid.",
          evidence: { payment_status: status },
        });
      } else if (PAYMENT_CLOSED_STATUSES.includes(status)) {
        resolutions.push({
          actionId: action.id,
          reason: "payment_closed",
          note: `Completed automatically: this payment is now ${status}, so there is nothing left to collect.`,
          evidence: { payment_status: status },
        });
      }
      // pending / failed / anything unrecognised: still an exception or ambiguous -> stays open
    }
    return resolutions;
  },
};

const membershipPastDueReconciler: AriaConditionReconciler = {
  relatedTable: "client_memberships",
  async resolve({ supabase, studioId, actions }) {
    const ids = relatedIds(actions);
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from("client_memberships")
      .select("id, status")
      .eq("studio_id", studioId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    const statusById = new Map(
      ((data ?? []) as Array<{ id: string; status: string | null }>).map(
        (row) => [row.id, normalized(row.status)],
      ),
    );

    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const status = action.related_id
        ? statusById.get(action.related_id)
        : undefined;
      if (!status || !MEMBERSHIP_KNOWN_STATUSES.includes(status)) continue;
      if (
        (ARIA_MEMBERSHIP_PAST_DUE_STATUSES as readonly string[]).includes(
          status,
        )
      )
        continue;
      resolutions.push({
        actionId: action.id,
        reason:
          status === "active"
            ? "membership_billing_current"
            : "membership_no_longer_billable",
        note:
          status === "active"
            ? "Completed automatically: this membership is back in good standing."
            : `Completed automatically: this membership is now ${status.replaceAll("_", " ")}, so the billing follow-up no longer applies.`,
        evidence: { membership_status: status },
      });
    }
    return resolutions;
  },
};

const bookingRequestAgingReconciler: AriaConditionReconciler = {
  relatedTable: "booking_requests",
  async resolve({ supabase, studioId, actions }) {
    const ids = relatedIds(actions);
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from("booking_requests")
      .select("id, status")
      .eq("studio_id", studioId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    const statusById = new Map(
      ((data ?? []) as Array<{ id: string; status: string | null }>).map(
        (row) => [row.id, normalized(row.status)],
      ),
    );

    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const status = action.related_id
        ? statusById.get(action.related_id)
        : undefined;
      if (!status || !BOOKING_REQUEST_CLOSED_STATUSES.includes(status))
        continue;
      resolutions.push({
        actionId: action.id,
        reason: "booking_request_closed",
        note: `Completed automatically: this booking request was ${status}.`,
        evidence: { booking_request_status: status },
      });
    }
    return resolutions;
  },
};

const externalPaymentMissingReconciler: AriaConditionReconciler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, actions }) {
    const ids = relatedIds(actions);
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from("appointments")
      .select("id, status, payment_status, price_amount")
      .eq("studio_id", studioId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    const byId = new Map(
      (
        (data ?? []) as Array<{
          id: string;
          status: string | null;
          payment_status: string | null;
          price_amount: unknown;
        }>
      ).map((row) => [row.id, row]),
    );

    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const appointment = action.related_id
        ? byId.get(action.related_id)
        : undefined;
      if (!appointment) continue;
      const paymentStatus = normalized(appointment.payment_status);
      const status = normalized(appointment.status);
      if (APPOINTMENT_SETTLED_PAYMENT_STATUSES.includes(paymentStatus)) {
        resolutions.push({
          actionId: action.id,
          reason: "appointment_payment_recorded",
          note: `Completed automatically: this appointment's payment is now recorded as ${paymentStatus}.`,
          evidence: { appointment_payment_status: paymentStatus },
        });
      } else if (APPOINTMENT_NOT_BILLABLE_STATUSES.includes(status)) {
        resolutions.push({
          actionId: action.id,
          reason: "appointment_not_billable",
          note: "Completed automatically: this appointment was cancelled or marked a no-show, so no payment is expected.",
          evidence: { appointment_status: status },
        });
      } else if (
        appointment.price_amount !== null &&
        finiteOr(appointment.price_amount, Number.NaN) <= 0
      ) {
        resolutions.push({
          actionId: action.id,
          reason: "appointment_no_amount_due",
          note: "Completed automatically: this appointment no longer has an amount due.",
          evidence: { amount_due: 0 },
        });
      }
      // unpaid / partial / pending with an amount due (or unknown state): stays open
    }
    return resolutions;
  },
};

export const ARIA_CONDITION_RECONCILERS: Record<
  AriaReconciledRuleKey,
  AriaConditionReconciler
> = {
  aria_low_package_balance: lowPackageReconciler,
  aria_intro_no_purchase: introNoPurchaseReconciler,
  aria_payment_exception: paymentExceptionReconciler,
  aria_membership_past_due: membershipPastDueReconciler,
  aria_booking_request_aging: bookingRequestAgingReconciler,
  aria_external_payment_missing: externalPaymentMissingReconciler,
  low_package_balance: legacyLowPackageReconciler,
};

/**
 * Cleanup PR C2: every rule with a current-state handler -- the C1 objective reconcilers, the legacy booking-request rule
 * (same condition as aria_booking_request_aging), and the remaining opportunity types (src/lib/aria/lifecycleHandlers.ts).
 * aria_schedule_conflict (C3) is reconciled from its anchor appointment only when no conflict remains at all.
 */
export const ARIA_LIFECYCLE_HANDLERS: Record<string, AriaConditionReconciler> = {
  ...ARIA_CONDITION_RECONCILERS,
  pending_booking_request: bookingRequestAgingReconciler,
  ...ARIA_C2_LIFECYCLE_HANDLERS,
};

export const ARIA_LIFECYCLE_RULE_KEYS = Object.keys(ARIA_LIFECYCLE_HANDLERS);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Runner                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AriaReconciliationResult = {
  checked: number;
  completed: number;
  completedActionIds: string[];
  expiredActionIds: string[];
  refreshedActionIds: string[];
};

/** Upper bound on open actions examined per studio per run; anything beyond is picked up by the next run. */
const MAX_ACTIONS_PER_RUN = 500;

/**
 * Re-check every open, eligible action of the supported rules for ONE studio against current DanceFlow records:
 * complete actions whose condition definitively no longer holds, expire actions whose window has passed (`skipped`),
 * and supersede stale factual wording on actions that stay open for a human. Idempotent and safe to run concurrently.
 */
export async function reconcileAriaActionsForStudio(params: {
  supabase: AnySupabaseClient;
  studioId: string;
  now?: Date;
}): Promise<AriaReconciliationResult> {
  const { supabase, studioId } = params;
  const now = params.now ?? new Date();
  const empty = (checked: number): AriaReconciliationResult => ({
    checked,
    completed: 0,
    completedActionIds: [],
    expiredActionIds: [],
    refreshedActionIds: [],
  });

  const { data, error } = await supabase
    .from("automation_actions")
    .select("id, rule_key, related_table, related_id, client_id, status, body")
    .eq("studio_id", studioId)
    .in("rule_key", ARIA_LIFECYCLE_RULE_KEYS)
    .in("status", [...ARIA_RECONCILABLE_STATUSES])
    .order("created_at", { ascending: true })
    .limit(MAX_ACTIONS_PER_RUN);
  if (error) throw new Error(error.message);

  const actions = (data ?? []) as Array<ReconcilableAriaAction & { body?: string | null }>;
  if (actions.length === 0) return empty(0);

  const resolutions: AriaActionResolution[] = [];
  for (const [ruleKey, handler] of Object.entries(ARIA_LIFECYCLE_HANDLERS)) {
    const ruleActions = actions.filter(
      (action) => action.rule_key === ruleKey && action.related_table === handler.relatedTable,
    );
    if (ruleActions.length === 0) continue;
    resolutions.push(...(await handler.resolve({ supabase, studioId, now, actions: ruleActions })));
  }
  if (resolutions.length === 0) return empty(actions.length);

  const actionById = new Map(actions.map((action) => [action.id, action]));
  const nowIso = now.toISOString();
  const result = empty(actions.length);

  // Wording supersession: open actions only, written only when the stored text differs (idempotent), no status change.
  for (const resolution of resolutions.filter((item) => item.kind === "refresh")) {
    const action = actionById.get(resolution.actionId);
    if (!action || !resolution.body || action.body === resolution.body) continue;
    const { data: updated, error: refreshError } = await supabase
      .from("automation_actions")
      .update({ body: resolution.body, updated_at: nowIso })
      .eq("studio_id", studioId)
      .eq("id", action.id)
      .eq("status", action.status)
      .select("id");
    if (refreshError) throw new Error(refreshError.message);
    if (((updated ?? []) as unknown[]).length > 0) result.refreshedActionIds.push(action.id);
  }

  // Status transitions: one guarded update per (kind, previous status, note) group. The status predicate makes
  // concurrent runs converge, and the returned rows are exactly the ones this run transitioned.
  const groups = new Map<string, AriaActionResolution[]>();
  for (const resolution of resolutions) {
    if (resolution.kind === "refresh") continue;
    const action = actionById.get(resolution.actionId);
    if (!action) continue;
    const key = `${resolution.kind ?? "complete"}\u0000${action.status}\u0000${resolution.note}`;
    groups.set(key, [...(groups.get(key) ?? []), resolution]);
  }

  for (const [key, group] of groups) {
    const [kind, previousStatus] = key.split("\u0000");
    const expiring = kind === "expire";
    const note = group[0].note;
    const newStatus = expiring ? "skipped" : "completed";
    const { data: updated, error: updateError } = await supabase
      .from("automation_actions")
      .update(
        expiring
          ? {
              status: "skipped",
              skipped_at: nowIso,
              skipped_by: null,
              reviewed_at: nowIso,
              reviewed_by: null,
              review_note: note,
              updated_at: nowIso,
            }
          : {
              status: "completed",
              completed_at: nowIso,
              completed_by: null,
              reviewed_at: nowIso,
              reviewed_by: null,
              review_note: note,
              updated_at: nowIso,
            },
      )
      .eq("studio_id", studioId)
      .eq("status", previousStatus)
      .in(
        "id",
        group.map((resolution) => resolution.actionId),
      )
      .select("id");
    if (updateError) throw new Error(updateError.message);

    const transitioned = new Set(((updated ?? []) as Array<{ id: string }>).map((row) => row.id));
    if (transitioned.size === 0) continue;

    const events = group
      .filter((resolution) => transitioned.has(resolution.actionId))
      .map((resolution) => ({
        studio_id: studioId,
        automation_action_id: resolution.actionId,
        event_type: newStatus,
        previous_status: previousStatus,
        new_status: newStatus,
        note: resolution.note,
        metadata: {
          source: ARIA_CONDITION_RECONCILIATION_SOURCE,
          reason: resolution.reason,
          rule_key: actionById.get(resolution.actionId)?.rule_key ?? null,
          evidence: resolution.evidence,
        },
        created_by: null,
      }));
    const transitionedIds = events.map((event) => event.automation_action_id);
    if (expiring) result.expiredActionIds.push(...transitionedIds);
    else result.completedActionIds.push(...transitionedIds);

    const { error: eventError } = await supabase.from("automation_action_events").insert(events);
    if (eventError) {
      console.warn("ARIA condition reconciliation could not record lifecycle events", eventError.message);
    }
  }

  result.completed = result.completedActionIds.length;
  return result;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Same-incident suppression (generation dedupe across closed history)                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/*
  An incident is identified by (rule_key, related_table, related_id). Generation already skips identities with an OPEN
  action. Closed history must also hold: once staff (or delivery) close an action, ARIA must not insert a replacement for
  the SAME continuous incident. A new action for the same identity is allowed only with evidence of a NEW occurrence:

  1. the system itself observed the condition clear on the latest closed action (condition reconciliation, package
     lifecycle reconciliation, or a verified outcome) -- the condition being true again is a new occurrence;
  2. the source record shows the current occurrence began after the latest closed action was created
     (candidate.incidentStartedAt, e.g. a new membership billing period or a newer intro lesson);
  3. a rule's own existing re-notify policy (aria_low_package_balance: 30 days).

  Rows still in flight for the identity (awaiting_outcome, failed) always suppress.
*/

/** Closed / in-flight statuses that are not "open" for generation dedupe but still belong to the incident. */
export const ARIA_INCIDENT_HISTORY_STATUSES = [
  "awaiting_outcome",
  "failed",
  "completed",
  "dismissed",
  "skipped",
] as const;
const ARIA_IN_FLIGHT_STATUSES = ["awaiting_outcome", "failed"];

/** Existing per-rule re-notify windows (only rules that already had one). */
export const ARIA_RENOTIFY_AFTER_DAYS: Partial<Record<string, number>> = {
  aria_low_package_balance: 30,
  low_package_balance: 30,
};

const SYSTEM_RESOLUTION_SOURCES = [
  ARIA_CONDITION_RECONCILIATION_SOURCE,
  "package_lifecycle_reconciliation",
];

export type AriaIncidentHistoryEntry = {
  id: string;
  status: string;
  created_at: string;
  systemObservedResolution: boolean;
};

export function ariaIncidentKey(
  ruleKey: string,
  relatedTable: string,
  relatedId: string,
) {
  return `${ruleKey}:${relatedTable}:${relatedId}`;
}

/**
 * Latest closed/in-flight action per incident identity for the given candidates, with whether the system observed the
 * condition clear on it. Studio-scoped; two queries per related table plus one events query.
 */
export async function loadAriaIncidentHistory(params: {
  supabase: AnySupabaseClient;
  studioId: string;
  candidates: Array<{
    ruleKey: string;
    relatedTable: string;
    relatedId: string;
  }>;
}): Promise<Map<string, AriaIncidentHistoryEntry>> {
  const { supabase, studioId, candidates } = params;
  const history = new Map<string, AriaIncidentHistoryEntry>();
  if (candidates.length === 0) return history;

  const ruleKeys = Array.from(
    new Set(candidates.map((candidate) => candidate.ruleKey)),
  );
  const idsByTable = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const set = idsByTable.get(candidate.relatedTable) ?? new Set<string>();
    set.add(candidate.relatedId);
    idsByTable.set(candidate.relatedTable, set);
  }

  type HistoryRow = {
    id: string;
    rule_key: string;
    related_table: string;
    related_id: string;
    status: string;
    created_at: string;
  };
  const latestByKey = new Map<string, HistoryRow>();
  for (const [relatedTable, ids] of idsByTable) {
    const { data, error } = await supabase
      .from("automation_actions")
      .select("id, rule_key, related_table, related_id, status, created_at")
      .eq("studio_id", studioId)
      .eq("related_table", relatedTable)
      .in("rule_key", ruleKeys)
      .in("related_id", Array.from(ids))
      .in("status", [...ARIA_INCIDENT_HISTORY_STATUSES]);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as HistoryRow[]) {
      const key = ariaIncidentKey(
        row.rule_key,
        row.related_table,
        row.related_id,
      );
      const current = latestByKey.get(key);
      if (!current || row.created_at > current.created_at)
        latestByKey.set(key, row);
    }
  }
  if (latestByKey.size === 0) return history;

  const completedIds = Array.from(latestByKey.values())
    .filter((row) => row.status === "completed")
    .map((row) => row.id);
  const observed = new Set<string>();
  if (completedIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("automation_action_events")
      .select("automation_action_id, event_type, metadata")
      .eq("studio_id", studioId)
      .in("automation_action_id", completedIds)
      .in("event_type", ["completed", "outcome_verified"]);
    if (eventsError) throw new Error(eventsError.message);
    for (const event of (events ?? []) as Array<{
      automation_action_id: string;
      event_type: string;
      metadata: { source?: unknown } | null;
    }>) {
      if (
        event.event_type === "outcome_verified" ||
        SYSTEM_RESOLUTION_SOURCES.includes(String(event.metadata?.source ?? ""))
      ) {
        observed.add(event.automation_action_id);
      }
    }
  }

  for (const [key, row] of latestByKey) {
    history.set(key, {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      systemObservedResolution: observed.has(row.id),
    });
  }
  return history;
}

/** Is a candidate for an identity with closed history a NEW occurrence (true) or the same continuous incident (false)? */
export function isNewAriaIncidentOccurrence(params: {
  ruleKey: string;
  latest: AriaIncidentHistoryEntry;
  incidentStartedAt?: string | null;
  now: Date;
}) {
  const { ruleKey, latest, incidentStartedAt, now } = params;
  if (ARIA_IN_FLIGHT_STATUSES.includes(latest.status)) return false;
  if (latest.systemObservedResolution) return true;
  const closedCreatedAt = new Date(latest.created_at).getTime();
  if (incidentStartedAt) {
    const started = new Date(incidentStartedAt).getTime();
    if (
      Number.isFinite(started) &&
      Number.isFinite(closedCreatedAt) &&
      started > closedCreatedAt
    )
      return true;
  }
  const renotifyDays = ARIA_RENOTIFY_AFTER_DAYS[ruleKey];
  if (renotifyDays !== undefined && Number.isFinite(closedCreatedAt)) {
    return (
      now.getTime() - closedCreatedAt >= renotifyDays * 24 * 60 * 60 * 1000
    );
  }
  return false;
}

/** Morning Briefing / digest: an action snoozed into the future is not actionable yet (snooze is never auto-cleared). */
export function isAriaActionSnoozedUntilFuture(
  action: { status?: string | null; snoozed_until?: string | null },
  now: Date,
) {
  if (action.status !== "snoozed" || !action.snoozed_until) return false;
  const until = new Date(action.snoozed_until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}
