// Test fixtures for the install-root work: a fake security-descriptor provider (it WALKS the real temp directory and reports SDDL per object, no OS call),
// an install() against a THROWAWAY temp root, and an envelope that satisfies the installed policy. Nothing here touches C:\ProgramData, Credential
// Manager, an account or the network.

import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeExec } from "../fakeChild";
import { install, type InstallInputs, type InstallProviders } from "../installer";
import { ADMIN_NODE, layout, roleOfPath, SID_ADMINS, type AclApplier, type AclRole, type Layout, type TreeEntry, type Who } from "../installroot";
import { anchorCode } from "../fingerprint";
import { REPO, SHA, tmp } from "./helpers";
import { testAuth } from "./softauth";

export const OWNER = "ownerperson";
export const OWNER_SID = "S-1-5-21-111-222-333-1000";
export const RUNAS_SID = "S-1-5-21-111-222-333-1001";
export const WHO: Who = { runAsSid: RUNAS_SID, ownerSid: OWNER_SID };
export const PLATFORM = "acct_UNITPLATFORM1";
export const CONNECTED = "acct_UNITCONNECTED1";

/** SDDL (Owner,Access form) of the CORRECT descriptor for a role. Tests override a path to simulate a violation. */
export function sddlFor(role: AclRole, who: Who = WHO, owner = "BA"): string {
  const admin = "(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)";
  const body: Record<AclRole, string> = {
    locked: `${admin}(A;OICI;0x1200a9;;;${who.runAsSid})(A;OICI;0x1200a9;;;${who.ownerSid})`,
    state: `${admin}(A;OICI;0x1301bf;;;${who.runAsSid})(A;OICI;0x1200a9;;;${who.ownerSid})`,
    evidence: `${admin}(A;OICI;0x1301bf;;;${who.runAsSid})(A;OICI;0x1200a9;;;${who.ownerSid})`,
    secret: `${admin}(A;OICI;0x1301bf;;;${who.runAsSid})`,
    inbox: `${admin}(A;OICI;0x1200a9;;;${who.runAsSid})(A;CI;0x12008f;;;${who.ownerSid})`,
  };
  return `O:${owner}G:SYD:PAI${body[role]}`;
}
export const withAce = (sddl: string, ace: string) => `${sddl}${ace}`;

export class FakeAcl implements AclApplier {
  readonly applied: Array<{ path: string; role: AclRole }> = [];
  readonly overrides = new Map<string, string>();
  readonly links = new Set<string>();
  readonly reads: Array<{ path: string; recurse: boolean }> = [];
  constructor(private readonly l: Layout, private readonly who: Who = WHO) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async apply(path: string, role: AclRole, _who?: Who): Promise<void> {
    this.applied.push({ path, role });
  }
  private entry(path: string): TreeEntry {
    const k = path.toLowerCase();
    const role = roleOfPath(this.l, path);
    const st = existsSync(path) ? lstatSync(path) : null;
    const isInboxFile = role === "inbox" && st?.isFile();
    const sddl = this.overrides.get(k) ?? sddlFor(role, this.who, isInboxFile ? this.who.ownerSid : "BA");
    return { path, kind: this.links.has(k) ? "link" : st?.isDirectory() ? "dir" : "file", sddl };
  }
  async readTree(path: string, recurse: boolean): Promise<TreeEntry[]> {
    this.reads.push({ path, recurse });
    if (!existsSync(path)) return [this.entry(path)];
    const out: TreeEntry[] = [this.entry(path)];
    if (recurse && lstatSync(path).isDirectory()) {
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          out.push(this.entry(p));
          if (lstatSync(p).isDirectory()) walk(p);
        }
      };
      walk(path);
    }
    return out;
  }
  override(path: string, sddl: string) {
    this.overrides.set(path.toLowerCase(), sddl);
  }
  link(path: string) {
    this.links.add(path.toLowerCase());
  }
}

export function writeAnchor(anchor: object = testAuth.anchor): string {
  const f = join(tmp(), "anchor-in.json");
  writeFileSync(f, JSON.stringify(anchor, null, 2));
  return f;
}

export function inputs(root: string, over: Partial<InstallInputs> = {}): InstallInputs {
  return { root, sourceRepo: REPO, commit: SHA, prNumber: 421, ownerGithubLogin: "genxowner", platformAcct: PLATFORM, connectedAcct: CONNECTED, anchorFile: writeAnchor(), ownerAccount: OWNER, runAsAccount: "d24run", ownerSid: OWNER_SID, runAsSid: RUNAS_SID, ...over };
}

export const defaultAnswer = (q: string): string => (/anchor fingerprint/.test(q) ? anchorCode(testAuth.anchor.fingerprintSha256) : /(([0-9A-F]{4}))/.exec(q)?.[1] ?? "");
export type Prov = InstallProviders & { lines: string[]; questions: string[]; installDepsCalls: string[]; acl: FakeAcl };
export function providers(l: Layout, over: Partial<InstallProviders> = {}, answer: (q: string) => string = (q) => (/anchor fingerprint/.test(q) ? anchorCode(testAuth.anchor.fingerprintSha256) : /\(([0-9A-F]{4})\)/.exec(q)?.[1] ?? "")): Prov {
  const lines: string[] = [];
  const questions: string[] = [];
  const installDepsCalls: string[] = [];
  const acl = new FakeAcl(l);
  return {
    isElevated: () => true,
    toolchainGates: async () => [{ id: "toolchain-fake", ok: true, detail: "fake: administrator-only toolchain" }],
    verifyRelease: async () => [{ id: "commit-on-main", ok: true, detail: "fake: ancestry and blobs verified" }],
    verifyPr: async () => ({ id: "pr-merge-commit", ok: true, detail: "fake: merged PR whose merge commit is the release" }),
    anchorSourceGate: async () => ({ id: "anchor-source", ok: true, detail: "fake: pinned in the verified tree" }),
    isAncestor: async () => true,
    acl,
    confirm: async (q) => {
      questions.push(q);
      return answer(q);
    },
    installDeps: async (d) => {
      installDepsCalls.push(d);
      mkdirSync(join(d, "node_modules", "tsx", "dist"), { recursive: true });
      writeFileSync(join(d, "node_modules", "tsx", "dist", "cli.mjs"), "// fake tsx\n");
    },
    now: () => new Date("2026-11-07T11:00:00Z"),
    out: (x) => void lines.push(x),
    ...over,
    lines,
    questions,
    installDepsCalls,
  } as Prov;
}

export async function installed(over: Partial<InstallInputs> = {}, provOver: Partial<InstallProviders> = {}) {
  const root = join(tmp("d24-root-"), "d24-runner");
  const l = layout(root);
  const p = providers(l, provOver);
  const r = await install(inputs(root, over), p);
  if (!r.ok) throw new Error(`fixture install failed: ${r.gates.filter((g) => !g.ok).map((g) => `${g.id}: ${g.detail}`).join(" | ")}`);
  return { root, l, p, r, acl: p.acl };
}

export function simulatedLive(l: Layout) {
  const calls: NonNullable<Parameters<typeof createFakeExec>[0]["calls"]> = [];
  return { exec: createFakeExec({ commitSha: SHA, repoDir: l.release, calls }, { simulateLive: true }), calls };
}

export { ADMIN_NODE, SID_ADMINS };
