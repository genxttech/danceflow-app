import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateEnvelope } from "../envelope";
import { createFakeExec } from "../fakeChild";
import { Ledger } from "../ledger";
import { ownerKeygen, type Pristine, type Prompter } from "../ownercli";
import { checkEncryptedKey, rotateTrust, signEnvelopeHash, type EncryptedKey } from "../ownersig";
import { loadTrust, privateKeyPath, trustPath } from "../ownerverify";
import { makeEnvelope, OWNER_PASS, REPO, SHA, tmp } from "./helpers";

vi.setConfig({ testTimeout: 120_000 }); // scrypt N=2^17 key generation is deliberately slow

const NEW_PASS = "a brand new passphrase 987";
const prompter = (hidden: string[], counter?: { n: number }): Prompter => {
  const h = [...hidden];
  return { isTty: true, line: async () => "", hidden: async () => ((counter ? (counter.n += 1) : 0), h.shift() ?? "") };
};
const pristine = (): Pristine => ({ repoDir: REPO, commitSha: SHA, exec: createFakeExec({ commitSha: SHA, repoDir: REPO }), env: {} });
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const setup = async () => {
  const dir = tmp();
  expect(await ownerKeygen(sink().io, prompter([OWNER_PASS, OWNER_PASS]), pristine(), dir)).toBe(0);
  return dir;
};
const next = { ownerToolsSha256: "1".repeat(64), registeredAtCommit: SHA, registeredBy: "owner-account" };
const leftovers = (dir: string) => readdirSync(dir).filter((f) => /\.(new|bak)$/.test(f));
const readOnly = (p: string) => (statSync(p).mode & 0o222) === 0;

describe("P2-1 a failed rotation never loses the old encrypted key", () => {
  it("restore failure after the new key was renamed in: .bak and .new are KEPT, the error names them and the recovery step, and the old key still decrypts", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    const kf = privateKeyPath(dir);
    const oldKeyFile = readFileSync(kf, "utf8");
    // the swap fails after the key file was replaced, and every restore copy fails too
    const failRestore = (from: string, to: string) => {
      if (from.endsWith(".bak") && !to.endsWith(".bak")) throw new Error("disk error while restoring");
      copyFileSync(from, to);
    };
    let message = "";
    try {
      rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: NEW_PASS }, "2026-11-08T00:00:00Z", { failSecondRename: true, ops: { copyFile: failRestore } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/could not be restored for .*owner-key.enc.json/);
    expect(message).toContain("owner-key.enc.json.bak");
    expect(message).toContain("owner-trust.json.bak");
    expect(message).toMatch(/Manual recovery/);
    expect(leftovers(dir)).toEqual(expect.arrayContaining(["owner-key.enc.json.bak", "owner-trust.json.bak"]));
    // the previous encrypted key is intact in the .bak and still opens with the OLD passphrase
    const bak = JSON.parse(readFileSync(`${kf}.bak`, "utf8")) as EncryptedKey;
    expect(readFileSync(`${kf}.bak`, "utf8")).toBe(oldKeyFile);
    expect(() => checkEncryptedKey(bak)).not.toThrow();
    expect(signEnvelopeHash(bak, OWNER_PASS, "a".repeat(64)).publicKeyFingerprint).toBe(trust.publicKeyFingerprint);
  });

  it("an inconsistent result (new key but old trust) is detected, rolled back, and the backups are removed only after a verified restore", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    const before = { t: readFileSync(trustPath(dir), "utf8"), k: readFileSync(privateKeyPath(dir), "utf8") };
    // the trust rename silently does nothing: the key file is new, the trust file is still the old one
    const renameFile = (from: string, to: string) => {
      if (to === trustPath(dir)) return;
      return renameSync(from, to);
    };
    expect(() => rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: NEW_PASS }, "2026-11-08T00:00:00Z", { ops: { renameFile } })).toThrow(/not consistent/);
    expect(readFileSync(trustPath(dir), "utf8")).toBe(before.t);
    expect(readFileSync(privateKeyPath(dir), "utf8")).toBe(before.k);
    expect(leftovers(dir)).toEqual([]);
    expect(readOnly(trustPath(dir))).toBe(true); // P3-3: mode restored
  });

  it("a successful rotation leaves the trust file read-only and no backups", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    const t = rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: NEW_PASS }, "2026-11-08T00:00:00Z");
    expect(loadTrust(dir)?.publicKeyFingerprint).toBe(t.publicKeyFingerprint);
    expect(leftovers(dir)).toEqual([]);
    expect(readOnly(trustPath(dir))).toBe(true);
    expect(signEnvelopeHash(JSON.parse(readFileSync(privateKeyPath(dir), "utf8")) as EncryptedKey, NEW_PASS, "c".repeat(64)).publicKeyFingerprint).toBe(t.publicKeyFingerprint);
  });

  it("after a clean failure with a successful restore the trust file is read-only again", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    // a copy that does NOT preserve the read-only mode (as a plain write would): the explicit re-chmod must restore it
    const copyFile = (from: string, to: string) => {
      copyFileSync(from, to);
      if (!to.endsWith(".bak")) chmodSync(to, 0o644);
    };
    expect(() => rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: NEW_PASS }, "2026-11-08T00:00:00Z", { failSecondRename: true, ops: { copyFile } })).toThrow(/simulated failure/);
    expect(readOnly(trustPath(dir))).toBe(true);
    expect(leftovers(dir)).toEqual([]);
  });
});

