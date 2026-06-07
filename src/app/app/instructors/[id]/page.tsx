import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type InstructorCredentialRow = {
  id: string;
  credential_type: string;
  name: string;
  issuing_organization: string | null;
  credential_year: number | null;
  proof_url: string | null;
  public_enabled: boolean;
  display_order: number;
  verification_status: string;
  review_note: string | null;
};

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

function credentialTypeLabel(value: string) {
  if (value === "title") return "Title";
  if (value === "achievement") return "Achievement";
  return "Certification";
}

function credentialBadgeClass(value: string) {
  if (value === "verified") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (value === "rejected") return "bg-red-50 text-red-700 ring-red-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
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

  const [instructorResult, credentialsResult] = await Promise.all([
    supabase
      .from("instructors")
      .select("*")
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("instructor_credentials")
      .select(
        "id, credential_type, name, issuing_organization, credential_year, proof_url, public_enabled, display_order, verification_status, review_note"
      )
      .eq("instructor_id", id)
      .eq("studio_id", studioId)
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: false }),
  ]);

  const instructor = instructorResult.data;
  const error = instructorResult.error;

  if (error || !instructor) {
    notFound();
  }

  if (credentialsResult.error) {
    throw new Error(`Failed to load instructor credentials: ${credentialsResult.error.message}`);
  }

  const typedInstructor = instructor as InstructorRow;
  const credentials = (credentialsResult.data ?? []) as InstructorCredentialRow[];
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

      <section className="rounded-3xl border border-amber-100 bg-amber-50/70 p-6 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
              Credentials
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Certifications, titles, and achievements
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Each item is verified separately before it appears publicly on the studio Staff tab.
            </p>
          </div>
          <Link
            href={`/app/instructors/${typedInstructor.id}/edit`}
            className="rounded-2xl border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-50"
          >
            Manage Credentials
          </Link>
        </div>

        {credentials.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-amber-200 bg-white/70 p-5 text-sm text-slate-600">
            No credentials have been added yet.
          </div>
        ) : (
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {credentials.map((credential) => (
              <div key={credential.id} className="rounded-2xl border border-amber-100 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                    {credentialTypeLabel(credential.credential_type)}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${credentialBadgeClass(credential.verification_status)}`}>
                    {credential.verification_status}
                  </span>
                  {credential.public_enabled ? (
                    <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-100">
                      Public when verified
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 font-semibold text-slate-950">{credential.name}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {[credential.issuing_organization, credential.credential_year].filter(Boolean).join(" · ") || "No issuer/year listed"}
                </p>
                {credential.proof_url ? (
                  <a href={credential.proof_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-sm font-semibold text-amber-700 hover:text-amber-800">
                    View proof / reference
                  </a>
                ) : null}
                {credential.review_note ? (
                  <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    Review note: {credential.review_note}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
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

