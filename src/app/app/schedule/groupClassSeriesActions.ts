"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { requireFloorRentalAppointmentAccess } from "@/lib/auth/serverRoleGuard";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";
import {
  buildCreateRpcArgs,
  buildPreviewRpcArgs,
  findInternalOverlaps,
  mapSeriesRpcError,
  mapWithConcurrency,
  parseSeriesInput,
  seriesError,
  toDstNote,
  toSafeConflict,
  type PreviewRpcRow,
  type SeriesConflict,
  type SeriesDefinition,
  type SeriesErrorCode,
  type SeriesPreviewOccurrence,
} from "@/lib/schedule/groupClassSeries";

/**
 * GC-S1B B2: server layer for canonical group-class SERIES.
 *
 * Exposes the reviewed B1 RPCs (preview_group_class_series /
 * create_group_class_series) through the application and adds the control B1
 * deliberately left out: instructor/room conflict enforcement through the
 * existing detectAppointmentConflicts engine (client_id is null for classes;
 * that engine already treats the client check as optional).
 *
 * Request id contract for the UI (B3): generate ONE clientRequestId (a UUID)
 * when the form mounts and send the same value with every preview and create
 * from that form instance, including retries after errors. Never regenerate it
 * automatically: if a create ended ambiguously (e.g. a network failure after the
 * server committed), reusing the id either replays the committed series or
 * returns "already created or changed", whereas a fresh id could create a
 * duplicate. A new id comes only from a fresh form (page load).
 *
 * The studio is always the caller's authenticated studio context: no studio id
 * is ever read from the submitted form.
 */

export type GroupClassSeriesPreviewState =
  | { status: "idle" }
  | {
      status: "preview";
      occurrences: (SeriesPreviewOccurrence & { skipped: boolean })[];
      /** Conflicts among occurrences that are NOT skipped. */
      conflictCount: number;
      /** Occurrences that would be created (generated minus skipped). */
      materializedCount: number;
    }
  | { status: "error"; code: SeriesErrorCode; error: string };

export type GroupClassSeriesCreateState =
  | { status: "idle" }
  | { status: "error"; code: SeriesErrorCode; error: string }
  | {
      status: "conflict";
      code: "conflict";
      error: string;
      conflicts: { index: number; localDate: string; startsAt: string; endsAt: string; conflict: SeriesConflict }[];
    };

type SeriesContext = Awaited<ReturnType<typeof requireFloorRentalAppointmentAccess>>;

const CONFLICT_CHECK_CONCURRENCY = 6;

function fail(code: SeriesErrorCode) {
  return { status: "error" as const, ...seriesError(code) };
}

async function resolveBroadStaffContext(): Promise<
  { ok: true; ctx: SeriesContext } | { ok: false; code: SeriesErrorCode }
> {
  try {
    const ctx = await requireFloorRentalAppointmentAccess();
    // Same authority as the existing one-time class action; the RPCs re-check
    // it inside the database. Instructors are deliberately refused.
    const isBroadStaff =
      ctx.isPlatformAdmin || ["studio_owner", "studio_admin", "front_desk"].includes(ctx.studioRole ?? "");
    return isBroadStaff ? { ok: true, ctx } : { ok: false, code: "unauthorized" };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { ok: false, code: "unauthorized" };
  }
}

type GeneratedResult =
  | { ok: true; rows: PreviewRpcRow[] }
  | { ok: false; code: SeriesErrorCode };

async function generateOccurrences(ctx: SeriesContext, def: SeriesDefinition): Promise<GeneratedResult> {
  const { data, error } = await ctx.supabase.rpc("preview_group_class_series", buildPreviewRpcArgs(ctx.studioId, def));

  if (error) {
    const code = mapSeriesRpcError(error);
    console.error("GC-S1B series preview failed:", code, error.message);
    return { ok: false, code };
  }

  const rows = (Array.isArray(data) ? data : []) as PreviewRpcRow[];
  if (rows.length === 0) return { ok: false, code: "no_occurrences" };

  // Generated occurrences must never overlap each other (B1's bounds make that
  // impossible; the explicit check keeps it a guarantee, not an assumption).
  const overlaps = findInternalOverlaps(
    rows.map((row) => ({ index: row.occurrence_index, startsAt: row.starts_at, endsAt: row.ends_at })),
  );
  if (overlaps.length > 0) {
    console.error("GC-S1B generated occurrences overlap each other:", overlaps.join(","));
    return { ok: false, code: "invalid_recurrence" };
  }

  return { ok: true, rows };
}

type ConflictOutcome =
  | { ok: true; byIndex: Map<number, SeriesConflict> }
  | { ok: false };

/**
 * Runs the canonical conflict engine for each occurrence. Fails CLOSED: if the
 * engine throws for any occurrence the whole check is reported as failed (never
 * treated as "no conflict"). Engine messages are mapped to safe copy, so nothing
 * about other people's bookings leaves this function.
 */
