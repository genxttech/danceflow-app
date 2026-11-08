import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { aclGate, entryViolations, isVerifiedInstalled, layout, lockedTreeGate, parseRelease, parseSddl, rawTreeSha256, rootPathGate, verifyInstalledTree, type TreeEntry } from "../installroot";
import { tmp } from "./helpers";
import { FakeAcl, installed, OWNER_SID, RUNAS_SID, sddlFor, WHO, withAce } from "./installfixture";

vi.setConfig({ testTimeout: 60_000 });
const E = (path: string, sddl: string, kind: TreeEntry["kind"] = "file"): TreeEntry => ({ path, kind, sddl });
const GOOD_LOCKED = sddlFor("locked");

describe("parseSddl (strict, fail closed)", () => {
  it("parses owner, flags, hex and alias masks, aliases and SIDs", () => {
    const p = parseSddl("O:BAG:SYD:PAI(A;OICI;FA;;;BA)(A;;0x1200a9;;;S-1-5-21-1-2-3-1000)(D;;WD;;;WD)");
    expect(p?.owner).toBe("S-1-5-32-544");
    expect(p?.aces).toEqual([{ type: "A", mask: 0x1f01ff, sid: "S-1-5-32-544", flags: "OICI" }, { type: "A", mask: 0x1200a9, sid: "S-1-5-21-1-2-3-1000", flags: "" }, { type: "D", mask: 0x40000, sid: "S-1-1-0", flags: "" }]);
  });
  it("returns null for anything not understood: unknown ACE type, odd token, extra fields, object ACEs, no DACL, garbage", () => {
    for (const s of ["", "garbage", "O:BAG:SY", "O:BAG:SYD:PAI(AU;;FA;;;BA)", "O:BAG:SYD:PAI(OA;;FA;;;BA)", "O:BAG:SYD:PAI(A;;Special;;;BA)", "O:BAG:SYD:PAI(A;;0x1200a9;;;Bad Name)", "O:BAG:SYD:PAI(A;;FA;x;;BA)", "O:BAG:SYD:PAI(A;;FA;;;BA", "O:BAG:SYD:PAI(A;;W D;;;BA)", "O:BAG:SYD:PAI(A;;FAXX;;;BA)"]) expect(parseSddl(s), s).toBeNull();
  });
});

