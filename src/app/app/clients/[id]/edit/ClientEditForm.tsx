"use client";

import { useActionState } from "react";
import { updateClientAction } from "../../actions";

const initialState = { error: "" };

type ClientRecord = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  dance_interests: string | null;
  skill_level: string | null;
  notes: string | null;
  referral_source: string | null;
  status: string;
};

export default function EditClientForm({
  client,
}: {
  client: ClientRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updateClientAction,
    initialState
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-tight">Edit Client</h2>
      <p className="mt-2 text-slate-600">Update client details.</p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
        <input type="hidden" name="clientId" value={client.id} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="firstName" className="mb-1 block text-sm font-medium">
              First Name
            </label>
            <input
              id="firstName"
              name="firstName"
              defaultValue={client.first_name}
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="lastName" className="mb-1 block text-sm font-medium">
              Last Name
            </label>
            <input
              id="lastName"
              name="lastName"
              defaultValue={client.last_name}
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={client.email ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="phone" className="mb-1 block text-sm font-medium">
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              defaultValue={client.phone ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="danceInterests" className="mb-1 block text-sm font-medium">
              Dance Interests
            </label>
            <input
              id="danceInterests"
              name="danceInterests"
              defaultValue={client.dance_interests ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="skillLevel" className="mb-1 block text-sm font-medium">
              Skill Level
            </label>
            <input
              id="skillLevel"
              name="skillLevel"
              defaultValue={client.skill_level ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="referralSource" className="mb-1 block text-sm font-medium">
              Referral Source
            </label>
            <input
              id="referralSource"
              name="referralSource"
              defaultValue={client.referral_source ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={client.status}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="lead">Lead</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            defaultValue={client.notes ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/clients/${client.id}`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}