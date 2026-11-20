import { describe, expect, it } from "vitest";
import { findClientByEmail, findClientByPhone, insertClient, normalizeClientPayload, phoneMatchVariants, quickAddClient } from "../clientCreate";

type Op = [string, unknown[]];
function fake(opts: { emailHit?: string; phoneHit?: string; insertError?: string }) {
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
                const hit = eqs.includes("email") ? opts.emailHit : entry.ops.some(([o, a]) => o === "in" && a[0] === "phone") ? opts.phoneHit : undefined;
                return { data: hit ? { id: hit } : null, error: null };
              };
            }
            if (op === "insert") {
              return (row: unknown) => {
                entry.ops.push([op, [row]]);
                return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
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

const base = { firstName: "Ana", lastName: "Alvarez", email: null, phone: null, note: "" };

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
    expect(withPhoto.log[0].ops[0][1][0]).toMatchObject({ id: "c1", studio_id: "s1", photo_url: null });
    const without = fake({});
    await insertClient({ supabase: without.supabase, studioId: "s1", clientId: "c1", payload });
    expect(without.log[0].ops[0][1][0]).not.toHaveProperty("photo_url");
  });
  it("surfaces the database message", async () => {
    expect(await insertClient({ supabase: fake({ insertError: "nope" }).supabase, studioId: "s1", clientId: "c1", payload })).toEqual({ ok: false, message: "nope" });
  });
});

describe("quickAddClient", () => {
  it("creates a lead with the shared payload and returns it", async () => {
    const f = fake({});
    const r = await quickAddClient({ supabase: f.supabase, studioId: "s1", newClientId: "n1", input: { ...base, phone: "+15550100123", note: "met at the showcase" } });
    expect(r).toEqual({ ok: true, client: { id: "n1", firstName: "Ana", lastName: "Alvarez", status: "lead" } });
    const insert = f.log.find((e) => e.ops.some(([o]) => o === "insert"))!.ops.find(([o]) => o === "insert")![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ id: "n1", studio_id: "s1", first_name: "Ana", phone: "+15550100123", notes: "met at the showcase", status: "lead", email: null, is_independent_instructor: false });
  });

  it("an email match is a duplicate (web parity) and nothing is inserted", async () => {
    const f = fake({ emailHit: "c-9" });
    expect(await quickAddClient({ supabase: f.supabase, studioId: "s1", newClientId: "n1", input: { ...base, email: "ana@example.test", phone: "+15550100123" } })).toEqual({
      ok: false, reason: "duplicate_client", existingClientId: "c-9", matchedOn: "email",
    });
    expect(f.log.some((e) => e.ops.some(([o]) => o === "insert"))).toBe(false);
  });

  it("a phone match is a duplicate unless the caller allows it; allowing it never overrides an email match", async () => {
    const hit = fake({ phoneHit: "c-8" });
    expect(await quickAddClient({ supabase: hit.supabase, studioId: "s1", newClientId: "n1", input: { ...base, phone: "+15550100123" } })).toMatchObject({ reason: "duplicate_client", matchedOn: "phone", existingClientId: "c-8" });
    const allowed = fake({ phoneHit: "c-8" });
    expect((await quickAddClient({ supabase: allowed.supabase, studioId: "s1", newClientId: "n1", input: { ...base, phone: "+15550100123", allowDuplicatePhone: true } })).ok).toBe(true);
    const both = fake({ emailHit: "c-7", phoneHit: "c-8" });
    expect(await quickAddClient({ supabase: both.supabase, studioId: "s1", newClientId: "n1", input: { ...base, email: "a@x.test", phone: "+15550100123", allowDuplicatePhone: true } })).toMatchObject({ matchedOn: "email", existingClientId: "c-7" });
  });

  it("a database failure is insert_failed", async () => {
    expect(await quickAddClient({ supabase: fake({ insertError: "rls" }).supabase, studioId: "s1", newClientId: "n1", input: { ...base, email: "a@x.test" } })).toEqual({ ok: false, reason: "insert_failed", message: "rls" });
  });
});
