"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  generateLessonAssistantAction,
  type LessonAIAssistantState,
} from "../../lesson-ai-actions";

type LessonRecapAIAssistantProps = {
  clientName: string;
  appointmentType: string;
  lessonTitle?: string | null;
  currentSummary?: string | null;
  currentHomework?: string | null;
  currentNextFocus?: string | null;
};

const initialState: LessonAIAssistantState = {
  ok: false,
};

const taskOptions = [
  { value: "student_friendly", label: "Make student-friendly" },
  { value: "generate_recap", label: "Generate recap" },
  { value: "practice_notes", label: "Suggest practice notes" },
  { value: "next_focus", label: "Suggest next focus" },
];

async function copyText(value: string) {
  if (!value.trim()) return;
  await navigator.clipboard.writeText(value);
}

export default function LessonRecapAIAssistant({
  clientName,
  appointmentType,
  lessonTitle,
  currentSummary,
  currentHomework,
  currentNextFocus,
}: LessonRecapAIAssistantProps) {
  const hasCurrentNotes = Boolean(currentSummary || currentHomework || currentNextFocus);
  const [state, setState] = useState<LessonAIAssistantState>(initialState);
  const [task, setTask] = useState(hasCurrentNotes ? "student_friendly" : "generate_recap");
  const [instructorNotes, setInstructorNotes] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleGenerate() {
    startTransition(async () => {
      const formData = new FormData();

      formData.set("mode", "lesson_recap");
      formData.set("task", task);
      formData.set("clientName", clientName);
      formData.set("appointmentType", appointmentType);
      formData.set("lessonTitle", lessonTitle ?? "");
      formData.set("instructorNotes", instructorNotes);
      formData.set("currentSummary", currentSummary ?? "");
      formData.set("currentHomework", currentHomework ?? "");
      formData.set("currentNextFocus", currentNextFocus ?? "");

      const result = await generateLessonAssistantAction(initialState, formData);
      setState(result);
      setCopied(null);
    });
  }

  async function handleCopy(label: string, value?: string) {
    await copyText(value ?? "");
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return (
    <section className="rounded-2xl border border-purple-100 bg-gradient-to-br from-white via-purple-50 to-orange-50 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-white p-2 text-purple-700 shadow-sm">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-slate-950">AI recap helper</h4>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Draft student-friendly recap notes. Review and edit before saving.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[220px_1fr]">
        <label className="space-y-2 text-sm font-semibold text-slate-900">
          Help me
          <select
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
          >
            {taskOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-semibold text-slate-900">
          Quick instructor notes
          <input
            value={instructorNotes}
            onChange={(event) => setInstructorNotes(event.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
            placeholder="What changed today, what improved, what should they practice?"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={isPending}
        className="mt-3 inline-flex w-full justify-center rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {isPending ? "Generating..." : "Generate recap notes"}
      </button>

      {state.error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
          {state.error}
        </div>
      ) : null}

      {state.ok ? (
        <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          {copied ? (
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              {copied} copied.
            </p>
          ) : null}

          {state.summary ? (
            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</p>
                <button
                  type="button"
                  onClick={() => handleCopy("Summary", state.summary)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{state.summary}</p>
            </div>
          ) : null}

          {state.practiceNotes ? (
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Practice notes</p>
                <button
                  type="button"
                  onClick={() => handleCopy("Practice notes", state.practiceNotes)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{state.practiceNotes}</p>
            </div>
          ) : null}

          {state.nextFocus ? (
            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next focus</p>
                <button
                  type="button"
                  onClick={() => handleCopy("Next focus", state.nextFocus)}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{state.nextFocus}</p>
            </div>
          ) : null}

          <p className="border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">
            Copy the parts you want into the recap fields, then edit before saving.
          </p>
        </div>
      ) : null}
    </section>
  );
}
