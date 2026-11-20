import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { CLIENT_NOTE_WEB_ERROR_CODES, addClientActivityNote, validateClientNoteInput } from "../clientNotes";

describe("validateClientNoteInput (same order and defaults the web action always had)", () => {
  const base = { clientId: "c1", noteType: "", body: "hello", occurredAt: "" };

  it("defaults the type to general and the date to now", () => {
    const r = validateClientNoteInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.noteType).toBe("general");
      expect(Math.abs(r.input.occurredAt.getTime() - Date.now())).toBeLessThan(5000);
    }
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
    expect(CLIENT_NOTE_WEB_ERROR_CODES).toEqual({
      missing_fields: "client_note_missing_fields",
      invalid_type: "client_note_invalid_type",
      invalid_date: "client_note_invalid_date",
      client_not_found: "client_not_found",
      save_failed: "client_note_save_failed",
    });
  });
});

type Op = [string, unknown[]];
function fakeSupabase(opts: { client?: unknown; existing?: unknown[]; inserted?: unknown; insertError?: boolean; clientError?: boolean }) {
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
              if (op === "then") {
                // list read (dedupe lookup)
                return (res: (v: unknown) => unknown) => Promise.resolve({ data: opts.existing ?? [], error: null }).then(res);
              }
              if (op === "single") {
                return async () =>
                  table === "clients"
                    ? { data: opts.clientError ? null : (opts.client ?? { id: "c1" }), error: opts.clientError ? { message: "no" } : null }
                    : { data: opts.insertError ? null : (opts.inserted ?? null), error: opts.insertError ? { message: "boom" } : null };
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
  occurred_at: "2026-11-20T10:00:00.000Z",
  created_at: "2026-11-20T10:00:01.000Z",
  ...over,
});
const input = { noteType: "general" as const, body: "hello", occurredAt: new Date("2026-11-20T10:00:00.000Z") };

describe("addClientActivityNote", () => {
  let studio: string;
  beforeEach(() => {
    studio = "s1";
  });

  it("looks the client up by id AND studio, then inserts exactly the web action's columns", async () => {
    const f = fakeSupabase({ inserted: row() });
    const r = await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input });
    expect(r).toMatchObject({ ok: true, created: true, note: { id: "n1", clientId: "c1", noteType: "general", body: "hello" } });
    const lookup = f.log[0];
    expect(lookup.table).toBe("clients");
    expect(lookup.ops.filter(([o]) => o === "eq")).toEqual([["eq", ["id", "c1"]], ["eq", ["studio_id", "s1"]]]);
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
    expect(await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input })).toEqual({ ok: false, reason: "client_not_found" });
    expect(f.log.map((e) => e.table)).toEqual(["clients"]);
  });

  it("a database error on insert is save_failed", async () => {
    const f = fakeSupabase({ insertError: true });
    expect(await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input })).toEqual({ ok: false, reason: "save_failed" });
  });

  it("web path (no dedupe window) never looks for an existing note", async () => {
    const f = fakeSupabase({ existing: [row({ id: "old" })], inserted: row({ id: "new" }) });
    const r = await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input });
    expect(r).toMatchObject({ ok: true, created: true, note: { id: "new" } });
    expect(f.log.filter((e) => e.table === "client_activity_notes")).toHaveLength(1);
  });

  it("API retry: an identical recent note by the same author is returned, not inserted again", async () => {
    const f = fakeSupabase({ existing: [row({ id: "old" })], inserted: row({ id: "new" }) });
    const r = await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input, dedupeWithinSeconds: 120 });
    expect(r).toMatchObject({ ok: true, created: false, note: { id: "old" } });
    const lookup = f.log.find((e) => e.table === "client_activity_notes")!;
    expect(lookup.ops.filter(([o]) => o === "eq")).toEqual([
      ["eq", ["studio_id", "s1"]],
      ["eq", ["client_id", "c1"]],
      ["eq", ["created_by", "u1"]],
      ["eq", ["note_type", "general"]],
      ["eq", ["body", "hello"]],
    ]);
    expect(lookup.ops.some(([o]) => o === "insert")).toBe(false);
  });

  it("the dedupe window is exactly the requested number of seconds back from now (boundary)", async () => {
    const f = fakeSupabase({ existing: [], inserted: row() });
    const before = Date.now();
    await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input, dedupeWithinSeconds: 120 });
    const after = Date.now();
    const gte = f.log.find((e) => e.table === "client_activity_notes")!.ops.find(([o]) => o === "gte")!;
    expect(gte[1][0]).toBe("created_at");
    const since = new Date(String(gte[1][1])).getTime();
    expect(since).toBeGreaterThanOrEqual(before - 120_000);
    expect(since).toBeLessThanOrEqual(after - 120_000);
  });

  it("API: with no recent twin the note is inserted", async () => {
    const f = fakeSupabase({ existing: [], inserted: row({ id: "new" }) });
    const r = await addClientActivityNote({ supabase: f.client, studioId: studio, clientId: "c1", userId: "u1", input, dedupeWithinSeconds: 120 });
    expect(r).toMatchObject({ ok: true, created: true, note: { id: "new" } });
  });
});
