import fs from "fs";
import path from "path";

/*
  Guard: what the staff app says when something fails must come from the shared error helpers
  (staffErrorKind and its wording in the screens, signInFailureKind on the sign-in screen), so a phone with no
  connection never shows "Network request failed" and never reads as "not allowed". Forbidden in screens and components:
    1. `x instanceof Error ? x.message : "fallback"` (a raw caught message shown to staff)
    2. `catch { ... setSomething("fixed text") }` with no error variable (cannot tell offline from anything else)
    3. a vendor or infrastructure name inside user-facing string literals
  UNSWEPT lists files still to move onto the helpers; it only shrinks. New screens must not be added to it.
*/

const UNSWEPT: string[] = [];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : walk(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

const root = path.resolve(__dirname, "../../..");
const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "src/screens")), ...walk(path.join(root, "src/components"))].map((f) => ({
  rel: path.relative(root, f).split(path.sep).join("/"),
  text: fs.readFileSync(f, "utf8"),
}));

const RAW = /(\w+) instanceof Error\s*\?\s*\1\.message\s*:/;
const FIXED_IN_BARE_CATCH = /catch \{\s*(?:if \(![\w.]+\) return;\s*)?(?:[^{}]*?;\s*)*?set(?:ErrorMessage|Error|Message|Status|SaveError)\(\s*["'`]/;
const VENDOR = /(["'`])[^"'`\n]*\b(Supabase|Postgres|PostgREST|Stripe|Twilio|Vercel|Firebase|GoTrue|Expo)\b[^"'`\n]*\1/;

describe("error wording goes through the shared helpers", () => {
  it("found the screens", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("no screen shows a raw caught message", () => {
    expect(files.filter((f) => RAW.test(f.text) && !UNSWEPT.includes(f.rel)).map((f) => f.rel)).toEqual([]);
  });

  it("no screen words a failure with fixed text from a catch that ignores the error", () => {
    expect(files.filter((f) => FIXED_IN_BARE_CATCH.test(f.text) && !UNSWEPT.includes(f.rel)).map((f) => f.rel)).toEqual([]);
  });

  it("no vendor name appears in a string literal in a screen (user copy)", () => {
    const offenders = files.filter((f) => f.text.split("\n").some((l) => !/^\s*(\/\/|\*|import )/.test(l) && !/from\s+["']/.test(l) && VENDOR.test(l))).map((f) => f.rel);
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
