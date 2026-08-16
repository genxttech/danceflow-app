import type { SupabaseClient } from "@supabase/supabase-js";

import { validateMembershipEntitlement } from "@/lib/memberships/entitlements";
import {
  isPackageStillEligible,
  resolveEligiblePackage,
} from "@/lib/packages/entitlement";

/**
 * Server-authoritative entitlement resolution for write paths that have no
 * explicit staff picker (self-service instant book, self-service
 * reschedule, booking-request approval) -- Schedule Stabilization Slice 1.
 *
 * Staff bookings (`src/app/app/schedule/actions.ts`) are unaffected: they
 * keep validating an explicit caller-chosen package/membership via
 * `validateClientPackageForBooking` / `validateMembershipEntitlement`
 * directly. This module only auto-*selects* when there is no explicit
 * choice to validate, and always fails closed rather than guessing.
 */

export type EntitlementResolutionOutcome =
  | {
      readonly outcome: "resolved";
      readonly billingType: "package_credit";
      readonly clientPackageId: string;
      readonly clientMembershipId: null;
    }
  | {
      readonly outcome: "resolved";
      readonly billingType: "membership";
      readonly clientPackageId: null;
      readonly clientMembershipId: string;
    }
  | { readonly outcome: "no_eligible_entitlement" }
  | { readonly outcome: "multiple_eligible_packages"; readonly clientPackageIds: readonly string[] }
  | {
      readonly outcome: "ambiguous_entitlement_type";
      readonly clientPackageId: string;
      readonly clientMembershipId: string;
    }
  | { readonly outcome: "lookup_failed"; readonly error: string };

/**
 * Membership's `ok: false` branches conflate genuine business-rule
 * rejection (not eligible) with occasional raw DB error propagation (see
 * `validateMembershipEntitlement`'s `membershipError.message` /
 * `periodError.message` / `benefitError.message` / `usageError.message`
 * branches) -- that function is reused unmodified per Slice 1 scope, so
 * this orchestrator cannot cleanly tell those two cases apart from its
 * return shape alone. Since leaking either category outward would risk
 * exposing raw Supabase/PostgREST text, both are treated uniformly here as
 * "membership not eligible for auto-selection," and this orchestrator's
 * own outcome messages are always used instead of forwarding
 * `MembershipEntitlementResult.error` to any caller.
 */
async function resolveEligibleMembership(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  appointmentType: string;
  appointmentDateIso: string;
  clientMembershipId?: string | null;
  excludeAppointmentId?: string | null;
}): Promise<{ eligible: true; clientMembershipId: string } | { eligible: false }> {
  const result = await validateMembershipEntitlement({
    supabase: params.supabase,
    studioId: params.studioId,
    clientId: params.clientId,
    appointmentType: params.appointmentType,
    startsAtIso: params.appointmentDateIso,
    clientMembershipId: params.clientMembershipId,
    excludeAppointmentId: params.excludeAppointmentId,
    includeFutureReservations: true,
  });

  if (!result.ok || !result.membershipId) return { eligible: false };
  return { eligible: true, clientMembershipId: result.membershipId };
}

/**
 * Fresh auto-selection: no existing linkage to consider. Used for instant
 * self-service booking, booking-request approval, and as the fallback when
 * a reschedule's existing linkage no longer qualifies.
 */
export async function resolveEntitlementForBooking(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  appointmentType: string;
  appointmentDateIso: string;
  excludeAppointmentId?: string | null;
}): Promise<EntitlementResolutionOutcome> {
  const { supabase, studioId, clientId, appointmentType, appointmentDateIso, excludeAppointmentId } =
    params;

  const packageResult = await resolveEligiblePackage({
    supabase,
    studioId,
    clientId,
    appointmentType,
    appointmentDateIso,
  });

  if (packageResult.outcome === "lookup_failed") {
    return { outcome: "lookup_failed", error: packageResult.error };
  }

  if (packageResult.outcome === "multiple_eligible_packages") {
    return {
      outcome: "multiple_eligible_packages",
      clientPackageIds: packageResult.clientPackageIds,
    };
  }

  const packageEligible = packageResult.outcome === "single_eligible";

  const membershipResult = await resolveEligibleMembership({
    supabase,
    studioId,
    clientId,
    appointmentType,
    appointmentDateIso,
    excludeAppointmentId,
  });

  if (packageEligible && membershipResult.eligible) {
    return {
      outcome: "ambiguous_entitlement_type",
      clientPackageId: packageResult.clientPackageId,
      clientMembershipId: membershipResult.clientMembershipId,
    };
  }

  if (packageEligible) {
    return {
      outcome: "resolved",
      billingType: "package_credit",
      clientPackageId: packageResult.clientPackageId,
      clientMembershipId: null,
    };
  }

  if (membershipResult.eligible) {
    return {
      outcome: "resolved",
      billingType: "membership",
      clientPackageId: null,
      clientMembershipId: membershipResult.clientMembershipId,
    };
  }

  return { outcome: "no_eligible_entitlement" };
}

/**
 * Reschedule: preserve the appointment's existing entitlement linkage when
 * it still covers the new date/type; only fall back to fresh resolution
 * when it no longer qualifies (or none existed, e.g. a pre-Slice-1
 * self-service appointment). Never swaps a still-valid linkage for a
 * different one.
 */
export async function resolveEntitlementForReschedule(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  appointmentType: string;
  newAppointmentDateIso: string;
  existingBillingType: string | null;
  existingClientPackageId: string | null;
  existingClientMembershipId: string | null;
  excludeAppointmentId?: string | null;
}): Promise<EntitlementResolutionOutcome> {
  const {
    supabase,
    studioId,
    clientId,
    appointmentType,
    newAppointmentDateIso,
    existingBillingType,
    existingClientPackageId,
    existingClientMembershipId,
    excludeAppointmentId,
  } = params;

  if (existingBillingType === "package_credit" && existingClientPackageId) {
    const stillEligible = await isPackageStillEligible({
      supabase,
      studioId,
      clientId,
      clientPackageId: existingClientPackageId,
      appointmentType,
      appointmentDateIso: newAppointmentDateIso,
    });

    if (!stillEligible.ok) {
      return { outcome: "lookup_failed", error: stillEligible.error };
    }

    if (stillEligible.eligible) {
      return {
        outcome: "resolved",
        billingType: "package_credit",
        clientPackageId: existingClientPackageId,
        clientMembershipId: null,
      };
    }
  } else if (existingBillingType === "membership" && existingClientMembershipId) {
    const membershipStillEligible = await resolveEligibleMembership({
      supabase,
      studioId,
      clientId,
      appointmentType,
      appointmentDateIso: newAppointmentDateIso,
      clientMembershipId: existingClientMembershipId,
      excludeAppointmentId,
    });

    if (membershipStillEligible.eligible) {
      return {
        outcome: "resolved",
        billingType: "membership",
        clientPackageId: null,
        clientMembershipId: membershipStillEligible.clientMembershipId,
      };
    }
  }

  return resolveEntitlementForBooking({
    supabase,
    studioId,
    clientId,
    appointmentType,
    appointmentDateIso: newAppointmentDateIso,
    excludeAppointmentId,
  });
}
