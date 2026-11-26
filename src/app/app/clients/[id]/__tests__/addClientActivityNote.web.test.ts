import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("resend", () => ({ Resend: class {} }));

// The web "add note" action is now a thin caller of src/lib/staff/clientNotes.ts. This pins its observable behavior: same redirect codes,
// same order (validation, then authorization, then the write), same revalidation.
const state = vi.hoisted(() => ({
  role: "front_desk",
  userId: "user-1",
  clientFound: true,
  insertError: false,
  inserts: [] as unknown[],
  revalidated: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => state.revalidated.push(p) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ studioId: "studio-1", studioRole: state.role }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } } }) },
    from(table: string) {
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, op: string) {
            if (op === "single") {
              return async () =>
                table === "clients"
                  ? state.clientFound ? { data: { id: "client-1" }, error: null } : { data: null, error: { message: "none" } }
                  : state.insertError ? { data: null, error: { message: "x" } } : { data: { id: "n1", client_id: "client-1", note_type: "general", body: "b", occurred_at: "t", created_at: "t" }, error: null };
            }
            if (op === "insert") return (row: unknown) => { state.inserts.push(row); return chain; };
            return () => chain;
          },
        },
      );
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const { addClientActivityNoteAction } = await import("../actions");

const urlOf = (e: unknown) => ((e as { digest?: string })?.digest ?? "").match(/^NEXT_REDIRECT;replace;([^;]*);/)?.[1] ?? "";
async function run(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return urlOf(await addClientActivityNoteAction(fd).catch((e) => e));
}
const ok = { clientId: "client-1", body: "Called about the showcase", returnTo: "/app/clients/client-1?tab=notes" };

describe("addClientActivityNoteAction (web)", () => {
  beforeEach(() => {
    state.role = "front_desk";
    state.clientFound = true;
    state.insertError = false;
    state.inserts = [];
    state.revalidated = [];
  });

  it("saves, revalidates the client page and redirects with success", async () => {
    expect(await run({ ...ok, noteType: "follow_up" })).toBe("/app/clients/client-1?tab=notes&success=client_note_saved");
    expect(state.inserts).toEqual([expect.objectContaining({ studio_id: "studio-1", client_id: "client-1", note_type: "follow_up", body: "Called about the showcase", created_by: "user-1" })]);
    expect(state.revalidated).toEqual(["/app/clients/client-1"]);
  });

  it("validation errors keep their codes and never reach authorization or the database", async () => {
    state.role = "instructor"; // would be unauthorized, but validation answers first, as before
    expect(await run({ ...ok, body: "" })).toContain("error=client_note_missing_fields");
    expect(await run({ ...ok, noteType: "nope" })).toContain("error=client_note_invalid_type");
    expect(await run({ ...ok, occurredAt: "garbage" })).toContain("error=client_note_invalid_date");
    expect(state.inserts).toEqual([]);
  });

  it("an instructor is unauthorized and nothing is written", async () => {
    state.role = "instructor";
    expect(await run(ok)).toContain("error=unauthorized");
    expect(state.inserts).toEqual([]);
  });

  it("a client outside the studio is client_not_found; a failed insert is client_note_save_failed", async () => {
    state.clientFound = false;
    expect(await run(ok)).toContain("error=client_not_found");
    expect(state.inserts).toEqual([]);
    state.clientFound = true;
    state.insertError = true;
    expect(await run(ok)).toContain("error=client_note_save_failed");
  });
});
