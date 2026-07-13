import LessonRecapForm from "@/components/LessonRecapForm";
import LessonRecapAIAssistant from "./LessonRecapAIAssistant";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  cancelAppointmentAction,
  deleteAppointmentAction,
  deleteLessonRecapAction,
  deleteLessonRecapVideoAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
  markFloorRentalWaivedAction,
  recordFloorRentalPaymentAction,
  recordPayAsYouGoLessonPaymentAction,
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
  billing_type: string | null;
  location_name: string | null;
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
  partner_client:
    | {
        id?: string;
        first_name: string;
        last_name: string;
      }
    | {
        id?: string;
        first_name: string;
        last_name: string;
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

const APPOINTMENT_DISPLAY_TIME_ZONE = "America/New_York";

function formatDateTime(value: string, timeZone = APPOINTMENT_DISPLAY_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateOnly(value: string, timeZone = APPOINTMENT_DISPLAY_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatTimeOnly(value: string, timeZone = APPOINTMENT_DISPLAY_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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
    | null,
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
    | null,
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
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client?.referral_source ?? null;
}

function getInstructorName(
  value:
    | { id?: string; first_name: string; last_name: string }
    | { id?: string; first_name: string; last_name: string }[]
    | null,
) {
  const instructor = Array.isArray(value) ? value[0] : value;
  return instructor ? `${instructor.first_name} ${instructor.last_name}` : "Unassigned";
}

function getRoomName(
  value: { id?: string; name: string } | { id?: string; name: string }[] | null,
) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room";
}

function getLowestRemainingValue(items: ClientPackageItem[]) {
  const finiteItems = items.filter(
    (item) => !item.is_unlimited && typeof item.quantity_remaining === "number",
  );

  if (finiteItems.length === 0) return null;

  return Math.min(...finiteItems.map((item) => Number(item.quantity_remaining ?? 0)));
}

function getPackageHealth(
  pkg: {
    active?: boolean | null;
    client_package_items?: ClientPackageItem[] | null;
  } | null,
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

  const [
    { data: appointment, error },
    { data: lessonRecap },
    { data: floorRentalPayments },
    { data: studioTimeZoneRow },
  ] = await Promise.all([
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
        billing_type,
        location_name,
        is_recurring,
        recurrence_series_id,
        created_at,
        clients:clients!appointments_client_id_fkey ( id, first_name, last_name, referral_source ),
        partner_client:clients!appointments_partner_client_id_fkey ( id, first_name, last_name ),
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
      .eq("external_reference", id)
      .order("paid_at", { ascending: false }),
    supabase
      .from("studios")
      .select("timezone")
      .eq("id", studioId)
      .maybeSingle(),
  ]);

  if (error || !appointment) {
    throw new Error(`Failed to load appointment: ${error?.message ?? "Not found"}`);
  }

  const studioTimeZone =
    typeof studioTimeZoneRow?.timezone === "string" && studioTimeZoneRow.timezone.trim()
      ? studioTimeZoneRow.timezone.trim()
      : APPOINTMENT_DISPLAY_TIME_ZONE;

  const typedAppointment = appointment as AppointmentRow;
  const typedLessonRecap = (lessonRecap ?? null) as LessonRecapRow | null;
  const typedPayments = (floorRentalPayments ?? []) as PaymentRow[];

  const pkg = Array.isArray(typedAppointment.client_packages)
    ? typedAppointment.client_packages[0]
    : typedAppointment.client_packages;

  const packageHealth = pkg ? getPackageHealth(pkg) : null;
  const clientName = getClientName(typedAppointment.clients);
  const clientId = getClientId(typedAppointment.clients);
  const partnerName = getClientName(typedAppointment.partner_client as any);
  const partnerId = getClientId(typedAppointment.partner_client as any);
  const instructorName = getInstructorName(typedAppointment.instructors);
  const roomName = getRoomName(typedAppointment.rooms);
  const locationName = typedAppointment.location_name?.trim() || null;
  const referralSource = getClientReferralSource(typedAppointment.clients);
  const returnTo = `/app/schedule/${typedAppointment.id}`;
  const totalPaid = typedPayments
    .filter((payment) => payment.status === "paid" || payment.status === "completed")
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
  const isPayAsYouGoLesson =
    !isFloorRental && typedAppointment.billing_type === "pay_as_you_go";
  const payAsYouGoLessonAmount = Number(typedAppointment.price_amount ?? 0);
  const payAsYouGoPaymentStatus = typedAppointment.payment_status ?? "unpaid";

  const isFinalStatus =
    typedAppointment.status === "attended" ||
    typedAppointment.status === "cancelled" ||
    typedAppointment.status === "no_show";

  const canEdit = canEditAppointments(role);
  const canTakeAttendance = canMarkAttendance(role) && !isFloorRental;
  const showAttendanceActions = !isFinalStatus && canTakeAttendance;
  const canDeleteAppointmentMistake = canEdit && !isFinalStatus;

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
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-5 py-5 text-white md:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Schedule
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  {isFloorRental ? "Floor Rental Details" : "Appointment Details"}
                </h1>

                <span className="inline-flex rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white">
                  {typedAppointment.status.replaceAll("_", " ")}
                </span>

                <span className="inline-flex rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white">
                  {isFloorRental
                    ? "Floor Rental"
                    : appointmentTypeLabel(typedAppointment.appointment_type)}
                </span>

                {typedAppointment.is_recurring ? (
                  <span className="inline-flex rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white">
                    Recurring
                  </span>
                ) : null}
              </div>

              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                Review lesson, rental, package, payment, and attendance details from
                one clean workspace.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/schedule"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Back to Schedule
              </Link>

              {typedAppointment.appointment_type === "group_class" ? (
                <Link
                  href={`/app/schedule/${typedAppointment.id}/attendance`}
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                >
                  Attendance
                </Link>
              ) : null}

              {!isFinalStatus && canEdit ? (
                <Link
                  href={`/app/schedule/${typedAppointment.id}/edit`}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  {isFloorRental ? "Edit Rental" : "Edit Appointment"}
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-5 py-4 md:px-6">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                Client
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                {clientName}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                Time
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-950">
                {formatDateOnly(typedAppointment.starts_at, studioTimeZone)} · {formatTimeOnly(typedAppointment.starts_at, studioTimeZone)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                Instructor / Room
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                {instructorName} · {roomName}
              </p>
              {locationName ? (
                <p className="mt-1 truncate text-xs text-slate-500">
                  {locationName}
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                {isFloorRental ? "Payment" : "Package"}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-950">
                {isFloorRental
                  ? paymentStatusLabel(effectivePaymentStatus)
                  : isPayAsYouGoLesson
                    ? paymentStatusLabel(payAsYouGoPaymentStatus)
                    : pkg && packageHealth
                      ? packageHealthLabel(packageHealth)
                      : "No package linked"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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

              {partnerId ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Partner</p>
                  <div className="mt-1">
                    <Link
                      href={`/app/clients/${partnerId}`}
                      className="text-sm font-medium text-slate-900 underline"
                    >
                      {partnerName}
                    </Link>
                  </div>
                </div>
              ) : null}

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
                  {formatDateOnly(typedAppointment.starts_at, studioTimeZone)}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">Time</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {formatTimeOnly(typedAppointment.starts_at, studioTimeZone)} -{" "}
                  {formatTimeOnly(typedAppointment.ends_at, studioTimeZone)}
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

              {locationName ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Location
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900">
                    {locationName}
                  </p>
                </div>
              ) : null}

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
                    ? formatDateTime(typedAppointment.created_at, studioTimeZone)
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
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
                    Last updated {formatDateTime(typedLessonRecap.updated_at, studioTimeZone)}
                  </div>
                </div>
              ) : null}

              {canEditLessonRecap ? (
                <div className="mt-5 space-y-4">
                  <LessonRecapAIAssistant
                    clientName={clientName}
                    appointmentType={appointmentTypeLabel(typedAppointment.appointment_type)}
                    lessonTitle={typedAppointment.title}
                    currentSummary={typedLessonRecap?.summary ?? ""}
                    currentHomework={typedLessonRecap?.homework ?? ""}
                    currentNextFocus={typedLessonRecap?.next_focus ?? ""}
                  />

                  <LessonRecapForm
                    appointmentId={typedAppointment.id}
                    defaultSummary={typedLessonRecap?.summary ?? ""}
                    defaultHomework={typedLessonRecap?.homework ?? ""}
                    defaultNextFocus={typedLessonRecap?.next_focus ?? ""}
                    defaultVisibleToClient={typedLessonRecap?.visible_to_client ?? true}
                  />

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
                          Uploaded {formatDateTime(typedLessonRecap.video_uploaded_at, studioTimeZone)}
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

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
                    It does not deduct from lesson packages and does not use the
                    standard lesson attendance workflow.
                  </p>
                  <p>
                    Instructor and room may still appear here when used for schedule
                    visibility and internal tracking.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Standard lesson actions are available while the appointment is
                    still active.
                  </p>

                  {typedAppointment.is_recurring ? (
                    <p>
                      This is part of a recurring series. Attendance applies per lesson,
                      and cancellation or edit workflows may support single-lesson or
                      series behavior depending on the action used.
                    </p>
                  ) : null}

                  {isPublicIntro ? (
                    <p>
                      This intro lesson originated from the public intro booking flow.
                    </p>
                  ) : null}

                  {isPrivateLesson ? (
                    <p>
                      Private lessons can include a lesson recap once the lesson has
                      been marked attended.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">
              {isFloorRental ? "Package Impact" : "Package"}
            </h3>

            <div className="mt-5">
              {isFloorRental ? (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-4 text-sm text-indigo-800">
                  Floor space rentals do not use lesson packages and do not deduct any
                  balance.
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
                          packageHealth,
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

          {isPayAsYouGoLesson ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-slate-900">
                    Pay-as-you-go Payment
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Record payment for this lesson before marking it attended.
                  </p>
                </div>

                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                    payAsYouGoPaymentStatus,
                  )}`}
                >
                  {paymentStatusLabel(payAsYouGoPaymentStatus)}
                </span>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Lesson Amount
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {payAsYouGoLessonAmount > 0
                      ? formatCurrency(payAsYouGoLessonAmount)
                      : "Not set"}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Payment Status
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {paymentStatusLabel(payAsYouGoPaymentStatus)}
                  </p>
                </div>
              </div>

              {payAsYouGoPaymentStatus !== "paid" ? (
                <form
                  action={recordPayAsYouGoLessonPaymentAction}
                  className="mt-5 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"
                >
                  <input
                    type="hidden"
                    name="appointmentId"
                    value={typedAppointment.id}
                  />
                  <input type="hidden" name="clientId" value={clientId ?? ""} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="paymentSource" value="appointment_detail" />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="paygoLessonPrice"
                        className="text-sm font-medium text-slate-900"
                      >
                        Lesson price
                      </label>
                      <input
                        id="paygoLessonPrice"
                        name="lessonPrice"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={
                          payAsYouGoLessonAmount > 0
                            ? String(payAsYouGoLessonAmount)
                            : ""
                        }
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        placeholder="0.00"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="paygoAmount"
                        className="text-sm font-medium text-slate-900"
                      >
                        Money collected today
                      </label>
                      <input
                        id="paygoAmount"
                        name="amount"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={
                          payAsYouGoLessonAmount > 0
                            ? String(payAsYouGoLessonAmount)
                            : ""
                        }
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        placeholder="0.00"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="paygoAccountCreditToApply"
                        className="text-sm font-medium text-slate-900"
                      >
                        Account credit to apply
                      </label>
                      <input
                        id="paygoAccountCreditToApply"
                        name="accountCreditToApply"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue="0"
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        placeholder="0.00"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="paygoPaymentMethod"
                        className="text-sm font-medium text-slate-900"
                      >
                        Collection method
                      </label>
                      <select
                        id="paygoPaymentMethod"
                        name="paymentMethod"
                        defaultValue="card"
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="card">Card outside DanceFlow</option>
                        <option value="cash">Cash</option>
                        <option value="check">Check</option>
                        <option value="venmo">Venmo</option>
                        <option value="zelle">Zelle</option>
                        <option value="ach">ACH</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="paygoPaymentNotes"
                      className="text-sm font-medium text-slate-900"
                    >
                      Payment notes
                    </label>
                    <textarea
                      id="paygoPaymentNotes"
                      name="notes"
                      rows={2}
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      placeholder="Optional note for the payment record."
                    />
                  </div>

                  <button
                    type="submit"
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Record Lesson Payment
                  </button>
                </form>
              ) : (
                <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-4 text-sm text-green-800">
                  This pay-as-you-go lesson is paid and can be marked attended.
                </div>
              )}
            </div>
          ) : null}

          {isFloorRental ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-slate-900">Payment</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Track rental billing for staff checkout and manual payments.
                  </p>
                </div>

                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${paymentStatusBadgeClass(
                    effectivePaymentStatus,
                  )}`}
                >
                  {paymentStatusLabel(effectivePaymentStatus)}
                </span>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Rental Amount
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {rentalAmount > 0 ? formatCurrency(rentalAmount) : "Not set"}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Paid
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {formatCurrency(totalPaid)}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    Balance Due
                  </p>
                  <p className="mt-2 text-lg font-semibold text-slate-900">
                    {formatCurrency(balanceDue)}
                  </p>
                </div>
              </div>

              <form
                action={recordFloorRentalPaymentAction}
                className="mt-5 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"
              >
                <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                <input type="hidden" name="clientId" value={clientId ?? ""} />
                <input type="hidden" name="returnTo" value={returnTo} />
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
                    <label
                      htmlFor="paymentMethod"
                      className="text-sm font-medium text-slate-900"
                    >
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
                  <label
                    htmlFor="paymentNotes"
                    className="text-sm font-medium text-slate-900"
                  >
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
                              {payment.paid_at
                                ? formatDateTime(payment.paid_at, studioTimeZone)
                                : "Date unavailable"}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                              {(payment.payment_method ?? "other").replaceAll("_", " ")}
                            </span>
                            <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                              {(payment.status ?? "paid").replaceAll("_", " ")}
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

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Actions</h3>

            <div className="mt-5 flex flex-wrap gap-3">
              {!isFinalStatus && canEdit ? (
                <Link
                  href={`/app/schedule/${typedAppointment.id}/edit`}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {isFloorRental ? "Edit Rental" : "Edit Appointment"}
                </Link>
              ) : null}

              {!isFinalStatus && canEdit ? (
                <details className="w-full rounded-2xl border border-red-200 bg-red-50 p-4">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-red-800">
                    {isFloorRental ? "Cancel Rental" : "Cancel Appointment"}
                  </summary>

                  <form action={cancelAppointmentAction} className="mt-4 space-y-4">
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={typedAppointment.id}
                    />
                    <input type="hidden" name="returnTo" value={returnTo} />

                    {typedAppointment.is_recurring ? (
                      <div>
                        <label
                          htmlFor="cancelScope"
                          className="text-sm font-medium text-slate-900"
                        >
                          Cancellation scope
                        </label>
                        <select
                          id="cancelScope"
                          name="cancelScope"
                          defaultValue="this_instance"
                          className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
                        >
                          <option value="this_instance">
                            This appointment only
                          </option>
                          <option value="this_and_future">
                            This and all future appointments in the series
                          </option>
                        </select>
                      </div>
                    ) : (
                      <input
                        type="hidden"
                        name="cancelScope"
                        value="this_instance"
                      />
                    )}

                    <div>
                      <label
                        htmlFor="cancellationRequestedBy"
                        className="text-sm font-medium text-slate-900"
                      >
                        Who requested the cancellation?
                      </label>
                      <select
                        id="cancellationRequestedBy"
                        name="cancellationRequestedBy"
                        defaultValue=""
                        required
                        className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="" disabled>
                          Select requester
                        </option>
                        <option value="client">Client</option>
                        <option value="instructor">Instructor</option>
                        <option value="studio">Studio</option>
                        <option value="other">Other</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="cancellationReason"
                        className="text-sm font-medium text-slate-900"
                      >
                        Cancellation reason
                      </label>
                      <textarea
                        id="cancellationReason"
                        name="cancellationReason"
                        rows={6}
                        maxLength={2000}
                        required
                        className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
                        placeholder="Enter the full reason for the cancellation, including any follow-up or rescheduling details."
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="missedAppointmentCharge"
                        className="text-sm font-medium text-slate-900"
                      >
                        Short-notice charge
                      </label>
                      <select
                        id="missedAppointmentCharge"
                        name="missedAppointmentCharge"
                        defaultValue="none"
                        className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="none">Do not deduct a lesson</option>
                        <option value="package">Deduct one package credit</option>
                        <option value="membership">
                          Deduct one membership benefit
                        </option>
                      </select>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        Use a deduction only when the studio&apos;s cancellation policy
                        treats the missed lesson as used.
                      </p>
                    </div>

                    <p className="text-xs leading-5 text-red-700">
                      The cancellation and charge decision will be saved to the
                      client&apos;s Notes / Activity ledger.
                    </p>

                    <button
                      type="submit"
                      className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
                    >
                      Confirm Cancellation
                    </button>
                  </form>
                </details>
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

                <details className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-amber-900">
                    Mark No Show
                  </summary>

                  <form action={markAppointmentNoShowAction} className="mt-4 space-y-4">
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={typedAppointment.id}
                    />
                    <input type="hidden" name="returnTo" value={returnTo} />

                    <div>
                      <label
                        htmlFor="noShowMissedAppointmentCharge"
                        className="text-sm font-medium text-slate-900"
                      >
                        Missed-lesson charge
                      </label>
                      <select
                        id="noShowMissedAppointmentCharge"
                        name="missedAppointmentCharge"
                        defaultValue="none"
                        className="mt-2 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="none">Do not deduct a lesson</option>
                        <option value="package">Deduct one package credit</option>
                        <option value="membership">
                          Deduct one membership benefit
                        </option>
                      </select>
                    </div>

                    <p className="text-xs leading-5 text-amber-800">
                      The no-show and charge decision will be saved to the
                      client&apos;s Notes / Activity ledger.
                    </p>

                    <button
                      type="submit"
                      className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
                    >
                      Confirm No Show
                    </button>
                  </form>
                </details>
              </div>
            ) : null}

            {isFloorRental && !isFinalStatus ? (
              <p className="mt-4 border-t pt-4 text-xs text-slate-500">
                Attendance actions are hidden because floor space rentals do not use the
                standard lesson attendance workflow.
              </p>
            ) : null}
          </div>

          {canDeleteAppointmentMistake ? (
            <details className="rounded-2xl border border-red-200 bg-red-50 p-6 shadow-sm">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-600">
                    Danger Zone
                  </p>
                  <h3 className="mt-1 text-xl font-semibold text-red-950">
                    Delete appointment created by mistake
                  </h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-red-800">
                    Use delete only for front desk or scheduling mistakes. If the client,
                    instructor, or studio actually cancelled the appointment, use Cancel
                    Appointment so the history stays accurate.
                  </p>
                </div>

                <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-red-700 ring-1 ring-red-200">
                  <span className="group-open:hidden">Expand</span>
                  <span className="hidden group-open:inline">Collapse</span>
                </span>
              </summary>

              <form action={deleteAppointmentAction} className="mt-5 rounded-2xl border border-red-200 bg-white p-4">
                <input type="hidden" name="appointmentId" value={typedAppointment.id} />
                <input type="hidden" name="returnTo" value={returnTo} />

                <label className="block text-sm font-semibold text-slate-900">
                  Type DELETE to confirm
                </label>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  The system will block deletion if this appointment already has payments,
                  lesson transactions, lesson recaps, or attendance history attached.
                </p>
                <input
                  name="confirmDeleteAppointment"
                  placeholder="DELETE"
                  className="mt-3 w-full max-w-xs rounded-xl border border-red-200 px-3 py-2 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                />

                <button
                  type="submit"
                  className="mt-4 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
                >
                  Delete Appointment
                </button>
              </form>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
