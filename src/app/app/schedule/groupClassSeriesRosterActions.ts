"use server";

import { revalidatePath } from "next/cache";
import { canEditGroupClassSeries } from "@/lib/auth/permissions";
import { requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";
import {
  classifySeriesRosterError,
  isSeriesRosterBilling,
  parseSeriesRosterResult,
  seriesRosterFailureMessage,
  type SeriesRosterKind,
  type SeriesRosterResult,
} from "@/lib/schedule/groupClassSeriesRoster";

/**
 * GC-S1D-2: "This and following classes" roster management for ONE dancer, called from the class-detail roster panel.
 * Two steps share one input shape: preview (advisory, read-only) and apply. The client supplies only the occurrence id,
 * the dancer id and the funding choice; the studio, the series, the lineage and every target are derived by the database,
 * and apply re-evaluates everything itself (the expected count only refuses a stale preview). Broad staff only -- the
 * assigned instructor keeps single-class authority; the database RPCs enforce it. Errors are fixed copy, never database text.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SeriesRosterRequest = {
  kind: SeriesRosterKind;
  appointmentId: string;
  clientId: string;
  /** Enrollment only. */
  billingType?: string | null;
  clientPackageId?: string | null;
  clientMembershipId?: string | null;
};

export type SeriesRosterActionState =
  | { status: "ok"; result: SeriesRosterResult }
  | { status: "error"; message: string };

function fail(failure: Parameters<typeof seriesRosterFailureMessage>[0]): SeriesRosterActionState {
  return { status: "error", message: seriesRosterFailureMessage(failure) };
}

function cleanId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return UUID_RE.test(text) ? text : null;
}

async function run(request: SeriesRosterRequest, apply: boolean, expectedCount: number | null): Promise<SeriesRosterActionState> {
  try {
    const { supabase, studioRole, isPlatformAdmin } = await requireAppointmentEditAccess();

    // UX-level gate only; the RPCs enforce broad-staff authority in the database.
    if (!isPlatformAdmin && !canEditGroupClassSeries(studioRole)) return fail("not_authorized");

    const kind = request.kind === "remove" ? "remove" : request.kind === "enroll" ? "enroll" : null;
    const appointmentId = cleanId(request.appointmentId);
    const clientId = cleanId(request.clientId);
    if (!kind || !appointmentId) return fail("not_found");
    if (!clientId) return fail("client_not_found");

    let rpc: string;
    let args: Record<string, unknown>;

    if (kind === "enroll") {
      const billingType = isSeriesRosterBilling(request.billingType) ? request.billingType : null;
      if (!billingType) return fail("invalid_funding");
      const membershipId = billingType === "membership" ? cleanId(request.clientMembershipId) : null;
      if (billingType === "membership" && !membershipId) return fail("invalid_funding");
      const packageId = billingType === "package_credit" ? cleanId(request.clientPackageId) : null;

      rpc = apply ? "enroll_group_class_series_from" : "preview_group_class_series_enrollment";
      args = {
        p_appointment_id: appointmentId,
        p_client_id: clientId,
        p_billing_type: billingType,
        p_client_package_id: packageId,
        p_client_membership_id: membershipId,
        ...(apply ? { p_expected_count: expectedCount } : {}),
      };
    } else {
      rpc = apply ? "remove_group_class_series_from" : "preview_group_class_series_removal";
      args = {
        p_appointment_id: appointmentId,
        p_client_id: clientId,
        ...(apply ? { p_expected_count: expectedCount } : {}),
      };
    }

    const { data, error } = await supabase.rpc(rpc, args);
    if (error) {
      console.error(`Series roster ${kind} ${apply ? "apply" : "preview"} failed:`, error.message);
      return fail(classifySeriesRosterError(error));
    }

    const result = parseSeriesRosterResult(data, kind);
    if (!result) return fail("unknown");

    if (apply && (result.outcome === "enrolled" || result.outcome === "removed")) {
      revalidatePath("/app/schedule");
      revalidatePath(`/app/schedule/${appointmentId}`);
    }

    return { status: "ok", result };
  } catch (error) {
    console.error("Series roster action failed:", error);
    return fail("unknown");
  }
}

/** Advisory preview: what "This and following classes" would do for this dancer. Writes nothing. */
export async function previewSeriesRosterAction(request: SeriesRosterRequest): Promise<SeriesRosterActionState> {
  return run(request, false, null);
}

/** Apply "This and following classes". `expectedCount` is the previewed count; a different current count is refused as changed. */
export async function applySeriesRosterAction(request: SeriesRosterRequest, expectedCount: number): Promise<SeriesRosterActionState> {
  const expected = Number.isInteger(expectedCount) && expectedCount >= 0 ? expectedCount : null;
  return run(request, true, expected);
}
