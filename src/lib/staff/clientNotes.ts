import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveInsertReplay, sameFields } from "@/lib/staff/writeSupport";

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

export type ClientNoteInput = {
  noteType: ClientNoteType;
  body: string;
  occurredAt: Date;
  /** True when the caller sent an occurredAt (a replay is compared on it only then; a defaulted "now" differs on every attempt). */
  occurredAtExplicit: boolean;
};

/** Web error codes for each failure, kept identical to the ones the web action has always redirected with. */
export type ClientNoteFailure = "missing_fields" | "invalid_type" | "invalid_date" | "client_not_found" | "save_failed" | "idempotency_conflict";

export const CLIENT_NOTE_WEB_ERROR_CODES: Record<ClientNoteFailure, string> = {
  missing_fields: "client_note_missing_fields",
  invalid_type: "client_note_invalid_type",
  invalid_date: "client_note_invalid_date",
  client_not_found: "client_not_found",
  save_failed: "client_note_save_failed",
  // API only (noteId): the web never supplies one, so it cannot reach this.
  idempotency_conflict: "client_note_save_failed",
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
  return { ok: true, input: { noteType: noteType as ClientNoteType, body: raw.body, occurredAt, occurredAtExplicit: Boolean(raw.occurredAt) } };
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

type NoteDbRowWithAuthor = NoteDbRow & { created_by: string | null };
const NOTE_COLUMNS = "id, client_id, note_type, body, occurred_at, created_at";

/**
 * Looks the client up in the studio (the web page's own check: id + studio_id) and inserts the note with the caller's own client, so RLS
 * applies. Returns `client_not_found` when the client is missing or belongs to another studio, `save_failed` on a database error.
 *
 * `noteId` (API only; the web passes nothing and the database generates the id): the CLIENT-SUPPLIED ENTITY ID pattern of the Staff API write
 * helpers. The app generates the UUID once per user action and resends it on every retry; the note is inserted with that id as its primary key.
 * A unique violation on a replay of the same content by the same author returns the existing note (`created: false`); the same id with different
 * content, another author, or an id that exists where this caller cannot read it is `idempotency_conflict` (with `current` when readable).
 */
export async function addClientActivityNote(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  userId: string | null;
  input: ClientNoteInput;
  noteId?: string;
}): Promise<
  | { ok: true; created: boolean; note: ClientNoteRow }
  | { ok: false; reason: "client_not_found" | "save_failed" }
  | { ok: false; reason: "idempotency_conflict"; current: ClientNoteRow | null }
> {
  const { supabase, studioId, clientId, userId, input, noteId } = params;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();
  if (clientError || !client) return { ok: false, reason: "client_not_found" };

  const { data: inserted, error } = await supabase
    .from("client_activity_notes")
    .insert({
      ...(noteId ? { id: noteId } : {}),
      studio_id: studioId,
      client_id: clientId,
      note_type: input.noteType,
      body: input.body,
      occurred_at: input.occurredAt.toISOString(),
      created_by: userId,
    })
    .select(NOTE_COLUMNS)
    .single();

  if (!error && inserted) return { ok: true, created: true, note: toNote(inserted as NoteDbRow) };
  if (!noteId) return { ok: false, reason: "save_failed" };

  const outcome = await resolveInsertReplay<NoteDbRowWithAuthor>({
    error,
    fetchExisting: async () => {
      const { data } = await supabase
        .from("client_activity_notes")
        .select(`${NOTE_COLUMNS}, created_by`)
        .eq("id", noteId)
        .eq("studio_id", studioId)
        .maybeSingle();
      return (data as NoteDbRowWithAuthor | null) ?? null;
    },
    matches: (existing) =>
      existing.created_by === userId &&
      existing.client_id === clientId &&
      sameFields(existing, { note_type: input.noteType, body: input.body }, ["note_type", "body"]) &&
      (!input.occurredAtExplicit || new Date(existing.occurred_at).getTime() === input.occurredAt.getTime()),
  });

  if (outcome.kind === "replay") return { ok: true, created: false, note: toNote(outcome.existing) };
  if (outcome.kind === "idempotency_conflict") return { ok: false, reason: "idempotency_conflict", current: toNote(outcome.existing) };
  if (outcome.kind === "other_conflict") return { ok: false, reason: "idempotency_conflict", current: null };
  return { ok: false, reason: "save_failed" };
}

// ---- Read: the notes list for the Staff API (GET .../clients/{clientId}/notes) ------------------------------------------------------------

export type ClientNoteListItem = ClientNoteRow & { authorName: string | null };

type NoteCursor = { o: string; c: string; i: string };

// A cursor is data the client sends back: bounded, shaped values only, so a hand-made one is a 400 and never a failing query.
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function encodeNoteCursor(item: { occurredAt: string; createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify({ o: item.occurredAt, c: item.createdAt, i: item.id } satisfies NoteCursor)).toString("base64url");
}

export function decodeNoteCursor(value: string | null): NoteCursor | null | "invalid" {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<NoteCursor>;
    if (
      typeof parsed.o === "string" && CURSOR_TIMESTAMP.test(parsed.o) &&
      typeof parsed.c === "string" && CURSOR_TIMESTAMP.test(parsed.c) &&
      typeof parsed.i === "string" && CURSOR_UUID.test(parsed.i)
    ) {
      return { o: parsed.o, c: parsed.c, i: parsed.i };
    }
  } catch {
    // fall through
  }
  return "invalid";
}

const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

type NoteListDbRow = NoteDbRow & { profiles: { full_name: string | null } | { full_name: string | null }[] | null };

/**
 * The same notes the web client page shows (studio + client, newest occurred_at first), read with the caller's own client so RLS applies.
 * Keyset paging on (occurred_at, created_at, id), all descending. The author is the profile name only: no email, as nowhere else in the API.
 * Returns null when the client is not in the studio (404 for the caller).
 */
export async function listClientNotes(params: {
  supabase: SupabaseClient;
  studioId: string;
  clientId: string;
  cursor: NoteCursor | null;
  limit: number;
}): Promise<{ notes: ClientNoteListItem[]; nextCursor: string | null } | null> {
  const { supabase, studioId, clientId, cursor, limit } = params;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (clientError) throw new Error(`Client lookup failed: ${clientError.message}`);
  if (!client) return null;

  let query = supabase
    .from("client_activity_notes")
    .select(`${NOTE_COLUMNS}, profiles:created_by ( full_name )`)
    .eq("studio_id", studioId)
    .eq("client_id", clientId);

  if (cursor) {
    const o = quoted(cursor.o);
    const c = quoted(cursor.c);
    query = query.or(`occurred_at.lt.${o},and(occurred_at.eq.${o},created_at.lt.${c}),and(occurred_at.eq.${o},created_at.eq.${c},id.lt.${cursor.i})`);
  }

  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(`Notes read failed: ${error.message}`);

  const rows = (data ?? []) as unknown as NoteListDbRow[];
  const page = rows.slice(0, limit);
  const notes = page.map((row) => {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return { ...toNote(row), authorName: profile?.full_name ?? null };
  });
  const last = notes[notes.length - 1];
  return { notes, nextCursor: rows.length > limit && last ? encodeNoteCursor(last) : null };
}
