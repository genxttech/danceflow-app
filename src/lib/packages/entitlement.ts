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

type PackageItemRow = {
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
  client_package_items: PackageItemRow[] | PackageItemRow | null;
};

function itemsOf(pkg: PackageRow): PackageItemRow[] {
  return Array.isArray(pkg.client_package_items)
    ? pkg.client_package_items
    : pkg.client_package_items
      ? [pkg.client_package_items]
      : [];
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
 */
function isPackageEligibleNow(
  pkg: PackageRow,
  usageTypes: readonly string[],
  appointmentDate: string,
): boolean {
  if (!pkg.active) return false;
  if (pkg.expiration_date && pkg.expiration_date < appointmentDate) return false;

  return itemsOf(pkg).some(
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
  const matchingItem = itemsOf(only).find((item) => usageTypes.includes(item.usage_type));

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
