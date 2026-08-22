import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Package entitlement validation and eligibility resolution -- shared by
 * staff-explicit-selection bookings (`src/app/app/schedule/actions.ts`) and
 * the Schedule Stabilization Slice 1 self-service/booking-request-approval
 * auto-selection paths (`src/lib/booking/entitlementResolution.ts`).
 *
 * Two deliberately different concepts live here:
 *   - `validateClientPackageForBooking` -- relocated, unchanged in behavior,
 *     from `schedule/actions.ts`. Validates a package a caller already
 *     explicitly chose (staff picked it from a dropdown). Gated by the
 *     `block_depleted_package_booking` studio setting, same as before.
 *   - `resolveEligiblePackage` -- new. Self-service has no picker at all, so
 *     this computes which package(s) a booking could use from real state
 *     (never gated by the studio setting -- see its own doc comment for
 *     why), so the caller can auto-select when exactly one qualifies and
 *     fail closed, not guess, when zero or multiple do.
 */

export type PackageValidationResult = {
  ok: boolean;
  error?: string;
};

export type PackageEligibilityOutcome =
  | { readonly outcome: "none_eligible" }
  | {
      readonly outcome: "single_eligible";
      readonly clientPackageId: string;
      readonly remaining: number | null;
    }
  | { readonly outcome: "multiple_eligible_packages"; readonly clientPackageIds: readonly string[] }
  | { readonly outcome: "lookup_failed"; readonly error: string };

/**
 * Mirrors `appointmentTypeToPackageUsageTypes` in
 * `src/app/app/schedule/new/AppointmentCreateForm.tsx` (client-side UI
 * filtering only, today) -- ported server-side so it can actually gate a
 * write, not just a picker's display. Anything not covered here (e.g.
 * `floor_space_rental`, `room_unavailable`) falls back to the literal
 * appointment type, which will simply never match a real
 * `package_usage_type` value -- the same "no package usage type applies"
 * outcome the client-side version produces.
 */
function usageTypesForAppointment(appointmentType: string): readonly string[] {
  if (
    appointmentType === "private_lesson" ||
    appointmentType === "intro_lesson" ||
    appointmentType === "coaching"
  ) {
    return ["private_lesson"];
  }
  if (appointmentType === "group_class") return ["group_class"];
  if (appointmentType === "practice_party" || appointmentType === "event") {
    return ["practice_party"];
  }
  return [appointmentType];
}

export type PackageItemRow = {
  usage_type: string;
  quantity_remaining: number | null;
  is_unlimited: boolean;
};

type PackageRow = {
  id: string;
  studio_id: string;
  client_id: string;
  active: boolean;
  expiration_date: string | null;
  refund_status: string | null;
  client_package_items: PackageItemRow[] | PackageItemRow | null;
};

function itemsOf(relation: PackageItemRow[] | PackageItemRow | null): PackageItemRow[] {
  return Array.isArray(relation) ? relation : relation ? [relation] : [];
}

/**
 * Package Refund P0, Slice 2b: the single shared predicate for "is this
 * package's entitlement unconditionally blocked by a refund." P0 semantics
 * are deliberately narrow -- `refund_status === 'full'` only. A `'partial'`
 * refund creates no hard block anywhere; ordinary remaining-balance rules
 * continue to apply. Safe to reuse across every eligibility/reactivation/
 * lifecycle call site: pure, no side effects, and `null` (the default for
 * every package that has never been refunded) correctly evaluates to
 * "not blocked" via plain `===` comparison -- no NULL-handling hazard here
 * the way there is with SQL/PostgREST inequality operators (see call sites
 * in lifecycle.ts and the payment-fulfillment/import guards for that case).
 */
export function isPackageRefundBlocked(pkg: { refund_status: string | null }): boolean {
  return pkg.refund_status === "full";
}

