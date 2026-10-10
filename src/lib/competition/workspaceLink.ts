import { canManageCompetition } from "@/lib/competition/access";

export const COMPETITION_EVENT_TYPES = ["competition", "showcase"] as const;

export type CompetitionWorkspaceLinkInput = {
  eventType: string | null | undefined;
  hasCompetitionProgram: boolean;
  isPlatformAdmin: boolean;
  studioRole: string | null | undefined;
  organizerUserRole: string | null | undefined;
};

/**
 * Whether the event detail page offers the Competition workspace. The role rule is shared with the
 * workspace's own guard (see access.ts).
 */
export function shouldShowCompetitionWorkspaceLink(input: CompetitionWorkspaceLinkInput) {
  const isCompetitionEvent =
    input.hasCompetitionProgram ||
    (COMPETITION_EVENT_TYPES as readonly string[]).includes(input.eventType ?? "");
  if (!isCompetitionEvent) return false;

  return canManageCompetition(input);
}

export function competitionWorkspaceHref(eventId: string) {
  return `/app/events/${eventId}/competition`;
}

/** Top-level Competition OS entry (studio sidebar → Events → Competitions). */
export const COMPETITIONS_HREF = "/app/competitions";

/**
 * "New Competition" reuses the canonical Create Event form, preselected to Competition; creating the
 * event then continues straight into competition setup (no second event form, no duplicate fields).
 */
export const NEW_COMPETITION_HREF = "/app/events/new?type=competition";

/** The Simple Mode wizard for an event; it forwards to the Overview when setup already exists. */
export function competitionSetupHref(eventId: string) {
  return `${competitionWorkspaceHref(eventId)}/new`;
}

/** Creating an event of this type continues directly into competition setup. */
export function continuesToCompetitionSetup(eventType: string | null | undefined) {
  return (eventType ?? "").trim().toLowerCase() === "competition";
}

/** Create Event primary action: a Competition event says where it goes next. */
export function createEventSubmitLabel(eventType: string | null | undefined) {
  return continuesToCompetitionSetup(eventType) ? "Create Event & Set Up Competition" : "Create Event";
}
