import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ensurePortalProfileAndClientLinks,
  getAuthUserFullName,
} from "@/lib/auth/portal-linking";

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

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  booking?: string | string[];
  error?: string | string[];
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_name: string | null;
};


function readSearchParam(
  value: string | string[] | undefined,
  fallback = "",
) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return typeof value === "string" ? value : fallback;
}

function buildPortalLoginPath(studioSlug: string, error?: string) {
  const search = new URLSearchParams({
    intent: "public",
    next: `/portal/${studioSlug}`,
  });

  if (error) {
    search.set("error", error);
  }

  return `/login?${search.toString()}`;
}

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_independent_instructor: boolean | null;
};

type ActiveMembership = {
  id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type AppointmentSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  title: string | null;
};

type RentalSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  room_id: string | null;
};

type PendingPaymentRow = {
  id: string;
  amount: number | null;
  currency: string | null;
  payment_type: string | null;
  notes: string | null;
  created_at: string;
  client_package_id: string | null;
  client_membership_id: string | null;
};

type ClientPackageItemRow = {
  usage_type: string | null;
  quantity_total: number | string | null;
  quantity_used: number | string | null;
  quantity_remaining: number | string | null;
  is_unlimited: boolean | null;
};

type ClientPackageRow = {
  id: string;
  name_snapshot: string;
  active: boolean;
  expiration_date: string | null;
  sold_price: number | null;
  price_snapshot: number | null;
  client_package_items: ClientPackageItemRow[] | null;
};

type PaymentHistoryRow = {
  id: string;
  amount: number | null;
  currency: string | null;
  payment_type: string | null;
  payment_method: string | null;
  status: string;
  notes: string | null;
  paid_at: string | null;
  created_at: string;
};

type LessonRecapRow = {
  id: string;
  appointment_id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean | null;
  updated_at: string;
};

type PortalDocumentAssignmentRow = {
  id: string;
  template_id: string;
  template_version_id: string | null;
  status: string;
  due_at: string | null;
  assigned_at: string;
  signed_at: string | null;
};

type PortalEventSummaryRow = {
  id: string;
  name: string;
  slug: string;
  start_date: string;
  start_time: string | null;
  end_date: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
};

type PortalStudioEventRow = PortalEventSummaryRow & {
  short_description: string | null;
  registration_required: boolean | null;
  public_directory_enabled: boolean | null;
  status: string | null;
  visibility: string | null;
};

type PortalEventAttendeeRow = {
  id: string;
  registration_id: string;
  event_id: string | null;
  first_name: string | null;
  last_name: string | null;
  sort_order: number | null;
  checked_in_at: string | null;
  waiver_signed_at: string | null;
  ticket_code: string | null;
  ticket_issued_at: string | null;
};

type PortalEventRegistrationRow = {
  id: string;
  event_id: string;
  status: string;
  payment_status: string | null;
  quantity: number | null;
  total_amount: number | null;
  created_at: string;
  events: PortalEventSummaryRow | PortalEventSummaryRow[] | null;
};

type PendingBookingRequestRow = {
  id: string;
  status: string | null;
  source: string | null;
  requested_starts_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type UpcomingItem = {
  id: string;
  kind: "appointment" | "rental";
  starts_at: string;
  ends_at: string;
  status: string;
  title: string;
};

function formatDateTime(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, { weekday: "short", year: undefined });
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00.000Z`));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatTimeRange(start: string, end: string, timeZone: string) {
  return `${formatStudioTime(start, timeZone)} – ${formatStudioTime(end, timeZone)}`;
}

function formatEventDateTime(event: PortalEventSummaryRow | null) {
  if (!event) return "Date coming soon";

  const datePart = formatDate(event.start_date);
  if (!event.start_time) return datePart;

  return `${datePart} at ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${event.start_date}T${event.start_time}Z`))}`;
}

function eventLocationLabel(event: PortalEventSummaryRow | null) {
  if (!event) return "Location coming soon";
  if (event.venue_name?.trim()) return event.venue_name.trim();

  const parts = [event.city, event.state].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location coming soon";
}

function eventRegistrationModeLabel(event: {
  registration_required?: boolean | null;
}) {
  return event.registration_required ? "DanceFlow tickets" : "Basic listing";
}

function ticketQrSrc(ticketCode: string) {
  return `/api/tickets/qr?code=${encodeURIComponent(ticketCode)}`;
}

function attendeeName(attendee: PortalEventAttendeeRow, index: number) {
  const fullName = `${attendee.first_name ?? ""} ${
    attendee.last_name ?? ""
  }`.trim();

  return fullName || `Ticket ${index + 1}`;
}

function getRegistrationEvent(registration: PortalEventRegistrationRow) {
  if (Array.isArray(registration.events)) {
    return registration.events[0] ?? null;
  }

  return registration.events ?? null;
}

function attentionToneClass(
  tone: "amber" | "emerald" | "orange" | "sky" | "rose" | "violet",
) {
  const tones: Record<string, string> = {
    amber: "border-amber-200 bg-amber-50 text-amber-950",
    orange: "border-orange-200 bg-orange-50 text-orange-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
    rose: "border-rose-200 bg-rose-50 text-rose-950",
    violet: "border-violet-200 bg-violet-50 text-violet-950",
  };

  return tones[tone];
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "party") return "Party";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function paymentTypeLabel(value: string | null) {
  if (value === "package_sale") return "Package Payment";
  if (value === "membership") return "Membership Payment";
  if (value === "floor_rental") return "Floor Rental Payment";
  if (value === "event_registration") return "Event Registration Payment";
  return "Payment Request";
}

function packageUsageTypeLabel(value: string | null) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return "Credits";
}

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function creditUsagePercent(
  total: number | string | null | undefined,
  used: number | string | null | undefined,
) {
  const parsedTotal = toNumber(total);
  if (parsedTotal <= 0) return 0;

  return clampPercent((toNumber(used) / parsedTotal) * 100);
}

function daysUntilDate(value: string | null) {
  if (!value) return null;

  const target = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffMs = target.getTime() - today.getTime();
  if (!Number.isFinite(diffMs)) return null;

  return Math.ceil(diffMs / 86_400_000);
}

function expirationLabel(value: string | null) {
  if (!value) return "No expiration date";

  const days = daysUntilDate(value);
  if (days === null) return `Expires ${formatDate(value)}`;
  if (days < 0) return `Expired ${formatDate(value)}`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  if (days <= 30) return `Expires in ${days} days`;

  return `Expires ${formatDate(value)}`;
}

function renewalLabel(membership: ActiveMembership | null) {
  if (!membership) return "No active membership";
  if (membership.cancel_at_period_end) {
    return `Ends ${formatDate(membership.current_period_end)}`;
  }
  if (membership.auto_renew) {
    return `Renews ${formatDate(membership.current_period_end)}`;
  }

  return `Current period ends ${formatDate(membership.current_period_end)}`;
}

function paymentMethodLabel(value: string | null) {
  if (!value) return "Payment";
  return value
    .replaceAll("_", " ")
    .replace(/\w/g, (char) => char.toUpperCase());
}

function statusLabel(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "attended") return "Completed";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "Missed";
  if (value === "active") return "Active";
  if (value === "trialing") return "Trial";
  if (value === "past_due") return "Past Due";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended")
    return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled")
    return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "active")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (status === "trialing")
    return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (status === "past_due")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getClientFirstName(client: ClientRow) {
  return client.first_name?.trim() || "there";
}

function getClientDisplayName(client: ClientRow) {
  const parts = [client.first_name, client.last_name]
    .map((part) => part?.trim())
    .filter(Boolean);

  return parts.length ? parts.join(" ") : client.email ?? "Portal Student";
}