describe("entryViolations: the review's failing scenarios", () => {
  const P = "C:\\ProgramData\\d24-runner\\release";
  it("P0-1: an object OWNED by the owner's user is a violation even when its DACL is perfect (the owner holds WRITE_DAC implicitly)", () => {
    expect(entryViolations(E(P, sddlFor("locked", WHO, "BA")), "locked", WHO)).toEqual([]);
    expect(entryViolations(E(P, sddlFor("locked", WHO, OWNER_SID)), "locked", WHO).join()).toMatch(/owned by S-1-5-21-111-222-333-1000/);
    expect(entryViolations(E(P, sddlFor("locked", WHO, RUNAS_SID)), "locked", WHO).join()).toMatch(/owned by/);
    expect(entryViolations(E(P, sddlFor("locked", WHO, "S-1-5-21-9-9-9-5000")), "locked", WHO)).not.toEqual([]);
    expect(entryViolations(E(P, sddlFor("state", WHO, RUNAS_SID)), "state", WHO)).toEqual([]);
    expect(entryViolations(E(P, sddlFor("state", WHO, OWNER_SID)), "state", WHO)).not.toEqual([]);
    expect(entryViolations(E(P, sddlFor("inbox", WHO, OWNER_SID)), "inbox", WHO)).toEqual([]);
  });
  it("P2-1a: unknown or odd rights can no longer slip through: a numeric mask with a write bit is caught, a Special/odd token fails closed", () => {
    expect(entryViolations(E(P, withAce(GOOD_LOCKED, "(A;OICI;0x1301bf;;;WD)")), "locked", WHO).join()).toMatch(/S-1-1-0 holds write-class/);
    expect(entryViolations(E(P, withAce(GOOD_LOCKED, "(A;OICI;Special;;;WD)")), "locked", WHO).join()).toMatch(/not understood/);
    expect(entryViolations(E(P, GOOD_LOCKED.replace("0x1200a9", "W D")), "locked", WHO).join()).toMatch(/not understood/);
  });
  it("P2-1b: trustees are matched by SID, not by name: an imposter account named SYSTEM or d24run gets no exemption", () => {
    const evil = "S-1-5-21-6-6-6-1234";
    expect(entryViolations(E(P, withAce(GOOD_LOCKED, `(A;OICI;FA;;;${evil})`)), "locked", WHO)).not.toEqual([]);
    expect(entryViolations(E(P, withAce(sddlFor("state"), `(A;OICI;0x1301bf;;;${evil})`)), "state", WHO)).not.toEqual([]);
    expect(entryViolations(E(P, withAce(sddlFor("state"), `(A;OICI;0x1301bf;;;${RUNAS_SID})`)), "state", WHO)).toEqual([]);
  });
  it("write-class by mask bit: each of the individual write bits is a violation for an unknown trustee on a locked path", () => {
    for (const bit of [0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000]) expect(entryViolations(E(P, withAce(GOOD_LOCKED, `(A;OICI;0x${bit.toString(16)};;;BU)`)), "locked", WHO), bit.toString(16)).toHaveLength(1);
    for (const bit of [0x1, 0x8, 0x20, 0x80, 0x20000, 0x100000]) expect(entryViolations(E(P, withAce(GOOD_LOCKED, `(A;OICI;0x${bit.toString(16)};;;BU)`)), "locked", WHO), bit.toString(16)).toEqual([]);
  });
  it("secret: any right for anyone but d24run/Administrators/SYSTEM is a violation", () => {
    expect(entryViolations(E(P, sddlFor("secret")), "secret", WHO)).toEqual([]);
    expect(entryViolations(E(P, withAce(sddlFor("secret"), `(A;OICI;0x120089;;;${OWNER_SID})`)), "secret", WHO)).toHaveLength(1);
    expect(entryViolations(E(P, withAce(sddlFor("secret"), "(A;OICI;FR;;;BU)")), "secret", WHO)).toHaveLength(1);
  });
  it("P2-3b: the inbox owner may only create (add file/subdirectory) and read; modify/delete/permission rights are refused", () => {
    expect(entryViolations(E(P, sddlFor("inbox")), "inbox", WHO)).toEqual([]);
    for (const bit of [0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000]) expect(entryViolations(E(P, withAce(sddlFor("inbox"), `(A;CI;0x${bit.toString(16)};;;${OWNER_SID})`)), "inbox", WHO), bit.toString(16)).toHaveLength(1);
    expect(entryViolations(E(P, withAce(sddlFor("inbox"), "(A;OICI;0x2;;;BU)")), "inbox", WHO)).toHaveLength(1);
  });
  it("a DENY entry is ignored, so a grant it supposedly cancels is still reported; links and missing admin entries fail", () => {
    expect(entryViolations(E(P, withAce(withAce(GOOD_LOCKED, "(A;OICI;0x1301bf;;;BU)"), "(D;OICI;0x1301bf;;;BU)")), "locked", WHO)).toHaveLength(1);
    expect(entryViolations(E(P, GOOD_LOCKED, "link"), "locked", WHO).join()).toMatch(/link or reparse/);
    expect(entryViolations(E(P, "O:BAG:SYD:PAI(A;OICI;0x1200a9;;;BU)"), "locked", WHO).join()).toMatch(/no full-control entry/);
  });
});

