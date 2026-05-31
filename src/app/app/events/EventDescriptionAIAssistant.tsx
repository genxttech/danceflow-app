"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  generateEventDescriptionAssistantAction,
  type EventDescriptionAIState,
} from "./ai-actions";

type EventDescriptionAIAssistantProps = {
  eventName: string;
  eventType: string;
  danceCategory: string;
  danceStyles: string[];
  startDate: string;
  startTime: string;
  venueName: string;
  city: string;
  state: string;
  beginnerFriendly: boolean;
  currentSummary: string;
  currentDescription: string;
  onUseSummary: (value: string) => void;
  onUseDescription: (value: string) => void;
};

const initialState: EventDescriptionAIState = {
  ok: false,
};

const taskOptions = [
  { value: "generate", label: "Generate new copy" },
  { value: "improve", label: "Improve current copy" },
  { value: "beginner_friendly", label: "Make it beginner-friendly" },
  { value: "exciting", label: "Make it more exciting" },
  { value: "shorten", label: "Shorten for the public page" },
  { value: "social_caption", label: "Create a social caption" },
  { value: "ticket_copy", label: "Create ticket sales copy" },
];

export default function EventDescriptionAIAssistant({
  eventName,
  eventType,
  danceCategory,
  danceStyles,
  startDate,
  startTime,
  venueName,
  city,
  state: eventState,
  beginnerFriendly,
  currentSummary,
  currentDescription,
  onUseSummary,
  onUseDescription,
}: EventDescriptionAIAssistantProps) {
  const [result, setResult] = useState<EventDescriptionAIState>(initialState);
  const [task, setTask] = useState(currentDescription ? "improve" : "generate");
  const [goal, setGoal] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleGenerate() {
    startTransition(async () => {
      const formData = new FormData();

      formData.set("eventName", eventName);
      formData.set("eventType", eventType);
      formData.set("danceCategory", danceCategory);
      formData.set("danceStyles", danceStyles.join(", "));
      formData.set("startDate", startDate);
      formData.set("startTime", startTime);
      formData.set("venueName", venueName);
      formData.set("city", city);
      formData.set("state", eventState);
      formData.set("beginnerFriendly", beginnerFriendly ? "true" : "false");
      formData.set("currentSummary", currentSummary);
      formData.set("currentDescription", currentDescription);
      formData.set("task", task);
      formData.set("goal", goal);

      const response = await generateEventDescriptionAssistantAction(
        initialState,
        formData,
      );

      setResult(response);
    });
  }

  return (
    <section className="rounded-3xl border border-[#A64AC9]/20 bg-gradient-to-br from-white via-[#F8F1FB] to-[#FFF4EE] p-4 shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-white p-2 text-[#A64AC9] shadow-sm">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h4 className="text-base font-bold text-slate-900">
            AI description helper
          </h4>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Draft or polish public event copy, then review and edit before
            saving.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[240px_1fr]">
        <label className="space-y-2 text-sm font-semibold text-slate-900">
          Help me
          <select
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
          >
            {taskOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-semibold text-slate-900">
          Goal or details
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
            placeholder="Mention all levels, encourage couples, highlight a guest coach..."
          />
        </label>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={isPending}
        className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {isPending ? "Generating..." : "Generate copy"}
      </button>

      {result.error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
          {result.error}
        </div>
      ) : null}

      {result.ok ? (
        <div className="mt-4 space-y-4 rounded-2xl border border-slate-200 bg-white p-4">
          {result.summaryText ? (
            <div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Public summary
                </p>
                <button
                  type="button"
                  onClick={() => onUseSummary(result.summaryText ?? "")}
                  className="rounded-full border border-[#A64AC9]/25 px-3 py-1.5 text-xs font-bold text-[#4D1F47] transition hover:bg-[#F8F1FB]"
                >
                  Use as summary
                </button>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-800">
                {result.summaryText}
              </p>
            </div>
          ) : null}

          {result.descriptionText ? (
            <div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Public description
                </p>
                <button
                  type="button"
                  onClick={() => onUseDescription(result.descriptionText ?? "")}
                  className="rounded-full border border-[#A64AC9]/25 px-3 py-1.5 text-xs font-bold text-[#4D1F47] transition hover:bg-[#F8F1FB]"
                >
                  Use as description
                </button>
              </div>
              <textarea
                readOnly
                rows={8}
                value={result.descriptionText}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800"
              />
            </div>
          ) : null}

          {result.socialCaption ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Social caption
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-800">
                {result.socialCaption}
              </p>
            </div>
          ) : null}

          {result.ticketCopy ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Ticket copy
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-800">
                {result.ticketCopy}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
