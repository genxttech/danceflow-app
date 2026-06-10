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
  birthday: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
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
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
          Client Details
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Keep contact, birthday, mailing address, and dance preferences current
          so staff can personalize follow-up and client care.
        </p>
      </div>

      <form
        action={formAction}
        encType="multipart/form-data"
        className="space-y-6 rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm md:p-6"
      >
        <input type="hidden" name="clientId" value={client.id} />

        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
              <label
                htmlFor="clientPhoto"
                className="block text-sm font-semibold text-slate-800"
              >
                Client headshot
              </label>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Choose an existing photo or take a new one, depending on your
                device. This helps staff verify the client during check-ins.
              </p>
              <input
                id="clientPhoto"
                name="clientPhoto"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="mt-3 block w-full text-sm text-slate-700 file:mr-4 file:rounded-xl file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
              />
              <p className="mt-2 text-xs text-slate-500">
                JPG, PNG, or WebP up to 5MB.
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
          <div>
            <h3 className="text-base font-semibold text-slate-950">
              Contact information
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Used for reminders, follow-up, and client communication.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="firstName"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="lastName"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="phone"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
        </section>

        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50/55 p-4">
          <div>
            <h3 className="text-base font-semibold text-amber-950">
              Birthday and mailing address
            </h3>
            <p className="mt-1 text-sm leading-6 text-amber-900">
              Helpful for birthday cards, handwritten notes, and mailers.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="birthday"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Birthday
              </label>
              <input
                id="birthday"
                name="birthday"
                type="date"
                defaultValue={client.birthday ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label
                htmlFor="country"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Country
              </label>
              <input
                id="country"
                name="country"
                defaultValue={client.country ?? ""}
                placeholder="United States"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="addressLine1"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Address Line 1
            </label>
            <input
              id="addressLine1"
              name="addressLine1"
              defaultValue={client.address_line1 ?? ""}
              placeholder="Street address"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label
              htmlFor="addressLine2"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Address Line 2
            </label>
            <input
              id="addressLine2"
              name="addressLine2"
              defaultValue={client.address_line2 ?? ""}
              placeholder="Apartment, suite, unit, building"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label
                htmlFor="city"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                City
              </label>
              <input
                id="city"
                name="city"
                defaultValue={client.city ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label
                htmlFor="state"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                State / Region
              </label>
              <input
                id="state"
                name="state"
                defaultValue={client.state ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label
                htmlFor="postalCode"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                ZIP / Postal Code
              </label>
              <input
                id="postalCode"
                name="postalCode"
                defaultValue={client.postal_code ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-200 p-4">
          <div>
            <h3 className="text-base font-semibold text-slate-950">
              Dance profile
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Give instructors quick context for lessons and follow-up.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="danceInterests"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="skillLevel"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="referralSource"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
              <label
                htmlFor="status"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
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
            <label
              htmlFor="notes"
              className="mb-1 block text-sm font-medium text-slate-700"
            >
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
        </section>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-2 sm:flex-row">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/clients/${client.id}`}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