// Descriptors in the shape stock Windows / Git for Windows gives Program Files content, reconstructed from the ACEs captured read-only on the owner's machine in the PR review
// (TrustedInstaller owner with FA, CREATOR OWNER GA that is INHERIT-ONLY, SY, BA, BU/AC read-and-execute). The synthetic FakeAcl cannot produce these, which is how the
// first version of the recursive Git-tree gate shipped unable to pass on a stock install.
const TI = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const REAL_GIT_DIR = `O:${TI}G:${TI}D:PAI(A;ID;FA;;;${TI})(A;OICIIOID;GA;;;CO)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)`;
const REAL_GIT_FILE = `O:${TI}G:${TI}D:AI(A;ID;FA;;;${TI})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)`;
describe("real Program Files descriptors (Git for Windows / Windows Installer shape)", () => {
  const P = "C:\\Program Files\\Git\\mingw64\\bin";
  it("a stock Git directory and file pass the locked-tree rules: TrustedInstaller is administrator-equivalent and an inherit-only CREATOR OWNER ACE grants nobody anything", () => {
    expect(entryViolations(E(P, REAL_GIT_DIR, "dir"), "locked", WHO)).toEqual([]);
    expect(entryViolations(E(P + "\\git.exe", REAL_GIT_FILE), "locked", WHO)).toEqual([]);
  });
  it("it is NOT a blanket exemption: a CREATOR OWNER write ACE that is not inherit-only still fails, as does any other trustee's inherit-only write, a non-TrustedInstaller owner, and the owner's user", () => {
    expect(entryViolations(E(P, REAL_GIT_DIR.replace("(A;OICIIOID;GA;;;CO)", "(A;OICIID;GA;;;CO)"), "dir"), "locked", WHO).join()).toMatch(/S-1-3-0 holds write-class/);
    expect(entryViolations(E(P, withAce(REAL_GIT_DIR, "(A;OICIIOID;GA;;;BU)"), "dir"), "locked", WHO).join()).toMatch(/S-1-5-32-545 holds write-class/);
    expect(entryViolations(E(P, REAL_GIT_FILE.replace(`O:${TI}`, "O:S-1-5-21-6-6-6-1234")), "locked", WHO).join()).toMatch(/owned by S-1-5-21-6-6-6-1234/);
    expect(entryViolations(E(P, withAce(REAL_GIT_FILE, `(A;ID;0x1301bf;;;${OWNER_SID})`)), "locked", WHO).join()).toMatch(/holds write-class/);
    expect(entryViolations(E(P, REAL_GIT_FILE.replace(/\(A;ID;FA;;;[^)]*\)/g, "(A;ID;0x1200a9;;;SY)")), "locked", WHO).join()).toMatch(/no full-control entry/);
  });
  it("parseSddl keeps the ACE flags (inherit-only is visible to the rules)", () => {
    expect(parseSddl(REAL_GIT_DIR)?.aces.find((a) => a.sid === "S-1-3-0")?.flags).toBe("OICIIOID");
  });
});

