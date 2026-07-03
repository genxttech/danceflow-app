import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, CalendarDays, ExternalLink, ShieldCheck } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DEFAULT_TIME_ZONE = "America/New_York";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Params = Promise<{ token: string }>;

type RecipientRow = {
  id: string;
  recap_id: string;
  studio_id: string;
  appointment_id: string | null;
  event_id: string | null;
  event_session_id: string | null;
  client_id: string | null;
  guest_name: string | null;
  guest_email: string | null;
  delivery_status: string;
  viewed_at: string | null;
};

type GroupLessonRecapRow = {
  id: string;
  title: string;
  summary: string | null;
  technique_notes: string | null;
  safety_notes: string | null;
  practice_assignment: string | null;
  media_links: string[] | null;
  status: string;
  published_at: string | null;
};

type StudioRow = {
  id: string;
  slug: string;
  name: string;
  public_name: string | null;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  appointment_type: string;
  starts_at: string | null;
};

type EventSessionRow = {
  id: string;
  session_date: string | null;
  start_time: string | null;
  session_label: string | null;
  events:
    | { name: string | null }
    | { name: string | null }[]
    | null;
};

type StudioSettingsRow = {
  timezone: string | null;
};

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function formatDateTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "Date not shared";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getMediaLabel(value: string, index: number) {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "") || `Resource ${index + 1}`;
  } catch {
    return `Resource ${index + 1}`;
  }
}

function displayName(recipient: RecipientRow) {
  return recipient.guest_name?.trim() || "there";
}

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatEventSessionDate(
  eventSession: EventSessionRow | null,
  timeZone: string,
) {
  if (!eventSession?.session_date) return "Date not shared";

  const value = eventSession.start_time
    ? `${eventSession.session_date}T${eventSession.start_time}`
    : eventSession.session_date;

  return formatDateTime(value, timeZone);
}

export default async function PublicGroupRecapPage({
  params,
}: {
  params: Params;
}) {
  const { token } = await params;
  const normalizedToken = token.trim();

  if (!UUID_PATTERN.test(normalizedToken)) {
    notFound();
  }

  const supabase = createAdminClient();

  const { data: recipientData, error: recipientError } = await supabase
    .from("group_lesson_recap_recipients")
    .select(
      "id, recap_id, studio_id, appointment_id, event_id, event_session_id, client_id, guest_name, guest_email, delivery_status, viewed_at",
    )
    .eq("secure_token", normalizedToken)
    .neq("delivery_status", "revoked")
    .maybeSingle();

  if (recipientError || !recipientData) {
    notFound();
  }

  const recipient = recipientData as RecipientRow;

  const [
    { data: recapData },
    { data: studioData },
    { data: appointmentData },
    { data: eventSessionData },
    { data: settingsData },
  ] =
    await Promise.all([
      supabase
        .from("group_lesson_recaps")
        .select(
          "id, title, summary, technique_notes, safety_notes, practice_assignment, media_links, status, published_at",
        )
        .eq("id", recipient.recap_id)
        .eq("studio_id", recipient.studio_id)
        .eq("status", "published")
        .maybeSingle(),
      supabase
        .from("studios")
        .select("id, slug, name, public_name")
        .eq("id", recipient.studio_id)
        .maybeSingle(),
      supabase
        .from("appointments")
        .select("id, title, appointment_type, starts_at")
        .eq("id", recipient.appointment_id ?? "00000000-0000-0000-0000-000000000000")
        .eq("studio_id", recipient.studio_id)
        .maybeSingle(),
      supabase
        .from("event_sessions")
        .select("id, session_date, start_time, session_label, events ( name )")
        .eq("id", recipient.event_session_id ?? "00000000-0000-0000-0000-000000000000")
        .eq("studio_id", recipient.studio_id)
        .maybeSingle(),
      supabase
        .from("studio_settings")
        .select("timezone")
        .eq("studio_id", recipient.studio_id)
        .maybeSingle(),
    ]);

  if (!recapData || !studioData) {
    notFound();
  }

  if (!recipient.viewed_at) {
    await supabase
      .from("group_lesson_recap_recipients")
      .update({ viewed_at: new Date().toISOString() })
      .eq("id", recipient.id);
  }

  const recap = recapData as GroupLessonRecapRow;
  const studio = studioData as StudioRow;
  const appointment = (appointmentData ?? null) as AppointmentRow | null;
  const eventSession = (eventSessionData ?? null) as EventSessionRow | null;
  const settings = (settingsData ?? null) as StudioSettingsRow | null;
  const studioName = studio.public_name?.trim() || studio.name;
  const studioTimeZone = getStudioTimeZone(settings?.timezone);
  const event = firstJoin(eventSession?.events);
  const recapContextTitle =
    appointment?.title ||
    eventSession?.session_label ||
    event?.name ||
    "Group class recap";
  const recapDate = appointment?.starts_at
    ? formatDateTime(appointment.starts_at, studioTimeZone)
    : formatEventSessionDate(eventSession, studioTimeZone);
  const portalHref = `/portal/${encodeURIComponent(studio.slug)}`;
  const loginHref = `/login?studio=${encodeURIComponent(studio.slug)}&next=${encodeURIComponent(
    `/recaps/${normalizedToken}`,
  )}`;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary,#7c3aed)_0%,#4b2e83_100%)] p-7 text-white sm:p-9">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
              DanceFlow Group Class Recap
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              {recap.title || recapContextTitle}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/80">
              Hi {displayName(recipient)}. {studioName} shared this recap from your group class.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold ring-1 ring-white/20">
                <CalendarDays className="h-3.5 w-3.5" />
                {recapDate}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold ring-1 ring-white/20">
                <ShieldCheck className="h-3.5 w-3.5" />
                Secure recap link
              </span>
            </div>
          </div>

          <div className="grid gap-5 p-5 sm:p-7">
            <section className="rounded-3xl border border-violet-100 bg-violet-50 p-5">
              <div className="flex items-start gap-3">
                <BookOpen className="mt-1 h-5 w-5 shrink-0 text-violet-700" />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
                    Class summary
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                    {recap.summary?.trim() || "No class summary was added."}
                  </p>
                </div>
              </div>
            </section>

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Practice assignment
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                  {recap.practice_assignment?.trim() || "No practice assignment was added."}
                </p>
              </section>

              <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Technique notes
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                  {recap.technique_notes?.trim() || "No technique notes were added."}
                </p>
              </section>
            </div>

            <section className="rounded-3xl border border-amber-100 bg-amber-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                Safety notes
              </p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
                {recap.safety_notes?.trim() || "No safety notes were added."}
              </p>
            </section>

            {recap.media_links?.length ? (
              <section className="rounded-3xl border border-emerald-100 bg-emerald-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  Shared links
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  {recap.media_links.map((href, index) => (
                    <a
                      key={`${recap.id}-${href}`}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-white/70 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                    >
                      {getMediaLabel(href, index)}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-slate-950">Want to save your recap history?</p>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-600">
            Create or sign in to your DanceFlow account to keep studio-shared recaps, lesson notes, schedule details, and
            LUMI guidance together.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={loginHref}
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Sign in or create account
            </Link>
            <Link
              href={portalHref}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Go to studio portal
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
