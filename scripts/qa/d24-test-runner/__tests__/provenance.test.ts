import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_NODE } from "../installroot";
import { toolchainGates, verifyMergedPr } from "../provenance";
import type { HttpGet } from "../remotetip";
import { readFileNoFollow, isRealDir } from "../safefs";
import { tmp } from "./helpers";
import { FakeAcl, installed, sddlFor, WHO, OWNER_SID } from "./installfixture";

vi.setConfig({ testTimeout: 60_000 });
const COMMIT = "a".repeat(40);
const pr = (over: Record<string, unknown> = {}) => ({ number: 421, merged: true, merge_commit_sha: COMMIT, base: { ref: "main", repo: { full_name: "genxttech/danceflow-app" } }, merged_by: { login: "GenxOwner" }, ...over });
const getOf = (body: unknown, status = 200, contentType = "application/json; charset=utf-8"): HttpGet => async () => ({ status, contentType, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const O = { prNumber: 421, commit: COMMIT, ownerLogin: "genxowner" };

describe("verifyMergedPr (P2-4): the release is THE merge commit of a merged PR into main, merged by the owner", () => {
  it("accepts the real shape", async () => expect((await verifyMergedPr(getOf(pr()), O)).ok).toBe(true));
  it("refuses: not merged, another commit on main (older/newer), wrong base, wrong repo, merged by someone else, wrong number, errors", async () => {
    for (const [name, g] of [
      ["not merged", getOf(pr({ merged: false }))],
      ["an older commit that is merely on main", getOf(pr({ merge_commit_sha: "b".repeat(40) }))],
      ["base is not main", getOf(pr({ base: { ref: "dev", repo: { full_name: "genxttech/danceflow-app" } } }))],
      ["another repository", getOf(pr({ base: { ref: "main", repo: { full_name: "evil/fork" } } }))],
      ["merged by another login", getOf(pr({ merged_by: { login: "someone" } }))],
      ["another PR number", getOf(pr({ number: 7 }))],
      ["404", getOf("{}", 404)],
      ["not json", getOf("<html>", 200, "text/html")],
      ["garbage json", getOf("{nope")],
    ] as const) expect((await verifyMergedPr(g, O)).ok, name).toBe(false);
    expect((await verifyMergedPr(async () => { throw new Error("net"); }, O)).ok).toBe(false);
    expect((await verifyMergedPr(getOf(pr()), { ...O, ownerLogin: "" })).ok).toBe(false);
  });
});

describe("toolchainGates (P0-2): the elevated installer runs administrator-only code with a clean environment", () => {
  const base = async () => {
    const { l } = await installed();
    return { env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", TSX_DISABLE_CACHE: "1" } as Record<string, string | undefined>, execArgv: [] as string[], execPath: ADMIN_NODE, adminNode: ADMIN_NODE, runningFile: "C:\\ProgramData\\d24-src\\scripts\\qa\\d24-test-runner\\installedcli.ts", sourceRepo: "C:\\ProgramData\\d24-src", gitBin: "C:\\Program Files\\Git\\cmd\\git.exe" as string | null, adminGit: "C:\\Program Files\\Git\\cmd\\git.exe", realGitDir: "C:\\Program Files\\Git\\mingw64\\bin", gitCoreDir: "C:\\Program Files\\Git\\mingw64\\libexec\\git-core", npmDir: "C:\\Program Files\\nodejs\\node_modules\\npm", reader: new FakeAcl(l), who: WHO };
  };
  it("passes in the clean, administrator-only configuration", async () => {
    const gates = await toolchainGates(await base());
    expect(gates.filter((g) => !g.ok)).toEqual([]);
    expect(gates.map((g) => g.id)).toEqual(["elevated-env", "elevated-node", "elevated-node-acl", "elevated-code-location", "elevated-source-acl", "elevated-git", "elevated-git-acl", "elevated-real-git-acl", "elevated-git-core-acl", "elevated-npm-acl", "elevated-tsx-cache"]);
  });
  it("each way the elevated process could run agent-controlled code or configuration is a failure", async () => {
    const b = await base();
    const bad = async (over: object, id: string) => expect((await toolchainGates({ ...b, ...over })).find((g) => !g.ok)?.id, id).toBe(id);
    await bad({ env: { ...b.env, NODE_OPTIONS: "--require C:\\Users\\x\\evil.js" } }, "elevated-env");
    await bad({ env: { ...b.env, npm_config_registry: "http://evil" } }, "elevated-env");
    await bad({ env: { ...b.env, GIT_DIR: "C:\\x" } }, "elevated-env");
    await bad({ env: { ...b.env, TSX_TSCONFIG_PATH: "C:\\x" } }, "elevated-env");
    await bad({ env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" } }, "elevated-tsx-cache");
    const rg = new FakeAcl((await installed()).l);
    rg.override("C:\\Program Files\\Git\\mingw64\\bin", sddlFor("locked", WHO, OWNER_SID));
    await bad({ reader: rg }, "elevated-real-git-acl");
    const gc = new FakeAcl((await installed()).l);
    gc.override("C:\\Program Files\\Git\\mingw64\\libexec\\git-core", sddlFor("locked", WHO, OWNER_SID));
    await bad({ reader: gc }, "elevated-git-core-acl");
    const nn = new FakeAcl((await installed()).l);
    nn.override("C:\\Program Files\\nodejs\\node_modules\\npm", sddlFor("locked", WHO, OWNER_SID));
    await bad({ reader: nn }, "elevated-npm-acl");
    await bad({ execArgv: ["--use-env-proxy"] }, "elevated-env");
    await bad({ execPath: "C:\\Users\\mcurt\\AppData\\node.exe" }, "elevated-node");
    await bad({ runningFile: "C:\\Users\\mcurt\\Dev\\installedcli.ts" }, "elevated-code-location");
    await bad({ gitBin: null }, "elevated-git");
    await bad({ gitBin: "C:\\Users\\mcurt\\git.exe" }, "elevated-git");
    const a = new FakeAcl((await installed()).l);
    a.override("C:\\ProgramData\\d24-src", sddlFor("locked", WHO, OWNER_SID)); // the clone is owned by the owner's user
    await bad({ reader: a }, "elevated-source-acl");
    const n = new FakeAcl((await installed()).l);
    n.override(ADMIN_NODE, sddlFor("locked", WHO, OWNER_SID));
    await bad({ reader: n }, "elevated-node-acl");
  });
});

describe("safefs (P2-3a)", () => {
  it("reads a regular file from the handle, refuses oversize, directories and missing files", () => {
    const d = tmp();
    writeFileSync(join(d, "a.json"), "{\"a\":1}");
    expect(readFileNoFollow(join(d, "a.json"), 100)?.toString()).toBe("{\"a\":1}");
    expect(readFileNoFollow(join(d, "a.json"), 3)).toBeNull();
    expect(readFileNoFollow(d, 100)).toBeNull();
    expect(readFileNoFollow(join(d, "missing"), 100)).toBeNull();
  });
  it("isRealDir is true only for a real directory", () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "f"), "x");
    expect(isRealDir(join(d, "sub"))).toBe(true);
    expect(isRealDir(join(d, "f"))).toBe(false);
    expect(isRealDir(join(d, "nope"))).toBe(false);
  });
});