/**
 * The real-state eligibility predicate: does this specific package cover
 * this specific appointment right now? Deliberately never gated by the
 * `block_depleted_package_booking` studio setting -- that setting only
 * softens the staff explicit-pick validator below; a self-service auto-
 * selection has no human confirming the choice, so eligibility must be
 * unconditional on real state (real remaining balance, real expiration),
 * never a policy toggle. A package at zero remaining is ineligible
 * immediately, even if `reconcileClientPackageLifecycle` hasn't yet
 * flipped its stored `active` flag to `false` (a Slice 1b data-hygiene
 * concern, not a Slice 1 correctness dependency).
 *
 * Package Refund P0, Slice 2b: a `refund_status='full'` package is excluded
 * here, before any other check -- this is the single choke point shared by
 * both `resolveEligiblePackage` (auto-selection) and `isPackageStillEligible`
 * (reschedule revalidation) below, so the exclusion applies to both, and
 * applies before `resolveEligiblePackage`'s own ambiguity check runs (a
 * refund-blocked package must never be able to cause a false
 * "multiple_eligible_packages" result for an otherwise-single genuinely
 * eligible package).
 */
function isPackageEligibleNow(
  pkg: PackageRow,
  usageTypes: readonly string[],
  appointmentDate: string,
): boolean {
  if (!pkg.active) return false;
  if (isPackageRefundBlocked(pkg)) return false;
  if (pkg.expiration_date && pkg.expiration_date < appointmentDate) return false;

  return itemsOf(pkg.client_package_items).some(
    (item) =>
      usageTypes.includes(item.usage_type) &&
      (item.is_unlimited || Number(item.quantity_remaining ?? 0) > 0),
  );
}

const PACKAGE_ELIGIBILITY_SELECT = `
  id,
  studio_id,
  client_id,
  active,
  expiration_date,
  refund_status,
  client_package_items (
    usage_type,
    quantity_remaining,
    is_unlimited
  )
`;

/**
 * Computes every currently-eligible package for a booking and classifies
 * the result -- never picks a "best" one among several. Read-only.
 * Defensively re-checks `studio_id`/`client_id` on each returned row even
 * though the query itself already filtered on both, matching the
 * "can't happen with a real DB, but check anyway" convention used
 * throughout this codebase.
 */
export async function resolveEligiblePackage(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  appointmentType: string;
  appointmentDateIso: string;
}): Promise<PackageEligibilityOutcome> {
  const { supabase, studioId, clientId, appointmentType, appointmentDateIso } = params;
  const usageTypes = usageTypesForAppointment(appointmentType);
  const appointmentDate = appointmentDateIso.slice(0, 10);

  const { data, error } = await supabase
    .from("client_packages")
    .select(PACKAGE_ELIGIBILITY_SELECT)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("active", true);

  if (error) {
    return { outcome: "lookup_failed", error: "Failed to look up client packages." };
  }

  const rows = ((data ?? []) as unknown as PackageRow[]).filter(
    (pkg) => pkg.studio_id === studioId && pkg.client_id === clientId,
  );
  const eligible = rows.filter((pkg) => isPackageEligibleNow(pkg, usageTypes, appointmentDate));

  if (eligible.length === 0) return { outcome: "none_eligible" };

  if (eligible.length > 1) {
    return {
      outcome: "multiple_eligible_packages",
      clientPackageIds: eligible.map((pkg) => pkg.id),
    };
  }

  const only = eligible[0];
  const matchingItem = itemsOf(only.client_package_items).find((item) =>
    usageTypes.includes(item.usage_type),
  );

  return {
    outcome: "single_eligible",
    clientPackageId: only.id,
    remaining: matchingItem?.is_unlimited ? null : Number(matchingItem?.quantity_remaining ?? 0),
  };
}

/**
 * Re-validates one already-known, specific package against a (possibly
 * new) appointment date -- used by reschedule to check "is the existing
 * linkage still good" without re-running full auto-selection (which could
 * silently swap which package gets used). Same real-state predicate as
 * `resolveEligiblePackage`, applied to a single targeted row instead of
 * the client's whole active set.
 */
export async function isPackageStillEligible(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  clientPackageId: string;
  appointmentType: string;
  appointmentDateIso: string;
}): Promise<{ ok: true; eligible: boolean } | { ok: false; error: string }> {
  const { supabase, studioId, clientId, clientPackageId, appointmentType, appointmentDateIso } = params;
  const usageTypes = usageTypesForAppointment(appointmentType);
  const appointmentDate = appointmentDateIso.slice(0, 10);

  const { data, error } = await supabase
    .from("client_packages")
    .select(PACKAGE_ELIGIBILITY_SELECT)
    .eq("id", clientPackageId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    return { ok: false, error: "Failed to look up the linked client package." };
  }

  if (!data) return { ok: true, eligible: false };

  const pkg = data as unknown as PackageRow;
  if (pkg.studio_id !== studioId || pkg.client_id !== clientId) {
    return { ok: true, eligible: false };
  }

  return { ok: true, eligible: isPackageEligibleNow(pkg, usageTypes, appointmentDate) };
}

