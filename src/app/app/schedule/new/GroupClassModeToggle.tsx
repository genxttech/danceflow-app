"use client";

export type GroupClassMode = "one_time" | "series";

const OPTIONS: { value: GroupClassMode; label: string; hint: string }[] = [
  { value: "one_time", label: "One-time class", hint: "A single class on one date" },
  { value: "series", label: "Class series", hint: "Repeats on a weekly schedule" },
];

/**
 * Segmented choice shown once "Group Class" is the appointment type. The
 * selected option is conveyed by aria-pressed and a visible check mark, not by
 * color alone.
 */
export default function GroupClassModeToggle({
  mode,
  onChange,
}: {
  mode: GroupClassMode;
  onChange: (mode: GroupClassMode) => void;
}) {
  return (
    <div role="group" aria-label="Class type" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {OPTIONS.map((option) => {
        const selected = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`rounded-xl border px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 ${
              selected
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            <span className="block font-medium">
              {selected ? "✓ " : ""}
              {option.label}
            </span>
            <span className={`mt-0.5 block text-xs ${selected ? "text-slate-200" : "text-slate-500"}`}>
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}
