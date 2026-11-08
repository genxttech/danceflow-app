// Thin entry point with the REAL providers for the installed-root flow. It hard-codes INSTALL_ROOT and is never exercised by the tests (they inject
// fake providers into installer.ts / launcher.ts / execinbox.ts). Nothing in it has been run on a real machine: see the Windows test plan in
// docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md (items marked unverified).
//
//   install  (elevated, from an ADMINISTRATOR-OWNED clone, run by C:\Program Files\nodejs\node.exe with a clean environment: see section 12.3)
//            --source <admin clone> --commit <sha> --pr <n> --github-login <owner login> --platform <acct_> --connected <acct_> --anchor <file>
//            --owner-account <name> [--run-as-account d24run] [--rotate-anchor]
//   launch   (owner)     lists the inbox, shows the fingerprint, requires the typed group, raises the tap (NOT IMPLEMENTED: needs the OWNER-AUTH ceremony)
//   exec <runId>         (scheduled task, as d24run) runs the gates and, if they pass, the run
//
// Creating the d24run account and the scheduled task are manual, documented administrator steps, not code here.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { icaclsExe, resolveGit, system32, GIT_FALLBACK_PATH } from "./bins";
import { baseEnv } from "./childenv";
import { DpapiFileStore, defaultPsRunner } from "./credstore";
import { execInboxMain } from "./execinbox";
import { realExec } from "./exec";
import { mainVerification, pristineGates } from "./gitverify";
import { install, type InstallProviders } from "./installer";
import { ADMIN_NODE, INSTALL_ROOT, layout, lockedTreeGate, readJson, RUN_AS_ACCOUNT, SID_ADMINS, SID_SYSTEM, type AclApplier, type AclRole, type TreeEntry, type Who } from "./installroot";
import { launch } from "./launcher";
import type { Policy } from "./policy";
import { toolchainGates, verifyMergedPr } from "./provenance";
import { defaultGet } from "./remotetip";

const ask = (q: string): Promise<string> =>
  new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(q, (a) => {
      rl.close();
      res(a);
    });
  });

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, cwd: system32(), stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stdout }));
  });
}

