"use client";

import { useActionState } from "react";
import { createLeadActivityAction } from "./activity-actions";

const initialState = { error: "" };

export default function LeadActivityForm({
  clientId,
  returnTo,
}: {
  clientId: string;
  returnTo?: string;
}) {
  const [state, formAction, pending] = useActionState(
    createLeadActivityAction,
    initialState
  );

  return (
    <form action={formAction} className="space-y-4 rounded-2xl border bg-white p-6">
      <input type="hidden" name="clientId" value={clientId} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}

      <div>
        <h3 className="text-xl font-semibold">Add Lead Activity</h3>
        <p className="mt-1 text-sm text-slate-600">
          Log outreach and set a follow-up reminder if needed.
        </p>
      </div>

      <div>
        <label htmlFor="activityType" className="mb-1 block text-sm font-medium">
          Activity Type
        </label>
        <select
          id="activityType"
          name="activityType"
          defaultValue="note"
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="text">Text</option>
          <option value="email">Email</option>
          <option value="consultation">Consultation</option>
          <option value="follow_up">Follow Up</option>
        </select>
      </div>

      <div>
        <label htmlFor="note" className="mb-1 block text-sm font-medium">
          Note
        </label>
        <textarea
          id="note"
          name="note"
          rows={4}
          required
          placeholder="Example: Called and left voicemail. Follow up Friday afternoon."
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="followUpDate" className="mb-1 block text-sm font-medium">
            Follow-Up Date
          </label>
          <input
            id="followUpDate"
            name="followUpDate"
            type="date"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="followUpTime" className="mb-1 block text-sm font-medium">
            Follow-Up Time
          </label>
          <input
            id="followUpTime"
            name="followUpTime"
            type="time"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>
      </div>

      {state?.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save Activity"}
        </button>
      </div>
    </form>
  );
}