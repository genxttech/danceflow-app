import Link from "next/link";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  formatEmploymentType,
  formatJobRole,
  getPublishedStudioJobPostings,
} from "@/lib/jobPostings";
import { createClient } from "@/lib/supabase/server";
import { saveStudioJobPostingAction } from "./actions";

type SearchParams = Promise<{
  edit?: string;
  new?: string;
  success?: string;
  error?: string;
}>;

type StudioJobPostingRow = {
  id: string;
  title: string;
  role_type: string;
  employment_type: string;
  location_type: string;
  city: string | null;
  state: string | null;
  compensation_summary: string | null;
  dance_styles: string[] | null;
  requirements: string | null;
  description: string | null;
  apply_url: string | null;
  apply_email: string | null;
  apply_phone: string | null;
  contact_name: string | null;
  status: string;
  published_at: string | null;
};

const danceStyleGroups = [
  {
    label: "American Smooth",
    styles: ["Waltz", "Tango", "Foxtrot", "Viennese Waltz"],
  },
  {
    label: "American Rhythm",
    styles: ["Cha Cha", "Rumba", "East Coast Swing", "Bolero", "Mambo"],
  },
  {
    label: "International Ballroom",
    styles: ["Waltz", "Tango", "Viennese Waltz", "Foxtrot", "Quickstep"],
  },
  {
    label: "International Latin",
    styles: ["Cha Cha", "Samba", "Rumba", "Paso Doble", "Jive"],
  },
  {
    label: "Country",
    styles: [
      "Country Two Step",
      "West Coast Swing",
      "East Coast Swing",
      "Nightclub Two Step",
      "Country Waltz",
      "Polka",
    ],
  },
  {
    label: "Social / Club",
    styles: ["Salsa", "Bachata", "Argentine Tango", "Hustle", "Lindy Hop", "Zouk", "Kizomba"],
  },
];

