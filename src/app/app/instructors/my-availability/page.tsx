import Link from "next/link";
import { redirect } from "next/navigation";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

type InstructorLookupRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  active: boolean | null;
};

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function formatInstructorName(instructor: InstructorLookupRow) {
  return (
    `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim() ||
    instructor.email ||
    "Instructor"
  );
}

export default async function MyInstructorAvailabilityPage() {
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (context.isPlatformAdmin || canManageInstructors(role)) {
    redirect("/app/instructors");
  }

  if (!["instructor", "independent_instructor"].includes(role)) {
    redirect("/app");
  }

  const email = normalizeEmail(context.email);

  if (!email) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Instructor Availability
        </p>
        <h1 className="text-2xl font-semibold text-slate-950">
          We could not find your instructor profile
        </h1>
        <p className="text-sm leading-6 text-slate-600">
          Your staff login does not have an email address attached, so DanceFlow cannot match it to an instructor record.
          Ask a studio admin to confirm your team login and instructor email.
        </p>
        <Link
          href="/app"
          className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  const supabase = await createClient();
  const { data: instructors, error } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, email, active")
    .eq("studio_id", context.studioId)
    .eq("active", true)
    .ilike("email", email);

  if (error) {
    throw new Error(`Failed to load instructor profile: ${error.message}`);
  }

  const matches = ((instructors ?? []) as InstructorLookupRow[]).filter(
    (instructor) => normalizeEmail(instructor.email) === email,
  );

  if (matches.length === 1) {
    redirect(`/app/instructors/${matches[0].id}/availability`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
        Instructor Availability
      </p>
      <h1 className="text-2xl font-semibold text-slate-950">
        {matches.length > 1 ? "Multiple instructor profiles found" : "Instructor profile not found"}
      </h1>
      <p className="text-sm leading-6 text-slate-600">
        {matches.length > 1
          ? "More than one active instructor profile uses your login email. Ask a studio admin to clean up duplicate instructor records before using self-managed availability."
          : "DanceFlow could not find an active instructor record that matches your login email. Ask a studio admin to add your email to your instructor profile."}
      </p>
      {matches.length > 1 ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-950">Matching profiles</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {matches.map((instructor) => (
              <li key={instructor.id}>{formatInstructorName(instructor)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Link
        href="/app"
        className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
