"use client";

import { useActionState } from "react";
import { upsertLessonRecapAction } from "@/app/app/schedule/actions";

type LessonRecapFormState = {
  error?: string;
  success?: string;
};

const initialState: LessonRecapFormState = {
  error: "",
  success: "",
};

export default function LessonRecapForm({
  appointmentId,
  defaultSummary,
  defaultHomework,
  defaultNextFocus,
  defaultVisibleToClient,
}: {
  appointmentId: string;
  defaultSummary?: string | null;
  defaultHomework?: string | null;
  defaultNextFocus?: string | null;
  defaultVisibleToClient?: boolean;
}) {
  const [state, formAction] = useActionState<LessonRecapFormState, FormData>(
    upsertLessonRecapAction,
    initialState
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="appointmentId" value={appointmentId} />

      <div>
        <label
          htmlFor="summary"
          className="text-sm font-medium text-slate-700"
        >
          Lesson Summary
        </label>
        <textarea
          id="summary"
          name="summary"
          defaultValue={defaultSummary ?? ""}
          rows={4}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label
          htmlFor="homework"
          className="text-sm font-medium text-slate-700"
        >
          Practice Before Next Lesson
        </label>
        <textarea
          id="homework"
          name="homework"
          defaultValue={defaultHomework ?? ""}
          rows={3}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label
          htmlFor="nextFocus"
          className="text-sm font-medium text-slate-700"
        >
          Next Lesson Focus
        </label>
        <textarea
          id="nextFocus"
          name="nextFocus"
          defaultValue={defaultNextFocus ?? ""}
          rows={3}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="visibleToClient"
          value="true"
          defaultChecked={defaultVisibleToClient ?? true}
          className="h-4 w-4 rounded border-slate-300"
        />
        Visible to client
      </label>

      <button
        type="submit"
        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Save Recap
      </button>

      {state.error ? (
        <p className="text-sm text-red-600">{state.error}</p>
      ) : null}

      {state.success ? (
        <p className="text-sm text-green-600">{state.success}</p>
      ) : null}
    </form>
  );
}