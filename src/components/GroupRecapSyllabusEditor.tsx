"use client";

import { useEffect, useMemo, useState } from "react";

type StepOption = {
  id: string;
  name: string;
  alternate_name: string | null;
  syllabus_levels:
    | {
        name: string;
        syllabus_dances:
          | {
              name: string;
              syllabus_styles:
                | { name: string }
                | { name: string }[]
                | null;
            }
          | {
              name: string;
              syllabus_styles:
                | { name: string }
                | { name: string }[]
                | null;
            }[]
          | null;
      }
    | {
        name: string;
        syllabus_dances:
          | {
              name: string;
              syllabus_styles:
                | { name: string }
                | { name: string }[]
                | null;
            }
          | {
              name: string;
              syllabus_styles:
                | { name: string }
                | { name: string }[]
                | null;
            }[]
          | null;
      }[]
    | null;
};

export type GroupRecapSyllabusRow = {
  stepId: string;
  progressStatus:
    | "introduced"
    | "practiced"
    | "needs_review"
    | "assigned"
    | "mastered";
  recapNote: string;
  practiceGuidance: string;
  studentVisible: boolean;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function optionLabel(step: StepOption) {
  const level = one(step.syllabus_levels);
  const dance = one(level?.syllabus_dances);
  const style = one(dance?.syllabus_styles);

  return [style?.name, dance?.name, level?.name, step.name]
    .filter(Boolean)
    .join(" • ");
}

export default function GroupRecapSyllabusEditor({
  defaultRows = [],
}: {
  defaultRows?: GroupRecapSyllabusRow[];
}) {
  const [steps, setSteps] = useState<StepOption[]>([]);
  const [rows, setRows] = useState<GroupRecapSyllabusRow[]>(defaultRows);
  const [selectedStepId, setSelectedStepId] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    fetch("/api/syllabus/steps")
      .then(async (response) => {
        const payload = (await response.json()) as {
          steps?: StepOption[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error || "Curriculum steps could not be loaded.");
        }

        if (active) setSteps(payload.steps ?? []);
      })
      .catch(() => {
        if (active) setSteps([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const availableSteps = useMemo(
    () => steps.filter((step) => !rows.some((row) => row.stepId === step.id)),
    [rows, steps],
  );

  function updateRow(stepId: string, patch: Partial<GroupRecapSyllabusRow>) {
    setRows((current) =>
      current.map((row) => (row.stepId === stepId ? { ...row, ...patch } : row)),
    );
  }

  function addStep() {
    if (!selectedStepId) return;

    setRows((current) => [
      ...current,
      {
        stepId: selectedStepId,
        progressStatus: "practiced",
        recapNote: "",
        practiceGuidance: "",
        studentVisible: true,
      },
    ]);
    setSelectedStepId("");
  }

  return (
    <section className="rounded-2xl border border-purple-100 bg-purple-50/50 p-4">
      <input
        type="hidden"
        name="syllabusStepRowsJson"
        value={JSON.stringify(rows)}
      />

      <div>
        <p className="text-sm font-semibold text-slate-900">
          Curriculum covered
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Connect the recap to canonical steps so attendees receive the right
          charts, videos, practice guidance, and progress updates.
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <select
          value={selectedStepId}
          onChange={(event) => setSelectedStepId(event.target.value)}
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
        >
          <option value="">
            {loading ? "Loading curriculum…" : "Choose a curriculum step"}
          </option>
          {availableSteps.map((step) => (
            <option key={step.id} value={step.id}>
              {optionLabel(step)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={addStep}
          disabled={!selectedStepId}
          className="rounded-full bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          Add step
        </button>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 space-y-3">
          {rows.map((row) => {
            const step = steps.find((item) => item.id === row.stepId);

            return (
              <div
                key={row.stepId}
                className="rounded-2xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-semibold text-slate-900">
                      {step ? optionLabel(step) : "Curriculum step"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setRows((current) =>
                        current.filter((item) => item.stepId !== row.stepId),
                      )
                    }
                    className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-slate-600">
                    Class outcome
                    <select
                      value={row.progressStatus}
                      onChange={(event) =>
                        updateRow(row.stepId, {
                          progressStatus: event.target
                            .value as GroupRecapSyllabusRow["progressStatus"],
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    >
                      <option value="introduced">Introduced</option>
                      <option value="practiced">Practiced</option>
                      <option value="needs_review">Needs review</option>
                      <option value="assigned">Assigned</option>
                      <option value="mastered">Mastered</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-2 self-end rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={row.studentVisible}
                      onChange={(event) =>
                        updateRow(row.stepId, {
                          studentVisible: event.target.checked,
                        })
                      }
                    />
                    Visible to students
                  </label>

                  <label className="text-xs font-semibold text-slate-600">
                    Recap note
                    <textarea
                      rows={2}
                      value={row.recapNote}
                      onChange={(event) =>
                        updateRow(row.stepId, { recapNote: event.target.value })
                      }
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="text-xs font-semibold text-slate-600">
                    Practice guidance
                    <textarea
                      rows={2}
                      value={row.practiceGuidance}
                      onChange={(event) =>
                        updateRow(row.stepId, {
                          practiceGuidance: event.target.value,
                        })
                      }
                      className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