describe("P3-2 leftovers from an interrupted rotation", () => {
  it("rotation refuses, names the files and the recovery step, and changes nothing", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    writeFileSync(`${privateKeyPath(dir)}.bak`, "previous key bytes from a crash");
    const before = readFileSync(trustPath(dir), "utf8");
    expect(() => rotateTrust(dir, trust, OWNER_PASS, next, "2026-11-08T00:00:00Z")).toThrow(/leftover.*owner-key\.enc\.json\.bak.*Manual recovery/);
    expect(readFileSync(trustPath(dir), "utf8")).toBe(before);
    expect(readFileSync(`${privateKeyPath(dir)}.bak`, "utf8")).toBe("previous key bytes from a crash");
    writeFileSync(`${trustPath(dir)}.new`, "x");
    expect(() => rotateTrust(dir, trust, OWNER_PASS, next, "2026-11-08T00:00:00Z")).toThrow(/owner-trust\.json\.new/);
  });
});

describe("P3-5 passphrase prompts", () => {
  it("a weak first passphrase fails cleanly (exit 2, message) before the second prompt, and nothing is registered", async () => {
    const dir = tmp();
    const counter = { n: 0 };
    const t = sink();
    const code = await ownerKeygen(t.io, prompter(["too short pass", "too short pass"], counter), pristine(), dir);
    expect(code).toBe(2);
    expect(counter.n).toBe(1);
    expect(t.err.join()).toMatch(/at least 16 characters/);
    expect(existsSync(trustPath(dir))).toBe(false);
  });
  it("the prompt text states the real minimum", () => {
    const src = readFileSync(join(__dirname, "..", "ownercli.ts"), "utf8");
    expect(src).not.toMatch(/at least 12 characters/);
    expect(src.match(/at least 16 characters/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("P3-7 depth cap and lock takeover", () => {
  it("over-deep nesting is refused BECAUSE of the depth cap (code oversize, reason stated), using a structure that is otherwise only an unknown key", () => {
    const e = JSON.parse(JSON.stringify(makeEnvelope())) as Record<string, unknown>;
    e.extra = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const r = validateEnvelope(e) as { ok: boolean; issues: Array<{ code: string; detail: string }> };
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("oversize");
    expect(r.issues[0].detail).toMatch(/nested too deeply/);
  });
  type Priv = { takeOverIfStale(f: string, read?: (p: string, enc: "utf8") => string): void };
  const staleLock = (content: string) => {
    const l = new Ledger(join(tmp(), "ledger"), () => new Date("2026-11-07T12:00:00Z"));
    const lf = join(l.dir, "append.lock");
    writeFileSync(lf, content);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lf, old, old);
    return { l, lf };
  };
  it("a stale lock whose content is unchanged is taken over", () => {
    const { l, lf } = staleLock("abandoned");
    (l as unknown as Priv).takeOverIfStale(lf);
    expect(existsSync(lf)).toBe(false);
  });
  it("a lock whose content changes between the two reads (a new holder replaced it) is NOT removed", () => {
    const { l, lf } = staleLock("abandoned");
    let n = 0;
    (l as unknown as Priv).takeOverIfStale(lf, () => (n++ === 0 ? "abandoned" : "new-holder-token"));
    expect(existsSync(lf)).toBe(true);
  });
});

