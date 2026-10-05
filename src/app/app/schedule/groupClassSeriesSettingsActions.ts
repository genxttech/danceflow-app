"use server";

import { revalidatePath } from "next/cache";
import { canEditGroupClassSeries } from "@/lib/auth/permissions";
import { requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";
import {
  classifySeriesSettingsError,
  parseSeriesSettingsResult,
  seriesSettingsFailureMessage,
  type SeriesSettingsActionOutcome,
  type SeriesSettingsFailure,
} from "@/lib/schedule/groupClassSeriesSettings";

/**
 * GC-S1D-3: "This and following classes" enrollment settings, called from the class Edit page. Two steps share one input
 * shape: preview (advisory, read-only) and apply. The client supplies only the occurrence id and the four managed settings; the
 * studio, series, lineage and every target are derived by the database, and apply re-evaluates everything itself (the expected
 * count only refuses a stale preview). Broad staff only -- the assigned instructor never edits series settings; the database
 * RPCs enforce it. Errors are fixed copy, never database text.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SeriesSettingsRequest = {
  appointmentId: string;
  publiclyDiscoverable: boolean;
  selfEnrollmentAllowed: boolean;
  packageEnabled: boolean;
  membershipEnabled: boolean;
};

function fail(failure: SeriesSettingsFailure): SeriesSettingsActionOutcome {
  return { status: "error", message: seriesSettingsFailureMessage(failure) };
}

async function run(request: SeriesSettingsRequest, apply: boolean, expectedCount: number | null): Promise<SeriesSettingsActionOutcome> {
  try {
    const { supabase, studioRole, isPlatformAdmin } = await requireAppointmentEditAccess();

    // UX-level gate only; the RPCs enforce broad-staff authority in the database.
    if (!isPlatformAdmin && !canEditGroupClassSeries(studioRole)) return fail("not_authorized");

    const appointmentId = String(request.appointmentId ?? "").trim();
    if (!UUID_RE.test(appointmentId)) return fail("not_found");

    const args = {
      p_appointment_id: appointmentId,
      p_publicly_discoverable: request.publiclyDiscoverable === true,
      p_self_enrollment_allowed: request.selfEnrollmentAllowed === true,
      p_package_enabled: request.packageEnabled === true,
      p_membership_enabled: request.membershipEnabled === true,
      ...(apply ? { p_expected_count: expectedCount } : {}),
    };

    const { data, error } = await supabase.rpc(
      apply ? "apply_group_class_series_enrollment_settings" : "preview_group_class_series_enrollment_settings",
      args,
    );
    if (error) {
      console.error(`Series enrollment settings ${apply ? "apply" : "preview"} failed:`, error.message);
      return fail(classifySeriesSettingsError(error));
    }

    const result = parseSeriesSettingsResult(data);
    if (!result) return fail("unknown");

    if (apply && result.outcome === "updated") {
      revalidatePath("/app/schedule");
      revalidatePath(`/app/schedule/${appointmentId}`);
      revalidatePath(`/app/schedule/${appointmentId}/edit`);
    }

    return { status: "ok", result };
  } catch (error) {
    console.error("Series enrollment settings action failed:", error);
    return fail("unknown");
  }
}

/** Advisory preview: what "This and following classes" would change. Writes nothing. */
export async function previewSeriesSettingsAction(request: SeriesSettingsRequest): Promise<SeriesSettingsActionOutcome> {
  return run(request, false, null);
}

/** Apply "This and following classes". `expectedCount` is the previewed count; a different current count is refused as changed. */
export async function applySeriesSettingsAction(request: SeriesSettingsRequest, expectedCount: number): Promise<SeriesSettingsActionOutcome> {
  const expected = Number.isInteger(expectedCount) && expectedCount >= 0 ? expectedCount : null;
  return run(request, true, expected);
}
