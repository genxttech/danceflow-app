import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Client activity note: the single write path shared by the web action (`addClientActivityNoteAction`) and the Staff API
 * (`POST /api/staff/workspaces/{studioId}/clients/{clientId}/notes`). The web action used to hold this logic inline; it now calls these
 * functions, so validation and the insert cannot drift between the two callers.
 *
 * Authorization is NOT here: callers decide who may write (web: getEditableStudioContext / canEditClients; API: requireStaffApi +
 * canEditClients). Row access is the caller's own RLS (insert requires an active studio membership and a client of the same studio).
 */

export const CLIENT_NOTE_TYPES = ["general", "follow_up", "sales", "lesson", "billing", "concern"] as const;
export type ClientNoteType = (typeof CLIENT_NOTE_TYPES)[number];

const NOTE_TYPE_SET = new Set<string>(CLIENT_NOTE_TYPES);

export type ClientNoteInput = { noteType: ClientNoteType; body: string; occurredAt: Date };

/** Web error codes for each failure, kept identical to the ones the web action has always redirected with. */
export type ClientNoteFailure = "missing_fields" | "invalid_type" | "invalid_date" | "client_not_found" | "save_failed";

export const CLIENT_NOTE_WEB_ERROR_CODES: Record<ClientNoteFailure, string> = {
  missing_fields: "client_note_missing_fields",
  invalid_type: "client_note_invalid_type",
  invalid_date: "client_note_invalid_date",
  client_not_found: "client_not_found",
  save_failed: "client_note_save_failed",
};

/**
 * Pure validation, same order as the web action always had: required fields, then the type, then the date. `noteType` defaults to
 * "general" and `occurredAt` to now when blank; all strings are expected already trimmed by the caller.
 */
export function validateClientNoteInput(raw: {
  clientId: string;
  noteType: string;
  body: string;
  occurredAt: string;
}): { ok: true; input: ClientNoteInput } | { ok: false; reason: "missing_fields" | "invalid_type" | "invalid_date" } {
  const noteType = raw.noteType || "general";
  if (!raw.clientId || !raw.body) return { ok: false, reason: "missing_fields" };
  if (!NOTE_TYPE_SET.has(noteType)) return { ok: false, reason: "invalid_type" };
  const occurredAt = raw.occurredAt ? new Date(raw.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, reason: "invalid_date" };
  return { ok: true, input: { noteType: noteType as ClientNoteType, body: raw.body, occurredAt } };
}

export type ClientNoteRow = {
  id: string;
  clientId: string;
  noteType: string;
  body: string;
  occurredAt: string;
  createdAt: string;
};

type NoteDbRow = { id: string; client_id: string; note_type: string; body: string; occurred_at: string; created_at: string };

const toNote = (row: NoteDbRow): ClientNoteRow => ({
  id: row.id,
  clientId: row.client_id,
  noteType: row.note_type,
  body: row.body,
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
});

/**
 * Looks the client up in the studio (the web page's own check: id + studio_id) and inserts the note with the caller's own client, so RLS
 * applies. Returns `client_not_found` when the client is missing or belongs to another studio, `save_failed` on a database error.
 *
 * `dedupeWithinSeconds` (API only; the web passes nothing): the Staff API stores no idempotency keys and an insert is not idempotent by
 * state, so a client retry after a lost response would add the note twice. When set, an identical note (same studio, client, author, type
 * and body) created within that window is returned instead of inserting again (`created: false`).
 */
export async function addClientActivityNote(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  userId: string | null;
  input: ClientNoteInput;
  dedupeWithinSeconds?: number;
}): Promise<{ ok: true; created: boolean; note: ClientNoteRow } | { ok: false; reason: "client_not_found" | "save_failed" }> {
  const { supabase, studioId, clientId, userId, input, dedupeWithinSeconds } = params;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();
  if (clientError || !client) return { ok: false, reason: "client_not_found" };

  if (dedupeWithinSeconds && userId) {
    const since = new Date(Date.now() - dedupeWithinSeconds * 1000).toISOString();
    const { data: existing, error: existingError } = await supabase
      .from("client_activity_notes")
      .select("id, client_id, note_type, body, occurred_at, created_at")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .eq("created_by", userId)
      .eq("note_type", input.noteType)
      .eq("body", input.body)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    if (existingError) return { ok: false, reason: "save_failed" };
    if (existing && existing.length) return { ok: true, created: false, note: toNote(existing[0] as NoteDbRow) };
  }

  const { data: inserted, error } = await supabase
    .from("client_activity_notes")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      note_type: input.noteType,
      body: input.body,
      occurred_at: input.occurredAt.toISOString(),
      created_by: userId,
    })
    .select("id, client_id, note_type, body, occurred_at, created_at")
    .single();
  if (error || !inserted) return { ok: false, reason: "save_failed" };

  return { ok: true, created: true, note: toNote(inserted as NoteDbRow) };
}
