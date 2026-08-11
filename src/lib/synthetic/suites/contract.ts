import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreatedRecordRefs, SyntheticConfig } from "@/lib/synthetic/types";
import type { SyntheticSession } from "@/lib/synthetic/auth";

/** Everything a suite needs to run, resolved once by the runner and passed
 * down -- suites never call loadSyntheticConfig()/signInSyntheticRole()
 * themselves, so there is exactly one place (runner.ts) that decides which
 * identity/config a given execution uses. */
export interface SuiteContext {
  runId: string;
  config: SyntheticConfig;
  /** Pre-authenticated sessions, keyed by role, for whichever roles the
   * runner signed in for this execution. A suite asks for the role it
   * needs and gets a clear, typed error if it wasn't provided. */
  sessions: Partial<Record<"owner" | "organizer" | "student", SyntheticSession>>;
}

export function requireSession(
  ctx: SuiteContext,
  role: "owner" | "organizer" | "student",
): SyntheticSession {
  const session = ctx.sessions[role];
  if (!session) {
    throw new Error(`Suite requires a synthetic "${role}" session but none was provided.`);
  }
  return session;
}

export interface SuiteCleanupResult {
  status: "not_required" | "completed" | "failed" | "partial";
  error: string | null;
}

/**
 * Suites signal success by resolving with the refs they created, and
 * signal failure by throwing (SyntheticSafetyError for guard failures, a
 * plain Error via assertTestCondition for a failed assertion). The runner
 * is the single place that catches and converts either into a SafeFailure
 * -- suites never construct SafeFailure themselves, so there's no risk of
 * a suite accidentally putting raw data into a field meant to be safe to
 * persist/display.
 */
export type SuiteFn = (ctx: SuiteContext) => Promise<CreatedRecordRefs>;

/**
 * Thrown instead of a plain Error when a suite creates a record and THEN
 * fails -- e.g. a security probe whose failure mode is "the write it was
 * trying to prove gets rejected actually succeeded." A suite that reaches
 * this point must not let the created record vanish from the audit trail
 * just because the rest of the assertion failed: the runner reads
 * partialRecordRefs out of this error, records it in created_record_refs,
 * and still runs the suite's cleanup against it, exactly as it would for
 * a normal passing run.
 */
export class SuiteAssertionError extends Error {
  partialRecordRefs: CreatedRecordRefs;

  constructor(message: string, partialRecordRefs: CreatedRecordRefs = {}) {
    super(message);
    this.name = "SuiteAssertionError";
    this.partialRecordRefs = partialRecordRefs;
  }
}

export type SuiteCleanupFn = (
  ctx: SuiteContext,
  createdRecordRefs: CreatedRecordRefs,
) => Promise<SuiteCleanupResult>;

export function mergeRefs(...refs: CreatedRecordRefs[]): CreatedRecordRefs {
  const merged: CreatedRecordRefs = {};
  for (const ref of refs) {
    for (const [table, ids] of Object.entries(ref)) {
      merged[table] = [...(merged[table] ?? []), ...ids];
    }
  }
  return merged;
}

export function addRef(refs: CreatedRecordRefs, table: string, id: string): CreatedRecordRefs {
  return { ...refs, [table]: [...(refs[table] ?? []), id] };
}

/** Shared assertion helper: throws a plain Error (caught by the runner and
 * converted into a SafeFailure) with a message safe to persist -- callers
 * should keep these messages free of PII/secrets by construction, since
 * they describe *shape* mismatches (missing/wrong record), not data
 * contents. */
export function assertTestCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export type SupabaseAny = SupabaseClient;