function makePortalPassCode(studio: StudioRow, client: ClientRow) {
  const seed = `${studio.id}:${client.id}:${client.email ?? ""}`;
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  const suffix = hash.toString(36).toUpperCase().padStart(8, "0").slice(-8);
  return `DF-PASS-${suffix}`;
}

function CardShell({
  title,
  subtitle,
  accent = "slate",
  children,
}: {
  title: string;
  subtitle?: string;
  accent?: "slate" | "orange" | "emerald" | "violet" | "sky";
  children: React.ReactNode;
}) {
  const accentMap: Record<string, string> = {
    slate: "text-slate-500",
    orange: "text-orange-600",
    emerald: "text-emerald-700",
    violet: "text-violet-700",
    sky: "text-sky-700",
  };

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-2 border-b border-slate-100 pb-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
        <p
          className={`text-xs font-semibold uppercase tracking-[0.16em] ${accentMap[accent]}`}
        >
          {title}
        </p>
        {subtitle ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
        ) : null}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ActionTile({
  href,
  title,
  description,
  tone = "slate",
}: {
  href: string;
  title: string;
  description: string;
  tone?: "slate" | "sky" | "orange" | "emerald" | "violet";
}) {
  const classes: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 hover:bg-slate-100",
    sky: "border-sky-200 bg-sky-50 hover:bg-sky-100",
    orange: "border-orange-200 bg-orange-50 hover:bg-orange-100",
    emerald: "border-emerald-200 bg-emerald-50 hover:bg-emerald-100",
    violet: "border-violet-200 bg-violet-50 hover:bg-violet-100",
  };

  return (
    <Link
      href={href}
      className={`rounded-2xl border p-4 transition ${classes[tone]}`}
    >
      <p className="font-medium text-slate-900">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
    </Link>
  );
}

