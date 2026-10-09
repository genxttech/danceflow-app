/**
 * Who may open and change the Competition workspace. This mirrors requireEventManager in
 * /app/events/[id]/competition/actions.ts and can_manage_event_competition in the database
 * (10A removed the creator-only branch from both sides).
 */

export const COMPETITION_STUDIO_ROLES = ["studio_owner", "studio_admin"] as const;
export const COMPETITION_ORGANIZER_ROLES = ["organizer_owner", "organizer_admin", "organizer_staff"] as const;

export type CompetitionAccessInput = {
  isPlatformAdmin: boolean;
  studioRole: string | null | undefined;
  organizerUserRole: string | null | undefined;
};

export function canManageCompetition(input: CompetitionAccessInput) {
  return (
    input.isPlatformAdmin ||
    (COMPETITION_STUDIO_ROLES as readonly string[]).includes(input.studioRole ?? "") ||
    (COMPETITION_ORGANIZER_ROLES as readonly string[]).includes(input.organizerUserRole ?? "")
  );
}