/**
 * Relocated from `src/app/app/schedule/actions.ts`, exported so both staff
 * (explicit selection) and this module's own callers can share it.
 * Behavior is intentionally unchanged from the original: validates a
 * caller-supplied `clientPackageId`, gated by the
 * `block_depleted_package_booking` studio setting -- this is the staff
 * "I already picked one, is it usable" check, distinct from
 * `resolveEligiblePackage`'s "which one(s) could I auto-pick" check above.
 */
export async function validateClientPackageForBooking(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  clientPackageId: string | null;
}): Promise<PackageValidationResult> {
  const { supabase, studioId, clientId, clientPackageId } = params;

  if (!clientPackageId) return { ok: true };

  const { data: studioSettings, error: settingsError } = await supabase
    .from("studio_settings")
    .select("block_depleted_package_booking")
    .eq("studio_id", studioId)
    .single();

  if (settingsError || !studioSettings) {
    return { ok: false, error: "Studio settings could not be loaded." };
  }

  const { data: pkg, error } = await supabase
    .from("client_packages")
    .select(
      `
      id,
      studio_id,
      client_id,
      active,
      refund_status,
      client_package_items (
        usage_type,
        quantity_remaining,
        quantity_total,
        is_unlimited
      )
    `,
    )
    .eq("id", clientPackageId)
    .eq("studio_id", studioId)
    .single();

  if (error || !pkg) {
    return { ok: false, error: "Selected package was not found." };
  }

  if (pkg.client_id !== clientId) {
    return {
      ok: false,
      error: "Selected package does not belong to the chosen client.",
    };
  }

  // Package Refund P0, Slice 2b: unconditional -- independent of
  // block_depleted_package_booking, which is a depletion-policy convenience
  // toggle, not a financial-integrity control. A refunded package must
  // never be bookable regardless of that studio setting.
  if (isPackageRefundBlocked(pkg)) {
    return {
      ok: false,
      error: "Selected package has been refunded and cannot be used for booking.",
    };
  }

  if (!pkg.active) {
    if (studioSettings.block_depleted_package_booking) {
      return {
        ok: false,
        error: "Selected package is inactive and cannot be used for booking.",
      };
    }

    return { ok: true };
  }

  const items = Array.isArray(pkg.client_package_items)
    ? pkg.client_package_items
    : [];
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number",
  );

  if (finiteItems.length === 0) {
    return { ok: true };
  }

  const lowestRemaining = Math.min(
    ...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)),
  );

  if (lowestRemaining <= 0 && studioSettings.block_depleted_package_booking) {
    return {
      ok: false,
      error: "Selected package has no remaining balance.",
    };
  }

  return { ok: true };
}

/**
 * Schedule Stabilization Slice 1b-a: staff-visible package lifecycle
 * status, shared so it can be reused by both the client detail page and
 * (in a later slice) warning-consistency logic. Distinct from
 * `isPackageEligibleNow` above (which answers "can THIS appointment use
 * this package") -- this answers "what should staff see as this
 * package's current state," independent of any appointment context.
 */
export type ClientPackageStatus = "archived" | "depleted" | "expired" | "low" | "active";

/**
 * Narrower than `PackageItemRow` -- status derivation and reactivation
 * eligibility are both usage-type-agnostic (they answer "does this
 * package have ANY usable balance," not "does it cover THIS appointment
 * type"), so they don't require `usage_type` to be selected/present.
 */
type BalanceItemRow = {
  quantity_remaining: number | null;
  is_unlimited: boolean | null;
};

function balanceItemsOf(
  relation: BalanceItemRow[] | BalanceItemRow | null,
): BalanceItemRow[] {
  return Array.isArray(relation) ? relation : relation ? [relation] : [];
}

