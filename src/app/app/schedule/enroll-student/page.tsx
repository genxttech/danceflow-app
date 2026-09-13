import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canCreateAppointments } from "@/lib/auth/permissions";
import { resolveViewerInstructorId } from "@/lib/auth/instructorIdentity";
import EnrollStudentForm from "./EnrollStudentForm";

type ClassOption = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  instructor_id: string | null;
  instructors: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
};

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
};

type ClientPackageItemRow = {
  usage_type: string | null;
  quantity_remaining: number | null;
  is_unlimited: boolean | null;
};

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  client_package_items: ClientPackageItemRow[] | null;
};

type ClientMembershipRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  status: string;
};

export type EligibleFundingSource =
  | { type: "package"; id: string; label: string; remainingLabel: string }
  | { type: "membership"; id: string; label: string; remainingLabel: string };

// GC-3.2: row shape returned by the canonical backend resolver
// (get_eligible_group_class_funding_candidates, gc3c) -- the single source
// of truth this RPC now shares with enroll_class_attendee's own
// own-instructor auto-resolution, replacing this page's former independent
// TypeScript eligibility computation.
type FundingCandidateRow = {
  funding_type: "package" | "membership";
  source_id: string;
  label: string;
  is_unlimited: boolean;
  quantity_total: number | null;
  used: number | null;
  remaining: number | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

// GC-2 item D: distinct, actionable messages for enrollClassAttendeeAction's
// specific error codes (see classifyEnrollClassAttendeeError in
// schedule/actions.ts) -- landing back here, not a generic failure banner.
function enrollmentErrorMessage(code: string): string {
  switch (code) {
    case "membership_requires_selection":
      return "Select a specific membership before billing this enrollment to Membership, or choose a different funding type.";
    case "no_eligible_entitlement":
      return "That membership does not include a group-class benefit. Choose a different funding source or bill manually.";
    case "entitlement_exhausted":
      return "That membership has no allowance remaining for a group class this billing period. Choose a different funding source or bill manually.";
    case "membership_not_active":
      return "That membership is not active for this client, or has expired. Choose a different funding source or bill manually.";
    case "ambiguous_funding_source":
      return "This student has more than one eligible funding source and none was selected -- choose one to complete the enrollment.";
    case "missing_enrollment_target":
      return "Select a class and a client before enrolling.";
    default:
      return "Could not enroll this student. Check the class and funding selection and try again.";
  }
}

type SearchParams = Promise<{ error?: string }>;

// GC-1.4A: "Enroll Student" -- the minimum functional UX for adding a
// client to an already-existing class instance. Deliberately not roster
// management (GC-1.5): no bulk enrollment, no search-and-add browser, no
// remove-with-confirmation dialog -- one class, one client, one submit.
export default async function EnrollStudentPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const errorBanner = query.error ? enrollmentErrorMessage(query.error) : null;

  const context = await getCurrentStudioContext();
  const { studioId, studioRole, isPlatformAdmin } = context;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // App-layer gate is deliberately permissive (lets an ordinary instructor
  // through, matching canCreateAppointments) -- enroll_class_attendee's own
  // embedded broad-or-own-instructor check is the real, fine-grained
  // authority; an unassigned/independent instructor reaching this page
  // simply gets an empty class list or a denied submit, never a data leak.
  if (!canCreateAppointments(studioRole ?? "")) {
    redirect("/app");
  }

  const isBroadStaff =
    isPlatformAdmin || ["studio_owner", "studio_admin", "front_desk"].includes(studioRole ?? "");

  let viewerInstructorId: string | null = null;
  if (!isBroadStaff) {
    viewerInstructorId = await resolveViewerInstructorId(supabase, studioId, user.id);
  }

  const nowIso = new Date().toISOString();

  let classesQuery = supabase
    .from("appointments")
    .select("id, title, starts_at, ends_at, instructor_id, instructors(first_name, last_name)")
    .eq("studio_id", studioId)
    .eq("appointment_type", "group_class")
    .neq("status", "cancelled")
    .gte("starts_at", nowIso)
    .order("starts_at", { ascending: true })
    .limit(100);

  if (!isBroadStaff) {
    if (!viewerInstructorId) {
      redirect("/app");
    }
    classesQuery = classesQuery.eq("instructor_id", viewerInstructorId);
  }

  const { data: classesData, error: classesError } = await classesQuery;

  if (classesError) {
    throw new Error(`Failed to load upcoming classes: ${classesError.message}`);
  }

  const classes = ((classesData ?? []) as ClassOption[]).map((row) => {
    const instructor = firstJoin(row.instructors);
    return {
      id: row.id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      instructorName: instructor
        ? `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim()
        : null,
    };
  });

  // GC-1.4A financial minimization: package/membership data is only ever
  // fetched for a broad-staff caller, who alone may exercise billing
  // override. An assigned instructor never receives this data at all --
  // the server auto-resolves their enrollment's billing internally.
  let clients: ClientOption[] = [];
  let clientPackagesByClientId: Record<string, ClientPackageRow[]> = {};
  let clientMembershipsByClientId: Record<string, ClientMembershipRow[]> = {};

  if (isBroadStaff) {
    const [{ data: clientsData, error: clientsError }, { data: packagesData }, { data: membershipsData }] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id, first_name, last_name, status")
          .eq("studio_id", studioId)
          .order("first_name", { ascending: true }),
        supabase
          .from("client_packages")
          .select(
            "id, client_id, name_snapshot, active, client_package_items(usage_type, quantity_remaining, is_unlimited)",
          )
          .eq("studio_id", studioId)
          .eq("active", true),
        supabase
          .from("client_memberships")
          .select("id, client_id, name_snapshot, status")
          .eq("studio_id", studioId)
          .eq("status", "active"),
      ]);

    if (clientsError) {
      throw new Error(`Failed to load clients: ${clientsError.message}`);
    }

    clients = ((clientsData ?? []) as ClientOption[]).filter(
      (client) => client.status !== "archived",
    );

    for (const pkg of (packagesData ?? []) as ClientPackageRow[]) {
      if (!pkg.client_id) continue;
      clientPackagesByClientId[pkg.client_id] ??= [];
      clientPackagesByClientId[pkg.client_id].push(pkg);
    }

    for (const membership of (membershipsData ?? []) as ClientMembershipRow[]) {
      if (!membership.client_id) continue;
      clientMembershipsByClientId[membership.client_id] ??= [];
      clientMembershipsByClientId[membership.client_id].push(membership);
    }
  }

  // GC-3.2: eligible funding sources now come from the canonical backend
  // resolver (get_eligible_group_class_funding_candidates) -- the same
  // function enroll_class_attendee's own-instructor auto-resolution uses --
  // rather than an independently-maintained TypeScript eligibility
  // computation. Called once per broad-staff-visible client, with no
  // appointment_id: this page has never scoped its eligibility preview to
  // one specific class (it precomputes for every visible client before a
  // class is chosen in the form below), so this preserves that existing,
  // appointment-independent behavior exactly.
  const eligibleFundingSourcesByClientId: Record<string, EligibleFundingSource[]> = {};

  if (isBroadStaff) {
    await Promise.all(
      clients.map(async (client) => {
        const { data, error } = await supabase.rpc("get_eligible_group_class_funding_candidates", {
          p_studio_id: studioId,
          p_client_id: client.id,
        });

        if (error) {
          throw new Error(`Failed to resolve funding eligibility for a client: ${error.message}`);
        }

        const sources: EligibleFundingSource[] = ((data ?? []) as FundingCandidateRow[]).map((row) => ({
          type: row.funding_type,
          id: row.source_id,
          label: row.label,
          remainingLabel: row.is_unlimited
            ? "Unlimited"
            : row.funding_type === "package"
              ? `${row.remaining ?? 0} remaining`
              : `${row.used ?? 0} of ${row.quantity_total ?? 0} used`,
        }));

        if (sources.length > 0) {
          eligibleFundingSourcesByClientId[client.id] = sources;
        }
      }),
    );
  }

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      {errorBanner ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorBanner}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Scheduling
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Enroll Student
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
              Add a student to an existing group class. To schedule a brand-new class instance, use{" "}
              <a href="/app/schedule/new" className="underline">
                Create Class
              </a>{" "}
              instead.
            </p>
          </div>
        </div>
      </section>

      <EnrollStudentForm
        classes={classes}
        clients={clients}
        clientPackagesByClientId={clientPackagesByClientId}
        clientMembershipsByClientId={clientMembershipsByClientId}
        eligibleFundingSourcesByClientId={eligibleFundingSourcesByClientId}
        instructorSearchMode={!isBroadStaff}
        isBroadStaff={isBroadStaff}
      />
    </div>
  );
}
