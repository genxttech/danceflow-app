import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  CalendarPlus,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Mail,
  MessageSquareText,
  Phone,
  UserRound,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { canCreateAppointments, canEditAppointments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  addBookingRequestStaffNoteAction,
  updateBookingRequestStatusAction,
} from "../actions";

const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hourPart = part("hour");

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: hourPart === 24 ? 0 : hourPart,
    minute: part("minute"),
    second: part("second"),
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));

  return date.toISOString().slice(0, 10);
}

function getZonedWeekday(dateKey: string, timeZone: string) {
  const date = zonedDateTimeToUtcDate(dateKey, "12:00", timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function getLocalDayUtcRange(dateKey: string, timeZone: string) {
  const safeTimeZone = getStudioTimeZone(timeZone);
  const nextDateKey = addDaysToDateKey(dateKey, 1);

  return {
    startIso: zonedDateTimeToUtcIso(dateKey, "00:00", safeTimeZone),
    endIso: zonedDateTimeToUtcIso(nextDateKey, "00:00", safeTimeZone),
  };
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not requested";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function formatStudioTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

type SearchParams = Promise<{
  status?: string;
  success?: string;
  error?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
};

type BookingRequestRow = {
  id: string;
  client_id: string | null;
  appointment_id: string | null;
  instructor_id: string | null;
  source: string | null;
  status: string | null;
  appointment_type: string | null;
  title: string | null;
  requested_starts_at: string | null;
  requested_ends_at: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  dance_interests: string | null;
  notes: string | null;
  staff_note: string | null;
  reviewed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const REQUEST_STATUS_OPTIONS = [
  { value: "all", label: "All requests" },
  { value: "pending", label: "New" },
  { value: "in_review", label: "In Review" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "declined", label: "Declined" },
];

const ACTION_STATUSES = [
  { value: "in_review", label: "Mark In Review" },
  { value: "approved", label: "Approve" },
  { value: "scheduled", label: "Mark Scheduled" },
  { value: "declined", label: "Decline" },
];


function formatDateTime(value: string | null, timeZone: string) {
  return formatStudioDateTime(value, timeZone);
}

function formatDate(value: string | null, timeZone: string) {
  return formatStudioDate(value, timeZone);
}

function personName(firstName?: string | null, lastName?: string | null) {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || "Student";
}

function appointmentTypeLabel(value: string | null) {
  if (value === "private_lesson") return "Private lesson";
  if (value === "coaching") return "Coaching";
  if (value === "group_class") return "Group class question";
  if (value === "makeup_lesson") return "Make-up lesson";
  if (value === "floor_rental") return "Floor rental";
  if (value === "floor_space_rental") return "Floor rental";
  if (value === "scheduling_question") return "Scheduling question";
  if (!value) return "Scheduling request";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusLabel(value: string | null) {
  if (value === "pending") return "New";
  if (value === "in_review") return "In Review";
  if (value === "approved") return "Approved";
  if (value === "scheduled") return "Scheduled";
  if (value === "declined") return "Declined";
  return "New";
}

function statusTone(value: string | null) {
  if (value === "scheduled") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (value === "approved") return "border-sky-200 bg-sky-50 text-sky-700";
  if (value === "in_review") return "border-violet-200 bg-violet-50 text-violet-700";
  if (value === "declined") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function successMessage(value?: string) {
  if (value === "booking_request_updated") return "Booking request updated.";
  if (value === "booking_request_note_saved") return "Staff note saved.";
  return null;
}

function errorMessage(value?: string) {
  if (value === "booking_request_not_found") return "That booking request could not be found.";
  if (value === "booking_request_update_failed") return "Booking request could not be updated.";
  return null;
}

function notesLines(value: string | null) {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }

  const query = search.toString();
  return query ? `?${query}` : "";
}

export default async function ScheduleRequestsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const selectedStatus = resolvedSearchParams.status || "pending";
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
const role = context.studioRole ?? "";
  const supabase = await createClient();

  const { data: settingsRow } = await supabase
    .from("studio_settings")
    .select("timezone")
    .eq("studio_id", studioId)
    .maybeSingle();

  const studioTimeZone = getStudioTimeZone(
    (settingsRow as { timezone?: string | null } | null)?.timezone,
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const query = supabase
    .from("booking_requests")
    .select(`
      id,
      client_id,
      appointment_id,
      instructor_id,
      source,
      status,
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
      reviewed_at,
      created_at,
      updated_at
    `)
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (selectedStatus !== "all") {
    query.eq("status", selectedStatus);
  }

  const { data: requestRows, error: requestError } = await query;

  if (requestError) {
    throw new Error(`Failed to load booking requests: ${requestError.message}`);
  }

  const requests = (requestRows ?? []) as BookingRequestRow[];
  const clientIds = Array.from(
    new Set(requests.map((request) => request.client_id).filter((value): value is string => Boolean(value))),
  );
  const instructorIds = Array.from(
    new Set(requests.map((request) => request.instructor_id).filter((value): value is string => Boolean(value))),
  );

  let clientsById = new Map<string, ClientRow>();
  let instructorsById = new Map<string, InstructorRow>();

  if (clientIds.length > 0) {
    const { data: clientRows, error: clientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone")
      .eq("studio_id", studioId)
      .in("id", clientIds);

    if (clientError) {
      throw new Error(`Failed to load request clients: ${clientError.message}`);
    }

    clientsById = new Map(((clientRows ?? []) as ClientRow[]).map((client) => [client.id, client]));
  }

  if (instructorIds.length > 0) {
    const { data: instructorRows, error: instructorError } = await supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .in("id", instructorIds);

    if (instructorError) {
      throw new Error(`Failed to load request instructors: ${instructorError.message}`);
    }

    instructorsById = new Map(((instructorRows ?? []) as InstructorRow[]).map((instructor) => [instructor.id, instructor]));
  }
  const openRequests = requests.filter((request) =>
    ["pending", "in_review", "approved"].includes(request.status || "pending"),
  );
  const pendingCount = requests.filter((request) => (request.status || "pending") === "pending").length;
  const canManageRequests = canEditAppointments(role);
  const canCreateLesson = canCreateAppointments(role);
  const success = successMessage(resolvedSearchParams.success);
  const error = errorMessage(resolvedSearchParams.error);
  const returnTo = `/app/schedule/requests${buildQuery({
    status: selectedStatus !== "pending" ? selectedStatus : undefined,
  })}`;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                Student Requests
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Booking Request Review
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Review lesson, coaching, floor rental, and scheduling requests submitted from the student portal.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/app/schedule"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Schedule
              </Link>
              {canCreateLesson ? (
                <Link
                  href="/app/schedule/new"
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  New Appointment
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">New</p>
              <p className="mt-2 text-3xl font-semibold text-amber-950">{pendingCount}</p>
              <p className="mt-1 text-sm text-amber-900">Requests waiting for a staff response.</p>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">Open</p>
              <p className="mt-2 text-3xl font-semibold text-violet-950">{openRequests.length}</p>
              <p className="mt-1 text-sm text-violet-900">New, in-review, or approved requests.</p>
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Workflow</p>
              <p className="mt-2 text-lg font-semibold text-sky-950">Review → Approve → Schedule</p>
              <p className="mt-1 text-sm text-sky-900">Use Create Lesson to convert a request into an appointment.</p>
            </div>
          </div>
        </div>
      </section>

      {success ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {success}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
          {error}
        </div>
      ) : null}

      <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Request Queue
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Staff review list</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Filter by status, review student preferences, add a staff note, and move each request toward scheduling.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {REQUEST_STATUS_OPTIONS.map((option) => (
              <Link
                key={option.value}
                href={`/app/schedule/requests${buildQuery({
                  status: option.value !== "pending" ? option.value : undefined,
                })}`}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  selectedStatus === option.value || (!resolvedSearchParams.status && option.value === "pending")
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                }`}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-6 space-y-4">
          {requests.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
              <ClipboardList className="mx-auto h-10 w-10 text-slate-400" />
              <h3 className="mt-3 text-lg font-semibold text-slate-950">No booking requests here</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
                Student portal booking requests will appear here when students ask for lessons, coaching, make-up sessions, or scheduling help.
              </p>
            </div>
          ) : (
            requests.map((request) => {
              const client = request.client_id ? clientsById.get(request.client_id) ?? null : null;
              const instructor = request.instructor_id ? instructorsById.get(request.instructor_id) ?? null : null;
              const displayName = client
                ? personName(client.first_name, client.last_name)
                : personName(request.customer_first_name, request.customer_last_name);
              const email = request.customer_email || client?.email || null;
              const phone = request.customer_phone || client?.phone || null;
              const notes = notesLines(request.notes);
              const createAppointmentHref = client?.id
                ? `/app/schedule/new?clientId=${encodeURIComponent(client.id)}`
                : "/app/schedule/new";

              return (
                <article
                  key={request.id}
                  className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-[var(--brand-primary)]/40 hover:shadow-md"
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusTone(request.status)}`}>
                          {statusLabel(request.status)}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                          {appointmentTypeLabel(request.appointment_type)}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-500">
                          Submitted {formatDate(request.created_at, studioTimeZone)}
                        </span>
                      </div>

                      <h3 className="mt-3 text-xl font-semibold text-slate-950">
                        {request.title || `${displayName} requested scheduling help`}
                      </h3>

                      <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            <UserRound className="h-3.5 w-3.5" /> Student
                          </p>
                          <p className="mt-1 font-semibold text-slate-950">{displayName}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            <Clock3 className="h-3.5 w-3.5" /> Requested Time
                          </p>
                          <p className="mt-1 font-semibold text-slate-950">{formatDateTime(request.requested_starts_at, studioTimeZone)}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            <MessageSquareText className="h-3.5 w-3.5" /> Preference
                          </p>
                          <p className="mt-1 font-semibold text-slate-950">{request.dance_interests || "See notes"}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            <CalendarPlus className="h-3.5 w-3.5" /> Instructor
                          </p>
                          <p className="mt-1 font-semibold text-slate-950">
                            {instructor ? personName(instructor.first_name, instructor.last_name) : "No preference"}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <div className="rounded-2xl border border-slate-100 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Student details</p>
                          <div className="mt-3 space-y-2 text-sm text-slate-700">
                            {email ? (
                              <p className="flex items-center gap-2">
                                <Mail className="h-4 w-4 text-slate-400" /> {email}
                              </p>
                            ) : null}
                            {phone ? (
                              <p className="flex items-center gap-2">
                                <Phone className="h-4 w-4 text-slate-400" /> {phone}
                              </p>
                            ) : null}
                            {!email && !phone ? <p>No contact details on this request.</p> : null}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-100 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Request notes</p>
                          {notes.length > 0 ? (
                            <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                              {notes.map((line, index) => (
                                <li key={`${request.id}-note-${index}`}>{line}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-3 text-sm text-slate-600">No student notes were included.</p>
                          )}
                        </div>
                      </div>

                      {request.staff_note ? (
                        <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-4 text-sm leading-6 text-violet-950">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">Staff note</p>
                          <p className="mt-2 whitespace-pre-wrap">{request.staff_note}</p>
                        </div>
                      ) : null}
                    </div>

                    <aside className="w-full space-y-3 xl:w-80">
                      {canCreateLesson ? (
                        <Link
                          href={createAppointmentHref}
                          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary-hover)]"
                        >
                          <CalendarPlus className="h-4 w-4" /> Create Lesson
                        </Link>
                      ) : null}

                      {canManageRequests ? (
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-sm font-semibold text-slate-950">Update request</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {ACTION_STATUSES.map((option) => (
                              <form key={`${request.id}-${option.value}`} action={updateBookingRequestStatusAction}>
                                <input type="hidden" name="requestId" value={request.id} />
                                <input type="hidden" name="status" value={option.value} />
                                <input type="hidden" name="returnTo" value={returnTo} />
                                <input type="hidden" name="staffNote" value={request.staff_note ?? ""} />
                                <button
                                  type="submit"
                                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                                >
                                  {option.label}
                                </button>
                              </form>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {canManageRequests ? (
                        <form action={addBookingRequestStaffNoteAction} className="rounded-2xl border border-slate-200 bg-white p-4">
                          <input type="hidden" name="requestId" value={request.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <label className="text-sm font-semibold text-slate-950" htmlFor={`staffNote-${request.id}`}>
                            Staff note
                          </label>
                          <textarea
                            id={`staffNote-${request.id}`}
                            name="staffNote"
                            defaultValue={request.staff_note ?? ""}
                            rows={4}
                            className="mt-2 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-ring)]"
                            placeholder="Add scheduling notes, follow-up details, or internal context."
                          />
                          <button
                            type="submit"
                            className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                          >
                            Save Note
                          </button>
                        </form>
                      ) : (
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                          <AlertTriangle className="mb-2 h-5 w-5" />
                          You can view booking requests, but your role cannot update them.
                        </div>
                      )}
                    </aside>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-950 shadow-sm md:p-6">
        <div className="flex gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-emerald-600" />
          <div>
            <h2 className="font-semibold">Staff workflow tip</h2>
            <p className="mt-1">
              Mark a request In Review when staff starts working on it, Approve once the studio agrees to schedule it, then use Create Lesson to add it to the calendar. Mark it Scheduled after the appointment is created.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
