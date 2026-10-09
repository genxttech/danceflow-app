import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";
import { getEventTimeZone } from "@/lib/events/eventTiming";
import type { ProfileDefaults } from "@/lib/competition/simple/types";
import CreateCompetitionWizard, { type EventSummary } from "./CreateCompetitionWizard";

function formatDate(value: string | null, endValue: string | null) {
  if (!value) return null;
  const format = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return endValue && endValue !== value ? `${format(value)} – ${format(endValue)}` : format(value);
}

function formatTime(start: string | null, end: string | null) {
  const format = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  };
  if (!start) return null;
  return end ? `${format(start)} – ${format(end)}` : format(start);
}

function existingWindow(event: { timezone: string | null; registration_opens_at: string | null; registration_closes_at: string | null }) {
  if (!event.registration_opens_at && !event.registration_closes_at) return null;
  const timeZone = getEventTimeZone(event);
  const format = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
  return [event.registration_opens_at ? `opens ${format(event.registration_opens_at)}` : null, event.registration_closes_at ? `closes ${format(event.registration_closes_at)}` : null].filter(Boolean).join(", ");
}

export default async function NewCompetitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, event } = await requireCompetitionWorkspace(id);

  const { count } = await supabase.from("event_competition_programs").select("id", { count: "exact", head: true }).eq("event_id", id);
  if ((count ?? 0) > 0) redirect(competitionWorkspaceHref(id));

  const { data: profile } = await supabase
    .from("competition_rules_profiles")
    .select("profile_key, version, defaults")
    .eq("profile_key", "studio_simple")
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!profile) throw new Error("No active competition profile is available.");

  const summary: EventSummary = {
    name: event.name,
    dates: formatDate(event.start_date, event.end_date),
    times: formatTime(event.start_time, event.end_time),
    venue: [event.venue_name, [event.city, event.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || null,
    existingWindow: existingWindow(event),
  };

  return (
    <CreateCompetitionWizard
      eventId={id}
      event={summary}
      profile={{ key: profile.profile_key, version: profile.version }}
      defaults={profile.defaults as ProfileDefaults}
      requestKey={randomUUID()}
    />
  );
}
