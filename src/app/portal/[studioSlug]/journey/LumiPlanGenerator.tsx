"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  generateLumiPlanAction,
  type LumiAssistantState,
} from "./actions";

const initialState: LumiAssistantState = { ok: false };

export default function LumiPlanGenerator({ studioSlug }: { studioSlug: string }) {
  const [state, setState] = useState(initialState);
  const [task, setTask] = useState("weekly_plan");
  const [pending, startTransition] = useTransition();

  function generate() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("studioSlug", studioSlug);
      formData.set("task", task);
      setState(await generateLumiPlanAction(initialState, formData));
    });
  }

  return (
    <section className="rounded-lg border border-fuchsia-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
            Ask LUMI
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Turn your progress into a clear next step
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            LUMI uses your shared lesson recaps, goals, syllabus progress, and upcoming lessons.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
          >
            <option value="weekly_plan">Plan this week</option>
            <option value="next_lesson">Prepare for my next lesson</option>
            <option value="recap_patterns">Review my recent feedback</option>
          </select>
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-700 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-800 disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            {pending ? "LUMI is thinking..." : "Create guidance"}
          </button>
        </div>
      </div>

      {state.error ? (
        <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {state.error}
        </p>
      ) : null}

      {state.ok ? (
        <div className="mt-5 space-y-5 border-t border-slate-100 pt-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">{state.headline}</h3>
            <p className="mt-2 text-sm leading-7 text-slate-700">{state.summary}</p>
          </div>
          {state.practicePriorities?.length ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-950">Practice priorities</h4>
              <ul className="mt-2 space-y-2">
                {state.practicePriorities.map((item) => (
                  <li key={item} className="rounded-lg bg-fuchsia-50 px-3 py-2 text-sm text-fuchsia-950">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.instructorQuestions?.length ? (
            <div>
              <h4 className="text-sm font-semibold text-slate-950">Ask your instructor</h4>
              <ul className="mt-2 space-y-2 text-sm text-slate-700">
                {state.instructorQuestions.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true">-</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.encouragement ? (
            <p className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm leading-6 text-orange-950">
              {state.encouragement}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
