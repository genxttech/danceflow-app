import { NextResponse } from "next/server";

/**
 * Shared helpers for Business staff API WRITE routes (Business expansion plan, Phase 0, P0-2). No migration, no new table.
 *
 * IDEMPOTENCY: THE EXISTING APPROACH, GENERALISED
 * The v0.1 class-attendance route (PUT .../attendance/{clientId}) requires an `Idempotency-Key` header, validates its shape, and does NOT store it.
 * Retries are safe because the write is idempotent BY STATE: if the dancer already has the requested status nothing is written and the current record
 * comes back with 200. The key's job is to make every user action carry its own id so a client can retry the exact same request.
 * Phase 1A keeps that rule and names three patterns, chosen per write, none needing a table:
 *   1. STATE-BASED (set-to-value writes: attended / no-show, cancel an attendee, set a status): re-applying the target state is a no-op that returns the
 *      current record (`alreadyApplied: true`); a request that contradicts a terminal state is a 409 with the current state (staffConflict).
 *   2. CLIENT-SUPPLIED ENTITY ID (creates: a client note, a new client): the app generates a UUID once per user action (the same value on every retry),
 *      the route inserts with that id as the primary key; a unique violation on a replay of identical content returns the existing row (200),
 *      the same id with different content is 409 `idempotency_conflict` (see resolveInsertReplay).
 *   3. NATURAL DOMAIN KEY (enrol a dancer in a class): the existing uniqueness rule ("already enrolled") is read as a replay for the same
 *      client and class and answered 200 with the existing row, never a second row.
 * A key-storage table (key, user, route, request hash, stored response) would only be needed for a write with none of these properties. None of the
 * Phase 1A writes is one. If a later slice needs it, that slice writes the migration, rollback and SQL test and stops for the owner gate.
 *
 * CONFLICTS: every conflict is a flat 409 `{ error, code, current }` where `current` is the server's present state of the thing the app tried to change,
 * so the app can show it and reconcile instead of guessing (staffConflict). Codes are lower snake case; each slice documents its own in
 * Staff_API_Contract.md ("Write error codes").
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
export const MAX_WRITE_BODY_BYTES = 16 * 1024;
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = { "Cache-Control": "private, no-store" };

/** A flat refusal with a slice-specific code. The shared StaffApiErrorCode union is protected code; write slices register theirs in the contract doc instead. */
export function staffWriteError(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  if (!CODE_PATTERN.test(code)) throw new Error(`Invalid staff API error code: ${code}`);
  return NextResponse.json({ error: message, code, ...extra }, { status, headers: HEADERS });
}

/** 409 with the server's current state so the app can reconcile. `current` must carry no more than the read routes already expose. */
export function staffConflict(code: string, message: string, current: Record<string, unknown> | null) {
  return staffWriteError(code, message, 409, { current });
}

export type KeyResult = { ok: true; key: string } | { ok: false; response: Response };

/** The Idempotency-Key header, required on every write route. Not stored (see the pattern notes above). */
export function readIdempotencyKey(request: Request): KeyResult {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      response: staffWriteError("invalid_request", "An Idempotency-Key header (8-128 letters, digits, - _ : .) is required.", 400),
    };
  }
  return { ok: true, key };
}

export type JsonBodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/** A JSON object body, at most MAX_WRITE_BODY_BYTES. Anything else is 400 invalid_request. */
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const bad = (message: string): JsonBodyResult => ({ ok: false, response: staffWriteError("invalid_request", message, 400) });
  let text: string;
  try {
    text = await request.text();
  } catch {
    return bad("The body could not be read.");
  }
  if (new TextEncoder().encode(text).length > MAX_WRITE_BODY_BYTES) return bad("The body is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad("The body must be JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("The body must be a JSON object.");
  return { ok: true, body: value as Record<string, unknown> };
}

/** A client-supplied entity id (pattern 2). Lower-cased so a retry with different casing is the same id. */
export function readEntityId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Postgres unique violation as PostgREST reports it. */
export function isUniqueViolation(error: { code?: string | null } | null | undefined) {
  return error?.code === "23505";
}

/** Compares the fields that define "the same request" between an existing row and the incoming values (trimmed strings, null = empty). */
export function sameFields(existing: Record<string, unknown>, incoming: Record<string, unknown>, keys: readonly string[]) {
  const norm = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v.trim() : String(v));
  return keys.every((key) => norm(existing[key]) === norm(incoming[key]));
}

export type InsertReplayOutcome<Row> =
  | { kind: "inserted" }
  | { kind: "replay"; existing: Row }
  | { kind: "idempotency_conflict"; existing: Row }
  | { kind: "other_conflict" }
  | { kind: "failed"; error: { message?: string } };

/**
 * Interprets the result of an insert that used a client-supplied primary key (pattern 2).
 *   no error                          -> inserted
 *   unique violation, row exists:
 *       identical content             -> replay (answer 200 with the existing row)
 *       different content             -> idempotency_conflict (answer 409 with `current` = existing)
 *   unique violation, no row at that id -> other_conflict (some other unique rule, e.g. a duplicate email: the slice maps it)
 *   any other error                   -> failed
 */
export async function resolveInsertReplay<Row extends Record<string, unknown>>(params: {
  error: { code?: string | null; message?: string } | null | undefined;
  fetchExisting: () => Promise<Row | null>;
  matches: (existing: Row) => boolean;
}): Promise<InsertReplayOutcome<Row>> {
  const { error, fetchExisting, matches } = params;
  if (!error) return { kind: "inserted" };
  if (!isUniqueViolation(error)) return { kind: "failed", error };
  const existing = await fetchExisting();
  if (!existing) return { kind: "other_conflict" };
  return matches(existing) ? { kind: "replay", existing } : { kind: "idempotency_conflict", existing };
}
