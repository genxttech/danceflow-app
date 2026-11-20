import { describe, expect, it } from "vitest";
import { CLIENT_NOTE_WEB_ERROR_CODES, addClientActivityNote, validateClientNoteInput } from "../clientNotes";

describe("validateClientNoteInput (same order and defaults the web action always had)", () => {
  const base = { clientId: "c1", noteType: "", body: "hello", occurredAt: "" };

  it("defaults the type to general and the date to now, and says whether the date was supplied", () => {
    const r = validateClientNoteInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.noteType).toBe("general");
      expect(r.input.occurredAtExplicit).toBe(false);
      expect(Math.abs(r.input.occurredAt.getTime() - Date.now())).toBeLessThan(5000);
    }
    const explicit = validateClientNoteInput({ ...base, occurredAt: "2026-11-20T10:00:00Z" });
    expect(explicit.ok && explicit.input.occurredAtExplicit).toBe(true);
  });

  it("missing client or body is checked first, then the type, then the date", () => {
    expect(validateClientNoteInput({ ...base, clientId: "" })).toEqual({ ok: false, reason: "missing_fields" });
    expect(validateClientNoteInput({ ...base, body: "", noteType: "nope" })).toEqual({ ok: false, reason: "missing_fields" });
    expect(validateClientNoteInput({ ...base, noteType: "nope", occurredAt: "garbage" })).toEqual({ ok: false, reason: "invalid_type" });
    expect(validateClientNoteInput({ ...base, occurredAt: "garbage" })).toEqual({ ok: false, reason: "invalid_date" });
  });

  it.each(["general", "follow_up", "sales", "lesson", "billing", "concern"])("accepts %s", (noteType) => {
    expect(validateClientNoteInput({ ...base, noteType }).ok).toBe(true);
  });

  it("keeps the web error codes the action has always redirected with", () => {
    expect(CLIENT_NOTE_WEB_ERROR_CODES).toMatchObject({
      missing_fields: "client_note_missing_fields",
      invalid_type: "client_note_invalid_type",
      invalid_date: "client_note_invalid_date",
      client_not_found: "client_not_found",
      save_failed: "client_note_save_failed",
    });
  });
});

type Op = [string, unknown[]];
function fakeSupabase(opts: { clientError?: boolean; inserted?: unknown; insertError?: { code?: string; message: string }; existing?: unknown }) {
  const log: { table: string; ops: Op[] }[] = [];
  return {
    log,
    client: {
      from(table: string) {
        const entry = { table, ops: [] as Op[] };
        log.push(entry);
        const chain: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, op: string) {
              if (op === "maybeSingle") return async () => ({ data: opts.existing ?? null, error: null });
              if (op === "single") {
                return async () =>
                  table === "clients"
                    ? { data: opts.clientError ? null : { id: "c1" }, error: opts.clientError ? { message: "no" } : null }
                    : { data: opts.insertError ? null : (opts.inserted ?? null), error: opts.insertError ?? null };
              }
              return (...args: unknown[]) => {
                entry.ops.push([op, args]);
                return chain;
              };
            },
          },
        );
        return chain;
      },
    } as never,
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  client_id: "c1",
  note_type: "general",
  body: "hello",
  occurred_at: "2026-11-20T10:00:00+00:00",
  created_at: "2026-11-20T10:00:01.000Z",
  created_by: "u1",
  ...over,
});
const input = { noteType: "general" as const, body: "hello", occurredAt: new Date("2026-11-20T10:00:00.000Z"), occurredAtExplicit: true };
const base = { studioId: "s1", clientId: "c1", userId: "u1", input };
const dup = { code: "23505", message: "duplicate key" };