/** icacls grant arguments per role, all by SID. Inheritance is removed first; the OWNER is set to Administrators before anything else. */
export function grantsFor(role: AclRole, who: Who): string[] {
  const g = (sid: string, r: string, inh = "(OI)(CI)") => `*${sid}:${inh}(${r})`;
  const base = [g(SID_ADMINS, "F"), g(SID_SYSTEM, "F")];
  switch (role) {
    case "locked": return [...base, g(who.runAsSid, "RX"), g(who.ownerSid, "RX")];
    case "state":
    case "evidence": return [...base, g(who.runAsSid, "M"), g(who.ownerSid, "RX")];
    case "secret": return [...base, g(who.runAsSid, "M")];
    // create-only for the owner: container inherit only (no object inherit), add-file and add-subdirectory plus read
    case "inbox": return [...base, g(who.runAsSid, "RX"), g(who.ownerSid, "RX,WD,AD", "(CI)")];
  }
}
const SDDL_SCRIPT = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadLine(); $rec=[Console]::In.ReadLine(); $items=@(Get-Item -LiteralPath $p -Force); if ($rec -eq '1') { $items += @(Get-ChildItem -LiteralPath $p -Force -Recurse) }; foreach ($i in $items) { $k='file'; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $k='link' } elseif ($i.PSIsContainer) { $k='dir' }; $s=$i.GetAccessControl().GetSecurityDescriptorSddlForm('Owner,Access'); $k + [char]9 + $i.FullName + [char]9 + $s }`;
export const realAcl: AclApplier = {
  async readTree(path, recurse) {
    const r = await defaultPsRunner(SDDL_SCRIPT, `${path}\n${recurse ? "1" : "0"}\n`);
    if (r.code !== 0) throw new Error("security descriptors could not be read");
    return r.stdout.split(/\r?\n/).filter((x) => x.length > 0).map((line): TreeEntry => {
      const [kind, p, sddl] = line.split("\t");
      return { kind: kind as TreeEntry["kind"], path: p, sddl };
    });
  },
  async apply(path, role, who) {
    const own = await run(icaclsExe(), [path, "/setowner", `*${SID_ADMINS}`, "/T"]);
    if (own.code !== 0) throw new Error(`icacls /setowner failed for ${path}`);
    const r = await run(icaclsExe(), [path, "/inheritance:r", "/grant:r", ...grantsFor(role, who), "/T"]);
    if (r.code !== 0) throw new Error(`icacls apply failed for ${path}`);
  },
};

export const isElevated = (): boolean => {
  if (process.platform !== "win32") return false;
  const r = spawnSync(join(system32(), "fltmc.exe"), [], { windowsHide: true, cwd: system32(), stdio: "ignore" });
  return r.status === 0;
};
export function currentSid(): string {
  const r = spawnSync(join(system32(), "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, cwd: system32(), encoding: "utf8" });
  const m = /"(S-1-[\d-]+)"/.exec(r.stdout ?? "");
  return m ? m[1] : "";
}
async function sidOfAccount(name: string): Promise<string> {
  const r = await defaultPsRunner(`$ErrorActionPreference='Stop'; $n=[Console]::In.ReadLine(); ([Security.Principal.NTAccount]$n).Translate([Security.Principal.SecurityIdentifier]).Value`, `${name}\n`);
  const m = /(S-1-5-21(?:-\d+){4})/.exec(r.stdout);
  if (r.code !== 0 || !m) throw new Error(`could not resolve a local account SID for ${name}`);
  return m[1];
}

/** Environment for the elevated `npm ci`: nothing inherited from the owner's profile, empty administrator-owned npm configs, fixed registry. */
function scrubbedNpmEnv(stage: string): Record<string, string> {
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  return { SystemRoot: sys, PATH: `${dirname(ADMIN_NODE)};${join(sys, "System32")}`, TEMP: join(stage, ".npm-tmp"), TMP: join(stage, ".npm-tmp"), npm_config_userconfig: join(stage, ".npmrc-empty"), npm_config_globalconfig: join(stage, ".npmrc-empty"), npm_config_cache: join(stage, ".npm-cache"), npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
}

function realInstallProviders(sourceRepo: string, who: Who): InstallProviders {
  return {
    isElevated,
    acl: realAcl,
    confirm: ask,
    out: (l) => console.log(l),
    now: () => new Date(),
    toolchainGates: () => toolchainGates({ env: process.env, execArgv: process.execArgv, execPath: process.execPath, adminNode: ADMIN_NODE, runningFile: fileURLToPath(import.meta.url), sourceRepo, gitBin: resolveGit(undefined), adminGit: GIT_FALLBACK_PATH, reader: realAcl, who }),
    verifyPr: (o) => verifyMergedPr(defaultGet, o),
    async anchorSourceGate(file) {
      const inTree = file.toLowerCase().replace(/\\/g, "/").startsWith(`${sourceRepo.toLowerCase().replace(/\\/g, "/")}/`);
      // inside the (administrator-owned, SHA-1-verified, pinned) source clone: covered by the pins; elsewhere it must itself be administrator-only
      return inTree ? { id: "anchor-source", ok: true, detail: "the anchor file is inside the verified source clone and is pinned with the runner folder" } : lockedTreeGate("anchor-source", file, false, realAcl, who);
    },
    async verifyRelease({ repoDir, commit, pins }) {
      const env = baseEnv({ SystemRoot: process.env.SystemRoot, PATH: `${dirname(GIT_FALLBACK_PATH)}` }).env;
      const gitBin = GIT_FALLBACK_PATH;
      const pristine = await pristineGates({ repoDir, commitSha: commit, env, exec: realExec, gitBin });
      if (pristine.some((g) => !g.ok)) return pristine;
      const mv = await mainVerification({ repoDir, commitSha: commit, env, exec: realExec, gitBin, pins });
      return [...pristine, mv.ancestry, ...(mv.content ? [mv.content] : [])];
    },
    async installDeps(releaseDir) {
      const env = scrubbedNpmEnv(releaseDir);
      const npmCli = join(dirname(ADMIN_NODE), "node_modules", "npm", "bin", "npm-cli.js");
      const r = await realExec(ADMIN_NODE, [npmCli, "ci", "--ignore-scripts"], { cwd: releaseDir, env, timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error("npm ci failed in the staged release directory");
    },
  };
}

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function main(argv: string[], out: (s: string) => void): Promise<number> {
  const cmd = argv[0];
  if (process.platform !== "win32") return out("the installed-root flow is Windows only"), 2;
  const l = layout(INSTALL_ROOT);
  if (cmd === "install") {
    const a = { source: flag(argv, "--source"), commit: flag(argv, "--commit"), pr: Number(flag(argv, "--pr")), login: flag(argv, "--github-login"), platform: flag(argv, "--platform"), connected: flag(argv, "--connected"), anchor: flag(argv, "--anchor"), owner: flag(argv, "--owner-account"), runAs: flag(argv, "--run-as-account") ?? RUN_AS_ACCOUNT };
    if (!a.source || !a.commit || !a.pr || !a.login || !a.platform || !a.connected || !a.anchor || !a.owner) return out("usage: install --source <admin clone> --commit <sha> --pr <n> --github-login <login> --platform <acct_> --connected <acct_> --anchor <file> --owner-account <name> [--run-as-account d24run] [--rotate-anchor]"), 2;
    let ownerSid: string;
    let runAsSid: string;
    try {
      [ownerSid, runAsSid] = [await sidOfAccount(a.owner), await sidOfAccount(a.runAs)];
    } catch (e) {
      return out(String((e as Error).message)), 2;
    }
    const who: Who = { runAsSid, ownerSid };
    const r = await install({ root: INSTALL_ROOT, sourceRepo: a.source, commit: a.commit, prNumber: a.pr, ownerGithubLogin: a.login, platformAcct: a.platform, connectedAcct: a.connected, anchorFile: a.anchor, ownerAccount: a.owner, runAsAccount: a.runAs, ownerSid, runAsSid, rotateAnchor: argv.includes("--rotate-anchor") }, realInstallProviders(a.source, who));
    return r.ok ? 0 : 1;
  }
  if (cmd === "launch") {
    const pol = readJson(l.policyJson) as Policy;
    const r = await launch({
      inbox: l.inbox,
      expectedAnchorFingerprint: pol.anchorFingerprint,
      confirm: ask,
      tap: async () => {
        throw new Error("the WebAuthn ceremony is not implemented here (OWNER-AUTH section 7)");
      },
      out,
    });
    return r.ok ? 0 : 1;
  }
  if (cmd === "exec") {
    const runId = argv[1];
    if (!runId) return out("usage: exec <runId>"), 2;
    return execInboxMain(runId, { layout: l, runningFile: fileURLToPath(import.meta.url), acl: realAcl, currentSid, execPath: process.execPath, tmpdir, now: () => new Date(), out }, () => new DpapiFileStore(l.cred), process.env, realExec);
  }
  return out("usage: install | launch | exec <runId>"), 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main(process.argv.slice(2), console.log).then((c) => process.exit(c));
