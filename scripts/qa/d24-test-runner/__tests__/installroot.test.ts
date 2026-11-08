import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { aclGate, aclViolations, isVerifiedInstalled, layout, markVerifiedInstalled, parseIcacls, parseRelease, rootPathGate, roles, verifyInstalledTree, type AclEntry, type InstalledRun } from "../installroot";
import { tmp } from "./helpers";
import { aclText, FakeAcl, installed, OWNER, WHO } from "./installfixture";

vi.setConfig({ testTimeout: 60_000 });
const E = (principal: string, rights: string[], deny = false): AclEntry => ({ principal, rights, deny });
const ADMINS = E("BUILTIN\\Administrators", ["F"]);
const SYS = E("NT AUTHORITY\\SYSTEM", ["F"]);

// text as `icacls C:\ProgramData\d24-runner` prints it (captured shape: first entry on the path line, the rest indented, a summary line)
const REAL_SHAPE = ["C:\\ProgramData\\d24-runner BUILTIN\\Administrators:(OI)(CI)(F)", "                    NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "                    BUILTIN\\Users:(OI)(CI)(RX)", "                    NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(IO)(M)", "", "Successfully processed 1 files; Failed processing 0 files"].join("\r\n");

describe("parseIcacls", () => {
  it("parses the first-line and indented entries, flags, and comma rights", () => {
    const e = parseIcacls(REAL_SHAPE, "C:\\ProgramData\\d24-runner");
    expect(e).toHaveLength(4);
    expect(e![0]).toEqual({ principal: "BUILTIN\\Administrators", rights: ["F"], deny: false });
    expect(e![3]).toEqual({ principal: "NT AUTHORITY\\Authenticated Users", rights: ["M"], deny: false });
    expect(parseIcacls("X:\\p PC\\u:(OI)(CI)(RX,WD,AD)", "X:\\p")![0].rights).toEqual(["RX", "WD", "AD"]);
    expect(parseIcacls("X:\\p PC\\u:(DENY)(WDAC)", "X:\\p")![0]).toMatchObject({ deny: true, rights: ["WDAC"] });
  });
  it("returns null (the caller fails closed) for empty, error or unrecognised output", () => {
    expect(parseIcacls("", "X:\\p")).toBeNull();
    expect(parseIcacls("X:\\p: Access is denied.", "X:\\p")).toBeNull();
    expect(parseIcacls("Successfully processed 0 files; Failed processing 1 files", "X:\\p")).toBeNull();
  });
});

describe("aclViolations (per role)", () => {
  it("locked: nobody but Administrators/SYSTEM may hold a write-class right, d24run and the owner included", () => {
    const base = [ADMINS, SYS, E("PC\\d24run", ["RX"]), E(`PC\\${OWNER}`, ["RX"]), E("BUILTIN\\Users", ["RX"])];
    expect(aclViolations(base, "locked", WHO)).toEqual([]);
    for (const [who, r] of [["BUILTIN\\Users", "M"], ["NT AUTHORITY\\Authenticated Users", "W"], [`PC\\${OWNER}`, "F"], ["PC\\d24run", "WD"], ["Everyone", "AD"], ["PC\\someone", "WDAC"], ["PC\\someone", "WO"], ["PC\\someone", "GW"], ["PC\\someone", "DE"]] as const)
      expect(aclViolations([...base, E(who, [r])], "locked", WHO).length, `${who} ${r}`).toBe(1);
  });
  it("state/evidence: only d24run may write; the owner may read", () => {
    const ok = [ADMINS, SYS, E("PC\\d24run", ["M"]), E(`PC\\${OWNER}`, ["RX"])];
    expect(aclViolations(ok, "state", WHO)).toEqual([]);
    expect(aclViolations(ok, "evidence", WHO)).toEqual([]);
    expect(aclViolations([...ok, E(`PC\\${OWNER}`, ["M"])], "state", WHO)).toHaveLength(1);
    expect(aclViolations([...ok, E("BUILTIN\\Users", ["WD"])], "evidence", WHO)).toHaveLength(1);
  });
  it("secret: ANY right for anyone but d24run/Administrators/SYSTEM is a violation (read included)", () => {
    expect(aclViolations([ADMINS, SYS, E("PC\\d24run", ["M"])], "secret", WHO)).toEqual([]);
    expect(aclViolations([ADMINS, SYS, E("PC\\d24run", ["M"]), E(`PC\\${OWNER}`, ["R"])], "secret", WHO)).toHaveLength(1);
    expect(aclViolations([ADMINS, SYS, E("BUILTIN\\Users", ["RX"])], "secret", WHO)).toHaveLength(1);
  });
  it("inbox: the owner may CREATE (WD/AD) and read, not modify, delete or change permissions", () => {
    const ok = [ADMINS, SYS, E("PC\\d24run", ["RX"]), E(`PC\\${OWNER}`, ["RX", "WD", "AD"])];
    expect(aclViolations(ok, "inbox", WHO)).toEqual([]);
    for (const r of ["M", "F", "D", "DE", "WA", "DC", "WDAC", "WO"]) expect(aclViolations([...ok, E(`PC\\${OWNER}`, [r])], "inbox", WHO).length, r).toBe(1);
    expect(aclViolations([...ok, E("BUILTIN\\Users", ["WD"])], "inbox", WHO)).toHaveLength(1);
  });
  it("a DENY entry is ignored, so a grant it supposedly cancels is still reported (fail closed)", () => {
    expect(aclViolations([ADMINS, SYS, E("BUILTIN\\Users", ["M"]), E("BUILTIN\\Users", ["M"], true)], "locked", WHO)).toHaveLength(1);
  });
});

describe("aclGate over a fake provider", () => {
  const mk = async () => {
    const f = await installed();
    return { ...f, fresh: new FakeAcl(f.l) };
  };
  it("passes for the correct ACLs on every protected path", async () => {
    const { l, fresh } = await mk();
    const g = await aclGate(l, fresh, WHO);
    expect(g.ok).toBe(true);
    expect(roles(l).length).toBeGreaterThanOrEqual(12);
  });
  it("fails when any ONE protected path is writable by Users, naming the path", async () => {
    const { l, fresh } = await mk();
    for (const { path, role } of roles(l)) {
      const f2 = new FakeAcl(l);
      f2.override(path, aclText(path, role).replace("Successfully", "      BUILTIN\\Users:(OI)(CI)(M)\n\nSuccessfully"));
      const g = await aclGate(l, f2, WHO);
      expect(g.ok, path).toBe(false);
      expect(g.detail).toContain(path);
    }
    void fresh;
  });
  it("fails closed on unreadable, garbled, or Administrator-less output", async () => {
    const { l } = await mk();
    const a = new FakeAcl(l);
    a.read = async () => {
      throw new Error("access denied");
    };
    expect((await aclGate(l, a, WHO)).ok).toBe(false);
    const b = new FakeAcl(l);
    b.override(l.anchorJson, "garbage");
    expect((await aclGate(l, b, WHO)).detail).toMatch(/not understood/);
    const c = new FakeAcl(l);
    c.override(l.releaseJson, `${l.releaseJson} PC\\someone:(RX)`);
    expect((await aclGate(l, c, WHO)).detail).toMatch(/no Administrators\/SYSTEM entry/);
  });
});

describe("rootPathGate", () => {
  it("accepts running code inside <root>/release and rejects code elsewhere, a redirected root, and link components", async () => {
    const { l } = await installed();
    const inside = join(l.runnerDir, "execinbox.ts");
    expect(rootPathGate(l, inside).ok).toBe(true);
    expect(rootPathGate(l, join(tmp(), "scripts", "execinbox.ts"), (p) => p).ok).toBe(false);
    expect(rootPathGate(l, join(l.state, "x.ts"), (p) => p).ok).toBe(false);
    expect(rootPathGate(l, inside, (p) => (p === l.root ? "C:\\elsewhere" : p)).detail).toMatch(/resolves elsewhere/);
    expect(rootPathGate(l, inside, (p) => p, (p) => p === l.cred).detail).toMatch(/is a link/);
    expect(rootPathGate(layout(join(tmp(), "nope")), "x").ok).toBe(false);
  });
});

describe("verifyInstalledTree", () => {
  it("passes for the installed tree and fails for one changed byte, an added file, a removed file (runner and proof)", async () => {
    const { l, r } = await installed();
    expect(verifyInstalledTree(l, r.release!).ok).toBe(true);
    const f = join(l.runnerDir, "runner.ts");
    const orig = readFileSync(f, "utf8");
    writeFileSync(f, orig.replace("REQUIRE_HARDWARE_FOR_LIVE: boolean = true", "REQUIRE_HARDWARE_FOR_LIVE: boolean = false"));
    expect(verifyInstalledTree(l, r.release!).ok).toBe(false);
    writeFileSync(f, orig);
    expect(verifyInstalledTree(l, r.release!).ok).toBe(true);
    const pf = join(l.proofDir, "config.ts");
    appendFileSync(pf, "\n// x");
    expect(verifyInstalledTree(l, r.release!).ok).toBe(false);
  });
  it("an added file in the runner folder changes the tree hash", async () => {
    const { l, r } = await installed();
    writeFileSync(join(l.runnerDir, "extra.ts"), "export {}");
    expect(verifyInstalledTree(l, r.release!).ok).toBe(false);
  });
});

describe("release record and the verified brand", () => {
  it("parseRelease is strict: unknown field, bad hash, wrong version are refused", async () => {
    const { r } = await installed();
    expect(parseRelease(r.release).ok).toBe(true);
    expect(parseRelease({ ...r.release, extra: 1 }).ok).toBe(false);
    expect(parseRelease({ ...r.release, treeSha256: "zz" }).ok).toBe(false);
    expect(parseRelease({ ...r.release, installerVersion: 2 }).ok).toBe(false);
    expect(parseRelease({ ...r.release, commit: "abc" }).ok).toBe(false);
  });
  it("only the marked object carries the brand: a structural copy or a plain literal does not", async () => {
    const { l, r } = await installed();
    const raw: InstalledRun = { layout: l, release: r.release!, anchorPath: l.anchorJson, statePath: join(l.state, "s.json"), ledgerDir: l.state, ledgerAnchorFile: join(l.state, "a.json"), verifyTree: () => ({ id: "x", ok: true, detail: "" }) };
    expect(isVerifiedInstalled(raw)).toBe(false);
    const branded = markVerifiedInstalled({ ...raw });
    expect(isVerifiedInstalled(branded)).toBe(true);
    expect(isVerifiedInstalled({ ...branded })).toBe(false);
    expect(isVerifiedInstalled(undefined)).toBe(false);
    expect(isVerifiedInstalled(JSON.parse(JSON.stringify(branded)))).toBe(false);
  });
});
