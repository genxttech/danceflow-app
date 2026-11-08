// Test fixtures for the install-root work: a fake ACL provider (injected text, no OS call), an install() against a THROWAWAY temp root, and an
// envelope that satisfies the installed policy. Nothing here touches C:\ProgramData, Credential Manager, an account or the network.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeExec } from "../fakeChild";
import { install, type InstallInputs, type InstallProviders } from "../installer";
import { layout, roles, RUN_AS_ACCOUNT, type AclApplier, type AclRole, type Layout, type Who } from "../installroot";
import { REPO, SHA, tmp } from "./helpers";
import { testAuth } from "./softauth";

export const OWNER = "ownerperson";
export const WHO: Who = { runAs: RUN_AS_ACCOUNT, owner: OWNER };
export const PLATFORM = "acct_UNITPLATFORM1";
export const CONNECTED = "acct_UNITCONNECTED1";

/** icacls-shaped text for a role: the CORRECT ACL. Tests override a path to simulate a violation. */
export function aclText(path: string, role: AclRole, who: Who = WHO): string {
  const a = "BUILTIN\\Administrators:(OI)(CI)(F)";
  const s = "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)";
  const run = `PC\\${who.runAs}`;
  const own = `PC\\${who.owner}`;
  const lines: Record<AclRole, string[]> = {
    locked: [a, s, `${run}:(OI)(CI)(RX)`, `${own}:(OI)(CI)(RX)`],
    state: [a, s, `${run}:(OI)(CI)(M)`, `${own}:(OI)(CI)(RX)`],
    secret: [a, s, `${run}:(OI)(CI)(M)`],
    inbox: [a, s, `${run}:(OI)(CI)(RX)`, `${own}:(OI)(CI)(RX,WD,AD)`],
    evidence: [a, s, `${run}:(OI)(CI)(M)`, `${own}:(OI)(CI)(RX)`],
  };
  const [first, ...rest] = lines[role];
  return [`${path} ${first}`, ...rest.map((x) => `      ${x}`), "", "Successfully processed 1 files; Failed processing 0 files"].join("\n");
}

export class FakeAcl implements AclApplier {
  readonly applied: Array<{ path: string; role: AclRole }> = [];
  readonly overrides = new Map<string, string>();
  constructor(private readonly l: Layout, private readonly who: Who = WHO) {}
  async apply(path: string, role: AclRole): Promise<void> {
    this.applied.push({ path, role });
  }
  async read(path: string): Promise<string> {
    const o = this.overrides.get(path.toLowerCase());
    if (o !== undefined) return o;
    const r = roles(this.l).find((x) => x.path.toLowerCase() === path.toLowerCase());
    if (!r) throw new Error(`no role for ${path}`);
    return aclText(path, r.role, this.who);
  }
  override(path: string, text: string) {
    this.overrides.set(path.toLowerCase(), text);
  }
}

export function writeAnchor(anchor: object = testAuth.anchor): string {
  const f = join(tmp(), "anchor-in.json");
  writeFileSync(f, JSON.stringify(anchor, null, 2));
  return f;
}

export function inputs(root: string, over: Partial<InstallInputs> = {}): InstallInputs {
  return { root, sourceRepo: REPO, commit: SHA, prNumber: 421, platformAcct: PLATFORM, connectedAcct: CONNECTED, anchorFile: writeAnchor(), ownerAccount: OWNER, runAsAccount: RUN_AS_ACCOUNT, ...over };
}

export type Prov = InstallProviders & { lines: string[]; questions: string[]; installDepsCalls: string[]; acl: FakeAcl };
export function providers(l: Layout, over: Partial<InstallProviders> = {}, answer: (q: string) => string = (q) => /\(([0-9A-F]{4})\)/.exec(q)?.[1] ?? ""): Prov {
  const lines: string[] = [];
  const questions: string[] = [];
  const installDepsCalls: string[] = [];
  const acl = new FakeAcl(l);
  return {
    isElevated: () => true,
    verifyRelease: async () => [{ id: "commit-on-main", ok: true, detail: "fake: ancestry and blobs verified" }],
    acl,
    confirm: async (q) => {
      questions.push(q);
      return answer(q);
    },
    installDeps: async (d) => void installDepsCalls.push(d),
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

export { mkdirSync };
