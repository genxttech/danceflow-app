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

export default function SyllabusStepPicker({
  name = "syllabusStepIds",
  defaultSelectedIds = [],
  label = "Syllabus steps",
}: {
  name?: string;
  defaultSelectedIds?: string[];
  label?: string;
}) {
  const [steps, setSteps] = useState<StepOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(defaultSelectedIds);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    fetch("/api/syllabus/steps")
      .then(async (response) => {
        const payload = (await response.json()) as {
          steps?: StepOption[];
          error?: string;
        };

        if (!response.ok) throw new Error(payload.error || "Could not load syllabus steps.");
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

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return steps;

    return steps.filter((step) =>
      optionLabel(step).toLowerCase().includes(normalized),
    );
  }, [query, steps]);

  function toggle(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  }

  return (
    <section className="rounded-2xl border border-purple-100 bg-purple-50/50 p-4">
      <input type="hidden" name={name} value={selectedIds.join(",")} />

      <div>
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Attach canonical curriculum steps so charts, videos, assignments, and progress stay connected.
        </p>
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search style, dance, level, or step"
        className="mt-3 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
      />

      <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-slate-500">Loading curriculum steps…</p>
        ) : filtered.length > 0 ? (
          filtered.map((step) => {
            const selected = selectedIds.includes(step.id);

            return (
              <button
                key={step.id}
                type="button"
                onClick={() => toggle(step.id)}
                className={`w-full rounded-2xl border px-3 py-2 text-left text-sm transition ${
                  selected
                    ? "border-purple-400 bg-purple-100 text-purple-950"
                    : "border-slate-200 bg-white text-slate-700 hover:border-purple-200"
                }`}
              >
                <span className="font-medium">{optionLabel(step)}</span>
                {step.alternate_name ? (
                  <span className="ml-2 text-xs text-slate-500">
                    ({step.alternate_name})
                  </span>
                ) : null}
              </button>
            );
          })
        ) : (
          <p className="text-sm text-slate-500">No matching curriculum steps.</p>
        )}
      </div>

      {selectedIds.length > 0 ? (
        <p className="mt-3 text-xs font-semibold text-purple-700">
          {selectedIds.length} step{selectedIds.length === 1 ? "" : "s"} selected
        </p>
      ) : null}
    </section>
  );
}
