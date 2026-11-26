import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_PATTERN,
  MAX_WRITE_BODY_BYTES,
  isUniqueViolation,
  readEntityId,
  readIdempotencyKey,
  readJsonBody,
  resolveInsertReplay,
  sameFields,
  staffConflict,
  staffWriteError,
} from "@/lib/staff/writeSupport";

const req = (init: { key?: string | null; body?: string } = {}) =>
  new Request("https://app.test/api/staff/x", {
    method: "POST",
    headers: init.key === null || init.key === undefined ? {} : { "Idempotency-Key": init.key },
    body: init.body,
  });

describe("readIdempotencyKey", () => {
  it("accepts 8-128 characters of letters, digits and - _ : .", () => {
    for (const key of ["abcdefgh", "df-bus-lq3x9k2a-abc123xy", "a".repeat(128), "A_b-c:d.e1"]) {
      expect(readIdempotencyKey(req({ key }))).toEqual({ ok: true, key });
      expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
    }
  });
  it("refuses missing, short, long and out-of-alphabet keys with the flat 400", async () => {
    for (const key of [null, "", "short", "a".repeat(129), "has space 123", "semi;colon1", "café-key-123"]) {
      const result = readIdempotencyKey(req({ key }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("cache-control")).toBe("private, no-store");
      expect((await result.response.json()).code).toBe("invalid_request");
    }
  });
});

describe("readJsonBody", () => {
  it("returns a JSON object", async () => {
    expect(await readJsonBody(req({ body: '{"a":1}' }))).toEqual({ ok: true, body: { a: 1 } });
  });
  it.each([
    ["not JSON", "nope"],
    ["an array", "[1]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["empty", ""],
  ])("refuses %s", async (_n, body) => {
    const result = await readJsonBody(req({ body }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
  });
  it("refuses a body over the size cap, counting bytes not characters", async () => {
    const big = JSON.stringify({ note: "x".repeat(MAX_WRITE_BODY_BYTES) });
    expect((await readJsonBody(req({ body: big }))).ok).toBe(false);
    const multibyte = JSON.stringify({ note: "é".repeat(MAX_WRITE_BODY_BYTES / 2 + 10) });
    expect(multibyte.length).toBeLessThan(MAX_WRITE_BODY_BYTES);
    expect((await readJsonBody(req({ body: multibyte }))).ok).toBe(false);
    expect((await readJsonBody(req({ body: JSON.stringify({ note: "x".repeat(1000) }) }))).ok).toBe(true);
  });
});

describe("readEntityId", () => {
  it("accepts a UUID and lower-cases it so a retry with other casing is the same id", () => {
    expect(readEntityId("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });
  it.each([null, undefined, 5, "", "not-a-uuid", "3f2504e0-4f89-41d3-9a0c-0305e82c330", "3f2504e0-4f89-01d3-9a0c-0305e82c3301"])("rejects %s", (v) => {
    expect(readEntityId(v)).toBeNull();
  });
});

describe("responses", () => {
  it("staffWriteError is flat, no-store, and rejects a malformed code", async () => {
    const res = staffWriteError("duplicate_email", "A client with this email already exists.", 409);
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "A client with this email already exists.", code: "duplicate_email" });
    expect(() => staffWriteError("Bad Code", "x", 400)).toThrow();
  });
  it("staffConflict carries the current server state for reconciliation", async () => {
    const res = staffConflict("outcome_conflict", "This lesson is already marked no-show.", { appointment: { id: "a", status: "no_show" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This lesson is already marked no-show.", code: "outcome_conflict", current: { appointment: { id: "a", status: "no_show" } } });
  });
});

describe("sameFields", () => {
  it("compares trimmed strings and treats null and empty as equal", () => {
    expect(sameFields({ body: " hi ", type: null }, { body: "hi", type: "" }, ["body", "type"])).toBe(true);
    expect(sameFields({ body: "hi" }, { body: "ho" }, ["body"])).toBe(false);
    expect(sameFields({ n: 1 }, { n: "1" }, ["n"])).toBe(true);
  });
});

describe("resolveInsertReplay (client-supplied id pattern)", () => {
  const row = { id: "n1", body: "hello", note_type: "general" };
  const matches = (e: typeof row) => sameFields(e, { body: "hello", note_type: "general" }, ["body", "note_type"]);

  it("no error: inserted, and the existing row is never fetched", async () => {
    let fetched = 0;
    const out = await resolveInsertReplay({ error: null, fetchExisting: async () => (fetched++, row), matches });
    expect(out).toEqual({ kind: "inserted" });
    expect(fetched).toBe(0);
  });
  it("unique violation on identical content: replay with the existing row", async () => {
    const out = await resolveInsertReplay({ error: { code: "23505" }, fetchExisting: async () => row, matches });
    expect(out).toEqual({ kind: "replay", existing: row });
  });
  it("unique violation on different content: idempotency_conflict with the existing row", async () => {
    const out = await resolveInsertReplay({ error: { code: "23505" }, fetchExisting: async () => ({ ...row, body: "other" }), matches });
    expect(out).toMatchObject({ kind: "idempotency_conflict", existing: { body: "other" } });
  });
  it("unique violation with no row at that id: some other unique rule", async () => {
    expect(await resolveInsertReplay({ error: { code: "23505" }, fetchExisting: async () => null, matches })).toEqual({ kind: "other_conflict" });
  });
  it("any other database error is a failure, not a replay", async () => {
    const out = await resolveInsertReplay({ error: { code: "42501", message: "denied" }, fetchExisting: async () => row, matches });
    expect(out).toEqual({ kind: "failed", error: { code: "42501", message: "denied" } });
    expect(isUniqueViolation({ code: "42501" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
