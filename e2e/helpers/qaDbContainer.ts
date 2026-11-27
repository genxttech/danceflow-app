/**
 * The only local database container the harness may run `docker exec ... psql` against: the dedicated CF1-C QA stack
 * (same pin as cf1Acceptance.ts). An allowlist pattern such as supabase_db_<anything> would let a mistyped or inherited
 * E2E_LOCAL_DB_CONTAINER point a purge (replication triggers off, deletes) at another session's database.
 */
export const CF1_QA_DB_CONTAINER = "supabase_db_cf1c-qa";
/** The disposable P1 walkthrough stack (scripts/qa/p1/browser/p1-stack.mjs), by exact name. */
export const P1_QA_DB_CONTAINER = "df-p1walk-db";

/** The pinned container name when E2E_LOCAL_DB_CONTAINER names exactly it; otherwise null. */
export function pinnedQaDbContainer(env: Record<string, string | undefined> = process.env): string | null {
  return [CF1_QA_DB_CONTAINER, P1_QA_DB_CONTAINER].find((name) => name === env.E2E_LOCAL_DB_CONTAINER) ?? null;
}
