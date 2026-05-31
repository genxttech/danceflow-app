"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  generateLessonAssistantAction,
  type LessonAIAssistantState,
} from "../../lesson-ai-actions";

type SyllabusNotesAIAssistantProps = {
  clientName: string;
  syllabusName: string;
  danceStyle?: string | null;
  figureTitle: string;
  figureDescription?: string | null;
  progressStatus: string;
  progressNotes?: string | null;
};

const initialState: LessonAIAssistantState = {
  ok: false,
};

const taskOptions = [
  { value: "practice_notes", label: "Suggest practice notes" },
  { value: "student_friendly", label: "Make notes student-friendly" },
  { value: "next_focus", label: "Suggest next focus" },
];

async function copyText(value: string) {
  if (!value.trim()) return;
  await navigator.clipboard.writeText(value);
}

export default function SyllabusNotesAIAssistant({
  clientName,
  syllabusName,
  danceStyle,
  figureTitle,
  figureDescription,
  progressStatus,
  progressNotes,
}: SyllabusNotesAIAssistantProps) {
  const [state, setState] = useState<LessonAIAssistantState>(initialState);
  const [task, setTask] = useState(progressNotes ? "student_friendly" : "practice_notes");
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleGenerate() {
    startTransition(async () => {
      const formData = new FormData();

      formData.set("mode", "syllabus_notes");
      formData.set("task", task);
      formData.set("clientName", clientName);
      formData.set("syllabusName", syllabusName);
      formData.set("danceStyle", danceStyle ?? "");
      formData.set("figureTitle", figureTitle);
      formData.set("figureDescription", figureDescription ?? "");
      formData.set("progressStatus", progressStatus);
      formData.set("progressNotes", progressNotes ?? "");

      const result = await generateLessonAssistantAction(initialState, formData);
      setState(result);
      setCopied(false);
    });
  }

  const combinedText = [state.summary, state.practiceNotes, state.nextFocus]
    .filter(Boolean)
    .join("\n\n");

  async function handleCopy() {
    await copyText(combinedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="mb-3 rounded-2xl border border-purple-100 bg-purple-50/60 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 text-purple-700" />
          <div>
            <p className="text-sm font-semibold text-slate-950">AI practice helper</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Draft notes for this figure. Review before saving to the student record.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 outline-none focus:border-purple-300 focus:ring-4 focus:ring-purple-100"
          >
            {taskOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            className="rounded-full bg-purple-700 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "Generating..." : "Generate"}
          </button>
        </div>
      </div>

      {state.error ? (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">
          {state.error}
        </div>
      ) : null}

      {state.ok && combinedText ? (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
          {copied ? (
            <p className="mb-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              Notes copied.
            </p>
          ) : null}
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{combinedText}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="mt-3 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Copy notes
          </button>
        </div>
      ) : null}
    </section>
  );
}
