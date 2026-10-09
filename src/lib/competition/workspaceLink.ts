export const COMPETITION_EVENT_TYPES = ["competition", "showcase"] as const;

const COMPETITION_STUDIO_ROLES = ["studio_owner", "studio_admin"];
const COMPETITION_ORGANIZER_ROLES = ["organizer_owner", "organizer_admin", "organizer_staff"];

export type CompetitionWorkspaceLinkInput = {
  eventType: string | null | undefined;
  hasCompetitionProgram: boolean;
  isPlatformAdmin: boolean;
  studioRole: string | null | undefined;
  organizerUserRole: string | null | undefined;
};

/**
 * Whether the event detail page offers the Competition workspace. Mirrors the
 * workspace's own guard (requireEventManager in /app/events/[id]/competition/actions.ts):
 * platform admin, studio owner/admin, or an active organizer role on the event.
 */
export function shouldShowCompetitionWorkspaceLink(input: CompetitionWorkspaceLinkInput) {
  const isCompetitionEvent =
    input.hasCompetitionProgram ||
    (COMPETITION_EVENT_TYPES as readonly string[]).includes(input.eventType ?? "");
  if (!isCompetitionEvent) return false;

  return (
    input.isPlatformAdmin ||
    COMPETITION_STUDIO_ROLES.includes(input.studioRole ?? "") ||
    COMPETITION_ORGANIZER_ROLES.includes(input.organizerUserRole ?? "")
  );
}

export function competitionWorkspaceHref(eventId: string) {
  return `/app/events/${eventId}/competition`;
}
