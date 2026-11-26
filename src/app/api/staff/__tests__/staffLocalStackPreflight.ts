/**
 * Precondition for the local-stack suites that read class roster names as an instructor. The iso-qa baseline stops before the migration that adds
 * get_class_roster_names_for_instructor, and the attendance route deliberately answers a null name when that lookup fails, so without this check a
 * stack that lacks it shows up as a confusing assertion failure.
 */
export const ROSTER_NAMES_MIGRATION_FLAG = "--migration origin/main:20270214120000";

export function requireRosterNamesRpc(psql: (sql: string) => string) {
  const present = psql("select to_regprocedure('public.get_class_roster_names_for_instructor(uuid)') is not null;").trim();
  if (present !== "t") {
    throw new Error(`This stack lacks public.get_class_roster_names_for_instructor: start it with "${ROSTER_NAMES_MIGRATION_FLAG}" (iso-qa run baseline ... -- <suite>).`);
  }
}
