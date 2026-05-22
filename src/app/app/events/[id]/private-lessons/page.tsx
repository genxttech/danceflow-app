import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  bookPrivateLessonSlotOfflineAction,
  holdPrivateLessonSlotAction,
  releasePrivateLessonSlotAction,
  regenerateGuestCoachScheduleTokenAction,
  setGuestCoachScheduleLinkEnabledAction,
} from "../actions";

type Params = Promise<{
  id: string;
}>;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type EventRow = {
  id: string;
  studio_id: string;
  organizer_id: string | null;
  name: string;
  slug: string;
  status: string;
  visibility: string;
  timezone: string | null;
};

type GuestCoachRow = {
  id: string;
  name: string;
  bio: string | null;
  photo_url: string | null;
  schedule_token: string;
  schedule_token_enabled: boolean | null;
  schedule_token_created_at: string | null;
};

type PrivateLessonSlotRow = {
  id: string;
  event_id: string;
  coach_id: string | null;
  block_id: string | null;
  studio_id: string;
  organizer_id: string | null;
  starts_at: string;
  ends_at: string;
  price: number | string | null;
  location_label: string | null;
  status: string;
  payment_status: string | null;
  client_id: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_notes: string | null;
  booked_at: string | null;
  held_until: string | null;
  hold_token: string | null;
  event_guest_coaches: GuestCoachRow | GuestCoachRow[] | null;
};

function canManageEvent(params: {
  isPlatformAdmin: boolean;
  organizerUserRole: string | null;
  studioRole: string | null;
  isStudioHosted: boolean;
}) {
  const { isPlatformAdmin, organizerUserRole, studioRole, isStudioHosted } =
    params;

  if (isPlatformAdmin) return true;

  if (
    ["organizer_owner", "organizer_admin", "organizer_staff"].includes(
      organizerUserRole ?? "",
    )
  ) {
    return true;
  }

  if (
    isStudioHosted &&
    ["studio_owner", "studio_admin", "front_desk"].includes(studioRole ?? "")
  ) {
    return true;
  }

  return false;
}

function getCoach(value: PrivateLessonSlotRow["event_guest_coaches"]) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function formatCurrency(value: number | string | null) {
  const amount = typeof value === "number" ? value : Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDateLabel(value: string, timeZone?: string | null) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

function formatTimeRange(
  startsAt: string,
  endsAt: string,
  timeZone?: string | null,
) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Time not set";
  }

  const startLabel = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(start);

  const endLabel = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(end);

  return `${startLabel} – ${endLabel}`;
}

