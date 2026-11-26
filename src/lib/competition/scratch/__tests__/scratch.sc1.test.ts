import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyPlacements,
  entryStatusLabel,
  formatChangeTime,
  heatEntryStatusLabel,
  isScratchable,
  normalizeReason,
  scratchConsistent,
  scratchErrorCode,
  scratchErrorMessage,
  scratchPreflight,
} from "../scratch";
import { performScratch, type ScratchSupabase } from "../scratchServer";
import { scratchHref } from "../../dayOf";

const EVENT = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";

type Fake = {
  eq: () => Fake;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  then: (resolve: (v: unknown) => void) => void;
};
type HeatRow = { status: string; heat: { lock_state: string; status: string } };

/** In-memory model of the tables + the lifecycle RPC, mirroring the live SQL (invoker, manager only, locked/certified refusal). */
function fake(opts: { entryStatus?: string; heats?: HeatRow[]; manager?: boolean; rpcError?: string; skipCascade?: boolean; missing?: boolean }) {
  const state = {
    entry: opts.missing ? null : { id: ENTRY, status: opts.entryStatus ?? "confirmed" },
    heats: (opts.heats ?? []).map((h) => ({ ...h })),
    audit: [] as Array<{ reason: string; fee: string }>,
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };
  const query = (table: string) => {
    const self: Fake = {
      eq: () => self,
      maybeSingle: async () => ({ data: table === "event_competition_entries" ? state.entry : null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: table === "event_competition_heat_entries" ? state.heats : [], error: null }),
    };
    return self;
  };
  const client = {
    from: (table: string) => ({ select: () => query(table) }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      if (opts.manager === false) return { data: null, error: { message: "Entry was not found or cannot be managed." } };
      if (state.heats.some((h) => ["locked", "certified"].includes(h.heat.lock_state))) {
        return { data: null, error: { message: "This entry is in a locked or certified heat and requires the correction workflow." } };
      }
      state.entry!.status = args.selected_status as string;
      state.audit.push({ reason: String(args.selected_reason), fee: String(args.selected_fee_handling) });
      if (!opts.skipCascade) state.heats.forEach((h) => { if (["scheduled", "checked_in"].includes(h.status)) h.status = "scratched"; });
      return { data: null, error: null };
    },
  } as unknown as ScratchSupabase;
  return { client, state };
}
const open = (status = "scheduled"): HeatRow => ({ status, heat: { lock_state: "open", status: "scheduled" } });

describe("SC1 port: href and labels", () => {
  it("scratchHref resolves to the route this PR adds", () => {
    const href = scratchHref("e1", "n1");
    expect(href).toBe("/app/events/e1/competition/registrations/scratch/n1");
    const root = path.resolve(__dirname, "../../../../app/app/events/[id]/competition/registrations/scratch/[entryId]/page.tsx");
    expect(() => readFileSync(root, "utf8")).not.toThrow();
  });
  it("keeps Scratched, Withdrawn and a stored disqualified status distinct, never as an organizer exclusion (OD-20)", () => {
    expect(entryStatusLabel("scratched")).toBe("Scratched");
    expect(entryStatusLabel("withdrawn")).toBe("Withdrawn");
    expect(entryStatusLabel("disqualified")).toBe("Disqualified status (not a DanceFlow decision)");
    expect(heatEntryStatusLabel("disqualified")).toBe("Disqualified status (not a DanceFlow decision)");
    for (const text of [entryStatusLabel("disqualified"), heatEntryStatusLabel("disqualified"), scratchErrorMessage("COMP_SC1_DISQUALIFIED_PLACEMENT")]) {
      expect(text).not.toMatch(/exclu|organizer/i);
    }
    for (const s of ["scratched", "withdrawn", "pending", "confirmed", "complete"]) {
      expect(entryStatusLabel(s)).not.toMatch(/disqualif/i);
    }
    const page = readFileSync(path.resolve(__dirname, "../../../../app/app/events/[id]/competition/registrations/scratch/[entryId]/page.tsx"), "utf8");
    expect(page).toMatch(/not a no-show, an organizer exclusion or a disqualification/);
    // That sentence is the only place the page may use the word at all.
    expect(page.replace("not a no-show, an organizer exclusion or a disqualification", "")).not.toMatch(/disqualif/i);
  });
});

