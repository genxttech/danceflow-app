import { describe, expect, it } from "vitest";
import { findClientByEmail, findClientByPhone, insertClient, normalizeClientPayload, phoneMatchVariants, quickAddClient } from "../clientCreate";

type Op = [string, unknown[]];
type Fake = {
  emailHit?: string;
  phoneHit?: string;
  byId?: Record<string, unknown> | null;
  /** successive by-id reads (a concurrent writer lands between the first read and the insert) */
  byIdSeq?: (Record<string, unknown> | null)[];
  insertError?: { code?: string; message: string };
};

function fake(opts: Fake) {
  const log: { table: string; ops: Op[] }[] = [];
  const supabase = {
    from(table: string) {
      const entry = { table, ops: [] as Op[] };
      log.push(entry);
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, op: string) {
            if (op === "maybeSingle") {
              return async () => {
                const eqs = entry.ops.filter(([o]) => o === "eq").map(([, a]) => a[0]);
                if (eqs.includes("id")) return { data: opts.byIdSeq ? (opts.byIdSeq.shift() ?? null) : (opts.byId ?? null), error: null };
                const hit = eqs.includes("email") ? opts.emailHit : entry.ops.some(([o, a]) => o === "in" && a[0] === "phone") ? opts.phoneHit : undefined;
                return { data: hit ? { id: hit } : null, error: null };
              };
            }
            if (op === "insert") {
              return (row: unknown) => {
                entry.ops.push([op, [row]]);
                return Promise.resolve({ error: opts.insertError ?? null });
              };
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
  };
  return { log, supabase: supabase as never };
}

const inserts = (f: ReturnType<typeof fake>) => f.log.flatMap((e) => e.ops.filter(([o]) => o === "insert").map(([, a]) => a[0] as Record<string, unknown>));
const base = { firstName: "Ana", lastName: "Alvarez", email: null, phone: null, note: "" };
const CID = "22222222-2222-4222-8222-222222222222";
const stored = (over: Record<string, unknown> = {}) => ({ id: CID, first_name: "Ana", last_name: "Alvarez", email: null, phone: "+15550100123", notes: null, status: "lead", ...over });

describe("normalizeClientPayload (verbatim extraction)", () => {
  it("builds a lead with null optional columns and the web defaults", () => {
    const payload = normalizeClientPayload({
      firstName: "Ana", lastName: "Alvarez", email: "ana@example.test", phone: "+15550100", birthday: "", addressLine1: "", addressLine2: "", city: "", state: "",
      postalCode: "", country: "", danceStyles: [], danceGoals: [], includeDanceGoals: true, skillLevel: "", notes: "hi", referralSource: "", status: "lead",
      linkedInstructorId: "x", isIndependentInstructor: false,
    });
    expect(payload).toEqual({
      first_name: "Ana", last_name: "Alvarez", email: "ana@example.test", phone: "+15550100", birthday: null, address_line1: null, address_line2: null, city: null,
      state: null, postal_code: null, country: null, dance_interests: null, dance_goals: null, skill_level: null, notes: "hi", referral_source: null, status: "lead",
      is_independent_instructor: false, linked_instructor_id: null,
    });
  });
});

describe("duplicate lookups", () => {
  it("email: exact match, studio filtered explicitly", async () => {
    const f = fake({ emailHit: "c-1" });
    expect(await findClientByEmail({ supabase: f.supabase, studioId: "s1", email: "ana@example.test" })).toEqual({ id: "c-1" });
    expect(f.log[0].ops.filter(([o]) => o === "eq")).toEqual([["eq", ["studio_id", "s1"]], ["eq", ["email", "ana@example.test"]]]);
  });

  it("phone variants cover the stored NANP forms; other numbers match exactly", () => {
    expect(phoneMatchVariants("+15550100123").sort()).toEqual(["+15550100123", "15550100123", "5550100123"].sort());
    expect(phoneMatchVariants("+442071838750")).toEqual(["+442071838750"]);
  });

  it("phone: studio filtered, oldest first", async () => {
    const f = fake({ phoneHit: "c-2" });
    expect(await findClientByPhone({ supabase: f.supabase, studioId: "s1", phone: "+15550100123" })).toEqual({ id: "c-2" });
    expect(f.log[0].ops.filter(([o]) => o === "eq")).toEqual([["eq", ["studio_id", "s1"]]]);
    expect(f.log[0].ops.find(([o]) => o === "order")?.[1]).toEqual(["created_at", { ascending: true }]);
  });
});

describe("insertClient", () => {
  const payload = normalizeClientPayload({
    firstName: "A", lastName: "B", email: null, phone: null, birthday: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "",
    danceStyles: [], includeDanceGoals: true, skillLevel: "", notes: "", referralSource: "", status: "lead", linkedInstructorId: null, isIndependentInstructor: false,
  });
  it("writes id + studio + payload, and photo_url only when one is given (web passes it, quick add does not)", async () => {
    const withPhoto = fake({});
    await insertClient({ supabase: withPhoto.supabase, studioId: "s1", clientId: "c1", payload, photoPath: null });
    expect(inserts(withPhoto)[0]).toMatchObject({ id: "c1", studio_id: "s1", photo_url: null });
    const without = fake({});
    await insertClient({ supabase: without.supabase, studioId: "s1", clientId: "c1", payload });
    expect(inserts(without)[0]).not.toHaveProperty("photo_url");
  });
  it("surfaces the database message and error", async () => {
    expect(await insertClient({ supabase: fake({ insertError: { message: "nope", code: "23505" } }).supabase, studioId: "s1", clientId: "c1", payload })).toEqual({
      ok: false, message: "nope", error: { message: "nope", code: "23505" },
    });
  });
});

describe("quickAddClient (client-supplied clientId)", () => {
  const args = { studioId: "s1", clientId: CID };

  it("creates a lead under the supplied id with the shared payload", async () => {
    const f = fake({});
    const r = await quickAddClient({ supabase: f.supabase, ...args, input: { ...base, phone: "+15550100123", note: "met at the showcase" } });
    expect(r).toEqual({ ok: true, replayed: false, client: { id: CID, firstName: "Ana", lastName: "Alvarez", status: "lead" } });
    expect(inserts(f)[0]).toMatchObject({ id: CID, studio_id: "s1", first_name: "Ana", phone: "+15550100123", notes: "met at the showcase", status: "lead", email: null, is_independent_instructor: false });
  });

  it("a replay (the id is already stored here with the same details) is answered without writing", async () => {
    const f = fake({ byId: stored() });
    const r = await quickAddClient({ supabase: f.supabase, ...args, input: { ...base, phone: "+15550100123" } });
    expect(r).toEqual({ ok: true, replayed: true, client: { id: CID, firstName: "Ana", lastName: "Alvarez", status: "lead" } });
    expect(inserts(f)).toEqual([]);
    expect(f.log[0].ops.filter(([o]) => o === "eq")).toEqual([["eq", ["studio_id", "s1"]], ["eq", ["id", CID]]]);
  });

  it("the same id with different details is an idempotency_conflict carrying the stored client", async () => {
    const f = fake({ byId: stored({ first_name: "Someone" }) });
    expect(await quickAddClient({ supabase: f.supabase, ...args, input: { ...base, phone: "+15550100123" } })).toEqual({
      ok: false, reason: "idempotency_conflict", current: { id: CID, firstName: "Someone", lastName: "Alvarez", status: "lead" },
    });
    expect(inserts(f)).toEqual([]);
  });

  it("an email match with a DIFFERENT client is a duplicate (web parity) and nothing is inserted", async () => {
    const f = fake({ emailHit: "c-9" });
    expect(await quickAddClient({ supabase: f.supabase, ...args, input: { ...base, email: "ana@example.test", phone: "+15550100123" } })).toEqual({
      ok: false, reason: "duplicate_client", existingClientId: "c-9", matchedOn: "email",
    });
    expect(inserts(f)).toEqual([]);
  });

  it("a match that is the client's own id is never reported as a duplicate", async () => {
    const f = fake({ emailHit: CID });
    expect((await quickAddClient({ supabase: f.supabase, ...args, input: { ...base, email: "ana@example.test" } })).ok).toBe(true);
  });

  it("a phone match is a duplicate unless the caller allows it; allowing it never overrides an email match", async () => {
    const hit = fake({ phoneHit: "c-8" });
    expect(await quickAddClient({ supabase: hit.supabase, ...args, input: { ...base, phone: "+15550100123" } })).toMatchObject({ reason: "duplicate_client", matchedOn: "phone", existingClientId: "c-8" });
    const allowed = fake({ phoneHit: "c-8" });
    expect((await quickAddClient({ supabase: allowed.supabase, ...args, input: { ...base, phone: "+15550100123", allowDuplicatePhone: true } })).ok).toBe(true);
    const both = fake({ emailHit: "c-7", phoneHit: "c-8" });
    expect(await quickAddClient({ supabase: both.supabase, ...args, input: { ...base, email: "a@x.test", phone: "+15550100123", allowDuplicatePhone: true } })).toMatchObject({ matchedOn: "email", existingClientId: "c-7" });
  });

  it("a concurrent identical attempt (unique violation, row now readable and equal) resolves to a replay; with different details to a conflict; unreadable to a conflict without current", async () => {
    // the first by-id read sees nothing, the insert collides, the second read finds (or cannot see) the row
    const racing = (row: Record<string, unknown> | null) => fake({ byIdSeq: [null, row], insertError: { code: "23505", message: "dup" } }).supabase;
    const input = { ...base, phone: "+15550100123", allowDuplicatePhone: true };
    expect(await quickAddClient({ supabase: racing(stored()), ...args, input })).toMatchObject({ ok: true, replayed: true });
    expect(await quickAddClient({ supabase: racing(stored({ last_name: "Other" })), ...args, input })).toMatchObject({ reason: "idempotency_conflict", current: { lastName: "Other" } });
    expect(await quickAddClient({ supabase: racing(null), ...args, input })).toEqual({ ok: false, reason: "idempotency_conflict", current: null });
  });

  it("any other database failure is insert_failed", async () => {
    expect(await quickAddClient({ supabase: fake({ insertError: { code: "42501", message: "rls" } }).supabase, ...args, input: { ...base, email: "a@x.test" } })).toEqual({
      ok: false, reason: "insert_failed", message: "rls",
    });
  });
});
