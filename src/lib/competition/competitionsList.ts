import { competitionSetupHref, competitionWorkspaceHref } from "@/lib/competition/workspaceLink";

/**
 * 10C.1: one row of the top-level Competitions list. Every row resolves to the SAME canonical
 * workspace (/app/events/[id]/competition); events without setup go to the Simple Mode wizard.
 */

export type CompetitionsListProgram = {
  status: string;
  rules_profile_key: string | null;
  profile_locked_at: string | null;
  registration_status: string | null;
  registration_opened_at: string | null;
};

export type CompetitionsListRow = {
  stateLabel: string;
  tone: "neutral" | "progress" | "ready" | "live" | "done";
  actionLabel: string;
  href: string;
};

/** Roles that see the Competitions list (the same roles that can create events). */
export function canSeeCompetitionsList(role: string | null | undefined, isPlatformAdmin: boolean) {
  return isPlatformAdmin || ["studio_owner", "studio_admin", "organizer_owner", "organizer_admin"].includes(role ?? "");
}

export function describeCompetitionRow(input: {
  eventId: string;
  eventStatus: string | null;
  program: CompetitionsListProgram | null;
}): CompetitionsListRow {
  const workspace = competitionWorkspaceHref(input.eventId);
  if (input.eventStatus === "cancelled") return { stateLabel: "Event cancelled", tone: "done", actionLabel: "View", href: workspace };
  if (input.eventStatus === "completed") return { stateLabel: "Event completed", tone: "done", actionLabel: "View", href: workspace };
  const program = input.program;
  if (!program) {
    return { stateLabel: "Not set up yet", tone: "neutral", actionLabel: "Set up competition", href: competitionSetupHref(input.eventId) };
  }
  if (["complete", "archived"].includes(program.status)) return { stateLabel: "Competition complete", tone: "done", actionLabel: "View", href: workspace };
  const published = program.rules_profile_key ? Boolean(program.profile_locked_at) : program.status !== "draft";
  if (!published) return { stateLabel: "Setup in progress", tone: "progress", actionLabel: "Continue setup", href: workspace };
  if (program.registration_status === "open") return { stateLabel: "Registration open", tone: "live", actionLabel: "Manage", href: workspace };
  if (program.registration_opened_at) return { stateLabel: "Registration closed", tone: "ready", actionLabel: "Manage", href: workspace };
  return { stateLabel: "Published · registration not open", tone: "ready", actionLabel: "Open registration", href: workspace };
}