function slotDateKey(startsAt: string, timeZone?: string | null) {
  const start = new Date(startsAt);

  if (Number.isNaN(start.getTime())) {
    return "unknown";
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(start);

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
}

function statusBadgeClass(status: string) {
  if (status === "available") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "booked") {
    return "border-purple-200 bg-purple-50 text-purple-700";
  }

  if (status === "held" || status === "blocked") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (status === "cancelled") {
    return "border-slate-200 bg-slate-100 text-slate-600";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function paymentBadgeClass(status: string | null) {
  if (status === "paid") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "waived") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function labelize(value: string | null | undefined) {
  return (value || "Not set")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isCheckoutHold(slot: PrivateLessonSlotRow) {
  return slot.status === "held" && Boolean(slot.held_until || slot.hold_token);
}

function isManualBlockedSlot(slot: PrivateLessonSlotRow) {
  return (slot.status === "held" && !isCheckoutHold(slot)) || slot.status === "blocked";
}

function slotStatusLabel(slot: PrivateLessonSlotRow) {
  if (slot.status === "held") {
    return isCheckoutHold(slot) ? "Checkout pending" : "Blocked";
  }

  return labelize(slot.status);
}

function slotPaymentLabel(slot: PrivateLessonSlotRow) {
  if (isManualBlockedSlot(slot)) {
    return "Not for sale";
  }

  return labelize(slot.payment_status);
}

function blockReasonLabel(slot: PrivateLessonSlotRow) {
  if (!isManualBlockedSlot(slot)) {
    return null;
  }

  return slot.buyer_notes || "Blocked by studio.";
}

function getBanner(searchParams: Record<string, string | string[] | undefined>) {
  if (searchParams.private_lesson_booked) {
    return {
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      message: "Private lesson slot was booked offline and removed from public checkout.",
    };
  }

  if (searchParams.private_lesson_blocked) {
    return {
      className: "border-amber-200 bg-amber-50 text-amber-800",
      message: "Private lesson slot was blocked and removed from public checkout.",
    };
  }

  if (searchParams.private_lesson_released) {
    return {
      className: "border-blue-200 bg-blue-50 text-blue-800",
      message: "Private lesson slot was released and is available again.",
    };
  }

  if (searchParams.coach_schedule_link_regenerated) {
    return {
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      message: "Guest coach schedule link was regenerated. Share the new link with the coach.",
    };
  }

  if (searchParams.coach_schedule_link_enabled) {
    return {
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
      message: "Guest coach schedule link was enabled.",
    };
  }

  if (searchParams.coach_schedule_link_disabled) {
    return {
      className: "border-amber-200 bg-amber-50 text-amber-800",
      message: "Guest coach schedule link was disabled.",
    };
  }

  if (searchParams.private_lesson_error) {
    return {
      className: "border-red-200 bg-red-50 text-red-800",
      message:
        "The private lesson slot or coach schedule link could not be updated. Confirm the record is still available and try again.",
    };
  }

  return null;
}

function groupSlotsByCoachAndDate(
  slots: PrivateLessonSlotRow[],
  timeZone?: string | null,
) {
  const coachGroups = new Map<
    string,
    {
      coach: GuestCoachRow | null;
      coachName: string;
      slots: PrivateLessonSlotRow[];
    }
  >();

  for (const slot of slots) {
    const coach = getCoach(slot.event_guest_coaches);
    const key = coach?.id ?? "unassigned";

    if (!coachGroups.has(key)) {
      coachGroups.set(key, {
        coach,
        coachName: coach?.name ?? "Unassigned coach",
        slots: [],
      });
    }

    coachGroups.get(key)?.slots.push(slot);
  }

  return Array.from(coachGroups.values())
    .sort((a, b) => a.coachName.localeCompare(b.coachName))
    .map((coachGroup) => {
      const dateGroups = new Map<
        string,
        {
          dateLabel: string;
          slots: PrivateLessonSlotRow[];
        }
      >();

      for (const slot of coachGroup.slots) {
        const key = slotDateKey(slot.starts_at, timeZone);

        if (!dateGroups.has(key)) {
          dateGroups.set(key, {
            dateLabel: formatDateLabel(slot.starts_at, timeZone),
            slots: [],
          });
        }

        dateGroups.get(key)?.slots.push(slot);
      }

      return {
        ...coachGroup,
        dateGroups: Array.from(dateGroups.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([dateKey, dateGroup]) => ({
            dateKey,
            dateLabel: dateGroup.dateLabel,
            slots: dateGroup.slots.sort((a, b) =>
              a.starts_at.localeCompare(b.starts_at),
            ),
          })),
      };
    });
}

export default async function EventPrivateLessonsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();

  if (!context) {
    notFound();
  }

  const { studioId, studioRole, isPlatformAdmin } = context;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select(
      `
      id,
      studio_id,
      organizer_id,
      name,
      slug,
      status,
      visibility,
      timezone
    `,
    )
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (eventError || !event) {
    notFound();
  }

  const typedEvent = event as EventRow;
  const isStudioHosted = !typedEvent.organizer_id;

  let organizerUserRole: string | null = null;

  if (typedEvent.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", typedEvent.organizer_id)
      .eq("user_id", user.id)
      .eq("active", true)
      .maybeSingle();

    organizerUserRole = organizerUser?.role ?? null;
  }

  const canManage = canManageEvent({
    isPlatformAdmin: Boolean(isPlatformAdmin),
    organizerUserRole,
    studioRole: studioRole ?? null,
    isStudioHosted,
  });

  const nowIso = new Date().toISOString();

  await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "available",
      payment_status: "unpaid",
      buyer_name: null,
      buyer_email: null,
      buyer_phone: null,
      buyer_notes: null,
      client_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      booked_at: null,
      held_until: null,
      hold_token: null,
      updated_at: nowIso,
    })
    .eq("event_id", typedEvent.id)
    .eq("studio_id", studioId)
    .eq("status", "held")
    .lt("held_until", nowIso);

  const { data: slots, error: slotsError } = await supabase
    .from("event_private_lesson_slots")
    .select(
      `
      id,
      event_id,
      coach_id,
      block_id,
      studio_id,
      organizer_id,
      starts_at,
      ends_at,
      price,
      location_label,
      status,
      payment_status,
      client_id,
      buyer_name,
      buyer_email,
      buyer_phone,
      buyer_notes,
      booked_at,
      held_until,
      hold_token,
      event_guest_coaches:coach_id (
        id,
        name,
        bio,
        photo_url,
        schedule_token,
        schedule_token_enabled,
        schedule_token_created_at
      )
    `,
    )
    .eq("event_id", typedEvent.id)
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: true });

  if (slotsError) {
    throw new Error(`Failed to load private lesson slots: ${slotsError.message}`);
  }

  const slotRows = (slots ?? []) as PrivateLessonSlotRow[];
  const groupedSlots = groupSlotsByCoachAndDate(slotRows, typedEvent.timezone);
  const banner = getBanner(query);
  const returnTo = `/app/events/${typedEvent.id}/private-lessons`;
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");

  const availableCount = slotRows.filter((slot) => slot.status === "available")
    .length;
  const bookedCount = slotRows.filter((slot) => slot.status === "booked").length;
  const blockedCount = slotRows.filter(
    (slot) => slot.status === "held" || slot.status === "blocked",
  ).length;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-[#F3D7FF]">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[10px] font-black tracking-normal text-[#5B197A]">
                DF
              </span>
              DanceFlow
            </div>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              Guest coach private lessons
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Manage private lesson slots
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Book offline sales, block unavailable times, and release slots when plans change.
              Only available unpaid slots appear on the public event page.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/events"
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Back to Events
            </Link>
            <Link
              href={`/app/events/${typedEvent.id}/edit`}
              className="inline-flex items-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
            >
              Edit Event
            </Link>
            <Link
              href={`/events/${typedEvent.slug}`}
              className="inline-flex items-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#5B197A] transition hover:bg-[#F9F1FF]"
            >
              View public page
            </Link>
          </div>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-4 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Event</p>
            <p className="mt-1 text-sm font-semibold">{typedEvent.name}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Available</p>
            <p className="mt-1 text-sm font-semibold">{availableCount}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Booked</p>
            <p className="mt-1 text-sm font-semibold">{bookedCount}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">Blocked</p>
            <p className="mt-1 text-sm font-semibold">{blockedCount}</p>
          </div>
        </div>
      </section>

      {banner ? (
        <div className={`rounded-2xl border px-4 py-4 text-sm ${banner.className}`}>
          {banner.message}
        </div>
      ) : null}

      {!canManage ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          You can view private lesson slots, but your current role does not have permission to
          manage them.
        </div>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Slot inventory</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Use <span className="font-medium text-slate-900">Book Offline</span> when money is
              taken outside Stripe. Use <span className="font-medium text-slate-900">Block</span>{" "}
              when the coach is unavailable or you need to hold the time.
            </p>
          </div>
        </div>

        {slotRows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[#D8B4FE] bg-[#FCF8FF] px-4 py-8 text-sm text-slate-600">
            No guest coach private lesson slots are set up yet. Edit the event and add guest coach
            availability blocks to generate purchasable slots.
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {groupedSlots.map((coachGroup) => (
              <div
                key={coachGroup.coach?.id ?? "unassigned"}
                className="rounded-3xl border border-[#E9D5FF] bg-[#FCF8FF] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                      Coach
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-slate-900">
                      {coachGroup.coachName}
                    </h3>
                  </div>
                  <p className="rounded-full border border-[#E9D5FF] bg-white px-3 py-1 text-xs font-medium text-slate-600">
                    {coachGroup.slots.length} slots
                  </p>
                </div>

                {coachGroup.coach?.schedule_token ? (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Guest coach schedule link
                        </p>
                        <p className="mt-2 break-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                          {`${siteUrl}/coach-schedule/${coachGroup.coach.schedule_token}`}
                        </p>
                        <p className="mt-2 text-xs leading-5 text-slate-500">
                          Share this private read-only link with the guest coach. It shows their
                          slot schedule without giving dashboard access.
                        </p>
                        {coachGroup.coach.schedule_token_enabled === false ? (
                          <p className="mt-2 text-xs font-semibold text-amber-700">
                            This link is currently disabled.
                          </p>
                        ) : null}
                      </div>

                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          <a
                            href={`/coach-schedule/${coachGroup.coach.schedule_token}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            Open Link
                          </a>

                          <form action={regenerateGuestCoachScheduleTokenAction}>
                            <input type="hidden" name="eventId" value={typedEvent.id} />
                            <input type="hidden" name="coachId" value={coachGroup.coach.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-100"
                            >
                              Regenerate
                            </button>
                          </form>

                          <form action={setGuestCoachScheduleLinkEnabledAction}>
                            <input type="hidden" name="eventId" value={typedEvent.id} />
                            <input type="hidden" name="coachId" value={coachGroup.coach.id} />
                            <input
                              type="hidden"
                              name="enabled"
                              value={
                                coachGroup.coach.schedule_token_enabled === false
                                  ? "true"
                                  : "false"
                              }
                            />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                            >
                              {coachGroup.coach.schedule_token_enabled === false
                                ? "Enable Link"
                                : "Disable Link"}
                            </button>
                          </form>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 space-y-4">
                  {coachGroup.dateGroups.map((dateGroup) => (
                    <details
                      key={dateGroup.dateKey}
                      className="group overflow-hidden rounded-2xl border border-slate-200 bg-white"
                    >
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                        <div className="min-w-0">
                          <h4 className="text-sm font-semibold text-slate-900">
                            {dateGroup.dateLabel}
                          </h4>
                          <p className="mt-1 text-xs text-slate-500">
                            {dateGroup.slots.length} private lesson slots
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                            {dateGroup.slots.filter((slot) => slot.status === "available").length} open
                          </span>
                          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:hidden">
                            Show
                          </span>
                          <span className="hidden rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:inline-flex">
                            Hide
                          </span>
                        </div>
                      </summary>

                      <div className="grid gap-3 border-t border-slate-100 p-4">
                        {dateGroup.slots.map((slot) => {
                          const canRelease = ["booked", "held", "blocked", "cancelled"].includes(
                            slot.status,
                          );
                          const isAvailable = slot.status === "available";

                          return (
                            <div
                              key={slot.id}
                              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                            >
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-base font-semibold text-slate-950">
                                      {formatTimeRange(
                                        slot.starts_at,
                                        slot.ends_at,
                                        typedEvent.timezone,
                                      )}
                                    </p>
                                    <span
                                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                                        slot.status,
                                      )}`}
                                    >
                                      {slotStatusLabel(slot)}
                                    </span>
                                    <span
                                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${paymentBadgeClass(
                                        slot.payment_status,
                                      )}`}
                                    >
                                      {slotPaymentLabel(slot)}
                                    </span>
                                  </div>

                                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                                    <span>{formatCurrency(slot.price)}</span>
                                    {slot.location_label ? (
                                      <span>{slot.location_label}</span>
                                    ) : null}
                                    {slot.buyer_name ? (
                                      <span>Buyer: {slot.buyer_name}</span>
                                    ) : null}
                                  </div>

                                  {slot.buyer_email || slot.buyer_phone ? (
                                    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
                                      {slot.buyer_email ? <p>Email: {slot.buyer_email}</p> : null}
                                      {slot.buyer_phone ? <p>Phone: {slot.buyer_phone}</p> : null}
                                    </div>
                                  ) : null}

                                  {slot.buyer_notes || blockReasonLabel(slot) ? (
                                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                                        {isManualBlockedSlot(slot) ? "Blocked reason" : "Notes"}
                                      </p>
                                      <p className="mt-1">{blockReasonLabel(slot) ?? slot.buyer_notes}</p>
                                    </div>
                                  ) : null}
                                </div>

                                {canManage ? (
                                  <div className="flex flex-col gap-2 lg:w-[26rem]">
                                    {isAvailable ? (
                                      <details className="rounded-2xl border border-slate-200 bg-white p-3">
                                        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                                          Book Offline
                                        </summary>
                                        <form
                                          action={bookPrivateLessonSlotOfflineAction}
                                          className="mt-3 grid gap-3"
                                        >
                                          <input type="hidden" name="slotId" value={slot.id} />
                                          <input
                                            type="hidden"
                                            name="eventId"
                                            value={typedEvent.id}
                                          />
                                          <input type="hidden" name="returnTo" value={returnTo} />

                                          <label className="space-y-1 text-sm">
                                            <span className="font-medium text-slate-700">
                                              Buyer name
                                            </span>
                                            <input
                                              name="buyerName"
                                              required
                                              className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                              placeholder="Student name"
                                            />
                                          </label>

                                          <div className="grid gap-3 md:grid-cols-2">
                                            <label className="space-y-1 text-sm">
                                              <span className="font-medium text-slate-700">
                                                Buyer email
                                              </span>
                                              <input
                                                name="buyerEmail"
                                                type="email"
                                                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                                placeholder="Optional"
                                              />
                                            </label>

                                            <label className="space-y-1 text-sm">
                                              <span className="font-medium text-slate-700">
                                                Buyer phone
                                              </span>
                                              <input
                                                name="buyerPhone"
                                                className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                                placeholder="Optional"
                                              />
                                            </label>
                                          </div>

                                          <label className="space-y-1 text-sm">
                                            <span className="font-medium text-slate-700">
                                              Payment status
                                            </span>
                                            <select
                                              name="paymentStatus"
                                              defaultValue="paid"
                                              className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                            >
                                              <option value="paid">Paid offline</option>
                                              <option value="unpaid">Reserved but unpaid</option>
                                              <option value="partial">Partially paid</option>
                                              <option value="waived">Waived / comped</option>
                                            </select>
                                          </label>

                                          <label className="space-y-1 text-sm">
                                            <span className="font-medium text-slate-700">
                                              Notes
                                            </span>
                                            <textarea
                                              name="buyerNotes"
                                              rows={2}
                                              className="w-full rounded-xl border border-slate-300 px-3 py-2"
                                              placeholder="Optional notes for this booking"
                                            />
                                          </label>

                                          <button
                                            type="submit"
                                            className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4A1363]"
                                          >
                                            Save Offline Booking
                                          </button>
                                        </form>
                                      </details>
                                    ) : null}

                                    {isAvailable ? (
                                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                                        <p className="text-sm font-semibold text-amber-950">
                                          Block Slot
                                        </p>
                                        <p className="mt-1 text-xs leading-5 text-amber-800">
                                          Use quick blocks for common schedule holds, or add a custom note.
                                        </p>

                                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                          <form action={holdPrivateLessonSlotAction}>
                                            <input type="hidden" name="slotId" value={slot.id} />
                                            <input
                                              type="hidden"
                                              name="eventId"
                                              value={typedEvent.id}
                                            />
                                            <input type="hidden" name="returnTo" value={returnTo} />
                                            <input
                                              type="hidden"
                                              name="buyerNotes"
                                              value="Coach break"
                                            />
                                            <button
                                              type="submit"
                                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100"
                                            >
                                              Coach Break
                                            </button>
                                          </form>

                                          <form action={holdPrivateLessonSlotAction}>
                                            <input type="hidden" name="slotId" value={slot.id} />
                                            <input
                                              type="hidden"
                                              name="eventId"
                                              value={typedEvent.id}
                                            />
                                            <input type="hidden" name="returnTo" value={returnTo} />
                                            <input
                                              type="hidden"
                                              name="buyerNotes"
                                              value="Group class"
                                            />
                                            <button
                                              type="submit"
                                              className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100"
                                            >
                                              Group Class
                                            </button>
                                          </form>
                                        </div>

                                        <details className="mt-3 rounded-xl border border-amber-200 bg-white p-3">
                                          <summary className="cursor-pointer text-sm font-semibold text-amber-900">
                                            Custom block note
                                          </summary>
                                          <form
                                            action={holdPrivateLessonSlotAction}
                                            className="mt-3 grid gap-3"
                                          >
                                            <input type="hidden" name="slotId" value={slot.id} />
                                            <input
                                              type="hidden"
                                              name="eventId"
                                              value={typedEvent.id}
                                            />
                                            <input type="hidden" name="returnTo" value={returnTo} />

                                            <label className="space-y-1 text-sm">
                                              <span className="font-medium text-amber-950">
                                                Block reason / note
                                              </span>
                                              <textarea
                                                name="buyerNotes"
                                                rows={2}
                                                className="w-full rounded-xl border border-amber-200 px-3 py-2"
                                                placeholder="Example: Coach dinner break, group class, staff hold"
                                              />
                                            </label>

                                            <button
                                              type="submit"
                                              className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700"
                                            >
                                              Block This Slot
                                            </button>
                                          </form>
                                        </details>
                                      </div>
                                    ) : null}

                                    {canRelease ? (
                                      <form
                                        action={releasePrivateLessonSlotAction}
                                        className="rounded-2xl border border-blue-200 bg-blue-50 p-3"
                                      >
                                        <input type="hidden" name="slotId" value={slot.id} />
                                        <input
                                          type="hidden"
                                          name="eventId"
                                          value={typedEvent.id}
                                        />
                                        <input type="hidden" name="returnTo" value={returnTo} />
                                        <button
                                          type="submit"
                                          className="w-full rounded-xl border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100"
                                        >
                                          Release Slot
                                        </button>
                                      </form>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}



