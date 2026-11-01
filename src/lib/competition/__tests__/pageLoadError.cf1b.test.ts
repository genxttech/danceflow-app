import { describe, expect, it } from "vitest";
import { classifyLoadError, shouldNotFound } from "../pageLoadError";

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
