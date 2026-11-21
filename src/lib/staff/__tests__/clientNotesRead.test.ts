import { describe, expect, it } from "vitest";
import { decodeNoteCursor, encodeNoteCursor, listClientNotes } from "../clientNotes";

const T1 = "2026-11-20T15:30:00.123456+00:00";
const T2 = "2026-11-20T15:31:00+00:00";
const ID = "11111111-1111-4111-8111-111111111111";

describe("note cursor", () => {
  it("round-trips", () => {
    const cursor = encodeNoteCursor({ occurredAt: T1, createdAt: T2, id: ID });
    expect(decodeNoteCursor(cursor)).toEqual({ o: T1, c: T2, i: ID });
  });
  it("no cursor is null; anything that is not exactly the issued shape is invalid", () => {
    expect(decodeNoteCursor(null)).toBeNull();
    expect(decodeNoteCursor("")).toBeNull();
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "not-base64-json",
      enc({}),
      enc({ o: T1, c: T2 }),
      enc({ o: "yesterday", c: T2, i: ID }),
      enc({ o: T1, c: T2, i: "not-a-uuid" }),
      enc({ o: `${T1}",id.eq."x`, c: T2, i: ID }), // a filter-injection attempt in a timestamp slot
      enc({ o: T1, c: T2, i: `${ID}) or (true` }),
      enc([1, 2, 3]),
    ]) {
      expect(decodeNoteCursor(bad)).toBe("invalid");
    }
  });
});

type Op = [string, unknown[]];
function fake(opts: { client?: unknown; rows?: unknown[]; clientError?: boolean; readError?: boolean }) {
  const log: { table: string; ops: Op[] }[] = [];
  return {
    log,
    supabase: {
      from(table: string) {
        const entry = { table, ops: [] as Op[] };
        log.push(entry);
        const chain: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, op: string) {
              if (op === "maybeSingle") return async () => ({ data: opts.client === undefined ? { id: "c1" } : opts.client, error: opts.clientError ? { message: "boom" } : null });
              if (op === "then") return (res: (v: unknown) => unknown) => Promise.resolve({ data: opts.rows ?? [], error: opts.readError ? { message: "read" } : null }).then(res);
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

let row_by: string | null = "u1";
const row = (n: number, profiles: unknown = { full_name: "Fran Desk" }) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  client_id: "c1",
  note_type: "general",
  body: `note ${n}`,
  occurred_at: `2026-11-20T15:3${n}:00+00:00`,
  created_at: `2026-11-20T15:3${n}:01+00:00`,
  created_by: row_by,
  profiles,
});

describe("listClientNotes", () => {
  it("is null when the client is not in the studio, and reads no notes then", async () => {
    const f = fake({ client: null });
    expect(await listClientNotes({ supabase: f.supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 25 })).toBeNull();
    expect(f.log.map((e) => e.table)).toEqual(["clients"]);
  });

  it("checks the client by id AND studio, then reads that studio and client newest first with one extra row", async () => {
    const f = fake({ rows: [] });
    await listClientNotes({ supabase: f.supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 25 });
    expect(f.log[0].ops.filter(([o]) => o === "eq")).toEqual([["eq", ["id", "c1"]], ["eq", ["studio_id", "s1"]]]);
    const notes = f.log[1];
    expect(notes.table).toBe("client_activity_notes");
    expect(notes.ops.filter(([o]) => o === "eq")).toEqual([["eq", ["studio_id", "s1"]], ["eq", ["client_id", "c1"]]]);
    expect(notes.ops.filter(([o]) => o === "order").map(([, a]) => a)).toEqual([
      ["occurred_at", { ascending: false }],
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(notes.ops.find(([o]) => o === "limit")![1]).toEqual([26]);
    expect(notes.ops.some(([o]) => o === "or")).toBe(false);
    expect(String(notes.ops.find(([o]) => o === "select")![1][0])).not.toContain("email");
  });

  it("a cursor becomes a quoted keyset filter on (occurred_at, created_at, id)", async () => {
    const f = fake({ rows: [] });
    await listClientNotes({ supabase: f.supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: { o: T1, c: T2, i: ID }, limit: 5 });
    expect(f.log[1].ops.find(([o]) => o === "or")![1][0]).toBe(
      `occurred_at.lt."${T1}",and(occurred_at.eq."${T1}",created_at.lt."${T2}"),and(occurred_at.eq."${T1}",created_at.eq."${T2}",id.lt.${ID})`,
    );
  });

  it("returns a page, a next cursor for the last returned note only when more rows exist, and the author name without any email", async () => {
    const more = await listClientNotes({ supabase: fake({ rows: [row(3), row(2), row(1)] }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 2 });
    expect(more!.notes.map((n) => n.body)).toEqual(["note 3", "note 2"]);
    expect(decodeNoteCursor(more!.nextCursor)).toEqual({ o: row(2).occurred_at, c: row(2).created_at, i: row(2).id });
    expect(more!.notes[0]).toEqual({
      id: row(3).id, clientId: "c1", noteType: "general", body: "note 3", occurredAt: row(3).occurred_at, createdAt: row(3).created_at, authorName: "Fran Desk", isMine: true,
    });
    const end = await listClientNotes({ supabase: fake({ rows: [row(2), row(1)] }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 2 });
    expect(end!.nextCursor).toBeNull();
  });

  it("isMine is true only for the caller own notes", async () => {
    row_by = "someone-else";
    const r = await listClientNotes({ supabase: fake({ rows: [row(1, null)] }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 10 });
    row_by = "u1";
    expect(r!.notes[0]).toMatchObject({ isMine: false, authorName: null });
  });

  it("a missing or array-shaped author embed is handled", async () => {
    const r = await listClientNotes({ supabase: fake({ rows: [row(1, null), row(2, [{ full_name: "Arr Ay" }]), row(3, [])] }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 10 });
    expect(r!.notes.map((n) => n.authorName)).toEqual([null, "Arr Ay", null]);
  });

  it("database errors are thrown (the route answers 503)", async () => {
    await expect(listClientNotes({ supabase: fake({ readError: true }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 5 })).rejects.toThrow("Notes read failed");
    await expect(listClientNotes({ supabase: fake({ clientError: true }).supabase, studioId: "s1", clientId: "c1", userId: "u1", cursor: null, limit: 5 })).rejects.toThrow("Client lookup failed");
  });
});
