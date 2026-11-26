import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELIGIBILITY_ERRORS, ELIGIBILITY_UNAVAILABLE_MESSAGE, eligibilityErrorCode, isEligibilityErrorCode, isNotClearedRefusal, loadClearanceStates, NOT_CLEARED_MESSAGE, recordEligibilityDecision } from "../eligibilityRpc";
import { friendlyDayOfError } from "../dayOf";

const decision = { entryId: "entry-1", outcome: "eligible", reasonCode: "criteria_verified_by_organizer", criteria: ["age_division"], requestId: "req-1" };

function client(answer: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let tableAccess = 0;
  return {
    calls,
    tableAccess: () => tableAccess,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
    from: () => {
      tableAccess += 1;
      throw new Error("no table access allowed");
    },
  };
}

describe("R-15 eligibility writes go only through the database function", () => {
  it("passes the decision to set_competition_entry_eligibility with its exact parameter names", async () => {
    const c = client({ data: { replayed: false } });
    await recordEligibilityDecision(c, decision);
    expect(c.calls).toEqual([{ fn: "set_competition_entry_eligibility", args: { p_entry_id: "entry-1", p_outcome: "eligible", p_reason_code: "criteria_verified_by_organizer", p_criteria: ["age_division"], p_request_id: "req-1" } }]);
    expect(c.tableAccess()).toBe(0);
  });
  it.each(["PGRST202", "42883"])("fails closed with no table fallback when the function is missing (%s)", async (code) => {
    const c = client({ error: { code, message: "function not found" } });
    await expect(recordEligibilityDecision(c, decision)).rejects.toThrow(ELIGIBILITY_UNAVAILABLE_MESSAGE);
    expect(c.tableAccess()).toBe(0);
  });
  it.each([
    ["COMP_R15_DETERMINATION_INVALID: every competitor must have an established adult age; this cannot be waived.", "adult"],
    ["COMP_R15_DETERMINATION_INVALID: this entry's division requires verification of: level.", "criteria"],
    ["COMP_R15_DETERMINATION_INVALID: a waiver cannot be used for an event that declares any sanctioning.", "waiver"],
    ["COMP_R15_DETERMINATION_INVALID: a withdrawn entry cannot be given an eligibility decision.", "entry_state"],
    ["COMP_R15_DETERMINATION_INVALID: unknown verification criterion.", "invalid"],
    ["COMP_R15_NOT_FOUND: entry was not found or cannot be managed.", "permission"],
    ["relation secret_table row 42", "failed"],
  ])("classifies a database refusal without passing its text on (%s)", (message, code) => {
    expect(eligibilityErrorCode({ code: "23514", message })).toBe(code);
    expect(ELIGIBILITY_ERRORS[eligibilityErrorCode({ message })]).not.toContain("secret_table");
  });
  it("accepts only its own codes from a URL", () => {
    expect(isEligibilityErrorCode("adult")).toBe(true);
    for (const value of ["toString", "<script>", "", undefined]) expect(isEligibilityErrorCode(value)).toBe(false);
  });
  it("tells staff why a gate refused an uncleared entry", () => {
    for (const message of ["COMP_R15_PROVISIONAL_ASSIGNMENT: x", "COMP_R15_ENTRY_NOT_CLEARED: y"]) {
      expect(isNotClearedRefusal(message)).toBe(true);
      expect(friendlyDayOfError({ message, code: "P0001" })).toBe(NOT_CLEARED_MESSAGE);
    }
    expect(isNotClearedRefusal("COMPO1_BAD_STATE: z")).toBe(false);
  });
  it("reads with the exact function and parameter name", async () => {
    const c = client({ data: "cleared" });
    await loadClearanceStates(c, ["a"]);
    expect(c.calls).toEqual([{ fn: "competition_entry_clearance_state", args: { p_entry_id: "a" } }]);
  });
  it("keeps every answer with its own entry across batches", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => String(i));
    const states = await loadClearanceStates({ rpc: async (_fn, args) => ({ data: Number(args.p_entry_id) % 2 ? "provisional" : "cleared", error: null }) }, ids);
    expect(ids.every((id) => states.get(id) === (Number(id) % 2 ? "provisional" : "cleared"))).toBe(true);
  });
  it("reads clearance states, treats a missing function as unavailable and any unknown answer as not cleared, and throws otherwise", async () => {
    expect([...(await loadClearanceStates(client({ data: "cleared" }), ["a", "b"])).values()]).toEqual(["cleared", "cleared"]);
    expect((await loadClearanceStates(client({ data: "maybe" }), ["a"])).get("a")).toBe("unavailable");
    expect((await loadClearanceStates(client({ error: { code: "PGRST202" } }), ["a"])).get("a")).toBe("unavailable");
    await expect(loadClearanceStates(client({ error: { code: "57014" } }), ["a"])).rejects.toThrow();
  });
  it("no application source writes eligibility_status or an eligibility determination to a table", () => {
    const root = join(__dirname, "..", "..", "..");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "__tests__" || name === "migrations" || name === "node_modules") return [];
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
    });
    const offenders = walk(root).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /\.(insert|update|upsert)\(\s*[\[{][\s\S]{0,300}?\beligibility_status\s*[:,}]/.test(text) || text.includes("eligibility_determination");
    });
    expect(offenders).toEqual([]);
  }, 60000);
});
