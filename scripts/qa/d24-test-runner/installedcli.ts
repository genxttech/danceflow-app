// Thin entry point with the REAL providers for the installed-root flow. It hard-codes INSTALL_ROOT and is never exercised by the tests (they inject
// fake providers into installer.ts / launcher.ts / execinbox.ts). Nothing in it has been run on a real machine: see the Windows test plan in
// docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md (items marked unverified).
//
//   install  (elevated)  --source <clean clone> --commit <sha> --pr <n> --platform <acct_> --connected <acct_> --anchor <file> --owner <account> [--rotate-anchor]
//   launch   (owner)     lists the inbox, shows the fingerprint, requires the typed group, raises the tap (NOT IMPLEMENTED: needs the OWNER-AUTH ceremony)
//   exec <runId>         (scheduled task, as d24run) runs the gates and, if they pass, the run
//
// Creating the d24run account and the scheduled task are manual, documented owner/admin steps (Windows test plan), not code here.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { icaclsExe, resolveGit, system32 } from "./bins";
import { baseEnv } from "./childenv";
import { DpapiFileStore } from "./credstore";
import { execInboxMain } from "./execinbox";
import { realExec } from "./exec";
import { install, type InstallProviders } from "./installer";
import { INSTALL_ROOT, layout, readJson, RUN_AS_ACCOUNT, type AclApplier, type AclRole, type Who } from "./installroot";
import { launch } from "./launcher";
import { mainVerification, pristineGates } from "./gitverify";
import { createInterface } from "node:readline";
import { type Policy } from "./policy";

const ask = (q: string): Promise<string> => new Promise((res) => { const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true }); rl.question(q, (a) => { rl.close(); res(a); }); });
const ADMINS = "*S-1-5-32-544";
const SYSTEM = "*S-1-5-18";

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, cwd: system32(), stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stdout }));
  });
}

/** icacls grant arguments per role (Administrators and SYSTEM by SID so a localised Windows still matches). */
export function grantsFor(role: AclRole, who: Who): string[] {
  const g = (p: string, r: string) => `${p}:(OI)(CI)(${r})`;
  const base = [g(ADMINS, "F"), g(SYSTEM, "F")];
  switch (role) {
    case "locked": return [...base, g(who.runAs, "RX"), g(who.owner, "RX")];
    case "state":
    case "evidence": return [...base, g(who.runAs, "M"), g(who.owner, "RX")];
    case "secret": return [...base, g(who.runAs, "M")];
    case "inbox": return [...base, g(who.runAs, "RX"), g(who.owner, "RX,WD,AD")];
  }
}
export const realAcl: AclApplier = {
  async read(path) {
    const r = await run(icaclsExe(), [path]);
    if (r.code !== 0) throw new Error("icacls failed");
    return r.stdout;
  },
  async apply(path, role, who) {
    const r = await run(icaclsExe(), [path, "/inheritance:r", "/grant:r", ...grantsFor(role, who), "/T"]);
    if (r.code !== 0) throw new Error(`icacls apply failed for ${path}`);
  },
};

export const isElevated = (): boolean => {
  if (process.platform !== "win32") return false;
  const r = spawnSync(join(system32(), "fltmc.exe"), [], { windowsHide: true, cwd: system32(), stdio: "ignore" });
  return r.status === 0;
};

function realInstallProviders(): InstallProviders {
  return {
    isElevated,
    acl: realAcl,
    confirm: ask,
    out: (l) => console.log(l),
    now: () => new Date(),
    async verifyRelease({ repoDir, commit, pins }) {
      const env = baseEnv(process.env).env;
      const gitBin = resolveGit(process.env.PATH) ?? undefined;
      const pristine = await pristineGates({ repoDir, commitSha: commit, env, exec: realExec, gitBin });
      if (pristine.some((g) => !g.ok)) return pristine;
      const mv = await mainVerification({ repoDir, commitSha: commit, env, exec: realExec, gitBin, pins });
      return [...pristine, mv.ancestry, ...(mv.content ? [mv.content] : [])];
    },
    async installDeps(releaseDir) {
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      const r = await realExec(process.execPath, [npmCli, "ci", "--ignore-scripts"], { cwd: releaseDir, env: baseEnv(process.env).env, timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error("npm ci failed in the release directory");
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
    const a = { source: flag(argv, "--source"), commit: flag(argv, "--commit"), pr: Number(flag(argv, "--pr")), platform: flag(argv, "--platform"), connected: flag(argv, "--connected"), anchor: flag(argv, "--anchor"), owner: flag(argv, "--owner") };
    if (!a.source || !a.commit || !a.pr || !a.platform || !a.connected || !a.anchor || !a.owner) return out("usage: install --source <clone> --commit <sha> --pr <n> --platform <acct_> --connected <acct_> --anchor <file> --owner <account> [--rotate-anchor]"), 2;
    const r = await install({ root: INSTALL_ROOT, sourceRepo: a.source, commit: a.commit, prNumber: a.pr, platformAcct: a.platform, connectedAcct: a.connected, anchorFile: a.anchor, ownerAccount: a.owner, runAsAccount: RUN_AS_ACCOUNT, rotateAnchor: argv.includes("--rotate-anchor") }, realInstallProviders());
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
    return execInboxMain(runId, { layout: l, runningFile: fileURLToPath(import.meta.url), acl: realAcl, whoami: () => userInfo().username, now: () => new Date(), out }, () => new DpapiFileStore(l.cred), process.env, realExec);
  }
  return out("usage: install | launch | exec <runId>"), 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main(process.argv.slice(2), console.log).then((c) => process.exit(c));