export default async function PortalHomePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const bookingStatus = readSearchParam(resolvedSearchParams.booking);
  const pageError = readSearchParam(resolvedSearchParams.error);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(buildPortalLoginPath(studioSlug));
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect(buildPortalLoginPath(studioSlug, "portal-studio-not-found"));
  }

  const typedStudio = studio as StudioRow;

  const { data: settingsRow } = await supabase
    .from("studio_settings")
    .select("timezone, lumi_enabled")
    .eq("studio_id", typedStudio.id)
    .maybeSingle();

  const studioTimeZone = getStudioTimeZone(
    (settingsRow as { timezone?: string | null } | null)?.timezone,
  );
  const lumiEnabled =
    (settingsRow as { lumi_enabled?: boolean | null } | null)?.lumi_enabled ===
    true;
  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;

  let typedClient: ClientRow | null = null;

  const { data: linkedClient, error: linkedClientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (linkedClientError) {
    throw linkedClientError;
  }

  if (linkedClient) {
    typedClient = linkedClient as ClientRow;
  } else if (user.email) {
    await ensurePortalProfileAndClientLinks({
      userId: user.id,
      email: user.email,
      fullName: getAuthUserFullName(user),
      studioId: typedStudio.id,
    });

    const { data: repairedClient, error: repairedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, is_independent_instructor")
      .eq("studio_id", typedStudio.id)
      .eq("portal_user_id", user.id)
      .maybeSingle();

    if (repairedClientError) {
      throw repairedClientError;
    }

    if (repairedClient) {
      typedClient = repairedClient as ClientRow;
    }
  }

  if (!typedClient) {
    redirect(buildPortalLoginPath(studioSlug, "portal-access-not-found"));
  }

  const { data: workspaceRole, error: workspaceRoleError } = await supabase
    .from("user_studio_roles")
    .select("role, active")
    .eq("studio_id", typedStudio.id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (workspaceRoleError) {
    throw workspaceRoleError;
  }

  const canReturnToWorkspace = Boolean(workspaceRole);

  const isInstructorPortal = Boolean(typedClient.is_independent_instructor);
  const nowIso = new Date().toISOString();

  const [
    { data: membership },
    { data: appointments, error: appointmentsError },
    { data: rentals, error: rentalsError },
    { data: pendingPayments, error: pendingPaymentsError },
    { data: packages, error: packagesError },
    { data: documentAssignments, error: documentAssignmentsError },
    { data: eventRegistrations, error: eventRegistrationsError },
    { data: upcomingStudioEvents, error: upcomingStudioEventsError },
    { data: bookingRequests, error: bookingRequestsError },
    { data: paymentHistory, error: paymentHistoryError },
  ] = await Promise.all([
    supabase
      .from("client_memberships")
      .select(
        `
        id,
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("status", ["active", "trialing", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("appointments")
      .select(
        `
        id,
        starts_at,
        ends_at,
        status,
        appointment_type,
        title
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("appointment_type", ["private_lesson", "intro_lesson", "group_class"])
      .order("starts_at", { ascending: false })
      .limit(20),

    isInstructorPortal
      ? supabase
          .from("appointments")
          .select("id, starts_at, ends_at, status, room_id")
          .eq("studio_id", typedStudio.id)
          .eq("client_id", typedClient.id)
          .eq("appointment_type", "floor_space_rental")
          .gte("starts_at", nowIso)
          .order("starts_at", { ascending: true })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),

    supabase
      .from("payments")
      .select(
        "id, amount, currency, payment_type, notes, created_at, client_package_id, client_membership_id",
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("client_packages")
      .select(
        `
        id,
        name_snapshot,
        active,
        expiration_date,
        sold_price,
        price_snapshot,
        client_package_items (
          usage_type,
          quantity_total,
          quantity_used,
          quantity_remaining,
          is_unlimited
        )
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("document_assignments")
      .select(
        "id, template_id, template_version_id, status, due_at, assigned_at, signed_at",
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .neq("status", "void")
      .order("assigned_at", { ascending: false })
      .limit(10),

    supabase
      .from("event_registrations")
      .select(
        `
        id,
        event_id,
        status,
        payment_status,
        quantity,
        total_amount,
        created_at,
        events (
          id,
          name,
          slug,
          start_date,
          start_time,
          end_date,
          venue_name,
          city,
          state
        )
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("status", ["confirmed", "checked_in", "pending", "waitlisted"])
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("events")
      .select(
        `
        id,
        name,
        slug,
        short_description,
        start_date,
        start_time,
        end_date,
        venue_name,
        city,
        state,
        registration_required,
        public_directory_enabled,
        status,
        visibility
      `,
      )
      .eq("studio_id", typedStudio.id)
      .eq("status", "published")
      .eq("visibility", "public")
      .gte("start_date", new Date().toISOString().slice(0, 10))
      .order("start_date", { ascending: true })
      .limit(6),

    supabase
      .from("booking_requests")
      .select("id, status, source, requested_starts_at, created_at, updated_at")
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("status", ["pending", "approved"])
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(5),

    supabase
      .from("payments")
      .select(
        "id, amount, currency, payment_type, payment_method, status, notes, paid_at, created_at",
      )
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .neq("status", "pending")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .limit(8),
  ]);

  if (appointmentsError) {
    throw appointmentsError;
  }

  if (rentalsError) {
    throw rentalsError;
  }

  if (pendingPaymentsError) {
    throw pendingPaymentsError;
  }

  if (packagesError) {
    throw packagesError;
  }

  if (documentAssignmentsError) {
    throw documentAssignmentsError;
  }

  if (eventRegistrationsError) {
    console.error(
      "portal event registrations unavailable",
      eventRegistrationsError.message,
    );
  }

  if (upcomingStudioEventsError) {
    console.error(
      "portal studio events unavailable",
      upcomingStudioEventsError.message,
    );
  }

  if (bookingRequestsError) {
    console.error(
      "portal booking requests unavailable",
      bookingRequestsError.message,
    );
  }

  if (paymentHistoryError) {
    throw paymentHistoryError;
  }

  const typedMembership = (membership ?? null) as ActiveMembership | null;
  const typedAppointments = (appointments ?? []) as AppointmentSummaryRow[];
  const typedRentals = (rentals ?? []) as RentalSummaryRow[];
  const typedPendingPayments = (pendingPayments ?? []) as PendingPaymentRow[];
  const typedPackages = (packages ?? []) as ClientPackageRow[];
  const typedDocumentAssignments = (documentAssignments ??
    []) as PortalDocumentAssignmentRow[];
  const typedEventRegistrations = (eventRegistrations ??
    []) as PortalEventRegistrationRow[];
  const typedUpcomingStudioEvents = (upcomingStudioEvents ??
    []) as PortalStudioEventRow[];
  const typedBookingRequests = (bookingRequests ?? []) as PendingBookingRequestRow[];
  const typedPaymentHistory = (paymentHistory ?? []) as PaymentHistoryRow[];
  const registrationIds = typedEventRegistrations.map((item) => item.id);
  let typedEventTickets: PortalEventAttendeeRow[] = [];

  if (registrationIds.length) {
    const { data: eventTickets, error: eventTicketsError } = await supabase
      .from("event_registration_attendees")
      .select(
        "id, registration_id, event_id, first_name, last_name, sort_order, checked_in_at, waiver_signed_at, ticket_code, ticket_issued_at",
      )
      .in("registration_id", registrationIds)
      .order("sort_order", { ascending: true });

    if (eventTicketsError) {
      console.error("portal event tickets unavailable", eventTicketsError.message);
    } else {
      typedEventTickets = (eventTickets ?? []) as PortalEventAttendeeRow[];
    }
  }

  const portalPassCode = makePortalPassCode(typedStudio, typedClient);
  const portalPassQrUrl = `/api/tickets/qr?code=${encodeURIComponent(portalPassCode)}`;
  const portalPassName = getClientDisplayName(typedClient);

  const recapAppointmentIds = typedAppointments
    .filter((item) => item.status === "attended")
    .map((item) => item.id);

  let typedLessonRecaps: LessonRecapRow[] = [];

  if (recapAppointmentIds.length) {
    const { data: lessonRecaps, error: lessonRecapsError } = await supabase
      .from("lesson_recaps")
      .select(
        "id, appointment_id, summary, homework, next_focus, visible_to_client, updated_at",
      )
      .eq("studio_id", typedStudio.id)
      .in("appointment_id", recapAppointmentIds)
      .eq("visible_to_client", true)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (lessonRecapsError) {
      throw lessonRecapsError;
    }

    typedLessonRecaps = (lessonRecaps ?? []) as LessonRecapRow[];
  }

  const upcomingAppointments = typedAppointments
    .filter((item) => item.starts_at >= nowIso)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 5);

  const recentAppointments = typedAppointments
    .filter((item) => item.starts_at < nowIso)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 5);

  const upcomingItems: UpcomingItem[] = [
    ...upcomingAppointments.map((item) => ({
      id: item.id,
      kind: "appointment" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: item.title?.trim() || appointmentTypeLabel(item.appointment_type),
    })),
    ...typedRentals.map((item) => ({
      id: item.id,
      kind: "rental" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: "Floor Space Rental",
    })),
  ]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 6);

  const upcomingCount = isInstructorPortal
    ? upcomingItems.length
    : upcomingAppointments.length;

  const nextUpItem = upcomingItems[0] ?? null;
  const unsignedDocumentAssignments = typedDocumentAssignments.filter(
    (item) => item.status !== "signed" && !item.signed_at,
  );
  const unsignedDocumentCount = unsignedDocumentAssignments.length;
  const overdueDocumentCount = unsignedDocumentAssignments.filter((item) => {
    if (!item.due_at) return false;
    const dueTime = new Date(item.due_at).getTime();
    return Number.isFinite(dueTime) && dueTime < Date.now();
  }).length;
  const upcomingDueDocumentCount = unsignedDocumentAssignments.filter((item) => {
    if (!item.due_at) return false;
    const dueTime = new Date(item.due_at).getTime();
    if (!Number.isFinite(dueTime)) return false;
    const diffDays = Math.ceil((dueTime - Date.now()) / 86_400_000);
    return diffDays >= 0 && diffDays <= 7;
  }).length;
  const lowCreditItems = typedPackages.flatMap((clientPackage) =>
    (clientPackage.client_package_items ?? [])
      .filter(
        (item) =>
          !item.is_unlimited &&
          toNumber(item.quantity_remaining) > 0 &&
          toNumber(item.quantity_remaining) <= 1,
      )
      .map((item) => ({
        packageName: clientPackage.name_snapshot,
        label: packageUsageTypeLabel(item.usage_type),
        remaining: toNumber(item.quantity_remaining),
      })),
  );
  const remainingCreditTotal = typedPackages.reduce(
    (packageTotal, clientPackage) => {
      return (
        packageTotal +
        (clientPackage.client_package_items ?? []).reduce((itemTotal, item) => {
          if (item.is_unlimited) return itemTotal;
          return itemTotal + toNumber(item.quantity_remaining);
        }, 0)
      );
    },
    0,
  );

  const packageWalletItems = typedPackages.map((clientPackage) => {
    const items = clientPackage.client_package_items ?? [];
    const hasUnlimited = items.some((item) => item.is_unlimited);
    const totalRemaining = items.reduce((total, item) => {
      if (item.is_unlimited) return total;
      return total + toNumber(item.quantity_remaining);
    }, 0);
    const totalPurchased = items.reduce((total, item) => {
      if (item.is_unlimited) return total;
      return total + toNumber(item.quantity_total);
    }, 0);
    const totalUsed = items.reduce((total, item) => {
      if (item.is_unlimited) return total;
      return total + toNumber(item.quantity_used);
    }, 0);
    const daysUntilExpiration = daysUntilDate(clientPackage.expiration_date);
    const isExpiringSoon =
      daysUntilExpiration !== null &&
      daysUntilExpiration >= 0 &&
      daysUntilExpiration <= 30;
    const isLowBalance =
      !hasUnlimited &&
      totalRemaining > 0 &&
      totalRemaining <= Math.max(1, Math.ceil(totalPurchased * 0.2));

    return {
      clientPackage,
      items,
      hasUnlimited,
      totalRemaining,
      totalPurchased,
      totalUsed,
      usagePercent: creditUsagePercent(totalPurchased, totalUsed),
      daysUntilExpiration,
      isExpiringSoon,
      isLowBalance,
    };
  });
  const hasUnlimitedCredits = packageWalletItems.some((item) => item.hasUnlimited);
  const expiringPackageCount = packageWalletItems.filter(
    (item) => item.isExpiringSoon,
  ).length;
  const lowBalancePackageCount = packageWalletItems.filter(
    (item) => item.isLowBalance,
  ).length;
  const walletStatusItems = [
    ...(typedPackages.length
      ? [
          `${typedPackages.length} active package${
            typedPackages.length === 1 ? "" : "s"
          }`,
        ]
      : ["No active packages"]),
    ...(hasUnlimitedCredits ? ["unlimited credits available"] : []),
    ...(lowBalancePackageCount
      ? [
          `${lowBalancePackageCount} package${
            lowBalancePackageCount === 1 ? "" : "s"
          } running low`,
        ]
      : []),
    ...(expiringPackageCount
      ? [
          `${expiringPackageCount} package${
            expiringPackageCount === 1 ? "" : "s"
          } expiring soon`,
        ]
      : []),
  ];
  const eventTicketsByRegistration = new Map<string, PortalEventAttendeeRow[]>();

  typedEventTickets.forEach((ticket) => {
    const current = eventTicketsByRegistration.get(ticket.registration_id) ?? [];
    current.push(ticket);
    eventTicketsByRegistration.set(ticket.registration_id, current);
  });

  const registeredEvents = typedEventRegistrations
    .map((registration) => ({
      registration,
      event: getRegistrationEvent(registration),
      tickets: eventTicketsByRegistration.get(registration.id) ?? [],
    }))
    .filter((item) => item.event)
    .sort((a, b) =>
      String(a.event?.start_date ?? "").localeCompare(
        String(b.event?.start_date ?? ""),
      ),
    )
    .slice(0, 4);
  const registeredEventIdSet = new Set(
    typedEventRegistrations.map((registration) => registration.event_id),
  );
  const discoverableStudioEvents = typedUpcomingStudioEvents
    .filter((event) => !registeredEventIdSet.has(event.id))
    .slice(0, 4);
  const issuedPortalTicketCount = typedEventTickets.filter((ticket) =>
    Boolean(ticket.ticket_code),
  ).length;
  const pendingBookingRequests = typedBookingRequests.filter(
    (request) => request.status === "pending",
  );
  const approvedBookingRequests = typedBookingRequests.filter(
    (request) => request.status === "approved",
  );
  const membershipRenewalDays = typedMembership
    ? daysUntilDate(typedMembership.current_period_end)
    : null;
  const upcomingRegisteredEvent = registeredEvents[0] ?? null;

  const portalNotificationItems = [
    ...(nextUpItem
      ? [
          {
            title: "Upcoming schedule reminder",
            description: `${nextUpItem.title} is next on ${formatDateTime(
              nextUpItem.starts_at,
              studioTimeZone,
            )}.`,
            tone: "sky" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule`,
            label: "Schedule",
          },
        ]
      : []),
    ...(upcomingRegisteredEvent?.event
      ? [
          {
            title: "Upcoming event reminder",
            description: `${upcomingRegisteredEvent.event.name} is coming up. Review your registration, ticket code, and event details before you arrive.`,
            tone: "orange" as const,
            href: upcomingRegisteredEvent.event.slug
              ? `/events/${encodeURIComponent(upcomingRegisteredEvent.event.slug)}`
              : `/portal/${encodeURIComponent(typedStudio.slug)}#portal-events`,
            label: "Events",
          },
        ]
      : []),
    ...(unsignedDocumentCount
      ? [
          {
            title: overdueDocumentCount
              ? "Document signature past due"
              : "Document signature needed",
            description: overdueDocumentCount
              ? `${overdueDocumentCount} document ${
                  overdueDocumentCount === 1 ? "is" : "are"
                } past due. Please review your document center.`
              : `${unsignedDocumentCount} document ${
                  unsignedDocumentCount === 1 ? "needs" : "need"
                } your signature before an upcoming studio activity.`,
            tone: overdueDocumentCount ? ("rose" as const) : ("violet" as const),
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/documents`,
            label: "Documents",
          },
        ]
      : []),
    ...(lowCreditItems.length
      ? [
          {
            title: "Package balance reminder",
            description: `${lowCreditItems[0].label} in ${lowCreditItems[0].packageName} ${
              lowCreditItems.length > 1 ? "and other credits are" : "is"
            } running low.`,
            tone: "rose" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}#wallet`,
            label: "Wallet",
          },
        ]
      : []),
    ...(pendingBookingRequests.length
      ? [
          {
            title: "Booking request pending",
            description: `${pendingBookingRequests.length} request ${
              pendingBookingRequests.length === 1 ? "is" : "are"
            } waiting for studio review.`,
            tone: "sky" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule#self-service-booking`,
            label: "Requests",
          },
        ]
      : []),
    ...(approvedBookingRequests.length
      ? [
          {
            title: "Booking request approved",
            description: `${approvedBookingRequests.length} request ${
              approvedBookingRequests.length === 1 ? "has" : "have"
            } been approved. Check your schedule or wait for the studio's next update.`,
            tone: "emerald" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule`,
            label: "Requests",
          },
        ]
      : []),
    ...(membershipRenewalDays !== null &&
    membershipRenewalDays >= 0 &&
    membershipRenewalDays <= 14
      ? [
          {
            title: "Membership renewal reminder",
            description: typedMembership?.cancel_at_period_end
              ? `Your membership is scheduled to end ${formatDate(
                  typedMembership.current_period_end,
                )}.`
              : `Your current membership period renews ${formatDate(
                  typedMembership?.current_period_end ?? null,
                )}.`,
            tone: typedMembership?.cancel_at_period_end
              ? ("amber" as const)
              : ("emerald" as const),
            href: `/portal/${encodeURIComponent(typedStudio.slug)}#wallet`,
            label: "Membership",
          },
        ]
      : []),
    ...(!upcomingItems.length
      ? [
          {
            title: "No upcoming lessons yet",
            description: isInstructorPortal
              ? "No upcoming lessons or rentals are showing in your portal."
              : "Request a lesson or contact the studio to get something on the calendar.",
            tone: "sky" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}${
              isInstructorPortal ? "/schedule" : "/schedule#self-service-booking"
            }`,
            label: "Schedule",
          },
        ]
      : []),
    ...(issuedPortalTicketCount
      ? [
          {
            title: "Ticket code ready",
            description: `${issuedPortalTicketCount} ticket ${
              issuedPortalTicketCount === 1 ? "code is" : "codes are"
            } available in your portal for event check-in.`,
            tone: "orange" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}#portal-events`,
            label: "Tickets",
          },
        ]
      : []),
  ].slice(0, 6);

  const attentionItems = [
    ...(typedPendingPayments.length
      ? [
          {
            title: "Payment request waiting",
            description: `${typedPendingPayments.length} pending payment ${
              typedPendingPayments.length === 1
                ? "request needs"
                : "requests need"
            } attention.`,
            tone: "amber" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}`,
            cta: "Review payments",
          },
        ]
      : []),
    ...(unsignedDocumentCount
      ? [
          {
            title: overdueDocumentCount
              ? "Document signature overdue"
              : "Document signature needed",
            description: overdueDocumentCount
              ? `${overdueDocumentCount} document ${
                  overdueDocumentCount === 1 ? "is" : "are"
                } past due. Review and sign before your next visit.`
              : `${unsignedDocumentCount} document ${
                  unsignedDocumentCount === 1 ? "is" : "are"
                } waiting for your review${
                  upcomingDueDocumentCount ? " soon" : ""
                }.`,
            tone: overdueDocumentCount ? ("rose" as const) : ("violet" as const),
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/documents`,
            cta: "Sign documents",
          },
        ]
      : []),
    ...(lowCreditItems.length
      ? [
          {
            title: "Credits running low",
            description: `${lowCreditItems[0].label} in ${lowCreditItems[0].packageName} ${
              lowCreditItems.length > 1 ? "and other credits are" : "is"
            } almost used up.`,
            tone: "rose" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule`,
            cta: "View credits",
          },
        ]
      : []),
    ...(pendingBookingRequests.length
      ? [
          {
            title: "Booking request sent",
            description: `${pendingBookingRequests.length} request ${
              pendingBookingRequests.length === 1 ? "is" : "are"
            } waiting for studio review.`,
            tone: "sky" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule#self-service-booking`,
            cta: "View request",
          },
        ]
      : []),
    ...(!upcomingItems.length
      ? [
          {
            title: "Nothing scheduled yet",
            description: isInstructorPortal
              ? "You do not have upcoming lessons or rentals showing in your portal."
              : "You do not have an upcoming lesson or class on your portal schedule.",
            tone: "sky" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}/schedule`,
            cta: "View schedule",
          },
        ]
      : []),
    ...(typedMembership?.status === "past_due"
      ? [
          {
            title: "Membership needs attention",
            description:
              "Your membership is marked past due. Contact the studio or review your payment requests.",
            tone: "amber" as const,
            href: `/portal/${encodeURIComponent(typedStudio.slug)}`,
            cta: "Review account",
          },
        ]
      : []),
  ].slice(0, 4);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_24%)] p-1">
      {bookingStatus === "request-sent" ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
          <p className="font-semibold">Request sent to the studio.</p>
          <p className="mt-1 text-sm leading-6 text-emerald-900">
            The studio team can review your request and follow up with next steps.
          </p>
        </div>
      ) : null}

      {pageError === "booking-request-failed" ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-rose-950">
          <p className="font-semibold">We could not send that request.</p>
          <p className="mt-1 text-sm leading-6 text-rose-900">
            Please try again or contact the studio directly.
          </p>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  {isInstructorPortal
                    ? "DanceFlow Instructor Portal"
                    : "DanceFlow Client Portal"}
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                  Welcome back, {getClientFirstName(typedClient)}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  {isInstructorPortal
                    ? "Use this page to see your schedule, manage floor rentals, and get to the tools you use most."
                    : "Use this page to check your upcoming appointments, view your membership, and stay on top of your studio activity."}
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                  <span>
                    Studio:{" "}
                    <span className="font-medium text-white">
                      {studioLabel}
                    </span>
                  </span>
                  <span>
                    Portal:{" "}
                    <span className="font-medium text-white">
                      {isInstructorPortal ? "Independent Instructor" : "Client"}
                    </span>
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {canReturnToWorkspace ? (
                  <Link
                    href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Back to Workspace
                  </Link>
                ) : null}
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  My Account
                </Link>

                <form action="/auth/logout" method="post">
                  <button
                    type="submit"
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Log Out
                  </button>
                </form>
              </div>
            </div>

            <div className="grid w-full gap-4 md:grid-cols-3">
              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  {isInstructorPortal ? "Coming Up" : "Upcoming Appointments"}
                </p>
                <p className="mt-3 text-3xl font-semibold text-white">
                  {upcomingCount}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Active Membership
                </p>
                <p className="mt-3 text-lg font-semibold text-white">
                  {typedMembership ? typedMembership.name_snapshot : "None"}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Active Packages
                </p>
                <p className="mt-3 text-3xl font-semibold text-white">
                  {typedPackages.length}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-4 md:px-8">
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Schedule
            </Link>
            {!isInstructorPortal ? (
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule#self-service-booking`}
                className="rounded-full border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50"
              >
                Book lesson
              </Link>
            ) : null}
            <Link
              href="#wallet"
              className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
            >
              Wallet
            </Link>
            <Link
              href="#my-pass"
              className="rounded-full border border-sky-200 bg-white px-4 py-2 text-sm font-semibold text-sky-800 hover:bg-sky-50"
            >
              Pass
            </Link>
            <Link
              href="#portal-events"
              className="rounded-full border border-orange-200 bg-white px-4 py-2 text-sm font-semibold text-orange-800 hover:bg-orange-50"
            >
              Events
            </Link>
            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/documents`}
              className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Documents
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                My Dance Hub
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                {nextUpItem
                  ? "You have something coming up"
                  : "You are all caught up"}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
                {nextUpItem
                  ? "Your portal keeps your schedule, credits, documents, events, and studio activity in one place."
                  : "There is nothing urgent showing right now. Use your quick actions to view your schedule, check credits, or contact the studio."}
              </p>
            </div>

            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
              className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              View Schedule
            </Link>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                Next Up
              </p>
              {nextUpItem ? (
                <>
                  <p className="mt-2 text-base font-semibold text-sky-950">
                    {nextUpItem.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-sky-900">
                    {formatDateTime(nextUpItem.starts_at, studioTimeZone)}
                  </p>
                  <p className="mt-1 text-sm text-sky-800">
                    {formatTimeRange(nextUpItem.starts_at, nextUpItem.ends_at, studioTimeZone)}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm leading-6 text-sky-900">
                  No upcoming lessons, classes, or rentals are currently on your
                  portal schedule.
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                My Wallet
              </p>
              <p className="mt-2 text-2xl font-semibold text-emerald-950">
                {hasUnlimitedCredits ? "Unlimited" : remainingCreditTotal}
              </p>
              <p className="mt-2 text-sm leading-6 text-emerald-900">
                {walletStatusItems.join(" • ")}
              </p>
              {typedMembership ? (
                <p className="mt-3 rounded-2xl border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-900">
                  {typedMembership.name_snapshot}: {renewalLabel(typedMembership)}
                </p>
              ) : null}
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Documents
              </p>
              <p className="mt-2 text-2xl font-semibold text-violet-950">
                {unsignedDocumentCount}
              </p>
              <p className="mt-2 text-sm leading-6 text-violet-900">
                {unsignedDocumentCount
                  ? overdueDocumentCount
                    ? `${overdueDocumentCount} past due. Review before your next visit.`
                    : upcomingDueDocumentCount
                      ? `${upcomingDueDocumentCount} due soon.`
                      : "signature needed."
                  : "No documents currently need your signature."}
              </p>
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/documents`}
                className="mt-4 inline-flex rounded-2xl border border-violet-200 bg-white px-4 py-2 text-sm font-semibold text-violet-900 hover:bg-violet-100"
              >
                Open Documents
              </Link>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
                My Events
              </p>
              <p className="mt-2 text-2xl font-semibold text-orange-950">
                {registeredEvents.length}
              </p>
              <p className="mt-2 text-sm leading-6 text-orange-900">
                {registeredEvents.length
                  ? `${issuedPortalTicketCount} ticket ${
                      issuedPortalTicketCount === 1 ? "code" : "codes"
                    } ready for check-in.`
                  : discoverableStudioEvents.length
                    ? "Studio events are available to review."
                    : "registered events will appear here after signup."}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Needs Attention
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                {attentionItems.length
                  ? "A few things to review"
                  : "You are all set"}
              </h2>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
              {attentionItems.length}
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {attentionItems.length ? (
              attentionItems.map((item) => (
                <Link
                  key={item.title}
                  href={item.href}
                  className={`block rounded-3xl border p-4 transition hover:shadow-sm ${attentionToneClass(item.tone)}`}
                >
                  <p className="font-semibold">{item.title}</p>
                  <p className="mt-1 text-sm leading-6 opacity-85">
                    {item.description}
                  </p>
                  <p className="mt-3 text-sm font-semibold">{item.cta} →</p>
                </Link>
              ))
            ) : (
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
                <p className="font-semibold">Nothing needs action right now.</p>
                <p className="mt-2 text-sm leading-6 text-emerald-900">
                  Your portal will highlight unsigned documents, pending
                  payments, low credits, and schedule reminders here.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      <CardShell
        title="Portal Updates"
        accent="violet"
        subtitle="A simple feed of reminders, changes, and next steps from your studio portal."
      >
        <div id="portal-notifications" className="space-y-4">
          {portalNotificationItems.length ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {portalNotificationItems.map((item) => (
                <Link
                  key={`${item.label}-${item.title}`}
                  href={item.href}
                  className={`block rounded-3xl border p-5 transition hover:shadow-sm ${attentionToneClass(item.tone)}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">
                        {item.label}
                      </p>
                      <p className="mt-2 font-semibold">{item.title}</p>
                    </div>
                    <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-semibold">
                      New
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 opacity-85">
                    {item.description}
                  </p>
                  <p className="mt-4 text-sm font-semibold">Review →</p>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-950">
              <p className="font-semibold">No portal updates right now.</p>
              <p className="mt-2 text-sm leading-6 text-emerald-900">
                Schedule reminders, tickets, documents, package notices, and booking request updates will appear here.
              </p>
            </div>
          )}

          <div className="grid gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600 sm:grid-cols-3">
            <div>
              <p className="font-semibold text-slate-900">Schedule</p>
              <p className="mt-1">Lessons, classes, rentals, and booking request status.</p>
            </div>
            <div>
              <p className="font-semibold text-slate-900">Account</p>
              <p className="mt-1">Credits, memberships, payment requests, and documents.</p>
            </div>
            <div>
              <p className="font-semibold text-slate-900">Events</p>
              <p className="mt-1">Registrations, ticket codes, waivers, and studio events.</p>
            </div>
          </div>
        </div>
      </CardShell>

      <CardShell
        title="My Pass"
        accent="emerald"
        subtitle="Show this pass at the front desk when you arrive. It gives the studio a quick way to confirm your portal profile, membership, and package snapshot."
      >
        <div id="my-pass" className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 text-center">
            <div className="mx-auto inline-flex rounded-[28px] border border-emerald-200 bg-white p-4 shadow-sm">
              <img
                src={portalPassQrUrl}
                alt="Student pass QR code"
                className="h-48 w-48 rounded-2xl"
              />
            </div>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Student Pass
            </p>
            <p className="mt-2 text-2xl font-semibold text-emerald-950">
              {portalPassName}
            </p>
            <p className="mt-1 text-sm text-emerald-900">{studioLabel}</p>
            <p className="mt-4 rounded-2xl border border-emerald-200 bg-white px-4 py-3 font-mono text-sm font-semibold tracking-[0.12em] text-emerald-950">
              {portalPassCode}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Portal Status
              </p>
              <p className="mt-3 text-xl font-semibold text-slate-950">
                Active portal profile
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Front desk staff can use this pass to quickly match your portal profile and review your studio account.
              </p>
            </div>

            <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                Membership
              </p>
              <p className="mt-3 text-xl font-semibold text-violet-950">
                {typedMembership ? statusLabel(typedMembership.status) : "Not active"}
              </p>
              <p className="mt-2 text-sm leading-6 text-violet-900">
                {typedMembership
                  ? renewalLabel(typedMembership)
                  : "No active membership is linked right now."}
              </p>
            </div>

            <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                Credits
              </p>
              <p className="mt-3 text-3xl font-semibold text-emerald-950">
                {hasUnlimitedCredits ? "Unlimited" : remainingCreditTotal}
              </p>
              <p className="mt-2 text-sm leading-6 text-emerald-900">
                {typedPackages.length
                  ? `${typedPackages.length} active package${
                      typedPackages.length === 1 ? "" : "s"
                    } linked.`
                  : "No active packages are linked right now."}
              </p>
            </div>

            <div className="rounded-3xl border border-sky-200 bg-sky-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">
                Next Up
              </p>
              <p className="mt-3 text-xl font-semibold text-sky-950">
                {nextUpItem ? nextUpItem.title : "Nothing scheduled"}
              </p>
              <p className="mt-2 text-sm leading-6 text-sky-900">
                {nextUpItem
                  ? formatDateTime(nextUpItem.starts_at, studioTimeZone)
                  : "Your next lesson or class will appear here after the studio schedules it."}
              </p>
            </div>
          </div>
        </div>
      </CardShell>

      <CardShell
        title="My Events & Tickets"
        accent="orange"
        subtitle="Review your registered events, ticket codes, event check-in details, and upcoming studio events."
      >
        <div className="space-y-6">
          {unsignedDocumentCount ? (
            <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-violet-950">
                    Event or studio documents may need your signature.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-violet-900">
                    Review your document center before attending class or checking in for an event.
                  </p>
                </div>
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/documents`}
                  className="inline-flex rounded-2xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-violet-800"
                >
                  Review documents
                </Link>
              </div>
            </div>
          ) : null}

          <div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  My Registered Events
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Your DanceFlow registrations and QR ticket codes appear here when available.
                </p>
              </div>
              <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-800 ring-1 ring-orange-100">
                {registeredEvents.length} registered
              </span>
            </div>

            {registeredEvents.length ? (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {registeredEvents.map(({ registration, event, tickets }) => (
                  <div
                    key={registration.id}
                    className="rounded-3xl border border-orange-100 bg-orange-50 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-orange-800 ring-1 ring-orange-100">
                        {statusLabel(registration.status)}
                      </span>
                      {registration.payment_status ? (
                        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                          {statusLabel(registration.payment_status)}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                        {tickets.length
                          ? `${tickets.length} ticket${
                              tickets.length === 1 ? "" : "s"
                            }`
                          : "Ticket pending"}
                      </span>
                    </div>

                    <Link
                      href={
                        event?.slug
                          ? `/events/${encodeURIComponent(event.slug)}`
                          : "#"
                      }
                      className="mt-4 block"
                    >
                      <p className="text-lg font-semibold text-orange-950 hover:text-orange-800">
                        {event?.name ?? "Event"}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-orange-900">
                        {formatEventDateTime(event)}
                      </p>
                      <p className="mt-1 text-sm text-orange-800">
                        {eventLocationLabel(event)}
                      </p>
                    </Link>

                    {tickets.length ? (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {tickets.slice(0, 2).map((ticket, index) => (
                          <div
                            key={ticket.id}
                            className="rounded-2xl border border-orange-100 bg-white p-3"
                          >
                            <div className="flex gap-3">
                              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white p-2">
                                {ticket.ticket_code ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={ticketQrSrc(ticket.ticket_code)}
                                    alt={`QR code for ${attendeeName(ticket, index)}`}
                                    className="h-full w-full"
                                  />
                                ) : (
                                  <span className="text-center text-xs text-slate-400">
                                    QR pending
                                  </span>
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-slate-950">
                                  {attendeeName(ticket, index)}
                                </p>
                                <p className="mt-1 font-mono text-[11px] font-semibold text-slate-600">
                                  {ticket.ticket_code ?? "Ticket code pending"}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {ticket.checked_in_at
                                    ? "Checked in"
                                    : "Ready for check-in"}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-4 rounded-2xl border border-dashed border-orange-200 bg-white/70 p-4 text-sm leading-6 text-orange-900">
                        Your QR ticket code will appear here after the registration is confirmed.
                      </p>
                    )}

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link
                        href={
                          event?.slug
                            ? `/events/${encodeURIComponent(event.slug)}`
                            : "#"
                        }
                        className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-700"
                      >
                        View event
                      </Link>
                      <Link
                        href={`/portal/${encodeURIComponent(typedStudio.slug)}/documents`}
                        className="rounded-xl border border-orange-200 bg-white px-4 py-2 text-sm font-semibold text-orange-800 hover:bg-orange-100"
                      >
                        Check waivers
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-3xl border border-dashed border-orange-200 bg-orange-50 p-6">
                <p className="font-semibold text-orange-950">
                  No registered events yet
                </p>
                <p className="mt-2 text-sm leading-6 text-orange-900">
                  When you register for a DanceFlow event, your event details and ticket codes will appear here.
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Upcoming Studio Events
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Discover events from {typedStudio.public_name ?? typedStudio.name}.
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {discoverableStudioEvents.length} available
              </span>
            </div>

            {discoverableStudioEvents.length ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {discoverableStudioEvents.map((event) => (
                  <Link
                    key={event.id}
                    href={`/events/${encodeURIComponent(event.slug)}`}
                    className="rounded-3xl border border-slate-200 bg-white p-5 transition hover:border-orange-200 hover:bg-orange-50"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                        {eventRegistrationModeLabel(event)}
                      </span>
                      {event.registration_required ? (
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">
                          Register online
                        </span>
                      ) : (
                        <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-100">
                          Host-managed registration
                        </span>
                      )}
                    </div>
                    <p className="mt-4 text-lg font-semibold text-slate-950">
                      {event.name}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {formatEventDateTime(event)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {eventLocationLabel(event)}
                    </p>
                    {event.short_description ? (
                      <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">
                        {event.short_description}
                      </p>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="font-semibold text-slate-950">
                  No additional studio events are posted right now.
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  New studio events will appear here when they are published.
                </p>
              </div>
            )}
          </div>
        </div>
      </CardShell>

      <CardShell
        title="Quick Actions"
        accent="sky"
        subtitle={
          isInstructorPortal
            ? "Use these links to move between your schedule, rentals, account details, and workspace access."
            : "Use these links to view your schedule, packages, payments, and account details."
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}`}
            title="Portal Home"
            description="Return to your main portal dashboard."
            tone="slate"
          />
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
            title="My Schedule"
            description="See upcoming lessons and recent activity."
            tone="sky"
          />
          {!isInstructorPortal && lumiEnabled ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/journey`}
              title="My Dance Journey"
              description="Set goals and ask LUMI what to practice next."
              tone="violet"
            />
          ) : null}
          {!isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule#self-service-booking`}
              title="Book a Lesson"
              description="Choose an available studio-approved time."
              tone="violet"
            />
          ) : null}
          <ActionTile
            href="#my-pass"
            title="My Pass"
            description="Show your student pass at the front desk for check-in or account lookup."
            tone="emerald"
          />
          <ActionTile
            href="#portal-notifications"
            title="Portal Updates"
            description="Review reminders, tickets, documents, and account prompts."
            tone="violet"
          />
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}/documents`}
            title="Documents"
            description="Review and sign documents from your studio."
            tone="orange"
          />
          {isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(studioSlug)}/floor-space`}
              title="Book Floor Space"
              description="Reserve time for teaching and rentals."
              tone="orange"
            />
          ) : null}
          {isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
              title="My Rentals"
              description="Review rentals, payments, and balances."
              tone="emerald"
            />
          ) : null}
          {!isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
              title="Packages & Credits"
              description="Check remaining lesson, group, and party credits."
              tone="emerald"
            />
          ) : null}
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
            title="My Account"
            description="Update your profile and account details."
            tone="violet"
          />
          {canReturnToWorkspace ? (
            <ActionTile
              href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
              title="Back to Workspace"
              description="Return to the full staff workspace for this studio."
              tone="slate"
            />
          ) : null}
        </div>
      </CardShell>

      <div className="grid gap-8 xl:grid-cols-[1.25fr_0.95fr]">
        <div className="space-y-8">
          <CardShell
            title="Pending Payments"
            accent="orange"
            subtitle="Any unpaid payment requests from the studio will appear here. Use Pay Now when you are ready to complete the purchase."
          >
            {typedPendingPayments.length ? (
              <div className="space-y-3">
                {typedPendingPayments.map((payment) => (
                  <div
                    key={payment.id}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-100">
                            Pending
                          </span>
                          <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                            {paymentTypeLabel(payment.payment_type)}
                          </span>
                        </div>
                        <p className="mt-3 text-2xl font-semibold text-slate-950">
                          {formatCurrency(payment.amount)}
                        </p>
                        {payment.notes ? (
                          <p className="mt-1 text-sm leading-6 text-slate-600">
                            {payment.notes}
                          </p>
                        ) : null}
                      </div>
                      <Link
                        href={
                          "/api/stripe/client-checkout?paymentId=" +
                          encodeURIComponent(payment.id) +
                          "&returnTo=" +
                          encodeURIComponent(`/portal/${typedStudio.slug}`) +
                          "&cancelTo=" +
                          encodeURIComponent(
                            `/portal/${typedStudio.slug}?error=payment_cancelled`,
                          )
                        }
                        className="inline-flex items-center justify-center rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                      >
                        Pay Now
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No pending payment requests right now.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title="My Wallet"
            accent="emerald"
            subtitle="Track your active packages, remaining credits, expiration dates, and what to ask the studio about next."
          >
            <div id="wallet" className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
                <p className="text-sm font-medium text-emerald-700">
                  Available credits
                </p>
                <p className="mt-3 text-4xl font-semibold text-emerald-950">
                  {hasUnlimitedCredits ? "Unlimited" : remainingCreditTotal}
                </p>
                <p className="mt-2 text-sm leading-6 text-emerald-900">
                  {typedPackages.length
                    ? `${typedPackages.length} active package${
                        typedPackages.length === 1 ? "" : "s"
                      } linked to this portal.`
                    : "No active package credits are linked right now."}
                </p>
              </div>

              <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5">
                <p className="text-sm font-medium text-amber-700">
                  Needs attention
                </p>
                <p className="mt-3 text-4xl font-semibold text-amber-950">
                  {lowBalancePackageCount + expiringPackageCount}
                </p>
                <p className="mt-2 text-sm leading-6 text-amber-900">
                  {lowBalancePackageCount || expiringPackageCount
                    ? "Package balances or expiration dates may need a quick review."
                    : "Your package balances do not need attention right now."}
                </p>
              </div>

              <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5">
                <p className="text-sm font-medium text-violet-700">
                  Membership
                </p>
                <p className="mt-3 text-xl font-semibold text-violet-950">
                  {typedMembership
                    ? statusLabel(typedMembership.status)
                    : "Not active"}
                </p>
                <p className="mt-2 text-sm leading-6 text-violet-900">
                  {typedMembership
                    ? renewalLabel(typedMembership)
                    : "No active membership is linked to this portal profile."}
                </p>
              </div>
            </div>

            {packageWalletItems.length ? (
              <div className="mt-6 space-y-4">
                {packageWalletItems.map((walletItem) => {
                  const clientPackage = walletItem.clientPackage;

                  return (
                    <div
                      key={clientPackage.id}
                      className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                    >
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
                              Active
                            </span>
                            <span
                              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ring-1 ${
                                walletItem.isExpiringSoon
                                  ? "bg-amber-50 text-amber-700 ring-amber-100"
                                  : "bg-white text-slate-600 ring-slate-200"
                              }`}
                            >
                              {expirationLabel(clientPackage.expiration_date)}
                            </span>
                            {walletItem.isLowBalance ? (
                              <span className="inline-flex rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-100">
                                Low balance
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-3 text-xl font-semibold text-slate-950">
                            {clientPackage.name_snapshot}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {walletItem.hasUnlimited
                              ? "Unlimited package"
                              : `${walletItem.totalRemaining} of ${walletItem.totalPurchased} credits remaining`}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-white bg-white px-4 py-3 text-sm text-slate-600 lg:min-w-48">
                          <p className="font-semibold text-slate-950">
                            {formatCurrency(
                              clientPackage.sold_price ??
                                clientPackage.price_snapshot,
                            )}
                          </p>
                          <p className="mt-1">
                            {walletItem.hasUnlimited
                              ? "Use as allowed by the studio"
                              : `${walletItem.totalUsed} credits used`}
                          </p>
                        </div>
                      </div>

                      {!walletItem.hasUnlimited ? (
                        <div className="mt-5">
                          <div className="h-2 overflow-hidden rounded-full bg-white">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${walletItem.usagePercent}%` }}
                            />
                          </div>
                          <div className="mt-2 flex justify-between text-xs text-slate-500">
                            <span>{walletItem.usagePercent}% used</span>
                            <span>{walletItem.totalRemaining} remaining</span>
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {walletItem.items.map((item) => {
                          const usagePercent = creditUsagePercent(
                            item.quantity_total,
                            item.quantity_used,
                          );

                          return (
                            <div
                              key={`${clientPackage.id}-${item.usage_type}`}
                              className="rounded-2xl border border-white bg-white p-4"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-slate-900">
                                    {packageUsageTypeLabel(item.usage_type)}
                                  </p>
                                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                                    {item.is_unlimited
                                      ? "Unlimited"
                                      : toNumber(item.quantity_remaining)}
                                  </p>
                                </div>
                                {!item.is_unlimited ? (
                                  <span
                                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                      toNumber(item.quantity_remaining) <= 1
                                        ? "bg-rose-50 text-rose-700"
                                        : "bg-emerald-50 text-emerald-700"
                                    }`}
                                  >
                                    {toNumber(item.quantity_remaining) <= 1
                                      ? "Low"
                                      : "Available"}
                                  </span>
                                ) : null}
                              </div>

                              {!item.is_unlimited ? (
                                <>
                                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                                    <div
                                      className="h-full rounded-full bg-slate-900"
                                      style={{ width: `${usagePercent}%` }}
                                    />
                                  </div>
                                  <p className="mt-2 text-xs text-slate-500">
                                    {toNumber(item.quantity_used)} used of{" "}
                                    {toNumber(item.quantity_total)}
                                  </p>
                                </>
                              ) : (
                                <p className="mt-2 text-xs text-slate-500">
                                  Unlimited use based on studio package rules.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {walletItem.isLowBalance || walletItem.isExpiringSoon ? (
                        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                          <p className="text-sm font-semibold text-amber-950">
                            Ask the studio about this package
                          </p>
                          <p className="mt-1 text-sm leading-6 text-amber-900">
                            {walletItem.isLowBalance
                              ? "Your credits are running low. The studio can help you renew, purchase another package, or schedule your next lesson."
                              : "This package expires soon. Check with the studio if you need to use or renew it."}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm font-semibold text-slate-950">
                  No active packages yet
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  When the studio adds a lesson package, class pack, or event
                  credit package to your account, it will appear here with
                  remaining credits and expiration details.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title={isInstructorPortal ? "My Membership" : "Membership Snapshot"}
            accent="violet"
            subtitle={
              isInstructorPortal
                ? "If this portal account also has a membership, you can review it here."
                : "See your current membership and billing period in one place."
            }
          >
            {typedMembership ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Plan</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {typedMembership.name_snapshot}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {formatCurrency(typedMembership.price_snapshot)} /{" "}
                    {typedMembership.billing_interval_snapshot || "period"}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Status</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {statusLabel(typedMembership.status)}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Current period:{" "}
                    {formatDate(typedMembership.current_period_start)} –{" "}
                    {formatDate(typedMembership.current_period_end)}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 md:col-span-2">
                  <p className="text-sm text-slate-500">Renewal</p>
                  <p className="mt-2 text-sm text-slate-700">
                    {typedMembership.cancel_at_period_end
                      ? "Your membership will end at the close of the current billing period."
                      : typedMembership.auto_renew
                        ? "Your membership is set to renew automatically."
                        : "Auto-renew is currently turned off."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No active membership is linked to this portal profile right
                  now.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title={
              isInstructorPortal
                ? "Recent Lesson Activity"
                : "Recent Appointments"
            }
            accent="emerald"
            subtitle={
              isInstructorPortal
                ? "A quick look at your recent lesson-side activity."
                : "A quick look at your most recent lessons and class bookings."
            }
          >
            {recentAppointments.length ? (
              <div className="space-y-3">
                {recentAppointments.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="font-medium text-slate-950">
                        {item.title?.trim() ||
                          appointmentTypeLabel(item.appointment_type)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {formatDateTime(item.starts_at, studioTimeZone)}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No recent appointment history yet.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title="Lesson Recaps"
            accent="violet"
            subtitle="When your instructor shares a lesson recap, you can review notes, homework, and next focus areas here."
          >
            {typedLessonRecaps.length ? (
              <div className="space-y-3">
                {typedLessonRecaps.map((recap) => (
                  <div
                    key={recap.id}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-100">
                        Shared by instructor
                      </span>
                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        Updated {formatDate(recap.updated_at.slice(0, 10))}
                      </span>
                    </div>
                    {recap.summary ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Summary
                        </p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">
                          {recap.summary}
                        </p>
                      </div>
                    ) : null}
                    {recap.homework ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Homework
                        </p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">
                          {recap.homework}
                        </p>
                      </div>
                    ) : null}
                    {recap.next_focus ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Next Focus
                        </p>
                        <p className="mt-2 text-sm leading-7 text-slate-700">
                          {recap.next_focus}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No shared lesson recaps yet.
                </p>
              </div>
            )}
          </CardShell>
        </div>

        <div className="space-y-8">
          <CardShell
            title="Coming Up"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your next lessons and rentals in one place."
                : "Your upcoming appointments at a glance."
            }
          >
            {upcomingItems.length ? (
              <div className="space-y-3">
                {upcomingItems.map((item) => (
                  <div
                    key={`${item.kind}-${item.id}`}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>

                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {item.kind === "rental" ? "Rental" : "Lesson"}
                      </span>
                    </div>

                    <p className="mt-3 font-medium text-slate-950">
                      {item.title}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatDateTime(item.starts_at, studioTimeZone)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {formatTimeRange(item.starts_at, item.ends_at, studioTimeZone)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No upcoming schedule items right now.
                </p>
              </div>
            )}

            <div className="mt-5">
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Open Full Schedule
              </Link>
            </div>
          </CardShell>

          <CardShell
            title="Payment History"
            accent="slate"
            subtitle="Review recent completed payments recorded by the studio."
          >
            {typedPaymentHistory.length ? (
              <div className="space-y-3">
                {typedPaymentHistory.map((payment) => (
                  <div
                    key={payment.id}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-slate-950">
                          {paymentTypeLabel(payment.payment_type)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {payment.paid_at
                            ? formatDateTime(payment.paid_at, studioTimeZone)
                            : formatDateTime(payment.created_at, studioTimeZone)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {paymentMethodLabel(payment.payment_method)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-slate-950">
                          {formatCurrency(payment.amount)}
                        </p>
                        <span
                          className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(payment.status)}`}
                        >
                          {statusLabel(payment.status)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No payment history is available yet.
                </p>
              </div>
            )}
          </CardShell>

          {isInstructorPortal ? (
            <CardShell
              title="Floor Rentals"
              accent="orange"
              subtitle="Manage your floor rental activity and keep your balance current."
            >
              <div className="space-y-5">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-500">Upcoming rentals</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-950">
                        {typedRentals.length}
                      </p>
                    </div>

                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      View Rentals
                    </Link>
                  </div>
                </div>

                {typedRentals.length ? (
                  <div className="space-y-3">
                    {typedRentals.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                          >
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <p className="mt-3 font-medium text-slate-950">
                          Floor Space Rental
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(item.starts_at, studioTimeZone)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {formatTimeRange(item.starts_at, item.ends_at, studioTimeZone)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                    <p className="text-sm text-slate-600">
                      You do not have any upcoming rentals booked.
                    </p>
                  </div>
                )}
              </div>
            </CardShell>
          ) : null}
        </div>
      </div>
    </div>
  );
}