describe("SC1 port: preflight", () => {
  it("allows pending / confirmed / waitlisted entries with open or no heats", () => {
    for (const s of ["pending", "confirmed", "waitlisted"]) {
      expect(scratchPreflight({ entryStatus: s, placementClass: "open" })).toEqual({ allowed: true });
      expect(scratchPreflight({ entryStatus: s, placementClass: "unplaced" })).toEqual({ allowed: true });
    }
  });
  it("refuses terminal statuses, danced, locked and certified", () => {
    for (const s of ["disqualified", "complete", "scratched", "withdrawn"]) expect(isScratchable(s)).toBe(false);
    expect(scratchPreflight({ entryStatus: "confirmed", placementClass: "danced" })).toEqual({ allowed: false, code: "COMP_SC1_DANCED" });
    expect(scratchPreflight({ entryStatus: "confirmed", placementClass: "locked" })).toEqual({ allowed: false, code: "COMP_SC1_LOCKED" });
    expect(scratchPreflight({ entryStatus: "confirmed", placementClass: "certified" })).toEqual({ allowed: false, code: "COMP_SC1_CERTIFIED" });
  });
  it("classifies placements like the R2 danced rule", () => {
    const p = (heatLockState: string, placementStatus: string, heatStatus = "scheduled") => ({ heatLockState, placementStatus, heatStatus });
    expect(classifyPlacements([])).toBe("unplaced");
    expect(classifyPlacements([p("open", "scheduled")])).toBe("open");
    expect(classifyPlacements([p("open", "danced")])).toBe("danced");
    expect(classifyPlacements([p("open", "scheduled", "active")])).toBe("danced");
    expect(classifyPlacements([p("open", "checked_in", "complete")])).toBe("danced");
    expect(classifyPlacements([p("open", "scratched", "complete")])).toBe("open");
    expect(classifyPlacements([p("locked", "scheduled")])).toBe("locked");
    expect(classifyPlacements([p("certified", "scheduled")])).toBe("certified");
  });
  it("requires a non-empty reason up to 500 characters", () => {
    expect(normalizeReason("  ")).toBeNull();
    expect(normalizeReason(null)).toBeNull();
    expect(normalizeReason("x".repeat(501))).toBeNull();
    expect(normalizeReason(" injury ")).toBe("injury");
    expect(normalizeReason("a\r\n".repeat(200) + "a".repeat(99))).toHaveLength(499);
  });
  it("labels history times with the event time zone and survives an unknown zone", () => {
    expect(formatChangeTime("2027-01-01T17:00:00Z", "America/New_York")).toMatch(/12:00 PM EST/);
    expect(formatChangeTime("2027-01-01T17:00:00Z", "Not/AZone")).toMatch(/5:00 PM UTC/);
    expect(formatChangeTime("2027-01-01T17:00:00Z", null)).toMatch(/UTC/);
  });
  it("maps database refusals (including U18-S) to stable codes", () => {
    expect(scratchErrorCode("COMP_U18S_SCRATCH_UNAUDITED: x")).toBe("COMP_SC1_UNAUDITED");
    expect(scratchErrorCode("COMP_U18S_UNSCRATCH_WRITER: x")).toBe("COMP_SC1_UNAUDITED");
    expect(scratchErrorCode("This entry is in a locked or certified heat and requires the correction workflow.")).toBe("COMP_SC1_LOCKED");
    expect(scratchErrorCode("Entry was not found or cannot be managed.")).toBe("COMP_SC1_NOT_FOUND");
    expect(scratchErrorCode("boom")).toBe("COMP_SC1_UNKNOWN");
    for (const code of ["nonsense", "constructor", "toString", "__proto__", null]) expect(scratchErrorMessage(code)).toMatch(/could not be scratched/);
  });
});

