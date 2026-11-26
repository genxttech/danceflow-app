import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELIGIBILITY_UNAVAILABLE_MESSAGE, eligibilityErrorMessage, loadClearanceStates, recordEligibilityDecision } from "../eligibilityRpc";

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
  it("surfaces the function's refusal sentence and hides other database text", () => {
    expect(eligibilityErrorMessage({ code: "23514", message: "COMP_R15_DETERMINATION_INVALID: every competitor must have an established adult age; this cannot be waived." }))
      .toBe("every competitor must have an established adult age; this cannot be waived.");
    expect(eligibilityErrorMessage({ code: "42501", message: "COMP_R15_NOT_FOUND: entry was not found or cannot be managed." })).toMatch(/permission/);
    expect(eligibilityErrorMessage({ code: "XX000", message: "relation secret_table row 42" })).not.toContain("secret_table");
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
      return /\.(insert|update|upsert)\(\s*\{[^}]*\beligibility_status\b/.test(text) || text.includes("eligibility_determination");
    });
    expect(offenders).toEqual([]);
  }, 60000);
});
