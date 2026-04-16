import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  cancelAppointmentAction,
  deleteLessonRecapAction,
  deleteLessonRecapVideoAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
  markFloorRentalWaivedAction,
  recordFloorRentalPaymentAction,
  upsertLessonRecapAction,
  uploadLessonRecapVideoAction,
} from "../actions";
import { summarizeClientPackageItems } from "@/lib/utils/packageSummary";
import {
  canEditAppointments,
  canMarkAttendance,
} from "@/lib/auth/permissions";

type Params = Promise<{
  id: string;
}>;

type ClientPackageItem = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total: number | null;
  is_unlimited: boolean;
};

type PackageHealth =
  | "healthy"
  | "low_balance"
  | "depleted"
  | "inactive"
  | "unknown";

type AppointmentRow = {
  id: string;
  title: string | null;
  notes: string | null;
  appointment_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  client_package_id: string | null;
  price_amount: number | null;
  payment_status: string | null;
  is_recurring: boolean;
  recurrence_series_id: string | null;
  created_at: string | null;
  clients:
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null;
  instructors:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null;
  rooms:
    | { id?: string; name: string }
    | { id?: string; name: string }[]
    | null;
  client_packages:
    | {
        id?: string;
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }
    | {
        id?: string;
        name_snapshot: string;
        active: boolean | null;
        client_package_items: ClientPackageItem[];
      }[]
    | null;
};

type PaymentRow = {
  id: string;
  amount: number | null;
  payment_method: string | null;
  status: string | null;
  paid_at: string | null;
  notes: string | null;
};

type LessonRecapRow = {
  id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean;
  created_at: string;
  updated_at: string;
  video_storage_path: string | null;
  video_original_name: string | null;
  video_mime_type: string | null;
  video_size_bytes: number | null;
  video_uploaded_at: string | null;
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateOnly(value: string) {
  return new Date(value).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimeOnly(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "coaching") return "Coaching";
  if (value === "practice_party") return "Practice Party";
  if (value === "event") return "Event";
  if (value === "floor_space_rental") return "Floor Space Rental";
  return value.replaceAll("_", " ");
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "no_show") return "bg-amber-50 text-amber-700";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700";
  return "bg-slate-100 text-slate-700";
}

function appointmentTypeBadgeClass(type: string) {
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700";
  if (type === "group_class") return "bg-green-50 text-green-700";
  if (type === "coaching") return "bg-purple-50 text-purple-700";
  if (type === "practice_party") return "bg-amber-50 text-amber-700";
  if (type === "event") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function paymentStatusLabel(value: string | null) {
  const normalized = value ?? "unpaid";
  if (normalized === "unpaid") return "Unpaid";
  if (normalized === "partial") return "Partially Paid";
  if (normalized === "paid") return "Paid";
  if (normalized === "waived") return "Waived";
  if (normalized === "refunded") return "Refunded";
  return normalized.replaceAll("_", " ");
}

function paymentStatusBadgeClass(value: string | null) {
  const normalized = value ?? "unpaid";
  if (normalized === "paid") return "bg-green-50 text-green-700";
  if (normalized === "partial") return "bg-amber-50 text-amber-700";
  if (normalized === "waived") return "bg-blue-50 text-blue-700";
  if (normalized === "refunded") return "bg-purple-50 text-purple-700";
  return "bg-slate-100 text-slate-700";
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function getClientName(
  value:
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getClientId(
  value:
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client?.id ?? null;
}

function getClientReferralSource(
  value:
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }
    | {
        id?: string;
        first_name: string;
        last_name: string;
        referral_source?: string | null;
      }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client?.referral_source ?? null;
}

function getInstructorName(
  value:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "Unassigned";
}

function getRoomName(
  value: { id?: string; name: string } | { id?: string; name: string }[] | null
) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getLowestRemainingValue(items: ClientPackageItem[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number"
  );

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)));
}