export default async function AppNowHiringPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const [{ data: myPostings, error: myPostingsError }, publicPostings] =
    await Promise.all([
      supabase
        .from("studio_job_postings")
        .select(
          "id, title, role_type, employment_type, location_type, city, state, compensation_summary, dance_styles, requirements, description, apply_url, apply_email, apply_phone, contact_name, status, published_at",
        )
        .eq("studio_id", context.studioId)
        .order("created_at", { ascending: false }),
      getPublishedStudioJobPostings(),
    ]);

  if (myPostingsError) {
    throw new Error(`Failed to load job postings: ${myPostingsError.message}`);
  }

  const postings = (myPostings ?? []) as StudioJobPostingRow[];
  const selectedPosting =
    query.new === "1"
      ? null
      : query.edit
        ? postings.find((posting) => posting.id === query.edit) ?? postings[0] ?? null
        : postings[0] ?? null;
  const formKey = selectedPosting ? `edit-${selectedPosting.id}` : "new-posting";
  const selectedDanceStyles = new Set(selectedPosting?.dance_styles ?? []);

  return (
    <div className="space-y-8">
      {query.success === "saved" ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Job posting saved.
        </div>
      ) : null}
      {query.error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          We could not save the job posting. Check the required fields and try again.
        </div>
      ) : null}

      <div className="rounded-[28px] border border-indigo-100 bg-gradient-to-br from-white via-white to-indigo-50/60 p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Now Hiring
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Publish studio job postings
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Add instructor, front desk, coach, event staff, and studio
              operations opportunities to DanceFlow discovery.
            </p>
          </div>
          <Link
            href="/discover/jobs"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Public View
          </Link>
          <Link
            href="/app/now-hiring?new=1"
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            New Posting
          </Link>
        </div>
      </div>

      <form
        key={formKey}
        action={saveStudioJobPostingAction}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <input type="hidden" name="postingId" value={selectedPosting?.id ?? ""} />
        <h2 className="text-xl font-semibold text-slate-950">
          {selectedPosting ? "Edit Job Posting" : "New Job Posting"}
        </h2>
        {selectedPosting ? (
          <p className="mt-1 text-sm text-slate-500">
            Editing {selectedPosting.title}. Use New Posting to create a separate opening.
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            Create a new opening for DanceFlow public discovery and the student app.
          </p>
        )}
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Title
            <input
              name="title"
              defaultValue={selectedPosting?.title ?? ""}
              required
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Country Dance Instructor"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Role
            <select
              name="roleType"
              defaultValue={selectedPosting?.role_type ?? "instructor"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="instructor">Instructor</option>
              <option value="coach">Coach</option>
              <option value="front_desk">Front Desk</option>
              <option value="event_staff">Event Staff</option>
              <option value="admin">Admin</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Employment type
            <select
              name="employmentType"
              defaultValue={selectedPosting?.employment_type ?? "contract"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="contract">Contract</option>
              <option value="part_time">Part Time</option>
              <option value="full_time">Full Time</option>
              <option value="employee">Employee</option>
              <option value="temporary">Temporary</option>
              <option value="volunteer">Volunteer</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Location type
            <select
              name="locationType"
              defaultValue={selectedPosting?.location_type ?? "in_person"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="in_person">In Person</option>
              <option value="hybrid">Hybrid</option>
              <option value="remote">Remote</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            City
            <input
              name="city"
              defaultValue={selectedPosting?.city ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            State
            <input
              name="state"
              defaultValue={selectedPosting?.state ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:col-span-2">
            <legend className="px-1 text-sm font-semibold text-slate-800">
              Dance styles
            </legend>
            <p className="mt-1 text-sm text-slate-500">
              Select the styles this role should support. Preset styles keep search results consistent.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {danceStyleGroups.map((group) => (
                <div key={group.label} className="rounded-2xl border border-white bg-white p-4 shadow-sm">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--brand-primary)] bg-white px-3 py-2 text-sm font-semibold text-[var(--brand-primary)]">
                    <input
                      type="checkbox"
                      name="danceStyles"
                      value={group.label}
                      defaultChecked={selectedDanceStyles.has(group.label)}
                      className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                    />
                    {group.label} - all styles
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {group.styles.map((style) => (
                      <label
                        key={style}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                      >
                        <input
                          type="checkbox"
                          name="danceStyles"
                          value={style}
                          defaultChecked={selectedDanceStyles.has(style)}
                          className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                        />
                        {style}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Compensation summary
            <input
              name="compensationSummary"
              defaultValue={selectedPosting?.compensation_summary ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="$35-$60/hr based on experience"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Description
            <textarea
              name="description"
              defaultValue={selectedPosting?.description ?? ""}
              rows={5}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Requirements
            <textarea
              name="requirements"
              defaultValue={selectedPosting?.requirements ?? ""}
              rows={4}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Apply URL
            <input
              name="applyUrl"
              defaultValue={selectedPosting?.apply_url ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Apply email
            <input
              name="applyEmail"
              type="email"
              defaultValue={selectedPosting?.apply_email ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Apply phone
            <input
              name="applyPhone"
              type="tel"
              defaultValue={selectedPosting?.apply_phone ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="614-555-0123"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Contact name
            <input
              name="contactName"
              defaultValue={selectedPosting?.contact_name ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Status
            <select
              name="status"
              defaultValue={selectedPosting?.status ?? "draft"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          className="mt-5 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          {selectedPosting ? "Save Job Posting" : "Create Job Posting"}
        </button>
      </form>

      <section className="grid gap-4">
        {postings.map((posting) => (
          <article
            key={posting.id}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  {posting.title}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {posting.city || posting.state
                    ? [posting.city, posting.state].filter(Boolean).join(", ")
                    : "Location coming soon"}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                  {formatJobRole(posting.role_type)}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {formatEmploymentType(posting.employment_type)}
                </span>
                <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                  {posting.status}
                </span>
                <Link
                  href={`/app/now-hiring?edit=${posting.id}`}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Edit
                </Link>
              </div>
            </div>
          </article>
        ))}
      </section>

      {publicPostings.length > 0 ? (
        <p className="text-sm text-slate-500">
          {publicPostings.length} public hiring posts are currently visible in
          DanceFlow discovery.
        </p>
      ) : null}
    </div>
  );
}
