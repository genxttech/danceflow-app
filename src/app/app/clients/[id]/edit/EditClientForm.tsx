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
  dance_goals?: string[] | null;
  skill_level: string | null;
  notes: string | null;
  referral_source: string | null;
  photo_url: string | null;
  status: string;
};

const CLIENT_STATUS_OPTIONS = [
  { value: "lead", label: "Lead" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
];

const CLIENT_SKILL_LEVEL_OPTIONS = [
  { value: "newcomer", label: "Newcomer" },
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
  { value: "competitive", label: "Competitive" },
  { value: "professional", label: "Professional" },
];

const CLIENT_REFERRAL_SOURCE_OPTIONS = [
  { value: "manual", label: "Staff entered" },
  { value: "walk_in", label: "Walk-in" },
  { value: "phone_call", label: "Phone call" },
  { value: "website", label: "Website" },
  { value: "google", label: "Google/Search" },
  { value: "social_media", label: "Social media" },
  { value: "friend_referral", label: "Friend referral" },
  { value: "student_referral", label: "Student referral" },
  { value: "event_registration", label: "Event registration" },
  { value: "public_intro_booking", label: "Public intro booking" },
  { value: "studio_portal", label: "Studio portal" },
  { value: "advertising", label: "Advertising" },
  { value: "other", label: "Other" },
];

const DANCE_STYLE_GROUPS = [
  {
    label: "American Smooth",
    options: [
      "American Smooth",
      "American Smooth - Waltz",
      "American Smooth - Tango",
      "American Smooth - Foxtrot",
      "American Smooth - Viennese Waltz",
    ],
  },
  {
    label: "American Rhythm",
    options: [
      "American Rhythm",
      "American Rhythm - Cha Cha",
      "American Rhythm - Rumba",
      "American Rhythm - East Coast Swing",
      "American Rhythm - Bolero",
      "American Rhythm - Mambo",
    ],
  },
  {
    label: "International Ballroom",
    options: [
      "International Ballroom",
      "International Ballroom - Waltz",
      "International Ballroom - Tango",
      "International Ballroom - Viennese Waltz",
      "International Ballroom - Foxtrot",
      "International Ballroom - Quickstep",
    ],
  },
  {
    label: "International Latin",
    options: [
      "International Latin",
      "International Latin - Cha Cha",
      "International Latin - Samba",
      "International Latin - Rumba",
      "International Latin - Paso Doble",
      "International Latin - Jive",
    ],
  },
  {
    label: "Country",
    options: [
      "Country",
      "Country - Two Step",
      "Country - West Coast Swing",
      "Country - Nightclub Two Step",
      "Country - Waltz",
      "Country - Polka",
    ],
  },
  {
    label: "Social / Club",
    options: [
      "Social / Club",
      "Social / Club - Salsa",
      "Social / Club - Bachata",
      "Social / Club - Merengue",
      "Social / Club - Hustle",
      "Social / Club - Argentine Tango",
    ],
  },
];

const DANCE_GOALS = [
  "Social dancing",
  "Practice partner",
  "Wedding dance",
  "Date night",
  "Showcase",
  "Competition",
  "Confidence",
  "Fitness",
  "New hobby",
  "Meet people",
  "Improve technique",
  "Prepare for an event",
];

function parseList(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function CheckboxGroup({
  groups,
  name,
  selected,
}: {
  groups: { label: string; options: string[] }[];
  name: string;
  selected: Set<string>;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={`${name}-${group.label}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">{group.label}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.options.map((option) => (
              <label key={`${name}-${group.label}-${option}`} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
                <input
                  type="checkbox"
                  name={name}
                  value={option}
                  defaultChecked={selected.has(option)}
                  className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GoalCheckboxes({
  name,
  selected,
}: {
  name: string;
  selected: Set<string>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {DANCE_GOALS.map((goal) => (
        <label key={`${name}-${goal}`} className="flex items-center gap-2 rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
          <input
            type="checkbox"
            name={name}
            value={goal}
            defaultChecked={selected.has(goal)}
            className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
          />
          <span>{goal}</span>
        </label>
      ))}
    </div>
  );
}

export default function EditClientForm({
  client,
}: {
  client: ClientRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updateClientAction,
    initialState
  );
  const selectedDanceStyles = new Set(parseList(client.dance_interests));
  const selectedDanceGoals = new Set(parseList(client.dance_goals ?? []));

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
                JPG, PNG, or WebP up to 5MB. On supported mobile devices,
                choose a photo from the library or take a new one.
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

        <section className="space-y-5 rounded-2xl border border-violet-200 bg-violet-50/45 p-4">
          <div>
            <h3 className="text-base font-semibold text-violet-950">
              Dance profile
            </h3>
            <p className="mt-1 text-sm leading-6 text-violet-900">
              Use consistent fields so instructors can personalize lessons and
              management can track conversion by source, style, level, and goal.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="danceInterests"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Skill Level
              </label>
              <select
                id="skillLevel"
                name="skillLevel"
                defaultValue={client.skill_level ?? ""}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
              >
                <option value="">Not set</option>
                {CLIENT_SKILL_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="referralSource"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Referral Source
              </label>
              <select
                id="referralSource"
                name="referralSource"
                defaultValue={client.referral_source ?? ""}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
              >
                <option value="">Not set</option>
                {CLIENT_REFERRAL_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-slate-700">
                Dance Interests
              </p>
              <p className="text-xs leading-5 text-slate-500">
                Multi-select the styles and dances this client cares about.
              </p>
            </div>
            <div className="mt-3">
              <CheckboxGroup
                groups={DANCE_STYLE_GROUPS}
                name="danceStyles"
                selected={selectedDanceStyles}
              />
            </div>
          </div>

          <div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-slate-700">
                Dance Goals
              </p>
              <p className="text-xs leading-5 text-slate-500">
                Goals can change over time. Update these whenever their reason
                for dancing changes so follow-up and analytics stay accurate.
              </p>
            </div>
            <div className="mt-3">
              <GoalCheckboxes name="danceGoals" selected={selectedDanceGoals} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
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
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
              >
                {CLIENT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
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
