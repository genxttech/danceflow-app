"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  applySeriesSettingsAction,
  previewSeriesSettingsAction,
  type SeriesSettingsRequest,
} from "@/app/app/schedule/groupClassSeriesSettingsActions";
import {
  SERIES_SETTINGS_STATE_LABELS,
  interpretSeriesSettingsApply,
  isBlockedSettingsState,
  isSkippedSettingsState,
  seriesSettingsApplyLabel,
  seriesSettingsBlockers,
  seriesSettingsClassStateLabel,
  seriesSettingsExpectedCount,
  seriesSettingsSummary,
  type SeriesSettingsResult,
} from "@/lib/schedule/groupClassSeriesSettings";
import { seriesRosterClassLabel } from "@/lib/schedule/groupClassSeriesRoster";

const TONE_CLASS = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-slate-200 bg-slate-50 text-slate-800",
  blocked: "border-amber-300 bg-amber-50 text-amber-900",
} as const;

function SettingsPreview({ result, timeZone }: { result: SeriesSettingsResult; timeZone: string }) {
  const summary = seriesSettingsSummary(result);
  const blockers = seriesSettingsBlockers(result);
  return (
    <div role="status" aria-live="polite" className={`space-y-2 rounded-xl border p-3 text-xs ${TONE_CLASS[summary.tone]}`}>
      <p className="text-sm font-semibold">{summary.headline}</p>
      {summary.details.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {summary.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {blockers.length > 0 ? (
        <div>
          <p className="font-semibold">Needs attention</p>
          <ul aria-label="Classes that need attention" className="mt-1 space-y-0.5">
            {blockers.map((item) => (
              <li key={item.appointmentId}>
                <span className="font-medium">{seriesRosterClassLabel(item.startsAt, timeZone)}</span> — {SERIES_SETTINGS_STATE_LABELS[item.state]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.classes.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium underline">Show all {result.classes.length} {result.classes.length === 1 ? "class" : "classes"}</summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto pr-1">
            {result.classes.map((item) => (
              <li key={item.appointmentId} className="flex flex-wrap justify-between gap-x-3">
                <span>{seriesRosterClassLabel(item.startsAt, timeZone)}</span>
                <span
                  className={
                    isBlockedSettingsState(item.state)
                      ? "font-semibold text-amber-800"
                      : isSkippedSettingsState(item.state) || item.state === "matches"
                        ? "text-slate-500"
                        : "font-medium"
                  }
                >
                  {seriesSettingsClassStateLabel(item.state, result.outcome)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * GC-S1D-3: the footer of the enrollment-settings form on the class Edit page. "This class" is the default and keeps the
 * unchanged single-class save. Broad staff on an eligible series class can choose "This and following classes": a compact
 * database-computed preview (how many classes will be updated, how many already match, what is skipped or blocking) and then
 * one atomic update. Later classes with different settings are overwritten by design; earlier classes are never changed.
 */
export default function SeriesSettingsFooter({
  appointmentId,
  seriesEnabled,
  scope,
  onScopeChange,
  settings,
  singleDisabled,
  timeZone,
  returnPath,
}: {
  appointmentId: string;
  seriesEnabled: boolean;
  scope: "single" | "series";
  onScopeChange: (next: "single" | "series") => void;
  settings: { publiclyDiscoverable: boolean; selfEnrollmentAllowed: boolean; packageEnabled: boolean; membershipEnabled: boolean };
  /** The single-class save is blocked by its own validation (discovery with no funding source). */
  singleDisabled: boolean;
  timeZone: string;
  returnPath: string;
}) {
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [preview, setPreview] = useState<{ key: string; result: SeriesSettingsResult } | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();

  const effectiveScope = seriesEnabled ? scope : "single";
  const previewKey = [settings.publiclyDiscoverable, settings.selfEnrollmentAllowed, settings.packageEnabled, settings.membershipEnabled].join("|");
  const current = preview && preview.key === previewKey ? preview.result : null;

  const request: SeriesSettingsRequest = {
    appointmentId,
    publiclyDiscoverable: settings.publiclyDiscoverable,
    selfEnrollmentAllowed: settings.selfEnrollmentAllowed,
    packageEnabled: settings.packageEnabled,
    membershipEnabled: settings.membershipEnabled,
  };

  async function review() {
    setError("");
    setBusy("review");
    try {
      const outcome = await previewSeriesSettingsAction(request);
      if (outcome.status === "ok") setPreview({ key: previewKey, result: outcome.result });
      else setError(outcome.message);
    } catch {
      setError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!current || current.outcome !== "ready") return;
    setError("");
    setBusy("apply");
    try {
      const outcome = await applySeriesSettingsAction(request, seriesSettingsExpectedCount(current));
      const step = interpretSeriesSettingsApply(outcome, returnPath);
      if (step.type === "error") {
        setError(step.message);
      } else if (step.type === "done") {
        setPreview(null);
        router.push(step.url);
      } else {
        // Changed, blocked or nothing to do: nothing was updated; show the fresh state instead of guessing.
        setPreview({ key: previewKey, result: step.result });
      }
    } catch {
      setError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {seriesEnabled ? (
        <fieldset className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Apply to</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="settingsScope" value="single" checked={scope === "single"} onChange={() => onScopeChange("single")} />
            <span className="text-slate-800">This class</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="settingsScope" value="series" checked={scope === "series"} onChange={() => onScopeChange("series")} />
            <span className="text-slate-800">This and following classes</span>
          </label>
          {scope === "series" ? (
            <p className="pt-1 text-xs text-slate-600">
              These settings replace the current ones on this class and every later class in the series, including any that were set
              differently. Earlier classes are not changed, and cancelled or ended classes are skipped.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {effectiveScope === "series" && current ? <SettingsPreview result={current} timeZone={timeZone} /> : null}

      {error ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {effectiveScope === "series" ? (
          <>
            <button
              type="button"
              onClick={() => void review()}
              disabled={busy !== null}
              aria-busy={busy === "review"}
              className={
                current?.outcome === "ready"
                  ? "inline-flex items-center justify-center rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  : "inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              }
            >
              {busy === "review" ? "Checking classes…" : current ? "Review again" : "Review classes"}
            </button>
            {current?.outcome === "ready" ? (
              <button
                type="button"
                onClick={() => void apply()}
                disabled={busy !== null}
                aria-busy={busy === "apply"}
                className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "apply" ? "Updating…" : seriesSettingsApplyLabel(seriesSettingsExpectedCount(current))}
              </button>
            ) : null}
          </>
        ) : (
          <button
            type="submit"
            disabled={singleDisabled}
            className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save enrollment settings
          </button>
        )}
      </div>
    </div>
  );
}