async function checkConflicts(
  ctx: SeriesContext,
  def: SeriesDefinition,
  rows: PreviewRpcRow[],
): Promise<ConflictOutcome> {
  if (!def.instructorId && !def.roomId) return { ok: true, byIndex: new Map() };

  try {
    const results = await mapWithConcurrency(rows, CONFLICT_CHECK_CONCURRENCY, async (row) => ({
      index: row.occurrence_index,
      result: await detectAppointmentConflicts({
        studioId: ctx.studioId,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        instructorId: def.instructorId,
        roomId: def.roomId,
      }),
    }));

    const byIndex = new Map<number, SeriesConflict>();
    for (const { index, result } of results) {
      if (result.hasConflict) byIndex.set(index, toSafeConflict(result.message));
    }
    return { ok: true, byIndex };
  } catch (error) {
    console.error("GC-S1B series conflict check failed:", error instanceof Error ? error.message : "unknown");
    return { ok: false };
  }
}

export async function previewGroupClassSeriesAction(
  _previous: GroupClassSeriesPreviewState,
  formData: FormData,
): Promise<GroupClassSeriesPreviewState> {
  const access = await resolveBroadStaffContext();
  if (!access.ok) return fail(access.code);
  const { ctx } = access;

  const parsed = parseSeriesInput(formData);
  if (!parsed.ok) return fail(parsed.code);
  const def = parsed.value;

  const generated = await generateOccurrences(ctx, def);
  if (!generated.ok) return fail(generated.code);

  // The preview shows conflicts for every generated date so the creator can
  // decide what to skip; only unskipped conflicts count against creation.
  const conflicts = await checkConflicts(ctx, def, generated.rows);
  if (!conflicts.ok) return fail("conflict_check_failed");

  const skipped = new Set(def.skipIndices);
  const occurrences = generated.rows.map((row) => ({
    index: row.occurrence_index,
    localDate: row.local_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    dstNote: toDstNote(row.dst_note),
    conflict: conflicts.byIndex.get(row.occurrence_index) ?? null,
    skipped: skipped.has(row.occurrence_index),
  }));

  return {
    status: "preview",
    occurrences,
    conflictCount: occurrences.filter((o) => !o.skipped && o.conflict).length,
    materializedCount: occurrences.filter((o) => !o.skipped).length,
  };
}

export async function createGroupClassSeriesAction(
  _previous: GroupClassSeriesCreateState,
  formData: FormData,
): Promise<GroupClassSeriesCreateState> {
  const access = await resolveBroadStaffContext();
  if (!access.ok) return fail(access.code);
  const { ctx } = access;

  const parsed = parseSeriesInput(formData);
  if (!parsed.ok) return fail(parsed.code);
  const def = parsed.value;

  // Retry of a request that may already have committed (same studio + same
  // request id): the series' own occurrences now exist and would show up as
  // conflicts with themselves, so the conflict recheck must not run. The create
  // RPC owns the idempotency decision: an identical definition replays, a
  // different one raises the idempotency conflict, and neither branch inserts.
  // A lookup failure fails CLOSED (never skips the recheck on uncertainty).
  const existing = await ctx.supabase
    .from("group_class_series")
    .select("id")
    .eq("studio_id", ctx.studioId)
    .eq("client_request_id", def.clientRequestId)
    .maybeSingle();

  if (existing.error) {
    console.error("GC-S1B series request lookup failed:", existing.error.message);
    return fail("unknown");
  }

  if (!existing.data) {
    // Never trust a previously shown preview: regenerate from the submitted
    // definition and re-run the full conflict check right before committing.
    const generated = await generateOccurrences(ctx, def);
    if (!generated.ok) return fail(generated.code);

    const generatedIndices = new Set(generated.rows.map((row) => row.occurrence_index));
    if (def.skipIndices.some((index) => !generatedIndices.has(index))) return fail("invalid_skip");

    const skipped = new Set(def.skipIndices);
    const remaining = generated.rows.filter((row) => !skipped.has(row.occurrence_index));
    if (remaining.length === 0) return fail("no_occurrences");

    // Only explicitly skipped occurrences are exempt; nothing is auto-skipped.
    const conflicts = await checkConflicts(ctx, def, remaining);
    if (!conflicts.ok) return fail("conflict_check_failed");

    if (conflicts.byIndex.size > 0) {
      return {
        status: "conflict",
        code: "conflict",
        error: seriesError("conflict").error,
        conflicts: remaining
          .filter((row) => conflicts.byIndex.has(row.occurrence_index))
          .map((row) => ({
            index: row.occurrence_index,
            localDate: row.local_date,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            conflict: conflicts.byIndex.get(row.occurrence_index) as SeriesConflict,
          })),
      };
    }
  }

  const { data, error } = await ctx.supabase.rpc("create_group_class_series", buildCreateRpcArgs(ctx.studioId, def));

  if (error) {
    const code = mapSeriesRpcError(error);
    console.error("GC-S1B series create failed:", code, error.message);
    return fail(code);
  }

  const result = (data ?? {}) as { series_id?: string; materialized_count?: number; replay?: boolean };
  if (!result.series_id) {
    console.error("GC-S1B series create returned no series id.");
    return fail("unknown");
  }

  // replay === true is a successful "already created" result for this request.
  revalidatePath("/app/schedule");
  redirect("/app/schedule");
}
