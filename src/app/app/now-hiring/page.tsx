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
  contact_name: string | null;
  status: string;
  published_at: string | null;
};

function listValue(value: string[] | null | undefined) {
  return (value ?? []).join(", ");
}

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
          "id, title, role_type, employment_type, location_type, city, state, compensation_summary, dance_styles, requirements, description, apply_url, apply_email, contact_name, status, published_at",
        )
        .eq("studio_id", context.studioId)
        .order("created_at", { ascending: false }),
      getPublishedStudioJobPostings(),
    ]);

  if (myPostingsError) {
    throw new Error(`Failed to load job postings: ${myPostingsError.message}`);
  }

  const postings = (myPostings ?? []) as StudioJobPostingRow[];
  const firstDraft = postings[0] ?? null;

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

      <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
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
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Public View
          </Link>
        </div>
      </div>

      <form
        action={saveStudioJobPostingAction}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <input type="hidden" name="postingId" value={firstDraft?.id ?? ""} />
        <h2 className="text-xl font-semibold text-slate-950">
          Job Posting
        </h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Title
            <input
              name="title"
              defaultValue={firstDraft?.title ?? ""}
              required
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Country Dance Instructor"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Role
            <select
              name="roleType"
              defaultValue={firstDraft?.role_type ?? "instructor"}
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
              defaultValue={firstDraft?.employment_type ?? "contract"}
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
              defaultValue={firstDraft?.location_type ?? "in_person"}
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
              defaultValue={firstDraft?.city ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            State
            <input
              name="state"
              defaultValue={firstDraft?.state ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Dance styles
            <input
              name="danceStyles"
              defaultValue={listValue(firstDraft?.dance_styles)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Country Two Step, Ballroom, Latin, Swing"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Compensation summary
            <input
              name="compensationSummary"
              defaultValue={firstDraft?.compensation_summary ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="$35-$60/hr based on experience"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Description
            <textarea
              name="description"
              defaultValue={firstDraft?.description ?? ""}
              rows={5}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Requirements
            <textarea
              name="requirements"
              defaultValue={firstDraft?.requirements ?? ""}
              rows={4}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Apply URL
            <input
              name="applyUrl"
              defaultValue={firstDraft?.apply_url ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Apply email
            <input
              name="applyEmail"
              type="email"
              defaultValue={firstDraft?.apply_email ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Contact name
            <input
              name="contactName"
              defaultValue={firstDraft?.contact_name ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Status
            <select
              name="status"
              defaultValue={firstDraft?.status ?? "draft"}
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
          className="mt-5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Save Job Posting
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
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                  {formatJobRole(posting.role_type)}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {formatEmploymentType(posting.employment_type)}
                </span>
                <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700">
                  {posting.status}
                </span>
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
