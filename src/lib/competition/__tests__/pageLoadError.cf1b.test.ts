import { describe, expect, it, vi } from "vitest";
import { classifyLoadError, secondaryData, shouldNotFound } from "../pageLoadError";

describe("page load error classification", () => {
  it.each([
    [null, "ok"],
    [{ code: "42501", message: "COMP_FORBIDDEN: not allowed." }, "notFound"],
    [{ code: "PGRST116", message: "no rows" }, "notFound"],
    [{ code: "", message: "COMP_FORBIDDEN: not allowed." }, "notFound"],
    [{ code: "P0001", message: "COMP_NOT_FOUND: round" }, "notFound"],
    [{ code: "", message: "<html>502 Bad Gateway</html>" }, "rethrow"],
    [{ code: "", message: "TypeError: fetch failed" }, "rethrow"],
    [{ code: "40P01", message: "deadlock detected" }, "rethrow"],
    [{ code: "XX000", message: "internal" }, "rethrow"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(classifyLoadError(error)).toBe(expected);
  });
  it("shouldNotFound: authz and empty data 404, server failure throws", () => {
    expect(shouldNotFound({ code: "42501", message: "x" }, null)).toBe(true);
    expect(shouldNotFound(null, null)).toBe(true);
    expect(shouldNotFound(null, { a: 1 })).toBe(false);
    expect(() => shouldNotFound({ code: "", message: "502 Bad Gateway" }, null)).toThrow(/Could not load/);
  });
});

describe("secondary reads (review P2-A) and the generic error (review P3)", () => {
  const gateway = { code: "", message: "<html>502 Bad Gateway</html>" };
  const forbidden = { code: "42501", message: "COMP_FORBIDDEN: not allowed." };

  it("returns the data of a clean read and null for an empty one", () => {
    expect(secondaryData("x", { data: { a: 1 }, error: null })).toEqual({ a: 1 });
    expect(secondaryData("x", { data: null, error: null })).toBeNull();
    expect(secondaryData("x", { data: undefined })).toBeNull();
  });

  it("an authorization refusal hides the panel (null), even when data is present", () => {
    expect(secondaryData("x", { data: { leaked: true }, error: forbidden })).toBeNull();
  });

  it.each([
    ["preview", gateway],
    ["exclusions", { code: "40P01", message: "deadlock detected" }],
    ["withdrawal state", { code: "XX000", message: "internal" }],
    ["ballot board", { code: "", message: "TypeError: fetch failed" }],
    ["correction", gateway],
    ["stored trace", gateway],
    ["stored rows", gateway],
  ])("a failed %s read rethrows instead of rendering a degraded page", (label, error) => {
    expect(() => secondaryData(label, { data: null, error })).toThrow(/Could not load this page/);
  });

  it("the thrown error never carries the raw database message or code, which are logged server-side only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = { code: "XX000", message: "relation event_competition_secret_table failed at 10.0.0.5" };
    let thrown: Error | null = null;
    try {
      secondaryData("correction", { data: null, error: secret });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toBe("Could not load this page. Refresh and try again.");
    expect(thrown?.message).not.toMatch(/secret_table|10\.0\.0\.5|XX000/);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("event_competition_secret_table"));
    expect(() => shouldNotFound(secret, null)).toThrow("Could not load this page. Refresh and try again.");
    spy.mockRestore();
  });
});
