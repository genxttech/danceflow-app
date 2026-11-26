import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * TW-4F slice E: suspension is an administrator's emergency action, never an automatic one. No cron, credit check, alert, webhook, reconciler or script may
 * reach it. Source scan of the whole application (and scripts): the ONLY non-test importer of the suspension modules is the guarded server-action file, and
 * the real status client is imported by nothing else at all. No code path outside them names the suspension database functions.
 */

const ROOT = process.cwd();
vi.setConfig({ testTimeout: 120_000 });
const SRC = join(ROOT, "src");
const ALLOWED_IMPORTER = "src/app/platform/sms/suspensionActions.ts";
const MODULES = ["suspension", "suspensionReal", "suspensionFake"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const isTest = (p: string) => /\/__tests__\/|\.test\.tsx?$|\.spec\.tsx?$/.test(rel(p));
const files = [...walk(SRC), ...walk(join(ROOT, "scripts"))];
const importRe = (mod: string) => new RegExp(`(from|import\\(|require\\()\\s*["'][^"']*twilioIsv/${mod}["']|(from|import\\(|require\\()\\s*["']\\./${mod}["']`);

describe("no automatic path can reach the suspension", () => {
  it("only the guarded server actions import the suspension runner and the real status client", () => {
    for (const mod of ["suspension", "suspensionReal"]) {
      const importers = files.filter((f) => !isTest(f) && importRe(mod).test(readFileSync(f, "utf8"))).map(rel).sort();
      // suspensionReal imports the runner module for its gate and types; nothing else may
      const allowed = mod === "suspension" ? [ALLOWED_IMPORTER, "src/lib/sms/twilioIsv/suspensionFake.ts", "src/lib/sms/twilioIsv/suspensionReal.ts"] : [ALLOWED_IMPORTER];
      expect(importers, mod).toEqual(allowed.sort());
    }
  });

  it("the fake provider is imported only by tests", () => {
    const importers = files.filter((f) => !isTest(f) && importRe("suspensionFake").test(readFileSync(f, "utf8"))).map(rel);
    expect(importers).toEqual([]);
  });

  it("no cron, webhook, credit, alert, reconciler or script file names a suspension database function or the status write", () => {
    const forbidden = /tw4susp_(begin|verify_begin|record|switch_set)|Status["']?\s*:\s*["'](suspended|closed)["']|runSubaccountStatusChange|createRealSuspensionProvider/;
    const offenders = files
      .filter((f) => !isTest(f))
      .map(rel)
      .filter((r) => r !== ALLOWED_IMPORTER && !MODULES.some((m) => r === `src/lib/sms/twilioIsv/${m}.ts`))
      .filter((r) => forbidden.test(readFileSync(join(ROOT, r), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the automated surfaces exist and were scanned (the scan is not vacuous)", () => {
    const scanned = files.map(rel);
    expect(scanned.some((r) => r.startsWith("src/app/api/cron/"))).toBe(true);
    expect(scanned).toContain("src/app/api/sms/twilio/inbound/route.ts");
    expect(scanned.some((r) => r.startsWith("src/lib/sms/providerFeeAlerts/"))).toBe(true);
    expect(scanned).toContain("src/lib/sms/twilioIsv/creditStore.ts");
    expect(scanned).toContain(ALLOWED_IMPORTER);
    // the detectors catch the forms an automated caller would use
    expect(importRe("suspension").test('import { runSubaccountStatusChange } from "@/lib/sms/twilioIsv/suspension";')).toBe(true);
    expect(importRe("suspensionReal").test('const m = await import("@/lib/sms/twilioIsv/suspensionReal");')).toBe(true);
    expect(importRe("suspension").test('import { x } from "./suspension";')).toBe(true);
    expect(importRe("suspension").test('import { x } from "@/lib/sms/twilioIsv/suspensionFake";')).toBe(false);
  });

  it("nothing in the application sets the environment gate", () => {
    const setters = files.filter((f) => !isTest(f) && /(\.|\[["'])TW4_SUBACCOUNT_SUSPENSION_CALLS["']?\]?\s*=[^=]/.test(readFileSync(f, "utf8"))).map(rel);
    expect(setters).toEqual([]);
    expect(readFileSync(join(ROOT, "vercel.json"), "utf8")).not.toContain("TW4_SUBACCOUNT_SUSPENSION_CALLS");
  });
});
