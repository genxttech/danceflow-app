import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SC1 port authorization, through the REAL requireCompetitionManager / requireCompetitionWorkspace (only the session
 * context and the Supabase client are faked). The database check inside the lifecycle RPC is separate and is not
 * executed here.
 */

const EVENT = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";

const session = vi.hoisted(() => ({
  studioRole: null as string | null,
  organizerRole: null as string | null,
  platformAdmin: false,
  eventInStudio: true,
  tables: [] as string[],
  filters: [] as string[],
  rpcCalls: [] as string[],
  entryStatus: "confirmed",
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", userId: "user-1", studioRole: session.studioRole, isPlatformAdmin: session.platformAdmin }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      session.tables.push(table);
      const row = () => {
        if (table === "events") return session.eventInStudio ? { id: EVENT, organizer_id: "org-1" } : null;
        if (table === "organizer_users") return session.organizerRole ? { role: session.organizerRole } : null;
        if (table === "event_competition_entries") return { id: ENTRY, status: session.entryStatus };
        return null;
      };
      type Query = Record<string, unknown>;
      const query: Query = {
        select: (): Query => query,
        eq: (...args: unknown[]): Query => { session.filters.push(`${table}.${args[0]}=${args[1]}`); return query; },
        in: (): Query => query,
        order: (): Query => query,
        maybeSingle: async () => ({ data: row(), error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return query;
    },
    rpc: async (name: string) => {
      session.rpcCalls.push(name);
      session.entryStatus = "scratched";
      return { data: null, error: null };
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { scratchCompetitionEntryAction } from "../../../../app/app/events/[id]/competition/registrations/scratch/actions";
import ScratchEntryPage from "../../../../app/app/events/[id]/competition/registrations/scratch/[entryId]/page";

function form() {
  const data = new FormData();
  data.set("eventId", EVENT);
  data.set("entryId", ENTRY);
  data.set("reason", "Injury");
  return data;
}
const page = () => ScratchEntryPage({ params: Promise.resolve({ id: EVENT, entryId: ENTRY }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  Object.assign(session, { studioRole: null, organizerRole: null, platformAdmin: false, eventInStudio: true, entryStatus: "confirmed" });
  session.tables.length = 0;
  session.filters.length = 0;
  session.rpcCalls.length = 0;
});

describe("SC1 port: who may scratch", () => {
  const refused: Array<[string, string | null, string | null]> = [
    ["no role at all (a chair or judge holding no manager role)", null, null],
    ["studio instructor", "instructor", null],
    ["studio front desk staff", "front_desk", null],
    ["independent instructor", "independent_instructor", null],
    ["organizer role outside the manager list", null, "organizer_viewer"],
  ];
  it.each(refused)("refuses %s: action throws, page 404s, no entry read, no RPC", async (_label, studioRole, organizerRole) => {
    session.studioRole = studioRole;
    session.organizerRole = organizerRole;
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/permission to manage this competition/);
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(session.rpcCalls).toEqual([]);
    expect(session.tables).not.toContain("event_competition_entries");
  });
  it("refuses an event outside the signed-in studio", async () => {
    session.studioRole = "studio_owner";
    session.eventInStudio = false;
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(session.filters).toContain("events.studio_id=studio-1");
    expect(session.filters).toContain(`events.id=${EVENT}`);
    expect(session.rpcCalls).toEqual([]);
  });
  // The existing live authority (access.ts / can_manage_event_competition) is unchanged: organizer_staff is a manager.
  const allowed: Array<[string, string | null, string | null, boolean]> = [
    ["studio owner", "studio_owner", null, false],
    ["studio admin", "studio_admin", null, false],
    ["organizer owner", null, "organizer_owner", false],
    ["organizer admin", null, "organizer_admin", false],
    ["organizer staff", null, "organizer_staff", false],
    ["platform admin", null, null, true],
  ];
  it.each(allowed)("lets a %s scratch through the lifecycle RPC", async (_label, studioRole, organizerRole, platformAdmin) => {
    Object.assign(session, { studioRole, organizerRole, platformAdmin });
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/\?done=1$/);
    expect(session.rpcCalls).toEqual(["change_competition_entry_lifecycle"]);
  });
  it("renders the page for a manager", async () => {
    session.studioRole = "studio_owner";
    await expect(page()).resolves.toBeTruthy();
  });
});
