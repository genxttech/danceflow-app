// Static review tests for the two administrator/agent PowerShell scripts. They are never executed here (and never by engineering): these tests read the
// text and pin the properties the review depends on: dry run by default, every change inside Do-Change, fail-closed header, no network/Stripe/secret use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const setup = readFileSync(join(dir, "Setup-D24StandardUserAgent.ps1"), "utf8");
const verify = readFileSync(join(dir, "Verify-D24StandardUserAgent.ps1"), "utf8");
const code = (t: string) => t.split(/\r?\n/).filter((l) => !/^\s*(#|\.)/.test(l));
const MUTATING = /\b(New-LocalUser|Set-LocalUser|Remove-LocalUser|Add-LocalGroupMember|Remove-LocalGroupMember|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|New-Item|Remove-Item|Set-Acl|Set-Content|Out-File|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|secedit|net\s+user|net\s+localgroup|icacls(\.exe)?|takeown|reg\s+add|sc\.exe|Restart-Computer|Stop-Computer)\b/i;

describe("Setup-D24StandardUserAgent.ps1 (administrator, run once)", () => {
  it("fails closed: strict mode, Stop on error, stops after failed preconditions, and a dry run never returns success", () => {
    expect(setup).toMatch(/Set-StrictMode -Version Latest/);
    expect(setup).toMatch(/\$ErrorActionPreference = 'Stop'/);
    expect(setup).toMatch(/function Stop-IfFailed[\s\S]*exit 2/);
    expect(setup).toMatch(/if \(-not \$Apply\) \{ exit 10 \}/);
  });
  it("is a DRY RUN unless -Apply is given: Apply is a switch with no default and Do-Change only runs the action when it is set", () => {
    expect(setup).toMatch(/\[switch\]\$Apply/);
    expect(setup).not.toMatch(/\$Apply\s*=\s*\$true/);
    const fn = /function Do-Change[\s\S]*?\n}\n/.exec(setup)?.[0] ?? "";
    expect(fn).toMatch(/if \(-not \$Apply\) \{[^}]*WOULD[^}]*return \}/);
    expect(fn.match(/& \$Action/g)).toHaveLength(1);
  });
  it("EVERY state-changing command is on a Do-Change line (nothing mutates outside the dry-run switch)", () => {
    const lines = code(setup);
    const start = lines.findIndex((l) => /^function Do-Change/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^}/.test(l));
    const outside = lines.filter((_, i) => i < start || i > end);
    const offenders = outside.filter((l) => MUTATING.test(l) && !/Do-Change/.test(l));
    expect(offenders).toEqual([]);
    expect(outside.filter((l) => /Do-Change /.test(l)).length).toBeGreaterThanOrEqual(7);
  });
  it("requires elevation, -NoProfile, an administrator-owned script file, and three distinct accounts", () => {
    expect(setup).toMatch(/IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
    expect(setup).toMatch(/-NoProfile/);
    expect(setup).toMatch(/S-1-5-32-544', 'S-1-5-18'/);
    expect(setup).toMatch(/must be three different accounts/);
  });
  it("sets/checks the UAC values the document requires (credentials on the secure desktop for standard users)", () => {
    for (const re of [/EnableLUA = 1/, /ConsentPromptBehaviorUser = 1/, /PromptOnSecureDesktop = 1/, /ConsentPromptBehaviorAdmin = 2/, /FilterAdministratorToken = 1/]) expect(setup).toMatch(re);
  });
  it("never removes the owner's data, never prints or stores a password, never touches the network or Stripe", () => {
    expect(setup).not.toMatch(/Remove-Item|Set-Content|Out-File/i);
    expect(setup).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget|Start-BitsTransfer|api\.stripe|rk_|sk_/i);
    expect(setup).not.toMatch(/ConvertFrom-SecureString|Write-Host[^\n]*\$pw|Write-Host[^\n]*\$p\b/);
    expect(setup).not.toMatch(/Administrators.*Add-LocalGroupMember|Add-LocalGroupMember -Group \(Get-LocalGroup -SID 'S-1-5-32-544'\)/);
  });
});

describe("Verify-D24StandardUserAgent.ps1 (standard user, read-only probes)", () => {
  it("fails closed and distinguishes not-fully-verified from pass: exit 0 only with no FAIL and no SKIP", () => {
    expect(verify).toMatch(/Set-StrictMode -Version Latest/);
    expect(verify).toMatch(/\$ErrorActionPreference = 'Stop'/);
    expect(verify).toMatch(/if \(\$fail -gt 0\) \{ exit 1 \}/);
    expect(verify).toMatch(/if \(\$skip -gt 0\)[\s\S]*exit 3/);
  });
  it("covers every negative test the document lists", () => {
    for (const id of ["not-administrator-member", "no-administrators-sid-at-all", "integrity-not-high", "no-dangerous-privileges", "uac-enabled", "uac-user-needs-credentials", "uac-secure-desktop", "uac-admin-consent", "write-root", "write-release", "write-state", "write-anchor-policy", "read-cred", "open-cred-file", "read-owner-profile", "read-owner-repository", "no-d24-credential-in-this-profile", "no-sensitive-env"]) expect(verify, id).toContain(id);
  });
  it("only ever creates an empty uniquely named probe file (and deletes it if it unexpectedly landed); no other mutation, no network, no secret read", () => {
    const offenders = code(verify).filter((l) => MUTATING.test(l) && !/\.d24probe|Remove-Item -LiteralPath \$probe/.test(l));
    expect(offenders).toEqual([]);
    expect(verify).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|api\.stripe|rk_|sk_|ReadAllText|Get-Content/i);
    expect(verify).toMatch(/\[IO\.File\]::Open\(\$f, 'Open', 'Write', 'ReadWrite'\)/); // opens existing pinned files without writing anything
  });
  it("must not be run elevated: it fails if the token is an administrator's", () => {
    expect(verify).toMatch(/not-administrator-member/);
  });
});