function getPackageHealth(
  pkg: {
    active?: boolean | null;
    client_package_items?: ClientPackageItem[] | null;
  } | null
): PackageHealth {
  if (!pkg) return "unknown";
  if (pkg.active === false) return "inactive";

  const items = pkg.client_package_items ?? [];
  const lowestRemaining = getLowestRemainingValue(items);

  if (lowestRemaining === null) return "healthy";
  if (lowestRemaining <= 0) return "depleted";
  if (lowestRemaining === 1) return "low_balance";

  return "healthy";
}

function packageHealthLabel(health: PackageHealth) {
  if (health === "healthy") return "Pkg Active";
  if (health === "low_balance") return "Pkg Low";
  if (health === "depleted") return "Pkg Empty";
  if (health === "inactive") return "Pkg Inactive";
  return "Pkg Unknown";
}

function packageHealthClass(health: PackageHealth) {
  if (health === "healthy") return "bg-green-50 text-green-700";
  if (health === "low_balance") return "bg-amber-50 text-amber-700";
  if (health === "depleted") return "bg-red-50 text-red-700";
  if (health === "inactive") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

export default async function AppointmentDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow } = await supabase
    .from("user_studio_roles")
    .select("studio_id, role")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (!roleRow) {
    redirect("/login");
  }

  const role = roleRow.role as string;
  const studioId = roleRow.studio_id;

  const [{ data: appointment, error }, { data: lessonRecap }, { data: floorRentalPayments }] = await Promise.all([
    supabase
      .from("appointments")
      .select(`
        id,
        title,
        notes,
        appointment_type,
        status,
        starts_at,
        ends_at,
        client_package_id,
        price_amount,
        payment_status,
        is_recurring,
        recurrence_series_id,
        created_at,
        clients ( id, first_name, last_name, referral_source ),
        instructors ( id, first_name, last_name ),
        rooms ( id, name ),
        client_packages (
          id,
          name_snapshot,
          active,
          client_package_items (
            usage_type,
            quantity_remaining,
            quantity_total,
            is_unlimited
          )
        )
      `)
      .eq("studio_id", studioId)
      .eq("id", id)
      .single(),
    supabase
      .from("lesson_recaps")
      .select(`
        id,
        summary,
        homework,
        next_focus,
        visible_to_client,
        created_at,
        updated_at,
        video_storage_path,
        video_original_name,
        video_mime_type,
        video_size_bytes,
        video_uploaded_at
      `)
      .eq("studio_id", studioId)
      .eq("appointment_id", id)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("id, amount, payment_method, status, paid_at, notes")
      .eq("studio_id", studioId)
      .eq("appointment_id", id)
      .order("paid_at", { ascending: false }),
  ]);

  if (error || !appointment) {
    throw new Error(`Failed to load appointment: ${error?.message ?? "Not found"}`);
  }

  const typedAppointment = appointment as AppointmentRow;
  const typedLessonRecap = (lessonRecap ?? null) as LessonRecapRow | null;
  const typedPayments = (floorRentalPayments ?? []) as PaymentRow[];

  const pkg = Array.isArray(typedAppointment.client_packages)
    ? typedAppointment.client_packages[0]
    : typedAppointment.client_packages;

  const packageHealth = pkg ? getPackageHealth(pkg) : null;
  const clientName = getClientName(typedAppointment.clients);
  const clientId = getClientId(typedAppointment.clients);
  const instructorName = getInstructorName(typedAppointment.instructors);
  const roomName = getRoomName(typedAppointment.rooms);
  const referralSource = getClientReferralSource(typedAppointment.clients);
  const returnTo = `/app/schedule/${typedAppointment.id}`;
  const totalPaid = typedPayments
    .filter((payment) => payment.status === "completed")
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
  const rentalAmount = Number(typedAppointment.price_amount ?? 0);
  const balanceDue = Math.max(rentalAmount - totalPaid, 0);
  const effectivePaymentStatus =
    typedAppointment.payment_status ??
    (rentalAmount <= 0
      ? "unpaid"
      : totalPaid <= 0
      ? "unpaid"
      : totalPaid < rentalAmount
      ? "partial"
      : "paid");

  const isPublicIntro =
    typedAppointment.appointment_type === "intro_lesson" &&
    referralSource === "public_intro_booking";

  const isFloorRental = typedAppointment.appointment_type === "floor_space_rental";
  const isPrivateLesson = typedAppointment.appointment_type === "private_lesson";

  const isFinalStatus =
    typedAppointment.status === "attended" ||
    typedAppointment.status === "cancelled" ||
    typedAppointment.status === "no_show";

  const canEdit = canEditAppointments(role);
  const canTakeAttendance = canMarkAttendance(role) && !isFloorRental;
  const showAttendanceActions = !isFinalStatus && canTakeAttendance;

  const canShowLessonRecapCard = isPrivateLesson;
  const canEditLessonRecap = canEdit && typedAppointment.status === "attended";
  const hasLessonRecap = !!typedLessonRecap;

  let lessonRecapVideoUrl: string | null = null;

  if (typedLessonRecap?.video_storage_path) {
    const { data: signedVideo } = await supabase.storage
      .from("lesson-recap-videos")
      .createSignedUrl(typedLessonRecap.video_storage_path, 60 * 60);

    lessonRecapVideoUrl = signedVideo?.signedUrl ?? null;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-3xl font-semibold tracking-tight">
              {isFloorRental ? "Floor Rental Detail" : "Appointment Detail"}
            </h2>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                typedAppointment.status
              )}`}
            >
              {typedAppointment.status.replaceAll("_", " ")}
            </span>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${appointmentTypeBadgeClass(
                typedAppointment.appointment_type
              )}`}
            >
              {isFloorRental
                ? "Floor Rental"
                : appointmentTypeLabel(typedAppointment.appointment_type)}
            </span>

            {typedAppointment.is_recurring ? (
              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                Recurring
              </span>
            ) : null}

            {isPublicIntro ? (
              <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                Public Intro
              </span>
            ) : null}

            {!isFloorRental && pkg && packageHealth ? (
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                  packageHealth
                )}`}
              >
                {packageHealthLabel(packageHealth)}
              </span>
            ) : null}

            {isFloorRental ? (
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                  effectivePaymentStatus
                )}`}
              >
                {paymentStatusLabel(effectivePaymentStatus)}
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-slate-600">
            {typedAppointment.title || appointmentTypeLabel(typedAppointment.appointment_type)}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/schedule"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Schedule
          </Link>

          {!isFloorRental ? (
            <Link
              href={`/app/schedule/${typedAppointment.id}/attendance`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Attendance
            </Link>
          ) : null}

          {!isFinalStatus && canEdit ? (
            <Link
              href={`/app/schedule/${typedAppointment.id}/edit`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              {isFloorRental ? "Edit Rental" : "Edit Appointment"}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-xl font-semibold text-slate-900">Overview</h3>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Client</p>
                <div className="mt-1">
                  {clientId ? (
                    <Link
                      href={`/app/clients/${clientId}`}
                      className="text-sm font-medium text-slate-900 underline"
                    >
                      {clientName}
                    </Link>
                  ) : (
                    <p className="text-sm font-medium text-slate-900">{clientName}</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">
                  {isFloorRental ? "Rental Type" : "Appointment Type"}
                </p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {appointmentTypeLabel(typedAppointment.appointment_type)}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Date</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {formatDateOnly(typedAppointment.starts_at)}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Time</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {formatTimeOnly(typedAppointment.starts_at)} -{" "}
                  {formatTimeOnly(typedAppointment.ends_at)}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Instructor</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {instructorName}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Room</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{roomName}</p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Status</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {typedAppointment.status.replaceAll("_", " ")}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Created</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {typedAppointment.created_at
                    ? formatDateTime(typedAppointment.created_at)
                    : "—"}
                </p>
              </div>
            </div>

            {typedAppointment.notes ? (
              <div className="mt-6 border-t pt-6">
                <p className="text-xs uppercase tracking-wide text-slate-400">Notes</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                  {typedAppointment.notes}
                </p>
              </div>
            ) : null}
          </div>

          {canShowLessonRecapCard ? (
            <div className="rounded-2xl border bg-white p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-xl font-semibold text-slate-900">Lesson Recap</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Add notes the client can review later in their portal.
                  </p>
                </div>

                {hasLessonRecap ? (
                  <span
                    className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ${
                      typedLessonRecap.visible_to_client
                        ? "bg-green-50 text-green-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {typedLessonRecap.visible_to_client
                      ? "Visible to client"
                      : "Hidden from client"}
                  </span>
                ) : null}
              </div>

              {typedAppointment.status !== "attended" ? (
                <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                  Lesson recap becomes available after the lesson is marked attended.
                </div>
              ) : null}

              {typedAppointment.status === "attended" && hasLessonRecap ? (
                <div className="mt-5 space-y-5 rounded-xl border border-slate-200 bg-slate-50 p-5">
                  {typedLessonRecap.summary ? (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Summary
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                        {typedLessonRecap.summary}
                      </p>
                    </div>
                  ) : null}

                  {typedLessonRecap.homework ? (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Practice Before Next Lesson
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                        {typedLessonRecap.homework}
                      </p>
                    </div>
                  ) : null}

                  {typedLessonRecap.next_focus ? (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">
                        Next Lesson Focus
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                        {typedLessonRecap.next_focus}
                      </p>
                    </div>
                  ) : null}

                  <div className="border-t pt-4 text-xs text-slate-500">
                    Last updated {formatDateTime(typedLessonRecap.updated_at)}
                  </div>
                </div>
              ) : null}

              {canEditLessonRecap ? (
                <div className="mt-5 space-y-4">
                  <form action={upsertLessonRecapAction} className="space-y-4">
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={typedAppointment.id}
                    />
                    <input type="hidden" name="returnTo" value={returnTo} />

                    <div>
                      <label
                        htmlFor="summary"
                        className="text-sm font-medium text-slate-900"
                      >
                        Lesson summary
                      </label>
                      <textarea
                        id="summary"
                        name="summary"
                        defaultValue={typedLessonRecap?.summary ?? ""}
                        rows={4}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-300"
                        placeholder="What did you work on in this lesson?"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="homework"
                        className="text-sm font-medium text-slate-900"
                      >
                        Practice before next lesson
                      </label>
                      <textarea
                        id="homework"
                        name="homework"
                        defaultValue={typedLessonRecap?.homework ?? ""}
                        rows={3}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-300"
                        placeholder="What should the client practice on their own?"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="nextFocus"
                        className="text-sm font-medium text-slate-900"
                      >
                        Next lesson focus
                      </label>
                      <textarea
                        id="nextFocus"
                        name="nextFocus"
                        defaultValue={typedLessonRecap?.next_focus ?? ""}
                        rows={3}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-slate-300"
                        placeholder="What should be the focus next time?"
                      />
                    </div>

                    <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
                      <input
                        type="checkbox"
                        name="visibleToClient"
                        defaultChecked={typedLessonRecap?.visible_to_client ?? true}
                        className="mt-1"
                      />
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          Visible to client
                        </p>
                        <p className="text-xs text-slate-500">
                          When enabled, this recap will appear in the client portal.
                        </p>
                      </div>
                    </label>

                    <button
                      type="submit"
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      {hasLessonRecap ? "Save Recap" : "Add Recap"}
                    </button>
                  </form>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-900">
                          Lesson Video
                        </h4>
                        <p className="text-xs text-slate-500">
                          Upload a short lesson video for the client portal.
                        </p>
                      </div>

                      {typedLessonRecap?.video_uploaded_at ? (
                        <span className="text-xs text-slate-500">
                          Uploaded {formatDateTime(typedLessonRecap.video_uploaded_at)}
                        </span>
                      ) : null}
                    </div>

                    {typedLessonRecap?.video_original_name ? (
                      <div className="mt-4 rounded-xl border bg-white px-4 py-3 text-sm text-slate-700">
                        Current video:{" "}
                        <span className="font-medium">
                          {typedLessonRecap.video_original_name}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-dashed bg-white px-4 py-3 text-sm text-slate-500">
                        No video uploaded yet.
                      </div>
                    )}

                    {lessonRecapVideoUrl ? (
                      <div className="mt-4 overflow-hidden rounded-2xl border bg-black">
                        <video
                          controls
                          preload="metadata"
                          className="w-full"
                          src={lessonRecapVideoUrl}
                        />
                      </div>
                    ) : null}

                    <form
                      action={uploadLessonRecapVideoAction}
                      className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
                    >
                      <input
                        type="hidden"
                        name="appointmentId"
                        value={typedAppointment.id}
                      />
                      <input type="hidden" name="returnTo" value={returnTo} />

                      <div className="flex-1">
                        <label
                          htmlFor="lessonVideo"
                          className="text-sm font-medium text-slate-900"
                        >
                          Upload video
                        </label>
                        <input
                          id="lessonVideo"
                          name="lessonVideo"
                          type="file"
                          accept="video/mp4,video/webm,video/quicktime"
                          className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        />
                        <p className="mt-2 text-xs text-slate-500">
                          Accepted: MP4, WebM, MOV. Max size: 50 MB.
                        </p>
                      </div>

                      <button
                        type="submit"
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                      >
                        {typedLessonRecap?.video_storage_path
                          ? "Replace Video"
                          : "Upload Video"}
                      </button>
                    </form>

                    {typedLessonRecap?.video_storage_path ? (
                      <form action={deleteLessonRecapVideoAction} className="mt-3">
                        <input
                          type="hidden"
                          name="appointmentId"
                          value={typedAppointment.id}
                        />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <button
                          type="submit"
                          className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                        >
                          Remove Video
                        </button>
                      </form>
                    ) : null}
                  </div>

                  {hasLessonRecap ? (
                    <form action={deleteLessonRecapAction}>
                      <input
                        type="hidden"
                        name="appointmentId"
                        value={typedAppointment.id}
                      />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button
                        type="submit"
                        className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                      >
                        Delete Recap
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-xl font-semibold text-slate-900">
              {isFloorRental ? "Floor Rental Rules" : "Workflow Notes"}
            </h3>

            <div className="mt-5 space-y-3 text-sm text-slate-600">
              {isFloorRental ? (
                <>
                  <p>
                    This booking is an independent instructor floor space rental.
                  </p>
                  <p>
                    It does not deduct from lesson packages and does not use the standard lesson attendance workflow.
                  </p>
                  <p>
                    Instructor and room may still appear here when used for schedule visibility and internal tracking.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Standard lesson actions are available while the appointment is still active.
                  </p>

                  {typedAppointment.is_recurring ? (
                    <p>
                      This is part of a recurring series. Attendance applies per lesson, and cancellation or edit workflows may support single-lesson or series behavior depending on the action used.
                    </p>
                  ) : null}

                  {isPublicIntro ? (
                    <p>
                      This intro lesson originated from the public intro booking flow.
                    </p>
                  ) : null}

                  {isPrivateLesson ? (
                    <p>
                      Private lessons can include a lesson recap once the lesson has been marked attended.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-xl font-semibold text-slate-900">
              {isFloorRental ? "Package Impact" : "Package"}
            </h3>

            <div className="mt-5">
              {isFloorRental ? (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-4 text-sm text-indigo-800">
                  Floor space rentals do not use lesson packages and do not deduct any balance.
                </div>
              ) : pkg ? (
                <>
                  <p className="text-sm font-medium text-slate-900">
                    {pkg.name_snapshot}
                  </p>

                  <p className="mt-2 text-sm text-slate-600">
                    {summarizeClientPackageItems(pkg.client_package_items ?? [])}
                  </p>

                  {packageHealth ? (
                    <div className="mt-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                          packageHealth
                        )}`}
                      >
                        {packageHealthLabel(packageHealth)}
                      </span>
                    </div>
                  ) : null}

                  {packageHealth && packageHealth !== "healthy" ? (
                    <p className="mt-3 text-xs text-slate-500">
                      {packageHealth === "low_balance"
                        ? "Linked package is running low."
                        : packageHealth === "depleted"
                        ? "Linked package has no remaining balance."
                        : packageHealth === "inactive"
                        ? "Linked package is inactive."
                        : ""}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-slate-500">No package linked.</p>
              )}
            </div>
          </div>

          {isFloorRental ? (
            <div className="rounded-2xl border bg-white p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-slate-900">Payment</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Track rental billing for staff checkout and manual payments.
                  </p>
                </div>

                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                    effectivePaymentStatus
                  )}`}
                >
                  {paymentStatusLabel(effectivePaymentStatus)}
                </span>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Rental Amount
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {rentalAmount > 0 ? formatCurrency(rentalAmount) : "Not set"}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Paid
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {formatCurrency(totalPaid)}
                  </p>
                </div>

                <div className="rounded-xl border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Balance Due
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {formatCurrency(balanceDue)}
                  </p>
                </div>
              </div>

              <form action={recordFloorRentalPaymentAction} className="mt-5 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="amount" className="text-sm font-medium text-slate-900">
                      Record payment amount
                    </label>
                    <input
                      id="amount"
                      name="amount"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={balanceDue > 0 ? String(balanceDue) : ""}
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      placeholder="0.00"
                    />
                  </div>

                  <div>
                    <label htmlFor="paymentMethod" className="text-sm font-medium text-slate-900">
                      Payment method
                    </label>
                    <select
                      id="paymentMethod"
                      name="paymentMethod"
                      defaultValue="card"
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      <option value="card">Card</option>
                      <option value="cash">Cash</option>
                      <option value="check">Check</option>
                      <option value="ach">ACH</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="paymentNotes" className="text-sm font-medium text-slate-900">
                    Payment notes
                  </label>
                  <textarea
                    id="paymentNotes"
                    name="notes"
                    rows={2}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    placeholder="Optional note for the payment record."
                  />
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Record Payment
                  </button>
                </div>
              </form>

              <form action={markFloorRentalWaivedAction} className="mt-3">
                <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button
                  type="submit"
                  className="rounded-xl border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
                >
                  Waive Fee
                </button>
              </form>

              <div className="mt-5">
                <h4 className="text-sm font-semibold text-slate-900">Payment History</h4>

                {typedPayments.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    {typedPayments.map((payment) => (
                      <div
                        key={payment.id}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium text-slate-900">
                              {formatCurrency(Number(payment.amount ?? 0))}
                            </p>
                            <p className="text-xs text-slate-500">
                              {payment.paid_at ? formatDateTime(payment.paid_at) : "Date unavailable"}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                              {(payment.payment_method ?? "other").replaceAll("_", " ")}
                            </span>
                            <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                              {(payment.status ?? "completed").replaceAll("_", " ")}
                            </span>
                          </div>
                        </div>

                        {payment.notes ? (
                          <p className="mt-2 text-sm text-slate-600">{payment.notes}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                    No payments have been recorded for this rental yet.
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-xl font-semibold text-slate-900">Actions</h3>

            <div className="mt-5 flex flex-wrap gap-3">
              {!isFinalStatus && canEdit ? (
                <Link
                  href={`/app/schedule/${typedAppointment.id}/edit`}
                  className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                >
                  {isFloorRental ? "Edit Rental" : "Edit Appointment"}
                </Link>
              ) : null}

              {!isFinalStatus && canEdit ? (
                <form action={cancelAppointmentAction}>
                  <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                  <input type="hidden" name="cancelScope" value="this_lesson_only" />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    className="rounded-xl border border-red-200 px-4 py-2 text-red-700 hover:bg-red-50"
                  >
                    {isFloorRental ? "Cancel Rental" : "Cancel Appointment"}
                  </button>
                </form>
              ) : null}
            </div>

            {showAttendanceActions ? (
              <div className="mt-4 flex flex-wrap gap-3 border-t pt-4">
                <form action={markAppointmentAttendedAction}>
                  <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    className="rounded-xl bg-green-600 px-4 py-2 text-white hover:bg-green-700"
                  >
                    Mark Attended
                  </button>
                </form>

                <form action={markAppointmentNoShowAction}>
                  <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    className="rounded-xl bg-amber-500 px-4 py-2 text-white hover:bg-amber-600"
                  >
                    Mark No Show
                  </button>
                </form>
              </div>
            ) : null}

            {isFloorRental && !isFinalStatus ? (
              <p className="mt-4 border-t pt-4 text-xs text-slate-500">
                Attendance actions are hidden because floor space rentals do not use the standard lesson attendance workflow.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}