function hasUsableBalance(items: readonly BalanceItemRow[]): boolean {
  return items.some(
    (item) => item.is_unlimited || Number(item.quantity_remaining ?? 0) > 0,
  );
}

function lowestFiniteRemaining(items: readonly BalanceItemRow[]): number | null {
  const finite = items.filter(
    (item) => !item.is_unlimited && item.quantity_remaining !== null,
  );
  if (finite.length === 0) return null;
  return Math.min(...finite.map((item) => Number(item.quantity_remaining ?? 0)));
}

/**
 * Precedence: archived_at set (deliberate staff action) always wins, even
 * over a package that's also naturally depleted or expired -- the
 * underlying balance/expiration facts remain queryable in the package's
 * own fields regardless of which single status this returns. "Depleted"
 * is computed from real balance (OR across items, matching
 * `hasUsablePackageCredit` in lifecycle.ts), not from the stored `active`
 * flag, so this self-heals against any pre-fix data drift rather than
 * propagating it.
 */
export function getClientPackageStatus(pkg: {
  archived_at: string | null;
  expiration_date: string | null;
  client_package_items: BalanceItemRow[] | BalanceItemRow | null;
}): ClientPackageStatus {
  if (pkg.archived_at) return "archived";

  const items = balanceItemsOf(pkg.client_package_items);

  if (!hasUsableBalance(items)) return "depleted";

  const today = new Date().toISOString().slice(0, 10);
  if (pkg.expiration_date && pkg.expiration_date < today) return "expired";

  const lowest = lowestFiniteRemaining(items);
  if (lowest !== null && lowest === 1) return "low";

  return "active";
}

/**
 * Reactivation safety rule: only allow reactivating a manually-archived
 * package when it would currently pass the same real-state check as fresh
 * eligibility resolution -- not expired, and has usable balance on at
 * least one item. Deliberately does not check `active` (the caller is
 * deciding whether to set it) or usage type (reactivation has no
 * appointment context to filter by).
 *
 * Package Refund P0, Slice 2b: also unconditionally blocks a
 * `refund_status='full'` package, checked first -- a fully refunded
 * package must never be reactivated through the ordinary
 * archive/reactivate workflow, regardless of expiration or balance.
 */
export function isPackageEligibleForReactivation(pkg: {
  expiration_date: string | null;
  refund_status: string | null;
  client_package_items: BalanceItemRow[] | BalanceItemRow | null;
}): boolean {
  if (isPackageRefundBlocked(pkg)) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (pkg.expiration_date && pkg.expiration_date < today) return false;
  return hasUsableBalance(balanceItemsOf(pkg.client_package_items));
}

/**
 * Schedule Stabilization Slice 1b-b: canonical package-warning and
 * replacement-coverage helpers, shared by every low/depleted-package
 * warning surface (portal, staff pages, notifications, ARIA, Marketing).
 * Before this, each surface reimplemented its own threshold (1, 2, a
 * purchased-quantity ratio, or a sum-across-items variant) and only one
 * surface (ARIA) suppressed a warning when the client had replacement
 * coverage elsewhere.
 *
 * `getClientPackageStatus` above remains the sole authority for a
 * package's single aggregate precedence label (Archived > Depleted >
 * Expired > Low > Active) -- nothing here changes it. What's added is a
 * finer, per-usage-type layer underneath it: a multi-item package can have
 * one usage type that's genuinely warning-worthy and another that isn't,
 * and a single replacement package must never be allowed to
 * blanket-suppress both. Every "is this warning suppressed" call site MUST
 * go through `getUnsuppressedWarningUsageTypes`/`hasUnsuppressedPackageWarning`
 * -- never call `hasReplacementCoverage` once for a package and apply the
 * result to the whole thing, or a package with e.g. a low private-lesson
 * item and a separately-depleted group-class item could have its
 * group-class warning silently swallowed by a replacement that only
 * covers private lessons.
 *
 * All coverage/suppression functions here return booleans or usage-type
 * lists only -- never a package reference. Multiple qualifying
 * replacement packages remaining an unresolved ambiguity for booking
 * (Slice 1) is a deliberate, preserved invariant; these helpers must never
 * become a mechanism for auto-selecting a package.
 */
export type PackageUsageType = string;

