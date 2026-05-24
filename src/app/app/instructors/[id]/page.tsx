import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  specialties: string | null;
  bio: string | null;
  public_profile_enabled?: boolean | null;
  public_photo_url?: string | null;
  public_title?: string | null;
  public_bio?: string | null;
  public_specialties?: string | null;
  years_experience?: number | null;
  display_order?: number | null;
};

function formatStatus(active: boolean) {
  return active ? "Active" : "Inactive";
}

export default async function InstructorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const { data: instructor, error } = await supabase
    .from("instructors")
    .select("*")
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (error || !instructor) {
    notFound();
  }

  const typedInstructor = instructor as InstructorRow;
  const instructorName = `${typedInstructor.first_name} ${typedInstructor.last_name}`.trim();

  return (
    <div className="max-w-5xl space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-sm">
        <div className="p-6 text-white md:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">
                DanceFlow Instructor Profile
              </p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
                {instructorName}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Review contact details, teaching focus, and account status for this instructor.
                Keep this profile current so scheduling, floor rentals, and instructor workflows stay accurate.
              </p>
            </div>

            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href={`/app/instructors/${typedInstructor.id}/edit`}
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-100"
              >
                Edit Instructor
              </Link>
              <Link
                href="/app/instructors"
                className="rounded-2xl border border-white/25 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
              >
                Back to Instructors
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
          </p>
          <div className="mt-3 flex items-center gap-2">
            <span
              className={
                typedInstructor.active
                  ? "h-2.5 w-2.5 rounded-full bg-emerald-500"
                  : "h-2.5 w-2.5 rounded-full bg-slate-400"
              }
            />
            <p className="text-lg font-semibold text-slate-950">
              {formatStatus(typedInstructor.active)}
            </p>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            Active instructors can be used in schedule and instructor workflows.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Teaching Focus
          </p>
          <p className="mt-3 text-lg font-semibold text-slate-950">
            {typedInstructor.specialties?.trim() || "No specialties listed yet"}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Add specialties like Two Step, Ballroom, Country, coaching, or floor-rental availability to help staff schedule faster.
          </p>
        </div>
      </section>

      <section className="rounded-3xl border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-700">
              Public Staff Profile
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Studio website visibility
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              When enabled, this instructor can appear on the public studio Staff tab with a public-facing bio and specialties.
            </p>
          </div>
          <span
            className={
              typedInstructor.public_profile_enabled
                ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600"
            }
          >
            {typedInstructor.public_profile_enabled ? "Public" : "Hidden"}
          </span>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-[120px_1fr]">
          <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
            {typedInstructor.public_photo_url?.trim() ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={typedInstructor.public_photo_url}
                alt={`${instructorName} headshot`}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-3xl font-bold text-violet-700">
                {typedInstructor.first_name?.charAt(0)}{typedInstructor.last_name?.charAt(0)}
              </span>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-white bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Public Title</p>
              <p className="mt-1 font-semibold text-slate-950">{typedInstructor.public_title?.trim() || "—"}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Display Order</p>
              <p className="mt-1 font-semibold text-slate-950">{typedInstructor.display_order ?? 0}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white/80 p-4 md:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Public Specialties</p>
              <p className="mt-1 font-semibold text-slate-950">{typedInstructor.public_specialties?.trim() || typedInstructor.specialties?.trim() || "—"}</p>
            </div>
            <div className="rounded-2xl border border-white bg-white/80 p-4 md:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Public Bio</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {typedInstructor.public_bio?.trim() || "No public bio has been added yet."}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">
              Contact Information
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Instructor details
            </h2>
          </div>
          <p className="max-w-xl text-sm text-slate-600">
            These details are used by studio staff when managing lessons, classes, and instructor communication.
          </p>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
            <p className="text-sm font-medium text-slate-500">Email</p>
            <p className="mt-1 break-words font-semibold text-slate-950">
              {typedInstructor.email?.trim() || "—"}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
            <p className="text-sm font-medium text-slate-500">Phone</p>
            <p className="mt-1 font-semibold text-slate-950">
              {typedInstructor.phone?.trim() || "—"}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 md:col-span-2">
            <p className="text-sm font-medium text-slate-500">Bio</p>
            <p className="mt-2 whitespace-pre-wrap leading-7 text-slate-700">
              {typedInstructor.bio?.trim() || "No bio has been added yet."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

