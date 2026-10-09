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