export type PackageWithItems = {
  id: string;
  active: boolean;
  archived_at: string | null;
  expiration_date: string | null;
  client_package_items: PackageItemRow[] | PackageItemRow | null;
};

/**
 * Per-item primitive: is this one item, in isolation, warning-worthy right
 * now? Mirrors `getClientPackageStatus`'s existing per-item thresholds
 * (finite, remaining<=0 => depleted; finite, remaining===1 => low), just
 * exposed per item instead of only folded into a package-level aggregate.
 * Unlimited items are never themselves low or depleted.
 */
export function getItemWarningLevel(item: PackageItemRow): "depleted" | "low" | null {
  if (item.is_unlimited) return null;
  const remaining = Number(item.quantity_remaining ?? 0);
  if (remaining <= 0) return "depleted";
  if (remaining === 1) return "low";
  return null;
}

/**
 * Every usage type on this package that is currently warning-worthy
 * (deduplicated), independent of the package's single aggregate status
 * label -- a package can have one low/depleted usage type and one
 * perfectly healthy one at the same time.
 */
export function getWarningCausingUsageTypes(pkg: PackageWithItems): PackageUsageType[] {
  const seen = new Set<PackageUsageType>();
  for (const item of itemsOf(pkg.client_package_items)) {
    if (getItemWarningLevel(item) !== null) seen.add(item.usage_type);
  }
  return Array.from(seen);
}

/**
 * Does this one candidate package provide usable replacement coverage for
 * a specific usage type right now? Not archived, active, not expired, and
 * that usage type's item is unlimited or has balance strictly greater
 * than zero -- deliberately >0, not above any low threshold: a
 * replacement that's itself "low" (but not depleted) still counts as
 * legitimate coverage.
 */
export function packageProvidesCoverageForUsageType(
  pkg: PackageWithItems,
  usageType: PackageUsageType,
): boolean {
  if (pkg.archived_at) return false;
  if (!pkg.active) return false;

  const today = new Date().toISOString().slice(0, 10);
  if (pkg.expiration_date && pkg.expiration_date < today) return false;

  return itemsOf(pkg.client_package_items).some(
    (item) =>
      item.usage_type === usageType &&
      (item.is_unlimited || Number(item.quantity_remaining ?? 0) > 0),
  );
}

/**
 * Does ANY candidate package provide replacement coverage for usageType?
 * Single-usage-type primitive -- boolean only, never selects or returns a
 * specific package. Fine to use directly when a caller already knows it's
 * dealing with exactly one usage type; multi-item callers must go through
 * `getUnsuppressedWarningUsageTypes` instead (see module doc comment).
 */
export function hasReplacementCoverage(params: {
  candidatePackages: readonly PackageWithItems[];
  usageType: PackageUsageType;
}): boolean {
  return params.candidatePackages.some((pkg) =>
    packageProvidesCoverageForUsageType(pkg, params.usageType),
  );
}

/**
 * Of `targetPackage`'s warning-causing usage types, which ones remain
 * uncovered after checking replacement coverage separately for each one?
 * A warning is only fully suppressed when this returns an empty array --
 * suppression requires every warning-causing usage type to be
 * individually covered, not just one of several. Different replacement
 * packages may collectively cover different usage types; none of them are
 * selected or returned. Defensively excludes `targetPackage.id` from the
 * candidate set even if a caller's `otherClientPackages` accidentally
 * includes it.
 */
export function getUnsuppressedWarningUsageTypes(params: {
  targetPackage: PackageWithItems;
  otherClientPackages: readonly PackageWithItems[];
}): PackageUsageType[] {
  const { targetPackage, otherClientPackages } = params;
  const candidates = otherClientPackages.filter((pkg) => pkg.id !== targetPackage.id);

  return getWarningCausingUsageTypes(targetPackage).filter(
    (usageType) => !hasReplacementCoverage({ candidatePackages: candidates, usageType }),
  );
}

/**
 * Package-level convenience for surfaces that render one badge per
 * package rather than one per usage type.
 */
export function hasUnsuppressedPackageWarning(params: {
  targetPackage: PackageWithItems;
  otherClientPackages: readonly PackageWithItems[];
}): boolean {
  return getUnsuppressedWarningUsageTypes(params).length > 0;
}
