import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { rpc: Array<{ fn: string; args: Record<string, unknown> }>; rpcError: { code?: string; message?: string } | null; dob: string; tableWrites: number } = { rpc: [], rpcError: null, dob: "1990-01-01", tableWrites: 0 };

const rows: Record<string, unknown> = {
  events: { id: "ev", studio_id: "s1", organizer_id: null },
  event_competition_entries: { id: "e1", division_id: "d1" },
  event_competition_divisions: { age_label: "Senior I", skill_label: "Gold", role_label: null },
};
function query(table: string) {
  const list = table === "event_competition_entry_participants" ? [{ competitor_id: "c1", participant_role: "dancer" }]
    : table === "event_competition_competitors" ? [{ id: "c1", date_of_birth: state.dob }] : [];
  const builder: Record<string, unknown> = {
    select: () => builder, eq: () => builder, in: () => builder,
    maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
    update: () => { state.tableWrites += 1; return builder; },
    insert: () => { state.tableWrites += 1; return builder; },
    then: (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null }),
  };
  return builder;
}
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error("REDIRECT " + url); } }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ studioId: "s1", studioRole: "studio_owner", isPlatformAdmin: false, userId: "u1" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: query, rpc: async (fn: string, args: Record<string, unknown>) => { state.rpc.push({ fn, args }); return { data: null, error: state.rpcError }; } }) }));

import { updateCompetitionEntryEligibilityAction } from "@/app/app/events/[id]/competition/registrations/actions";

const form = (fields: Record<string, string>, criteria: string[] = []) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ eventId: "ev", entryId: "e1", eligibilityStatus: "eligible", reasonCode: "criteria_verified_by_organizer", ...fields })) data.set(key, value);
  for (const item of criteria) data.append("criteria", item);
  return data;
};

describe("R-15 organizer eligibility action (executed)", () => {
  beforeEach(() => { state.rpc = []; state.rpcError = null; state.dob = "1990-01-01"; state.tableWrites = 0; });

  it("sends exactly the criteria the organizer ticked, through the function, with no table write", async () => {
    // success lands on the clean page, so an earlier ?eligibilityError never survives it
    await expect(updateCompetitionEntryEligibilityAction(form({}, ["age_division", "level"]))).rejects.toThrow(/^REDIRECT \/app\/events\/ev\/competition\/registrations$/);
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].fn).toBe("set_competition_entry_eligibility");
    expect(state.rpc[0].args.p_criteria).toEqual(["age_division", "level"]);
    expect(state.tableWrites).toBe(0);
  });
  it("never fills in a criterion the organizer did not tick", async () => {
    await expect(updateCompetitionEntryEligibilityAction(form({}, ["age_division"]))).rejects.toThrow("eligibilityError=criteria");
    expect(state.rpc).toEqual([]);
  });
  it("refuses a minor before calling the database, with a visible reason", async () => {
    state.dob = "2015-01-01";
    await expect(updateCompetitionEntryEligibilityAction(form({}, ["age_division", "level"]))).rejects.toThrow("eligibilityError=adult");
    expect(state.rpc).toEqual([]);
  });
  it("refuses a waiver on a classified division", async () => {
    await expect(updateCompetitionEntryEligibilityAction(form({ eligibilityStatus: "waived", reasonCode: "waiver_event_policy_fee" }))).rejects.toThrow("eligibilityError=waiver");
    expect(state.rpc).toEqual([]);
  });
  it.each([
    [{ code: "PGRST202", message: "not found" }, "unavailable"],
    [{ code: "23514", message: "COMP_R15_DETERMINATION_INVALID: a waiver cannot be used for an event that declares any sanctioning." }, "waiver"],
    [{ code: "42501", message: "COMP_R15_NOT_FOUND: x" }, "permission"],
  ])("shows a database refusal as a code and writes nothing (%o)", async (error, code) => {
    state.rpcError = error;
    await expect(updateCompetitionEntryEligibilityAction(form({}, ["age_division", "level"]))).rejects.toThrow("eligibilityError=" + code);
    expect(state.tableWrites).toBe(0);
  });
});
