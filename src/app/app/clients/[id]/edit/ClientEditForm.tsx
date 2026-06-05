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

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm outline-none transition focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary-soft)]";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

export default function EditClientForm({
  client,
}: {
  client: ClientRecord;
  instructors?: InstructorOption[];
}) {
  const [state, formAction, pending] = useActionState(
    updateClientAction,
    initialState
  );

  return (
    <form
      action={formAction}
      className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm"
    >
      <input type="hidden" name="clientId" value={client.id} />

      <div className="border-b border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
          CRM Profile
        </p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">
          Client details
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Keep contact, interests, and lead status accurate so scheduling,
          follow-ups, and messaging stay connected.
        </p>
      </div>

      <div className="space-y-6 p-6">
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Contact
            </h3>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="firstName" className={labelClass}>
                First Name
              </label>
              <input
                id="firstName"
                name="firstName"
                defaultValue={client.first_name}
                required
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="lastName" className={labelClass}>
                Last Name
              </label>
              <input
                id="lastName"
                name="lastName"
                defaultValue={client.last_name}
                required
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={client.email ?? ""}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="phone" className={labelClass}>
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                defaultValue={client.phone ?? ""}
                className={inputClass}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Dance profile
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Tip: use interests and skill level to personalize class suggestions
              and follow-up messages.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="danceInterests" className={labelClass}>
                Dance Interests
              </label>
              <input
                id="danceInterests"
                name="danceInterests"
                defaultValue={client.dance_interests ?? ""}
                placeholder="Country Two Step, Ballroom, Wedding Dance"
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="skillLevel" className={labelClass}>
                Skill Level
              </label>
              <input
                id="skillLevel"
                name="skillLevel"
                defaultValue={client.skill_level ?? ""}
                placeholder="New dancer, beginner, intermediate"
                className={inputClass}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              CRM status
            </h3>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="referralSource" className={labelClass}>
                Referral Source
              </label>
              <input
                id="referralSource"
                name="referralSource"
                defaultValue={client.referral_source ?? ""}
                placeholder="Website, event, referral, manual"
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="status" className={labelClass}>
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue={client.status}
                className={inputClass}
              >
                <option value="lead">Lead</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={5}
              defaultValue={client.notes ?? ""}
              placeholder="Helpful context for instructors, front desk, or follow-up."
              className={inputClass}
            />
          </div>
        </section>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/clients/${client.id}`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </div>
    </form>
  );
}