describe("SC1 port: performScratch (calls the audited RPC as the user; entry/heat-entry consistency)", () => {
  it("scratches through change_competition_entry_lifecycle with a fixed fee handling and cascades heat entries", async () => {
    const { client, state } = fake({ heats: [open("scheduled"), open("checked_in")] });
    const result = await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "  Injury  " });
    expect(result).toEqual({ ok: true, outcome: "scratched" });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({
      name: "change_competition_entry_lifecycle",
      args: { selected_entry_id: ENTRY, selected_status: "scratched", selected_reason: "Injury", selected_fee_handling: "not_applicable" },
    });
    expect(state.entry!.status).toBe("scratched");
    expect(state.heats.map((h) => h.status)).toEqual(["scratched", "scratched"]);
    expect(state.audit).toEqual([{ reason: "Injury", fee: "not_applicable" }]);
  });
  it("works for an entry that is not placed, and for pending / waitlisted entries", async () => {
    for (const entryStatus of ["pending", "waitlisted", "confirmed"]) {
      const { client } = fake({ entryStatus });
      expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: true, outcome: "scratched" });
    }
  });
  it("relies on the live published-schedule guard exempting status-only heat-entry updates (static check of the 10D migration)", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20261111090000_phase10d_heats_floor_schedule.sql"), "utf8");
    const guard = sql.slice(sql.indexOf("create function public._comp10d_guard_heat_child"));
    expect(guard).toMatch(/\(to_jsonb\(new\) - array\['status', 'updated_at'\]\) = \(to_jsonb\(old\) - array\['status', 'updated_at'\]\) then\s+return new;/);
  });
  it("replay and double scratch are no-ops: the second request never reaches the RPC", async () => {
    const { client, state } = fake({ heats: [open()] });
    await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" });
    const again = await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" });
    expect(again).toEqual({ ok: true, outcome: "already_scratched" });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
    const withdrawn = fake({ entryStatus: "withdrawn" });
    expect(await performScratch(withdrawn.client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: true, outcome: "already_withdrawn" });
    expect(withdrawn.state.rpcCalls).toHaveLength(0);
  });
  it("refuses locked / certified heats, recorded placements and started or finished heats without calling the RPC", async () => {
    const cases: Array<[HeatRow[], string]> = [
      [[{ status: "scheduled", heat: { lock_state: "locked", status: "scheduled" } }], "COMP_SC1_LOCKED"],
      [[{ status: "scheduled", heat: { lock_state: "certified", status: "complete" } }], "COMP_SC1_CERTIFIED"],
      [[{ status: "danced", heat: { lock_state: "open", status: "complete" } }], "COMP_SC1_DANCED"],
      [[{ status: "scheduled", heat: { lock_state: "open", status: "active" } }], "COMP_SC1_DANCED"],
      [[{ status: "disqualified", heat: { lock_state: "open", status: "scheduled" } }], "COMP_SC1_DISQUALIFIED_PLACEMENT"],
    ];
    for (const [heats, code] of cases) {
      const { client, state } = fake({ heats });
      expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code });
      expect(state.rpcCalls).toHaveLength(0);
      expect(state.entry!.status).toBe("confirmed");
    }
  });
  it("surfaces the RPC's own locked/certified refusal if state changed between preflight and call", async () => {
    const { client } = fake({ heats: [open()], rpcError: "This entry is in a locked or certified heat and requires the correction workflow." });
    expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_LOCKED" });
  });
  it("maps the RPC's cannot-manage refusal and leaves the entry unchanged", async () => {
    const { client, state } = fake({ manager: false });
    expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_NOT_FOUND" });
    expect(state.entry!.status).toBe("confirmed");
  });
  it("U18-S refusal is reported, never bypassed", async () => {
    const { client } = fake({ rpcError: "COMP_U18S_SCRATCH_UNAUDITED: x" });
    expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_UNAUDITED" });
  });
  it("requires a reason, and refuses terminal statuses and missing entries", async () => {
    const a = fake({});
    expect(await performScratch(a.client, { eventId: EVENT, entryId: ENTRY, reason: "   " })).toEqual({ ok: false, code: "COMP_SC1_REASON_REQUIRED" });
    expect(a.state.rpcCalls).toHaveLength(0);
    for (const entryStatus of ["disqualified", "complete"]) {
      const b = fake({ entryStatus });
      expect(await performScratch(b.client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_NOT_SCRATCHABLE" });
      expect(b.state.rpcCalls).toHaveLength(0);
    }
    expect(await performScratch(fake({ missing: true }).client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_NOT_FOUND" });
  });
  it("never re-calls the RPC for an already-out entry, even with heat placements left behind (no unaudited overwrite)", async () => {
    for (const entryStatus of ["scratched", "withdrawn"]) {
      const { client, state } = fake({ entryStatus, heats: [open("scheduled")] });
      expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "again" })).toEqual({ ok: false, code: "COMP_SC1_STRANDED" });
      expect(state.rpcCalls).toHaveLength(0);
      expect(state.heats[0].status).toBe("scheduled");
    }
  });
  it("maps the draft S6 refusals", () => {
    expect(scratchErrorCode("COMP_ENTRY_LIFECYCLE_PLACED: x")).toBe("COMP_SC1_DANCED");
    expect(scratchErrorCode("COMP_ENTRY_LIFECYCLE_STATE: x")).toBe("COMP_SC1_NOT_SCRATCHABLE");
  });
  it("detects entry / heat-entry inconsistency after the RPC", async () => {
    const { client } = fake({ heats: [open()], skipCascade: true });
    expect(await performScratch(client, { eventId: EVENT, entryId: ENTRY, reason: "r" })).toEqual({ ok: false, code: "COMP_SC1_INCONSISTENT" });
    expect(scratchConsistent("scratched", ["scratched", "danced"])).toBe(true);
    expect(scratchConsistent("scratched", ["checked_in"])).toBe(false);
    expect(scratchConsistent("confirmed", [])).toBe(false);
  });
});

