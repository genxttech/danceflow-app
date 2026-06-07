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
  photo_url: string | null;
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

      <form action={formAction} encType="multipart/form-data" className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
        <input type="hidden" name="clientId" value={client.id} />

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white text-xl font-semibold text-slate-500">
              {client.photo_url ? (
                <img
                  src={client.photo_url}
                  alt={`${client.first_name} ${client.last_name}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span>
                  {client.first_name.slice(0, 1)}
                  {client.last_name.slice(0, 1)}
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <label htmlFor="clientPhoto" className="block text-sm font-semibold text-slate-800">
                Client headshot
              </label>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Upload a photo or take one from a supported mobile camera for staff verification.
              </p>
              <input
                id="clientPhoto"
                name="clientPhoto"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="mt-3 block w-full text-sm text-slate-700 file:mr-4 file:rounded-xl file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
              />
              <p className="mt-2 text-xs text-slate-500">JPG, PNG, or WebP up to 5MB.</p>
            </div>
          </div>
        </div>

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