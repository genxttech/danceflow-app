"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelClassAttendeeAction } from "@/app/app/schedule/actions";
import {
  applySeriesRosterAction,
  previewSeriesRosterAction,
  type SeriesRosterRequest,
} from "@/app/app/schedule/groupClassSeriesRosterActions";
import {
  interpretSeriesApply,
  seriesRosterApplyLabel,
  seriesRosterExpectedCount,
  type SeriesRosterResult,
} from "@/lib/schedule/groupClassSeriesRoster";
import RosterSubmitButton from "./RosterSubmitButton";
import SeriesRosterPreview from "./SeriesRosterPreview";

/**
 * Remove one enrolled dancer. "This class" is the unchanged GC-S1D-1 path (one form post to cancelClassAttendeeAction).
 * Broad staff on a series class can also choose "This and following classes": a compact database-computed preview first,
 * then one atomic removal across the selected and following classes. Classes where attendance is already recorded keep
 * the dancer; no credit is used or returned. The assigned instructor never sees the scope choice (the database enforces it too).
 */
export default function RemoveDancerControl({
  appointmentId,
  attendeeId,
  clientId,
  name,
  returnTo,
  seriesScope = false,
  timeZone = "America/New_York",
}: {
  appointmentId: string;
  attendeeId: string;
  clientId: string;
  name: string;
  returnTo: string;
  seriesScope?: boolean;
  timeZone?: string;
}) {
  const [scope, setScope] = useState<"single" | "series">("single");
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [preview, setPreview] = useState<{ scope: string; result: SeriesRosterResult } | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();

  const effectiveScope = seriesScope ? scope : "single";
  const currentPreview = preview && preview.scope === effectiveScope ? preview.result : null;

  const request: SeriesRosterRequest = { kind: "remove", appointmentId, clientId };

  async function review() {
    setError("");
    setBusy("review");
    try {
      const outcome = await previewSeriesRosterAction(request);
      if (outcome.status === "ok") setPreview({ scope: effectiveScope, result: outcome.result });
      else setError(outcome.message);
    } catch {
      setError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!currentPreview || currentPreview.outcome !== "ready") return;
    setError("");
    setBusy("apply");
    try {
      const outcome = await applySeriesRosterAction(request, seriesRosterExpectedCount(currentPreview, "remove"));
      const step = interpretSeriesApply(outcome, "remove", returnTo);
      if (step.type === "error") {
        setError(step.message);
      } else if (step.type === "done") {
        setPreview(null);
        router.push(step.url);
      } else {
        // Changed or nothing to do: nothing was removed; show the fresh state instead of guessing.
        setPreview({ scope: effectiveScope, result: step.result });
      }
    } catch {
      setError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="relative text-right">
      <summary className="cursor-pointer list-none text-xs font-semibold text-red-700 underline [&::-webkit-details-marker]:hidden">
        Remove
      </summary>
      <div
        className={`mt-2 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-xs text-red-900 sm:absolute sm:right-0 sm:z-10 ${
          seriesScope ? "w-72 max-w-full sm:w-80" : "w-64 max-w-full"
        }`}
      >
        {seriesScope ? (
          <fieldset className="space-y-1">
            <legend className="font-semibold">Which classes?</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name={`removeScope-${attendeeId}`} checked={scope === "single"} onChange={() => setScope("single")} />
              <span>This class</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={`removeScope-${attendeeId}`} checked={scope === "series"} onChange={() => setScope("series")} />
              <span>This and following classes</span>
            </label>
          </fieldset>
        ) : null}

        {effectiveScope === "single" ? (
          <form action={cancelClassAttendeeAction} className="space-y-2">
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="attendeeId" value={attendeeId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <p>
              Remove <span className="font-semibold">{name}</span> from this class? They will no longer be enrolled. No credit
              is used or returned, and this frees a seat.
            </p>
            <RosterSubmitButton
              label="Remove from class"
              pendingLabel="Removing…"
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
            />
          </form>
        ) : (
          <div className="space-y-2">
            <p>
              Remove <span className="font-semibold">{name}</span> from this class and the classes after it. Review which
              classes will change first.
            </p>
            {currentPreview ? <SeriesRosterPreview result={currentPreview} kind="remove" name={name} timeZone={timeZone} /> : null}
            {error ? (
              <p role="alert" className="rounded-lg border border-red-300 bg-white px-2 py-1.5 text-red-700">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void review()}
                disabled={busy !== null}
                aria-busy={busy === "review"}
                className={
                  currentPreview?.outcome === "ready"
                    ? "rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-100 disabled:opacity-60"
                    : "rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                }
              >
                {busy === "review" ? "Checking classes…" : currentPreview ? "Review again" : "Review classes"}
              </button>
              {currentPreview?.outcome === "ready" ? (
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy !== null}
                  aria-busy={busy === "apply"}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {busy === "apply" ? "Removing…" : seriesRosterApplyLabel("remove", seriesRosterExpectedCount(currentPreview, "remove"))}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
