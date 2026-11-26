import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * TW-4F slice E: suspension is an administrator's emergency action, never an automatic one. No cron, credit check, alert, webhook, reconciler or script may
 * reach it. Source scan of the whole application (and scripts):
 *  - the real status client lives in real.ts (the only module allowed to reach Twilio, see realAndConfig.test.ts); its class is not exported, and its
 *    factory `createRealSuspensionProvider` is CALLED only by the guarded server-action file;
 *  - the runner module is imported only by that file, the fake, and real.ts (for the gate and the types);
 *  - no other code path names the suspension database functions or a status write.
 */

const ROOT = process.cwd();
vi.setConfig({ testTimeout: 120_000 });
const SRC = join(ROOT, "src");
const ALLOWED_IMPORTER = "src/app/platform/sms/suspensionActions.ts";
const REAL = "src/lib/sms/twilioIsv/real.ts";
const MODULES = ["src/lib/sms/twilioIsv/suspension.ts", "src/lib/sms/twilioIsv/suspensionFake.ts", REAL];

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
const appFiles = files.filter((f) => !isTest(f));
const importRe = (mod: string) => new RegExp(`(from|import\\(|require\\()\\s*["'][^"']*twilioIsv/${mod}["']|(from|import\\(|require\\()\\s*["']\\./${mod}["']`);
const read = (f: string) => readFileSync(f, "utf8");

describe("no automatic path can reach the suspension", () => {
  it("only the guarded server actions call the real suspension factory; the client class is not exported", () => {
    const users = appFiles.filter((f) => /createRealSuspensionProvider/.test(read(f))).map(rel).sort();
    expect(users).toEqual([ALLOWED_IMPORTER, REAL].sort());
    const real = read(join(ROOT, REAL));
    expect(real).toMatch(/^class RealSubaccountStatusClient /m);
    expect(real).not.toMatch(/export\s+(default\s+)?class RealSubaccountStatusClient|export\s*\{[^}]*RealSubaccountStatusClient/);
    expect(appFiles.filter((f) => rel(f) !== REAL && /RealSubaccountStatusClient/.test(read(f))).map(rel)).toEqual([]);
  });

  it("the runner module is imported only by the server actions, the fake and real.ts", () => {
    const importers = appFiles.filter((f) => importRe("suspension").test(read(f))).map(rel).sort();
    expect(importers).toEqual([ALLOWED_IMPORTER, "src/lib/sms/twilioIsv/suspensionFake.ts", REAL].sort());
  });

  it("the fake provider is imported only by tests", () => {
    expect(appFiles.filter((f) => importRe("suspensionFake").test(read(f))).map(rel)).toEqual([]);
  });

  it("no cron, webhook, credit, alert, reconciler or script file names a suspension database function or the status write", () => {
    const forbidden = /tw4susp_(begin|verify_begin|record|switch_set|reconciliation_attest|attempt_abandon)|tw4_traffic_hold_release|Status["']?\s*:\s*["'](suspended|closed)["']|runSubaccountStatusChange|runSubaccountVerification|createRealSuspensionProvider/;
    const offenders = appFiles.map(rel).filter((r) => r !== ALLOWED_IMPORTER && !MODULES.includes(r)).filter((r) => forbidden.test(read(join(ROOT, r))));
    expect(offenders).toEqual([]);
  });

  it("the automated surfaces exist and were scanned (the scan is not vacuous); the detectors catch the forms an automated caller would use", () => {
    const scanned = files.map(rel);
    expect(scanned.some((r) => r.startsWith("src/app/api/cron/"))).toBe(true);
    expect(scanned).toContain("src/app/api/sms/twilio/inbound/route.ts");
    expect(scanned.some((r) => r.startsWith("src/lib/sms/providerFeeAlerts/"))).toBe(true);
    expect(scanned).toContain("src/lib/sms/twilioIsv/creditStore.ts");
    expect(scanned).toContain(ALLOWED_IMPORTER);
    expect(importRe("suspension").test('import { runSubaccountStatusChange } from "@/lib/sms/twilioIsv/suspension";')).toBe(true);
    expect(importRe("suspension").test('import { x } from "./suspension";')).toBe(true);
    expect(importRe("suspension").test('import { x } from "@/lib/sms/twilioIsv/suspensionFake";')).toBe(false);
  });

  it("nothing in the application sets the environment gate", () => {
    const setters = appFiles.filter((f) => /(\.|\[["'])TW4_SUBACCOUNT_SUSPENSION_CALLS["']?\]?\s*=[^=]/.test(read(f))).map(rel);
    expect(setters).toEqual([]);
    expect(readFileSync(join(ROOT, "vercel.json"), "utf8")).not.toContain("TW4_SUBACCOUNT_SUSPENSION_CALLS");
  });
});
