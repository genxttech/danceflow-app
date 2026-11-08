// Static review tests for the two administrator/agent PowerShell scripts. They are never executed here (and never by engineering): these tests read the
// text and pin the properties the reviews depend on: dry run by default, check-everything-before-changing, every change inside an Add-Plan block, no recursive ACL
// change, module/binary hygiene, defensive registry reads, the required UAC values, and that the verification script can pass and cannot be fooled by a split token.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const setupRaw = readFileSync(join(dir, "Setup-D24StandardUserAgent.ps1"), "utf8");
const noBlockComments = (t: string) => t.replace(/<#[\s\S]*?#>/g, "");
const setup = setupRaw;
const verify = readFileSync(join(dir, "Verify-D24StandardUserAgent.ps1"), "utf8");
const MUTATING = /\b(New-LocalUser|Set-LocalUser|Remove-LocalUser|Add-LocalGroupMember|Remove-LocalGroupMember|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|New-Item|Remove-Item|Set-Acl|Set-Content|Out-File|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|secedit|net\s+user|net\s+localgroup|icacls(\.exe)?|takeown|reg\s+add|sc\.exe|Restart-Computer|Stop-Computer)\b/i;

/** Removes every balanced { ... } block that follows `marker` (so the text left is "code that runs in phase 1/2"). */
function stripBlocks(text: string, marker: RegExp): string {
  let out = "";
  let i = 0;
  const re = new RegExp(marker.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = text.indexOf("{", m.index + m[0].length - 1);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    out += text.slice(i, m.index);
    i = j + 1;
    re.lastIndex = i;
  }
  return out + text.slice(i);
}
const codeLines = (t: string) => t.split(/\r?\n/).filter((l) => !/^\s*(#|\.)/.test(l));

describe("Setup-D24StandardUserAgent.ps1 (administrator, run once)", () => {
  it("module/binary hygiene comes FIRST: PSModulePath reduced to the inbox modules before any command resolves; fixed System32 binaries; inbox module imported by full path", () => {
    const body = setup.slice(setup.indexOf("[CmdletBinding()]"));
    const firstCode = codeLines(body).find((l) => /^\s*(\$|Set-|function)/.test(l) && !/^\s*(param|\[)/.test(l)) ?? "";
    expect(firstCode).toMatch(/\$env:PSModulePath = Join-Path \$PSHOME 'Modules'/);
    expect(setup).toMatch(/\$SystemDir = 'C:\\Windows\\System32'/);
    expect(setup).toMatch(/Import-Module -Name \$lam/);
    expect(setup).not.toMatch(/\$env:SystemRoot|%SystemRoot%|\$env:windir/i);
    expect(noBlockComments(setup)).not.toMatch(/Get-CimInstance|Get-WmiObject|Get-Acl\b/);
  });
  it("fails closed in three phases: all checks and the full plan BEFORE the first change; a failed check exits 2 with nothing changed; an aborted apply lists what was done", () => {
    const iCheck = setup.indexOf("PHASE 1: CHECK");
    const iPlan = setup.indexOf("PHASE 2: PLAN");
    const iApply = setup.indexOf("PHASE 3: APPLY");
    expect(iCheck).toBeGreaterThan(0);
    expect(iPlan).toBeGreaterThan(iCheck);
    expect(iApply).toBeGreaterThan(iPlan);
    const planPhase = setup.slice(iPlan, iApply);
    expect(planPhase).toMatch(/Nothing was changed\./);
    expect(planPhase).toMatch(/if \(\$script:Failures\.Count -gt 0\)[\s\S]*exit 2/);
    expect(planPhase).toMatch(/if \(-not \$Apply\)[\s\S]*exit 10/);
    const applyPhase = setup.slice(iApply);
    expect(applyPhase).toMatch(/catch \{[\s\S]*Completed \(\$\(\$done\.Count\) of[\s\S]*exit 2/);
    expect(applyPhase.match(/& \$a\.Action/g)).toHaveLength(1);
  });
  it("is a DRY RUN unless -Apply: Apply is a switch with no default and the only invocation of an action is in phase 3", () => {
    expect(setup).toMatch(/\[switch\]\$Apply/);
    expect(setup).not.toMatch(/\$Apply\s*=\s*\$true/);
  });
  it("EVERY state-changing command is inside an Add-Plan block (or the $aclApply helper block used only by Add-Plan blocks); nothing in phase 1/2 mutates", () => {
    const stripped = stripBlocks(stripBlocks(noBlockComments(setup), /Add-Plan\s+(?:"[^"\n]*"|'[^'\n]*')\s+\(\{/), /\$aclApply\s*=\s*\{/);
    const offenders = codeLines(stripped).filter((l) => MUTATING.test(l) && !/^\s*\$Icacls\s*=/.test(l) && !/^function Add-Plan/.test(l));
    expect(offenders).toEqual([]);
    expect((setup.match(/Add-Plan\s+(?:"[^"\n]*"|'[^'\n]*')\s+\(\{/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
  it("P0: NEVER recurses an ACL change: no icacls /T, no /L-less recursion, no setowner over a tree; a reparse point in the workspace is refused", () => {
    expect(setup).not.toMatch(/\/T\b/);
    expect(setup).not.toMatch(/-Recurse/);
    expect(setup).toMatch(/Test-Reparse \$wsFull/);
    expect(setup).toMatch(/\/setowner/);
    expect(setup).toMatch(/is not empty after creation/);
  });
  it("P1: registry values are read defensively (StrictMode-safe) and a missing FilterAdministratorToken does not crash", () => {
    expect(setup).toMatch(/function Get-RegValue[\s\S]*PSObject\.Properties\[\$Name\]/);
    expect(setup).not.toMatch(/\(Get-ItemProperty[^\n]*\)\.\$/);
  });
  it("P1: lockout guard: refuses the account running the script, RID 500, and any plan that leaves no enabled administrator; the owner must be an enabled administrator", () => {
    expect(setup).toMatch(/the account running this script: refusing/);
    expect(setup).toMatch(/EndsWith\('-500'\)/);
    expect(setup).toMatch(/would leave NO enabled administrator/);
    expect(setup).toMatch(/is not a member of Administrators/);
    expect(setup).toMatch(/must be three different accounts/);
  });
  it("UAC: standard users AUTOMATICALLY DENY elevation (ConsentPromptBehaviorUser = 0), secure desktop on, admin consent on the secure desktop, built-in Administrator filtered", () => {
    expect(setup).toMatch(/ConsentPromptBehaviorUser = 0/);
    expect(setup).not.toMatch(/ConsentPromptBehaviorUser = 1/);
    for (const re of [/EnableLUA = 1/, /PromptOnSecureDesktop = 1/, /ConsentPromptBehaviorAdmin = 2/, /FilterAdministratorToken = 1/]) expect(setup).toMatch(re);
  });
  it("requires elevation, -NoProfile, and an administrator-owned script FILE AND FOLDER; prints its own hash", () => {
    expect(setup).toMatch(/IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
    expect(setup).toMatch(/-NoProfile/);
    expect(setup).toMatch(/Split-Path -Parent \$self/);
    expect(setup).toMatch(/script sha256/);
  });
  it("never removes the owner's data, never prints or stores a password, never touches the network or Stripe", () => {
    expect(setup).not.toMatch(/Remove-Item|Set-Content|Out-File/i);
    expect(setup).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget|Start-BitsTransfer|api\.stripe|rk_|sk_/i);
    expect(setup).not.toMatch(/ConvertFrom-SecureString|Write-Host[^\n]*\$pw/);
    expect(setup).toMatch(/\$pw\.Length -lt 12/);
  });
});

describe("Verify-D24StandardUserAgent.ps1 (standard user, probes)", () => {
  it("fails closed, same module hygiene, fixed binaries, and exit 0 is REACHABLE (no always-SKIP row)", () => {
    expect(verify).toMatch(/\$env:PSModulePath = Join-Path \$PSHOME 'Modules'/);
    expect(verify).not.toMatch(/\$env:SystemRoot/);
    expect(verify).toMatch(/if \(\$fail -gt 0\) \{ exit 1 \}/);
    expect(verify).toMatch(/if \(\$skip -gt 0\)[\s\S]*exit 3/);
    expect(verify).toMatch(/\nexit 0\s*$/);
    expect(verify).not.toMatch(/Row 'inbox-no-modify' 'SKIP'/);
  });
  it("detects a deny-only Administrators SID from `whoami /groups` (IsInRole and Groups cannot), on ANY attribute", () => {
    expect(verify).toMatch(/whoami\.exe" \/groups \/fo csv \| ConvertFrom-Csv/);
    expect(verify).toMatch(/\$_\.SID -eq 'S-1-5-32-544'/);
    expect(verify).toMatch(/no-administrators-sid-even-deny-only/);
  });
  it("only access-denied is a PASS: other errors are FAIL, and a probe that landed is removed and FAILs", () => {
    expect(verify).toMatch(/catch \[UnauthorizedAccessException\] \{ return 'denied' \}/);
    expect(verify).toMatch(/return \('error:' \+ \$_\.Exception\.GetType\(\)\.Name\)/);
    expect(verify).toMatch(/default \{ Row \$Id 'FAIL' "unexpected result/);
    expect(verify).toMatch(/'created' \{ Row \$Id 'FAIL'/);
  });
  it("the CREATE probe itself: only access-denied returns denied; every other failure returns an error result", () => {
    const fn = /function Test-Create[\s\S]*?\n}\n/.exec(verify)?.[0] ?? "";
    expect(fn.match(/return 'denied'/g)).toHaveLength(1);
    expect(fn).toMatch(/catch \[UnauthorizedAccessException\] \{ return 'denied' \}\s*\n\s*catch \{ return \('error:'/);
  });
  it("UAC check requires ConsentPromptBehaviorUser = 0 and the other values", () => {
    expect(verify).toMatch(/\$cpu -eq 0/);
    expect(verify).not.toMatch(/\$cpu -eq 1/);
    for (const id of ["uac-enabled", "uac-standard-user-auto-deny", "uac-secure-desktop", "uac-admin-consent", "uac-builtin-admin-filtered"]) expect(verify, id).toContain(id);
  });
  it("covers every negative test the document lists, including folder creation, the toolchain, C:\\Dev and the owner's data", () => {
    for (const id of ["not-administrator-member", "integrity-not-high", "no-dangerous-privileges", "create-in-root", "mkdir-in-root", "write-pinned-files", "read-cred", "open-cred-file", "create-in-dev-root", "create-in-admin-clone", "read-owner-profile", "read-owner-repository", "no-d24-credential-in-this-profile", "no-sensitive-env"]) expect(verify, id).toContain(id);
    expect(verify).toMatch(/C:\\Program Files\\Git\\mingw64\\bin/);
    expect(verify).toMatch(/C:\\Program Files\\nodejs\\node_modules\\npm/);
  });
  it("states that it is self-attesting when the agent runs it", () => {
    expect(verify).toMatch(/SELF-ATTESTING/);
    expect(verify).toMatch(/ADVISORY/i);
    expect(verify).toMatch(/AUTHORITATIVE/);
  });
  it("only ever creates an empty uniquely named probe (removed if it landed); no other mutation, no network, no secret read", () => {
    const offenders = codeLines(noBlockComments(verify)).filter((l) => MUTATING.test(l) && !/Remove-Item -LiteralPath \$probe/.test(l));
    expect(offenders).toEqual([]);
    expect(verify).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|api\.stripe|rk_|sk_|ReadAllText|Get-Content/i);
  });
});
