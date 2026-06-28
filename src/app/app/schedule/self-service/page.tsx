import Link from "next/link";
import { redirect } from "next/navigation";
import { canCreateAppointments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioTimeZone } from "@/lib/booking/selfServiceAvailability";
import { createClient } from "@/lib/supabase/server";
import {
  approveStudentBookingActionRequest,
  declineStudentBookingActionRequest,
} from "./actions";

type SearchParams = Promise<{
  status?: string;
  success?: string;
  error?: string;
}>;

type ActionRequestRow = {
  id: string;
  action_type: string;
  mode: string;
  status: string;
  requested_starts_at: string | null;
  requested_ends_at: string | null;
  previous_starts_at: string | null;
  previous_ends_at: string | null;
  lesson_type: string | null;
  reason: string | null;
  created_at: string;
  clients:
    | { first_name: string | null; last_name: string | null; email: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null }[]
    | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

function firstItem<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatName(
  value:
    | { first_name: string | null; last_name: string | null; email?: string | null }
    | null
    | undefined
) {
  if (!value) return "Unknown";
  const fullName = `${value.first_name ?? ""} ${value.last_name ?? ""}`.trim();
  return fullName || value.email || "Unknown";
}

function formatDateTime(value: string | null, timeZone: string) {
  if (!value) return "Not selected";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function typeLabel(value: string | null) {
  if (!value) return "Lesson";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "pending") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "executed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "declined") return "border-rose-200 bg-rose-50 text-rose-800";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function actionBadgeClass(actionType: string) {
  if (actionType === "cancel") return "bg-rose-50 text-rose-700";
  if (actionType === "reschedule") return "bg-violet-50 text-violet-700";
  return "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]";
}

export default async function SelfServiceScheduleReviewPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const context = await getCurrentStudioContext();

  if (!canCreateAppointments(context.studioRole ?? "")) {
    redirect("/app/schedule");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const status = resolvedSearchParams.status || "pending";
  const supabase = await createClient();

  const [{ data: settings }, { data: requests, error }] = await Promise.all([
    supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", context.studioId)
      .maybeSingle<{ timezone: string | null }>(),
    supabase
      .from("student_booking_action_requests")
      .select(`
        id,
        action_type,
        mode,
        status,
        requested_starts_at,
        requested_ends_at,
        previous_starts_at,
        previous_ends_at,
        lesson_type,
        reason,
        created_at,
        clients (
          first_name,
          last_name,
          email
        ),
        instructors:instructor_id (
          first_name,
          last_name
        ),
        rooms:room_id (
          name
        )
      `)
      .eq("studio_id", context.studioId)
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (error) {
    throw new Error(`Failed to load self-service requests: ${error.message}`);
  }

  const studioTimeZone = getStudioTimeZone(settings?.timezone);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
                Schedule
              </p>
              <h1 className="mt-1 text-2xl font-semibold">
                Schedule Requests
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                Review student booking, reschedule, and cancellation requests before they become appointments.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/app/schedule/self-service/availability"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
              >
                Manage availability
              </Link>
              <Link
                href="/app/schedule"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
              >
                Back to schedule
              </Link>
            </div>
          </div>
        </div>
      </section>

      {resolvedSearchParams.error ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {resolvedSearchParams.error}
        </p>
      ) : null}

      {resolvedSearchParams.success ? (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
          Request {resolvedSearchParams.success}.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {["pending", "executed", "declined", "failed"].map((item) => (
          <Link
            key={item}
            href={`/app/schedule/self-service?status=${item}`}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold capitalize transition ${
              status === item
                ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                : "border-slate-300 bg-white text-slate-700 hover:border-[var(--brand-primary)]"
            }`}
          >
            {item.replaceAll("_", " ")}
          </Link>
        ))}
      </div>

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm ring-1 ring-black/[0.02]">
        {requests?.length ? (
          <div className="divide-y divide-slate-200">
            {(requests as ActionRequestRow[]).map((request) => {
              const client = firstItem(request.clients);
              const instructor = firstItem(request.instructors);
              const room = firstItem(request.rooms);

              return (
                <div key={request.id} className="grid gap-4 p-5 lg:grid-cols-[1fr_auto]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-slate-950">
                        {formatName(client)}
                      </h2>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(request.status)}`}>
                        {request.status.replaceAll("_", " ")}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${actionBadgeClass(request.action_type)}`}>
                        {request.action_type.replaceAll("_", " ")}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                        {request.mode.replaceAll("_", " ")}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                        {typeLabel(request.lesson_type)}
                      </span>
                    </div>

                    <dl className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
                      <div>
                        <dt className="font-medium text-slate-900">
                          {request.action_type === "cancel" ? "Current time" : "Requested time"}
                        </dt>
                        <dd>
                          {formatDateTime(
                            request.requested_starts_at ?? request.previous_starts_at,
                            studioTimeZone
                          )}
                        </dd>
                      </div>
                      {request.previous_starts_at ? (
                        <div>
                          <dt className="font-medium text-slate-900">Previous time</dt>
                          <dd>{formatDateTime(request.previous_starts_at, studioTimeZone)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="font-medium text-slate-900">Instructor</dt>
                        <dd>{formatName(instructor)}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-900">Room</dt>
                        <dd>{room?.name || "No room selected"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-900">Submitted</dt>
                        <dd>{formatDateTime(request.created_at, studioTimeZone)}</dd>
                      </div>
                    </dl>

                    {request.reason ? (
                      <p className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                        {request.reason}
                      </p>
                    ) : null}
                  </div>

                  {request.status === "pending" ? (
                    <div className="flex flex-col gap-2 lg:w-48">
                      <form action={approveStudentBookingActionRequest}>
                        <input type="hidden" name="actionRequestId" value={request.id} />
                        <button className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95">
                          Approve
                        </button>
                      </form>

                      <form action={declineStudentBookingActionRequest} className="space-y-2">
                        <input type="hidden" name="actionRequestId" value={request.id} />
                        <input
                          name="reviewNote"
                          placeholder="Optional decline note"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        />
                        <button className="w-full rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                          Decline
                        </button>
                      </form>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-slate-600">
            No schedule requests found for this status.
          </p>
        )}
      </div>
    </div>
  );
}
