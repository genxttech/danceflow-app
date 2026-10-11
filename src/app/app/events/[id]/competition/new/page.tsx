import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";
import type { SetupProfileDefaults } from "@/lib/competition/setup/types";
import { STUDIO_CUSTOM_PROFILE } from "@/lib/competition/setup/studioCustomV3";
import { setupProfileProblems } from "@/lib/competition/setup/draft";
import { readEventOperationsLocks, readEventPresentation } from "@/lib/competition/setup/eventPresentationServer";
import { formatEventDates, formatEventTimes, formatEventVenue } from "@/lib/events/eventDisplay";
import CompetitionSetupWizard, { type EventSummary } from "./CompetitionSetupWizard";

export default async function NewCompetitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, event, canEditOperations } = await requireCompetitionWorkspace(id);

  const { count } = await supabase.from("event_competition_programs").select("id", { count: "exact", head: true }).eq("event_id", id);
  if ((count ?? 0) > 0) redirect(competitionWorkspaceHref(id));

  // 10C.5: the setup wizard runs on the Studio / Custom Rules profile (schema 2). Governing-body rules are
  // shown in the wizard but are not available yet, so no other profile is loaded here.
  const [{ data: profile }, presentation, operationsLocks] = await Promise.all([
    supabase
      .from("competition_rules_profiles")
      .select("profile_key, version, defaults")
      .eq("profile_key", STUDIO_CUSTOM_PROFILE.key)
      .eq("version", STUDIO_CUSTOM_PROFILE.version)
      .eq("status", "active")
      .maybeSingle(),
    readEventPresentation(supabase, id),
    readEventOperationsLocks(supabase, id),
  ]);
  if (!presentation) throw new Error("The event could not be loaded.");
  if (!profile) throw new Error("No active competition profile is available.");
  // Fail loudly on a profile/code mismatch instead of rendering empty steps.
  if (setupProfileProblems(profile.defaults).length > 0) throw new Error("The competition setup rules do not match this version of DanceFlow.");

  const summary: EventSummary = {
    name: event.name,
    dates: formatEventDates(event.start_date, event.end_date),
    times: formatEventTimes(event.start_time, event.end_time),
    venue: formatEventVenue(event.venue_name, event.city, event.state),
  };

  return (
    <CompetitionSetupWizard
      eventId={id}
      event={summary}
      profile={{ key: profile.profile_key, version: profile.version }}
      defaults={profile.defaults as SetupProfileDefaults}
      // Competition registration has its own window and account setting (stored on the competition); they are not
      // read from, or written to, the event's ticket registration settings.
      initialRegistration={{ opens: "", closes: "", accountRequired: true }}
      initialPresentation={presentation}
      canEditOperations={canEditOperations}
      operationsLocks={operationsLocks}
      requestKey={randomUUID()}
    />
  );
}
