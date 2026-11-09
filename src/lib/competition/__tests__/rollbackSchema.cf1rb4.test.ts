import { describe, expect, it, vi } from "vitest";
import { classifyLoadError, secondaryData, shouldNotFound } from "../pageLoadError";

// RB4 app-first compatibility (integration-5). If the SQL is rolled back while the CF1 app is still deployed, PostgREST answers the CF1 RPCs with
// "function not found" (PGRST202 through the API, 42883 from Postgres). The results page must then fail CLOSED: a generic error through the
// error boundary, never a page that renders without the Approve guard / co-sign panel, never the raw database message. This is why the documented
// rollback order is "app first, then SQL".
const MISSING = [
  { code: "PGRST202", message: "Could not find the function public.competition_round_advancement_preview(p_round_id) in the schema cache" },
  { code: "42883", message: "function public.competition_round_exclusions(uuid) does not exist" },
];

describe("CF1 RPCs absent after a SQL rollback (app deployed first is the safe order)", () => {
  it.each(MISSING)("%j is classified rethrow, never notFound and never a silently hidden panel", (e) => {
    expect(classifyLoadError(e)).toBe("rethrow");
  });

  it.each(["advancement preview", "exclusions", "withdrawal state", "correction", "publications"])("secondary read '%s' with a missing function throws the generic error", (label) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const e of MISSING) {
      expect(() => secondaryData(label, { data: null, error: e })).toThrow("Could not load this page. Refresh and try again.");
    }
    spy.mockRestore();
  });

  it("the primary read with a missing function also throws (no 404 for a legitimate manager)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => shouldNotFound(MISSING[0], null)).toThrow("Could not load this page. Refresh and try again.");
    spy.mockRestore();
  });

  it("the thrown error carries neither the function name nor the database code", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      secondaryData("advancement preview", { data: null, error: MISSING[0] });
      throw new Error("did not throw");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).not.toMatch(/PGRST|42883|competition_round|schema cache/);
    }
    spy.mockRestore();
  });
});
