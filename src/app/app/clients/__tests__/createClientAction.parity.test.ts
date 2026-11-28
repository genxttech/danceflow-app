import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * createClientAction's create path now runs through src/lib/staff/clientCreate.ts (shared with the Staff API quick add). This pins what the web
 * action observably did before the extraction: the duplicate-email and partner-email messages, the inserted columns, the error text and the
 * redirect.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const state = vi.hoisted(() => ({
  existingEmails: new Set<string>(),
  insertError: null as string | null,
  inserts: [] as Record<string, unknown>[],
  lookups: [] as unknown[][],
}));

const supabase = {
  from(table: string) {
    if (table !== "clients") throw new Error(`UNEXPECTED_TABLE_ACCESS:${table}`);
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      limit: () => chain,
      maybeSingle: async () => {
        state.lookups.push([filters.studio_id, filters.email]);
        return { data: state.existingEmails.has(String(filters.email)) ? { id: "existing-client" } : null, error: null };
      },
      insert: async (row: Record<string, unknown>) => {
        state.inserts.push(row);
        return { error: state.insertError ? { message: state.insertError } : null };
      },
    };
    return chain;
  },
};

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireClientEditAccess: async () => ({ supabase, studioId: "studio-1", user: { id: "user-1" } }),
}));

const { createClientAction } = await import("../actions");

const urlOf = (e: unknown) => ((e as { digest?: string })?.digest ?? "").match(/^NEXT_REDIRECT;replace;([^;]*);/)?.[1] ?? "";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("firstName", "Jane");
  fd.set("lastName", "Doe");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createClientAction (web) after the shared-core extraction", () => {
  beforeEach(() => {
    state.existingEmails = new Set();
    state.insertError = null;
    state.inserts = [];
    state.lookups = [];
  });

  it("inserts the payload the web always built (lead by default, nulls for blanks, photo_url null) and redirects to the new client", async () => {
    const result = await createClientAction({ error: "" }, form({ email: "Jane@Example.TEST", phone: "(555) 010-0100", notes: "hello" })).catch((e) => e);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      studio_id: "studio-1",
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.test",
      phone: "+15550100100",
      notes: "hello",
      status: "lead",
      referral_source: null,
      skill_level: null,
      birthday: null,
      is_independent_instructor: false,
      linked_instructor_id: null,
      photo_url: null,
      dance_goals: null,
    });
    expect(urlOf(result)).toBe(`/app/clients/${state.inserts[0].id}`);
    expect(state.lookups).toEqual([["studio-1", "jane@example.test"]]);
  });

  it("a client with the same email in the studio returns the web's message and inserts nothing", async () => {
    state.existingEmails.add("jane@example.test");
    const result = await createClientAction({ error: "" }, form({ email: "jane@example.test" }));
    expect(result).toEqual({ error: "A client with this email already exists in this studio. Update the existing record instead." });
    expect(state.inserts).toEqual([]);
  });

  it("a partner with an existing email returns the partner message and inserts nothing", async () => {
    state.existingEmails.add("pat@example.test");
    const result = await createClientAction({ error: "" }, form({ createPartner: "on", partnerFirstName: "Pat", partnerLastName: "Doe", partnerEmail: "pat@example.test" }));
    expect(result).toEqual({
      error: "A client with the partner email already exists in this studio. Create the first client, then link the existing partner record.",
    });
    expect(state.inserts).toEqual([]);
  });

  it("a database error is reported with the web's prefix", async () => {
    state.insertError = "boom";
    expect(await createClientAction({ error: "" }, form({}))).toEqual({ error: "Client creation failed: boom" });
  });
});
