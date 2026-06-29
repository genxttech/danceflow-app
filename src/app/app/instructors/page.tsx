import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  createInstructorCalendarFeedAction,
  deactivateInstructorAction,
  regenerateInstructorCalendarFeedAction,
} from "./actions";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type InstructorCalendarFeedRow = {
  instructor_id: string;
  token: string;
  active: boolean;
  last_accessed_at: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  specialties: string | null;
  bio?: string | null;
  active: boolean;
  created_at: string;
  public_profile_enabled: boolean;
  public_photo_url: string | null;
  public_title: string | null;
  public_bio: string | null;
  public_specialties: string | null;
  years_experience: number | null;
  display_order: number;
  teaching_certifications: string | null;
  competitive_titles: string | null;
  credentials_verification_status: string | null;
};


function getAppBaseUrl() {
  const explicitUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL;

  if (explicitUrl) return explicitUrl.replace(/\/$/, "");

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}

function buildInstructorCalendarFeedUrl(token: string) {
  return `${getAppBaseUrl()}/calendar/instructor/${token}.ics`;
}

export default async function InstructorsPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManageInstructors(role)) {
    redirect("/app");
  }

  const { data: instructors, error } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, email, phone, specialties, active, created_at, public_profile_enabled, public_photo_url, public_title, public_bio, public_specialties, years_experience, display_order, teaching_certifications, competitive_titles, credentials_verification_status")
    .eq("studio_id", studioId)
    .order("first_name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load instructors: ${error.message}`);
  }

  const typedInstructors = (instructors ?? []) as InstructorRow[];

  const { data: calendarFeeds, error: calendarFeedsError } = await supabase
    .from("instructor_calendar_feeds")
    .select("instructor_id, token, active, last_accessed_at")
    .eq("studio_id", studioId);

  if (calendarFeedsError) {
    throw new Error(`Failed to load instructor calendar feeds: ${calendarFeedsError.message}`);
  }

  const calendarFeedByInstructorId = new Map(
    ((calendarFeeds ?? []) as InstructorCalendarFeedRow[]).map((feed) => [
      feed.instructor_id,
      feed,
    ])
  );

  const activeCount = typedInstructors.filter((item) => item.active).length;
  const inactiveCount = typedInstructors.filter((item) => !item.active).length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Staff
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Instructors
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Manage teaching staff, public profiles, specialties, and who can be scheduled for lessons.
              </p>
            </div>

            <Link
              href="/app/instructors/new"
              className="inline-flex items-center rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
            >
              New Instructor
            </Link>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Bookable Team</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Manage who can be assigned to private lessons, classes, and appointments.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Public Profiles</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Control which instructors appear publicly and what dancers can see.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Schedule Clarity</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Keep instructor details organized so scheduling is easier for the front desk.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Total Instructors</p>
          <p className="mt-2 text-3xl font-semibold">{typedInstructors.length}</p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Inactive</p>
          <p className="mt-2 text-3xl font-semibold">{inactiveCount}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-slate-600">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Specialties</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Public Profile</th>
              <th className="px-4 py-3 font-medium">Calendar Sync</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {typedInstructors.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  No instructors yet.
                </td>
              </tr>
            ) : (
              typedInstructors.map((instructor) => {
                const calendarFeed = calendarFeedByInstructorId.get(instructor.id);
                const calendarFeedUrl = calendarFeed?.active
                  ? buildInstructorCalendarFeedUrl(calendarFeed.token)
                  : null;

                return (
                <tr key={instructor.id} className="border-t">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link
                      href={`/app/instructors/${instructor.id}`}
                      className="hover:underline"
                    >
                      {instructor.first_name} {instructor.last_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{instructor.email ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{instructor.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{instructor.specialties ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {instructor.active ? "active" : "inactive"}
                  </td>
                  <td className="px-4 py-3">
                    {instructor.public_profile_enabled ? (
                      <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700 ring-1 ring-green-200">
                        Public
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                        Hidden
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {calendarFeedUrl ? (
                      <div className="space-y-2">
                        <input
                          readOnly
                          value={calendarFeedUrl}
                          className="w-full min-w-64 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700"
                          aria-label={`Calendar feed URL for ${instructor.first_name} ${instructor.last_name}`}
                        />
                        <form action={regenerateInstructorCalendarFeedAction}>
                          <input type="hidden" name="instructorId" value={instructor.id} />
                          <button type="submit" className="text-xs text-slate-900 underline">
                            Regenerate link
                          </button>
                        </form>
                      </div>
                    ) : (
                      <form action={createInstructorCalendarFeedAction}>
                        <input type="hidden" name="instructorId" value={instructor.id} />
                        <button type="submit" className="text-slate-900 underline">
                          Create calendar link
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/app/instructors/${instructor.id}`}
                        className="text-slate-900 underline"
                      >
                        View
                      </Link>
                      <Link
                        href={`/app/instructors/${instructor.id}/edit`}
                        className="text-slate-900 underline"
                      >
                        Edit
                      </Link>
                      <Link
                        href={`/app/instructors/${instructor.id}/availability`}
                        className="text-slate-900 underline"
                      >
                        Availability
                      </Link>
                      {instructor.active ? (
                        <form action={deactivateInstructorAction}>
                          <input type="hidden" name="instructorId" value={instructor.id} />
                          <button type="submit" className="text-red-600 underline">
                            Deactivate
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
