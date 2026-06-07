import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import Link from "next/link";
import { notFound } from "next/navigation";

type Params = Promise<{
  token: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  status: string | null;
  skill_level: string | null;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string | null;
  status: string | null;
  starts_at: string;
  ends_at: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

type ClientPackageRow = {
  id: string;
  name_snapshot: string | null;
  active: boolean | null;
  expiration_date: string | null;
};

type ClientMembershipRow = {
  id: string;
  status: string | null;
  name_snapshot: string | null;
  current_period_end: string | null;
  ends_on: string | null;
};

function getInitials(firstName: string, lastName: string) {
  const first = firstName.trim().charAt(0).toUpperCase();
  const last = lastName.trim().charAt(0).toUpperCase();

  return `${first}${last}` || "DF";
}

function getSingle<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function appointmentTypeLabel(value: string | null | undefined) {
  if (value === "private_lesson") return "Private lesson";
  if (value === "group_class") return "Group class";
  if (value === "intro_lesson") return "Intro lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice / party";
  if (value === "floor_space_rental") return "Floor rental";

  return value ? value.replaceAll("_", " ") : "Appointment";
}

function statusClass(status: string | null | undefined) {
  if (status === "attended" || status === "completed") {
    return "bg-green-50 text-green-700";
  }

  if (status === "cancelled" || status === "no_show") {
    return "bg-rose-50 text-rose-700";
  }

  return "bg-amber-50 text-amber-700";
}

export default async function ClientIdentityPage({ params }: { params: Params }) {
  const { token } = await params;
  const supabase = await createClient();
  const { studioId } = await getCurrentStudioContext();

  const trimmedToken = token.trim();

  if (!trimmedToken) {
    notFound();
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select(
      "id, first_name, last_name, email, phone, photo_url, status, skill_level"
    )
    .eq("studio_id", studioId)
    .eq("client_qr_token", trimmedToken)
    .maybeSingle();

  if (clientError || !client) {
    notFound();
  }

  const typedClient = client as ClientRow;
  const clientName = `${typedClient.first_name} ${typedClient.last_name}`.trim();
  const initials = getInitials(typedClient.first_name, typedClient.last_name);

  const [
    appointmentsResult,
    packagesResult,
    membershipResult,
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        `
        id,
        title,
        appointment_type,
        status,
        starts_at,
        ends_at,
        instructors ( first_name, last_name ),
        rooms ( name )
      `
      )
      .eq("studio_id", studioId)
      .eq("client_id", typedClient.id)
      .gte("starts_at", todayStart.toISOString())
      .lt("starts_at", tomorrowStart.toISOString())
      .order("starts_at", { ascending: true }),
    supabase
      .from("client_packages")
      .select("id, name_snapshot, active, expiration_date")
      .eq("studio_id", studioId)
      .eq("client_id", typedClient.id)
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("client_memberships")
      .select("id, status, name_snapshot, current_period_end, ends_on")
      .eq("studio_id", studioId)
      .eq("client_id", typedClient.id)
      .in("status", ["active", "past_due", "unpaid", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const appointments = (appointmentsResult.data ?? []) as AppointmentRow[];
  const activePackages = (packagesResult.data ?? []) as ClientPackageRow[];
  const membership = (membershipResult.data ?? null) as ClientMembershipRow | null;

  return (
    <div className="space-y-8">
      <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,#0d1536_0%,#111b45_48%,#5b145e_100%)] p-5 text-white shadow-sm md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[28px] border border-white/20 bg-white/10 text-2xl font-semibold">
              {typedClient.photo_url ? (
                <img
                  src={typedClient.photo_url}
                  alt={`${clientName} headshot`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span>{initials}</span>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Client QR Identity
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                {clientName}
              </h1>
              <p className="mt-2 text-sm text-white/75">
                Staff-only identity screen for visual verification and same-day check-in review.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/app/clients/${typedClient.id}`}
              className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-[#111b45] hover:bg-white/90"
            >
              Open client profile
            </Link>
            <Link
              href={`/app/schedule/new?clientId=${typedClient.id}`}
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            >
              Book lesson
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Contact
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-[var(--brand-text)]">{typedClient.email ?? "Not saved"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Phone</dt>
              <dd className="font-medium text-[var(--brand-text)]">{typedClient.phone ?? "Not saved"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium text-[var(--brand-text)]">{typedClient.status ?? "Active"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Skill level</dt>
              <dd className="font-medium text-[var(--brand-text)]">{typedClient.skill_level ?? "Not set"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Membership / package status
          </p>

          <div className="mt-4 space-y-3">
            {membership ? (
              <div className="rounded-2xl bg-green-50 p-3 text-sm text-green-800">
                <p className="font-semibold">{membership.name_snapshot ?? "Active membership"}</p>
                <p className="mt-1 text-green-700">
                  Status: {membership.status ?? "active"}
                  {membership.current_period_end || membership.ends_on
                    ? ` · Through ${formatDate(membership.current_period_end ?? membership.ends_on)}`
                    : ""}
                </p>
              </div>
            ) : (
              <p className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
                No active membership found.
              </p>
            )}

            {activePackages.length > 0 ? (
              <div className="space-y-2">
                {activePackages.map((pkg) => (
                  <div
                    key={pkg.id}
                    className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-3 text-sm"
                  >
                    <p className="font-semibold text-[var(--brand-text)]">
                      {pkg.name_snapshot ?? "Active package"}
                    </p>
                    <p className="mt-1 text-slate-500">
                      {pkg.expiration_date ? `Expires ${formatDate(pkg.expiration_date)}` : "No expiration date"}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
                No active packages found.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-[28px] border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            Staff reminder
          </p>
          <p className="mt-3 text-sm leading-6 text-amber-800">
            This screen identifies the client only. Check-ins are still completed from the
            appointment, class, or event check-in flow until Client QR Check-In actions are added.
          </p>
        </div>
      </div>

      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Today’s eligible check-ins
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
              Same-day activity
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Each item is reviewed separately. Future check-in actions will appear here so staff can check the client into one activity at a time.
            </p>
          </div>
          <span className="rounded-full bg-[var(--brand-accent-soft)] px-3 py-1 text-sm font-semibold text-[var(--brand-accent-dark)]">
            {appointments.length} today
          </span>
        </div>

        <div className="mt-5 space-y-3">
          {appointments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
              No scheduled appointments were found for this client today.
            </div>
          ) : (
            appointments.map((appointment) => {
              const instructor = getSingle(appointment.instructors);
              const room = getSingle(appointment.rooms);
              const checkedIn = appointment.status === "attended" || appointment.status === "completed";

              return (
                <div
                  key={appointment.id}
                  className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[var(--brand-text)]">
                          {formatTime(appointment.starts_at)}
                          {appointment.ends_at ? ` – ${formatTime(appointment.ends_at)}` : ""}
                        </p>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClass(appointment.status)}`}>
                          {checkedIn ? "Already checked in" : appointment.status ?? "Scheduled"}
                        </span>
                      </div>

                      <p className="mt-2 text-sm font-medium text-slate-700">
                        {appointment.title || appointmentTypeLabel(appointment.appointment_type)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {appointmentTypeLabel(appointment.appointment_type)}
                        {instructor ? ` · ${[instructor.first_name, instructor.last_name].filter(Boolean).join(" ")}` : ""}
                        {room?.name ? ` · ${room.name}` : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/app/schedule/${appointment.id}`}
                        className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm hover:bg-[var(--brand-primary-soft)]"
                      >
                        Open appointment
                      </Link>
                      <Link
                        href={`/app/schedule/${appointment.id}/attendance`}
                        className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-2 text-sm font-semibold text-white hover:brightness-105"
                      >
                        Attendance
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