describe("SC1 port: static guarantees (no money, no service key, no un-scratch)", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");
  const files = [
    read("../scratch.ts"),
    read("../scratchServer.ts"),
    read("../../../../app/app/events/[id]/competition/registrations/scratch/actions.ts"),
    read("../../../../app/app/events/[id]/competition/registrations/scratch/[entryId]/page.tsx"),
  ];
  it("never imports the admin client or Stripe and writes no table directly", () => {
    for (const src of files) {
      expect(src).not.toMatch(/supabase\/admin|createAdminClient|SERVICE_ROLE|getStripe|competitionRefunds/);
      expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    }
  });
  it("scratches only through the lifecycle RPC with the scratched status", () => {
    expect(files[1]).toContain("SCRATCH_RPC");
    expect(files[0]).toContain('"change_competition_entry_lifecycle"');
    expect(files[0]).toContain('SCRATCH_STATUS = "scratched"');
    expect(files[0]).toContain('SCRATCH_FEE_HANDLING = "not_applicable"');
  });
  it("exports one server action and no un-scratch action", () => {
    const actions = files[2];
    expect([...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1])).toEqual(["scratchCompetitionEntryAction"]);
    expect(actions).toMatch(/requireCompetitionManager/);
  });
});

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); });
const requireCompetitionManager = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u), notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/competition/workspaceServer", () => ({ requireCompetitionManager: (id: string) => requireCompetitionManager(id), requireCompetitionWorkspace: vi.fn() }));

describe("SC1 port: server action authorization", () => {
  beforeEach(() => { redirect.mockClear(); requireCompetitionManager.mockReset(); });
  const form = (over: Record<string, string> = {}) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ eventId: EVENT, entryId: ENTRY, reason: "Injury", ...over })) f.set(k, v);
    return f;
  };
  it("a non-manager (chair, staff, judge, other studio) is stopped before any database call", async () => {
    requireCompetitionManager.mockRejectedValue(new Error("You do not have permission to manage this competition."));
    const { scratchCompetitionEntryAction } = await import("../../../../app/app/events/[id]/competition/registrations/scratch/actions");
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/permission/);
  });
  it("rejects malformed ids and redirects a successful scratch to the confirmation", async () => {
    const { scratchCompetitionEntryAction } = await import("../../../../app/app/events/[id]/competition/registrations/scratch/actions");
    await expect(scratchCompetitionEntryAction(form({ entryId: "nope" }))).rejects.toThrow("NEXT_REDIRECT:/app/events");
    expect(requireCompetitionManager).not.toHaveBeenCalled();
    const { client } = fake({ heats: [open()] });
    requireCompetitionManager.mockResolvedValue({ supabase: client });
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/\?done=1$/);
    const again = fake({ entryStatus: "scratched" });
    requireCompetitionManager.mockResolvedValue({ supabase: again.client });
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/\?already=1$/);
    const locked = fake({ heats: [{ status: "scheduled", heat: { lock_state: "locked", status: "scheduled" } }] });
    requireCompetitionManager.mockResolvedValue({ supabase: locked.client });
    await expect(scratchCompetitionEntryAction(form())).rejects.toThrow(/error=COMP_SC1_LOCKED$/);
  });
});