describe("addClientActivityNote", () => {
  it("looks the client up by id AND studio, then inserts exactly the web action's columns (no id on the web path)", async () => {
    const f = fakeSupabase({ inserted: row() });
    const r = await addClientActivityNote({ supabase: f.client, ...base });
    expect(r).toMatchObject({ ok: true, created: true, note: { id: "n1", clientId: "c1", noteType: "general", body: "hello" } });
    expect(f.log[0].table).toBe("clients");
    expect(f.log[0].ops.filter(([o]) => o === "eq")).toEqual([["eq", ["id", "c1"]], ["eq", ["studio_id", "s1"]]]);
    const insert = f.log.find((e) => e.table === "client_activity_notes")!.ops.find(([o]) => o === "insert")!;
    expect(insert[1][0]).toEqual({
      studio_id: "s1",
      client_id: "c1",
      note_type: "general",
      body: "hello",
      occurred_at: "2026-11-20T10:00:00.000Z",
      created_by: "u1",
    });
  });

  it("a client that is missing or in another studio never reaches the insert", async () => {
    const f = fakeSupabase({ clientError: true });
    expect(await addClientActivityNote({ supabase: f.client, ...base })).toEqual({ ok: false, reason: "client_not_found" });
    expect(f.log.map((e) => e.table)).toEqual(["clients"]);
  });

  it("a database error without a noteId is save_failed (the web path never tries a replay)", async () => {
    const f = fakeSupabase({ insertError: dup });
    expect(await addClientActivityNote({ supabase: f.client, ...base })).toEqual({ ok: false, reason: "save_failed" });
  });

  describe("noteId (client-supplied entity id)", () => {
    const withId = { ...base, noteId: "11111111-1111-4111-8111-111111111111" };

    it("inserts with that id as the primary key", async () => {
      const f = fakeSupabase({ inserted: row({ id: withId.noteId }) });
      const r = await addClientActivityNote({ supabase: f.client, ...withId });
      expect(r).toMatchObject({ ok: true, created: true, note: { id: withId.noteId } });
      expect(f.log.find((e) => e.table === "client_activity_notes")!.ops.find(([o]) => o === "insert")![1][0]).toMatchObject({ id: withId.noteId });
    });

    it("a replay of the same note by the same author returns the existing note and writes nothing", async () => {
      const f = fakeSupabase({ insertError: dup, existing: row({ id: withId.noteId }) });
      const r = await addClientActivityNote({ supabase: f.client, ...withId });
      expect(r).toMatchObject({ ok: true, created: false, note: { id: withId.noteId, body: "hello" } });
    });

    it("the fetch of the existing row is by id AND studio", async () => {
      const f = fakeSupabase({ insertError: dup, existing: row() });
      await addClientActivityNote({ supabase: f.client, ...withId });
      const fetch = f.log.filter((e) => e.table === "client_activity_notes")[1];
      expect(fetch.ops.filter(([o]) => o === "eq")).toEqual([["eq", ["id", withId.noteId]], ["eq", ["studio_id", "s1"]]]);
    });

    it("the same id with a different body, type, client or occurredAt (when supplied) is an idempotency_conflict carrying the current note", async () => {
      for (const existing of [row({ body: "other" }), row({ note_type: "sales" }), row({ client_id: "c2" }), row({ occurred_at: "2026-01-01T00:00:00+00:00" })]) {
        const r = await addClientActivityNote({ supabase: fakeSupabase({ insertError: dup, existing }).client, ...withId });
        expect(r).toMatchObject({ ok: false, reason: "idempotency_conflict", current: { id: "n1" } });
      }
    });

    it("an occurredAt that was defaulted (not supplied) is not compared", async () => {
      const r = await addClientActivityNote({
        supabase: fakeSupabase({ insertError: dup, existing: row({ occurred_at: "2020-01-01T00:00:00+00:00" }) }).client,
        ...withId,
        input: { ...input, occurredAtExplicit: false },
      });
      expect(r).toMatchObject({ ok: true, created: false });
    });

    it("the same id used by ANOTHER author is a conflict, never a replay", async () => {
      const r = await addClientActivityNote({ supabase: fakeSupabase({ insertError: dup, existing: row({ created_by: "someone-else" }) }).client, ...withId });
      expect(r).toMatchObject({ ok: false, reason: "idempotency_conflict" });
    });

    it("an id that exists where this caller cannot read it is a conflict with no current", async () => {
      const r = await addClientActivityNote({ supabase: fakeSupabase({ insertError: dup, existing: null }).client, ...withId });
      expect(r).toEqual({ ok: false, reason: "idempotency_conflict", current: null });
    });

    it("any other database error is save_failed", async () => {
      const r = await addClientActivityNote({ supabase: fakeSupabase({ insertError: { code: "42501", message: "rls" } }).client, ...withId });
      expect(r).toEqual({ ok: false, reason: "save_failed" });
    });
  });
});
