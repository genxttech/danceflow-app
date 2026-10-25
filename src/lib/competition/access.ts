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

/**
 * 10C.5 owner decision: only studio owners/admins and organizer owners/admins may change a competition event's
 * venue, dates, times or time zone. Organizer staff (and platform support) keep their competition access but not
 * this. Mirrors can_edit_competition_event_operations and the events guard trigger in the database.
 */
export const EVENT_OPERATIONS_STUDIO_ROLES = ["studio_owner", "studio_admin"] as const;
export const EVENT_OPERATIONS_ORGANIZER_ROLES = ["organizer_owner", "organizer_admin"] as const;

export function canEditCompetitionEventOperations(input: Pick<CompetitionAccessInput, "studioRole" | "organizerUserRole">) {
  return (
    (EVENT_OPERATIONS_STUDIO_ROLES as readonly string[]).includes(input.studioRole ?? "") ||
    (EVENT_OPERATIONS_ORGANIZER_ROLES as readonly string[]).includes(input.organizerUserRole ?? "")
  );
}

export function canManageCompetition(input: CompetitionAccessInput) {
  return (
    input.isPlatformAdmin ||
    (COMPETITION_STUDIO_ROLES as readonly string[]).includes(input.studioRole ?? "") ||
    (COMPETITION_ORGANIZER_ROLES as readonly string[]).includes(input.organizerUserRole ?? "")
  );
}

/**
 * CB-2: the front desk may run competition check-in (admit, mark arrival, collect authorized desk payments) and
 * nothing else in the workspace. Mirrors can_check_in_event_competition in the database: a manager, or an active
 * front_desk role in the hosting studio.
 */
export const COMPETITION_CHECKIN_STUDIO_ROLES = ["front_desk"] as const;

export type CompetitionAccessLevel = "manager" | "check_in_only" | "none";

export function competitionAccessLevel(input: CompetitionAccessInput): CompetitionAccessLevel {
  if (canManageCompetition(input)) return "manager";
  if ((COMPETITION_CHECKIN_STUDIO_ROLES as readonly string[]).includes(input.studioRole ?? "")) return "check_in_only";
  return "none";
}

export function canCheckInCompetition(input: CompetitionAccessInput) {
  return competitionAccessLevel(input) !== "none";
}
