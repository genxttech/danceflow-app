import fs from "fs";
import path from "path";

/*
  Guard: a screen that catches a load/save failure must word it through the shared helpers
  (friendlyMessage / failureMessage in @/lib/errorKind), so a phone with no connection never shows
  "Network request failed" or reads as "not available" / "not found". Two patterns are forbidden:
    1. `x instanceof Error ? x.message : "fallback"` (raw message to the dancer)
    2. `catch { ... setErrorMessage("fixed text") }` with no error variable (cannot tell offline from anything else)
  UNSWEPT lists files still to move onto the helpers; it only shrinks. New screens must not be added to it.
*/

const UNSWEPT: string[] = [];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const root = path.resolve(__dirname, "../../..");
const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "src"))].map((f) => ({
  rel: path.relative(root, f).split(path.sep).join("/"),
  text: fs.readFileSync(f, "utf8"),
}));

const RAW = /(\w+) instanceof Error\s*\?\s*\1\.message\s*:\s*"/;
const FIXED_IN_BARE_CATCH = /catch \{\s*(?:if \(![\w.]+\) return;\s*)?(?:[^{}]*?;\s*)*?set(?:ErrorMessage|Error|Message)\(\s*"/;

describe("error wording goes through the shared helpers", () => {
  it("no screen shows a raw caught message (x instanceof Error ? x.message : ...)", () => {
    const offenders = files.filter((f) => f.rel.startsWith("app/") && RAW.test(f.text) && !UNSWEPT.includes(f.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no screen words a failure with fixed text from a catch that ignores the error", () => {
    const offenders = files.filter((f) => f.rel.startsWith("app/") && FIXED_IN_BARE_CATCH.test(f.text) && !UNSWEPT.includes(f.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("UNSWEPT only lists files that still need the sweep", () => {
    for (const rel of UNSWEPT) {
      const file = files.find((f) => f.rel === rel);
      expect(file).toBeTruthy();
      expect(RAW.test(file!.text) || FIXED_IN_BARE_CATCH.test(file!.text)).toBe(true);
    }
  });
});
