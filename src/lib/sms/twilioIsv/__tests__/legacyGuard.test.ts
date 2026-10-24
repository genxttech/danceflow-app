import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_REAL_MODE_MESSAGE, legacyRealModeRefusal } from "../../../../../scripts/tw4-validation/legacyGuard";

const root = resolve(__dirname, "../../../../..");

describe("legacy Stage B/C harness: real mode is retired (fail closed)", () => {
  it("allows no --adapter and the fake adapter only", () => {
    expect(legacyRealModeRefusal([])).toBeNull();
    expect(legacyRealModeRefusal(["run", "--stages", "B"])).toBeNull();
    expect(legacyRealModeRefusal(["run", "--adapter", "fake"])).toBeNull();
    expect(legacyRealModeRefusal(["run", "--adapter=fake"])).toBeNull();
    expect(legacyRealModeRefusal(["run", "--adapter", "fake", "--adapter=fake"])).toBeNull();
  });
  it("refuses real in every spelling, and any unknown or missing value", () => {
    const cases = [["--adapter", "real"], ["--adapter=real"], ["--adapter", "REAL"], ["--adapter", "Real"], ["--adapter"], ["--adapter", ""], ["--adapter=", "x"], ["--adapter", "live"], ["--adapter=subaccount"], ["--adapter", " real"]];
    for (const c of cases) expect(legacyRealModeRefusal(["run", ...c]), c.join(" ")).toBe(LEGACY_REAL_MODE_MESSAGE);
  });
  it("judges every occurrence: a real flag anywhere makes the whole call refused", () => {
    expect(legacyRealModeRefusal(["--adapter", "fake", "--adapter", "real"])).toBe(LEGACY_REAL_MODE_MESSAGE);
    expect(legacyRealModeRefusal(["--adapter", "real", "--adapter", "fake"])).toBe(LEGACY_REAL_MODE_MESSAGE);
    expect(legacyRealModeRefusal(["--adapter=fake", "--adapter=real"])).toBe(LEGACY_REAL_MODE_MESSAGE);
  });
  it("has no environment bypass: the decision depends on the arguments only", () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, { TW4_ISV_REAL_CALLS: "on", TW4_ISV_FAKE: "on", NODE_ENV: "production", TW4_ALLOW_LEGACY_REAL: "1", TW4_LEGACY_REAL: "on" });
      expect(legacyRealModeRefusal(["authorize-b", "--adapter", "real"])).toBe(LEGACY_REAL_MODE_MESSAGE);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
  });
  it("the explanation names the replacement (subaccount runner), the dry-run alternative, and says nothing was sent", () => {
    for (const phrase of ["retired", "Nothing was sent to Twilio", "subaccount", "G-SUB", "-DryRun", "production onboarding runner"]) expect(LEGACY_REAL_MODE_MESSAGE).toContain(phrase);
  });
  it("the CLI calls the guard before dispatching any command, and the launcher refuses non-dry-run before any prompt", () => {
    const cli = readFileSync(resolve(root, "scripts/tw4-validation/stage-bc.ts"), "utf8");
    const main = cli.slice(cli.indexOf("async function main()"));
    expect(main.indexOf("legacyRealModeRefusal(")).toBeGreaterThan(-1);
    expect(main.indexOf("if (refusal) throw new Error(refusal);")).toBeGreaterThan(main.indexOf("legacyRealModeRefusal("));
    expect(main.indexOf("if (refusal) throw new Error(refusal);")).toBeLessThan(main.indexOf("command === \"seed\""));
    expect(main.indexOf("legacyRealModeRefusal(")).toBeLessThan(main.indexOf('command === "seed"'));
    const launcher = readFileSync(resolve(root, "scripts/tw4-validation/run-stage-b.ps1"), "utf8");
    const guard = launcher.indexOf("if (-not $DryRun) {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(launcher.indexOf("Read-Validated"));
    expect(guard).toBeLessThan(launcher.indexOf("function Invoke-Harness"));
    expect(launcher.slice(guard, guard + 1400)).toContain("exit 2");
    // no switch, parameter or environment variable re-enables real mode
    const paramStart = launcher.indexOf("[CmdletBinding()]");
    const paramBlock = launcher.slice(paramStart, launcher.indexOf("\n)", paramStart));
    expect(paramBlock).toContain("[switch]$DryRun");
    expect(paramBlock).not.toMatch(/Legacy|AllowReal|ForceReal|Unsafe|Override/i);
    expect(launcher + cli).not.toMatch(/TW4_(ALLOW|ENABLE)_(LEGACY|REAL)/);
  });
});