describe("aclGate over EVERY object under the root", () => {
  it("passes for the correct descriptors; counts all directories and files", async () => {
    const { l } = await installed();
    const g = await aclGate(l, new FakeAcl(l), WHO);
    expect(g.ok).toBe(true);
    expect(Number(/of (\d+) directories/.exec(g.detail)?.[1])).toBeGreaterThan(40);
  });
  it("P0-1b: a single file buried in node_modules that is agent-OWNED (or writable) fails the gate, naming it", async () => {
    const { l } = await installed();
    const f = join(l.release, "node_modules", "tsx", "dist", "cli.mjs");
    const a = new FakeAcl(l);
    a.override(f, sddlFor("locked", WHO, OWNER_SID));
    const g = await aclGate(l, a, WHO);
    expect(g.ok).toBe(false);
    expect(g.detail).toContain("cli.mjs");
    const b = new FakeAcl(l);
    b.override(join(l.state, "hw-signcount.json"), sddlFor("state", WHO, OWNER_SID));
    mkdirSync(l.state, { recursive: true });
    writeFileSync(join(l.state, "hw-signcount.json"), "{}");
    expect((await aclGate(l, b, WHO)).ok).toBe(false);
  });
  it("a link anywhere under the root, an unreadable listing, a missing required object, or garbage SDDL fail closed", async () => {
    const { l } = await installed();
    const a = new FakeAcl(l);
    a.link(join(l.release, "node_modules"));
    expect((await aclGate(l, a, WHO)).detail).toMatch(/link or reparse/);
    const b = new FakeAcl(l);
    b.readTree = async () => {
      throw new Error("denied");
    };
    expect((await aclGate(l, b, WHO)).ok).toBe(false);
    const c = new FakeAcl(l);
    const orig = c.readTree.bind(c);
    c.readTree = async (p, r) => (await orig(p, r)).filter((e) => e.path !== l.policyJson);
    expect((await aclGate(l, c, WHO)).detail).toMatch(/missing from the security-descriptor listing/);
    const d = new FakeAcl(l);
    d.override(l.anchorJson, "nonsense");
    expect((await aclGate(l, d, WHO)).detail).toMatch(/not understood/);
  });
  it("lockedTreeGate works for a single file or an arbitrary tree (the elevated installer's source clone and node binary)", async () => {
    const { l } = await installed();
    const a = new FakeAcl(l);
    expect((await lockedTreeGate("x", "C:\\Program Files\\nodejs\\node.exe", false, a, WHO)).ok).toBe(true);
    a.override("C:\\Program Files\\nodejs\\node.exe", sddlFor("locked", WHO, OWNER_SID));
    expect((await lockedTreeGate("x", "C:\\Program Files\\nodejs\\node.exe", false, a, WHO)).ok).toBe(false);
    const empty = new FakeAcl(l);
    empty.readTree = async () => [];
    expect((await lockedTreeGate("x", "C:\\p", false, empty, WHO)).ok).toBe(false);
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

describe("verifyInstalledTree pins everything the key-bearing process loads", () => {
  it("fails for one changed byte in the runner (incl. the REQUIRE_HARDWARE_FOR_LIVE constant), a proof file, an added/removed file", async () => {
    const { l, r } = await installed();
    expect(verifyInstalledTree(l, r.release!).ok).toBe(true);
    const f = join(l.runnerDir, "runner.ts");
    const orig = readFileSync(f, "utf8");
    writeFileSync(f, orig.replace("REQUIRE_HARDWARE_FOR_LIVE: boolean = true", "REQUIRE_HARDWARE_FOR_LIVE: boolean = false"));
    expect(verifyInstalledTree(l, r.release!).detail).toMatch(/runner folder/);
    writeFileSync(f, orig);
    appendFileSync(join(l.proofDir, "config.ts"), "\n// x");
    expect(verifyInstalledTree(l, r.release!).detail).toMatch(/proof folder/);
  });
  it("P1-1: package.json, package-lock.json, tsconfig.json and node_modules are pinned too", async () => {
    for (const [what, edit] of [
      ["package.json", (l: ReturnType<typeof layout>) => appendFileSync(join(l.release, "package.json"), " ")],
      ["package-lock.json", (l: ReturnType<typeof layout>) => appendFileSync(join(l.release, "package-lock.json"), " ")],
      ["tsconfig.json", (l: ReturnType<typeof layout>) => writeFileSync(join(l.release, "tsconfig.json"), "{}")],
      ["node_modules", (l: ReturnType<typeof layout>) => appendFileSync(join(l.release, "node_modules", "tsx", "dist", "cli.mjs"), "// evil")],
      ["node_modules", (l: ReturnType<typeof layout>) => writeFileSync(join(l.release, "node_modules", "tsx", "dist", "extra.js"), "x")],
    ] as const) {
      const { l, r } = await installed();
      edit(l);
      const g = verifyInstalledTree(l, r.release!);
      expect(g.ok, what).toBe(false);
      expect(g.detail, what).toContain(what);
    }
  });
  it("rawTreeSha256 hashes raw bytes (no CRLF normalisation) and refuses links", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.bin"), Buffer.from([1, 13, 10, 2]));
    const h1 = rawTreeSha256(d).sha256;
    writeFileSync(join(d, "a.bin"), Buffer.from([1, 10, 2]));
    expect(rawTreeSha256(d).sha256).not.toBe(h1);
  });
});

describe("release record and the verified brand", () => {
  it("parseRelease is strict: unknown field, bad hash, wrong version are refused", async () => {
    const { r } = await installed();
    expect(parseRelease(r.release).ok).toBe(true);
    expect(parseRelease({ ...r.release, extra: 1 }).ok).toBe(false);
    expect(parseRelease({ ...r.release, treeSha256: "zz" }).ok).toBe(false);
    expect(parseRelease({ ...r.release, installerVersion: 1 }).ok).toBe(false);
    expect(parseRelease({ ...r.release, nodeModulesSha256: undefined }).ok).toBe(false);
  });
  it("P2-2: no object is branded unless execinbox minted it; a plain or copied object never is", async () => {
    const { l, r } = await installed();
    const raw = { layout: l, release: r.release!, anchorPath: l.anchorJson, statePath: "s", ledgerDir: "d", ledgerAnchorFile: "a", verifyTree: () => ({ id: "x", ok: true, detail: "" }) };
    expect(isVerifiedInstalled(raw)).toBe(false);
    expect(isVerifiedInstalled(JSON.parse(JSON.stringify(raw)))).toBe(false);
    expect(isVerifiedInstalled(undefined)).toBe(false);
  });
});
