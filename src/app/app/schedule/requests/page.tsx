import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  XCircle,
} from "lucide-react";
import { canCreateAppointments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import {
  approveBookingRequestAction,
  declineBookingRequestAction,
} from "./actions";

type SearchParams = Promise<{
  status?: string;
  success?: string;
  error?: string;
}>;

type BookingRequestRow = {
  id: string;
  status: string;
  source: string;
  appointment_type: string;
  title: string | null;
  requested_starts_at: string;
  requested_ends_at: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  dance_interests: string | null;
  notes: string | null;
  staff_note: string | null;
  created_at: string;
  reviewed_at: string | null;
  appointment_id: string | null;
  clients:
    | { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }
    | { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[]
    | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

function firstRelated<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusBadgeClass(status: string) {
  if (status === "pending") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "declined") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function statusLabel(status: string) {
  if (status === "pending") return "Pending";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  if (status === "cancelled") return "Cancelled";
  return status.replaceAll("_", " ");
}

function sourceLabel(source: string) {
  if (source === "public_intro") return "Public intro request";
  if (source === "portal_schedule") return "Portal schedule request";
  return source.replaceAll("_", " ");
}

function appointmentTypeLabel(value: string) {
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "private_lesson") return "Private Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "group_class") return "Group Class";
  return value.replaceAll("_", " ");
}

function personName(request: BookingRequestRow) {
  const client = firstRelated(request.clients);
  const first = client?.first_name ?? request.customer_first_name ?? "";
  const last = client?.last_name ?? request.customer_last_name ?? "";
  return `${first} ${last}`.trim() || "Unknown client";
}

function instructorName(request: BookingRequestRow) {
  const instructor = firstRelated(request.instructors);
  if (!instructor) return "Any available instructor";
  return `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim() || "Instructor";
}

function roomName(request: BookingRequestRow) {
  const room = firstRelated(request.rooms);
  return room?.name || "No room selected";
}

export default async function ScheduleRequestsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const selectedStatus = query.status ?? "pending";

  const supabase = await createClient();
  const { studioId, studioRole } = await getCurrentStudioContext();
  const canReviewRequests = canCreateAppointments(studioRole);

  let requestsQuery = supabase
    .from("booking_requests")
    .select(`
      id,
      status,
      source,
      appointment_type,
      title,
      requested_starts_at,
      requested_ends_at,
      customer_first_name,
      customer_last_name,
      customer_email,
      customer_phone,
      dance_interests,
      notes,
      staff_note,
      created_at,
      reviewed_at,
      appointment_id,
      clients(id, first_name, last_name, email, phone),
      instructors(first_name, last_name),
      rooms(name)
    `)
    .eq("studio_id", studioId)
    .order("requested_starts_at", { ascending: true });

  if (selectedStatus !== "all") {
    requestsQuery = requestsQuery.eq("status", selectedStatus);
  }

  const { data: requests, error } = await requestsQuery;
  const typedRequests = (requests ?? []) as BookingRequestRow[];

  const { data: statusRows } = await supabase
    .from("booking_requests")
    .select("status")
    .eq("studio_id", studioId);

  const allStatuses = ((statusRows ?? []) as { status: string | null }[]).map(
    (row) => row.status ?? "",
  );

  const pendingCount = allStatuses.filter((status) => status === "pending").length;
  const approvedCount = allStatuses.filter((status) => status === "approved").length;
  const declinedCount = allStatuses.filter((status) => status === "declined").length;

  return (
    <main className="min-h-screen bg-[var(--brand-page-bg)] px-4 py-8 text-[var(--brand-foreground)] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-gradient-to-br from-[var(--brand-primary)] via-[var(--brand-primary)] to-[var(--brand-accent)] px-6 py-8 text-white md:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">
                  Scheduling
                </p>
                <h1 className="mt-2 text-3xl font-bold">Booking Requests</h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-white/85">
                  Review public intro lesson and portal schedule requests before they become appointments.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/app/schedule"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Schedule
                </Link>
                <Link
                  href="/app/schedule/new"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  New Appointment
                </Link>
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <div className="flex items-center gap-2 text-amber-900">
                  <Clock3 className="h-5 w-5" />
                  <h2 className="font-semibold">Pending</h2>
                </div>
                <p className="mt-2 text-3xl font-bold text-amber-950">{pendingCount}</p>
                <p className="mt-1 text-sm text-amber-900">Need staff review.</p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                <div className="flex items-center gap-2 text-emerald-900">
                  <CheckCircle2 className="h-5 w-5" />
                  <h2 className="font-semibold">Approved</h2>
                </div>
                <p className="mt-2 text-3xl font-bold text-emerald-950">{approvedCount}</p>
                <p className="mt-1 text-sm text-emerald-900">Converted to appointments.</p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                <div className="flex items-center gap-2 text-rose-900">
                  <XCircle className="h-5 w-5" />
                  <h2 className="font-semibold">Declined</h2>
                </div>
                <p className="mt-2 text-3xl font-bold text-rose-950">{declinedCount}</p>
                <p className="mt-1 text-sm text-rose-900">Reviewed but not scheduled.</p>
              </div>
            </div>
          </div>
        </section>

        {query.success ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            {query.success === "approved"
              ? "Booking request approved and appointment created."
              : "Booking request declined."}
          </div>
        ) : null}

        {query.error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            {decodeURIComponent(query.error)}
          </div>
        ) : null}

        <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Request queue</h2>
              <p className="mt-1 text-sm text-slate-600">
                Approving a request creates a scheduled appointment. Declining keeps the history on file.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                ["pending", "Pending"],
                ["approved", "Approved"],
                ["declined", "Declined"],
                ["all", "All"],
              ].map(([value, label]) => (
                <Link
                  key={value}
                  href={`/app/schedule/requests?status=${value}`}
                  className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                    selectedStatus === value
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>

          {error ? (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              Could not load booking requests: {error.message}
            </div>
          ) : typedRequests.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
              <CalendarDays className="mx-auto h-10 w-10 text-slate-400" />
              <h3 className="mt-3 text-lg font-semibold text-slate-950">No requests found</h3>
              <p className="mt-2 text-sm text-slate-600">
                New public intro requests will appear here when prospective students submit a time.
              </p>
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              {typedRequests.map((request) => {
                const client = firstRelated(request.clients);
                const contactEmail = client?.email ?? request.customer_email;
                const contactPhone = client?.phone ?? request.customer_phone;
                const isPending = request.status === "pending";

                return (
                  <article
                    key={request.id}
                    className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                              request.status,
                            )}`}
                          >
                            {statusLabel(request.status)}
                          </span>
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                            {sourceLabel(request.source)}
                          </span>
                          <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                            {appointmentTypeLabel(request.appointment_type)}
                          </span>
                        </div>

                        <h3 className="mt-3 text-xl font-semibold text-slate-950">
                          {personName(request)}
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Requested {formatDateTime(request.requested_starts_at)} –{" "}
                          {formatShortDateTime(request.requested_ends_at)}
                        </p>

                        <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
                          <div className="rounded-xl bg-slate-50 p-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Instructor
                            </p>
                            <p className="mt-1 font-medium text-slate-950">
                              {instructorName(request)}
                            </p>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Room
                            </p>
                            <p className="mt-1 font-medium text-slate-950">
                              {roomName(request)}
                            </p>
                          </div>
                        </div>

                        <div className="mt-4 space-y-1 text-sm text-slate-600">
                          {contactEmail ? <p>Email: {contactEmail}</p> : null}
                          {contactPhone ? <p>Phone: {contactPhone}</p> : null}
                          {request.dance_interests ? (
                            <p>Interests: {request.dance_interests}</p>
                          ) : null}
                          {request.notes ? <p>Notes: {request.notes}</p> : null}
                          {request.staff_note ? (
                            <p className="rounded-xl bg-slate-50 p-3 text-slate-700">
                              Staff note: {request.staff_note}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      {isPending && canReviewRequests ? (
                        <div className="w-full max-w-md shrink-0 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-start gap-2 text-sm text-amber-800">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p>
                              Approval will check for conflicts again before creating the appointment.
                            </p>
                          </div>

                          <form action={approveBookingRequestAction} className="space-y-3">
                            <input type="hidden" name="requestId" value={request.id} />
                            <label className="block text-sm font-medium text-slate-700">
                              Staff note
                              <textarea
                                name="staffNote"
                                rows={2}
                                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                                placeholder="Optional confirmation note"
                              />
                            </label>
                            <button
                              type="submit"
                              className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95"
                            >
                              Approve and create appointment
                            </button>
                          </form>

                          <form action={declineBookingRequestAction} className="space-y-3">
                            <input type="hidden" name="requestId" value={request.id} />
                            <label className="block text-sm font-medium text-slate-700">
                              Decline reason
                              <textarea
                                name="staffNote"
                                rows={2}
                                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                                placeholder="Optional internal note"
                              />
                            </label>
                            <button
                              type="submit"
                              className="w-full rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              Decline request
                            </button>
                          </form>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
