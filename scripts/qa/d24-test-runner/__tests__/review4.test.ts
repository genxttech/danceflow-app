import { cpSync, existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { icaclsExe, powershellExe, system32, taskkillExe } from "../bins";
import { envelopeHash, validateEnvelope, type Envelope } from "../envelope";
import { createFakeExec } from "../fakeChild";
import { Ledger } from "../ledger";
import { OWNER_EXTERNAL_FILES, ownerKeygen, ownerSign, ownerToolsSha256, type Pristine, type Prompter } from "../ownercli";
import { checkEncryptedKey, DEFAULT_SCRYPT_N, generateOwnerKey, MIN_SCRYPT_N, passphraseProblem, readEncryptedKey, rotateTrust, signEnvelopeHash } from "../ownersig";
import { icaclsGrantsWrite, loadTrust, ownerSeparationWarning, privateKeyPath, trustPath } from "../ownerverify";
import { makeEnvelope, OWNER_PASS, REPO, SHA, tmp, writeEnvelope } from "./helpers";

vi.setConfig({ testTimeout: 90_000 }); // scrypt N=2^17 key generation is deliberately slow
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "..");
const prompter = (a: { lines?: string[]; hidden?: string[] }): Prompter => {
  const l = [...(a.lines ?? [])];
  const h = [...(a.hidden ?? [])];
  return { isTty: true, line: async () => l.shift() ?? "", hidden: async () => h.shift() ?? "" };
};
const pristine = (toolsDir?: string): Pristine => ({ repoDir: REPO, commitSha: SHA, exec: createFakeExec({ commitSha: SHA, repoDir: REPO }), env: {}, toolsDir });
const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe("CI regression: Windows paths are built with path.win32 on every host", () => {
  it("backslash paths regardless of the host separator", () => {
    for (const p of [powershellExe(), icaclsExe(), taskkillExe(), system32()]) {
      expect(p).not.toContain("/");
      expect(p.startsWith(String.raw`C:\Windows\System32`)).toBe(true);
    }
    expect(powershellExe()).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  });
  it("bins.ts uses win32 joins for the Windows paths (static)", () => {
    const src = readFileSync(join(TOOLS, "bins.ts"), "utf8");
    expect(src).toMatch(/win32\.join\(WINDOWS_DIR/);
    expect(src).not.toMatch(/=> join\(system32/);
  });
});

describe("P3-2 size caps, P3-3 nested unknown keys", () => {
  const reseal = (e: Record<string, unknown>) => {
    e.envelopeSha256 = envelopeHash(e as unknown as Envelope);
    return e;
  };
  const clone = () => JSON.parse(JSON.stringify(makeEnvelope())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("rejects over-long strings, long arrays, too many keys, over-deep nesting", () => {
    const a = clone();
    a.manualAttestations.sandbox.statement = "x".repeat(2001);
    expect(validateEnvelope(reseal(a))).toMatchObject({ ok: false, issues: [{ code: "oversize" }] });
    const b = clone();
    b.stopConditions = Array.from({ length: 65 }, (_, i) => `c${i}`);
    expect(validateEnvelope(reseal(b))).toMatchObject({ ok: false, issues: [{ code: "oversize" }] });
    const c = clone();
    for (let i = 0; i < 70; i++) c.manualAttestations[`k${i}`] = { statement: "a statement long enough", attestedBy: "unit", reference: "unit-ref" };
    expect(validateEnvelope(reseal(c))).toMatchObject({ ok: false, issues: [{ code: "oversize" }] });
    const d = clone();
    d.extra = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(validateEnvelope(d).ok).toBe(false);
    const ok = validateEnvelope(makeEnvelope());
    expect(ok.ok).toBe(true);
  });
  it("rejects an unknown key inside every nested object and inside an attestation", () => {
    for (const obj of ["code", "proof", "runner", "accounts", "credential", "cleanup", "forbidden", "ownerApproval"]) {
      const e = clone();
      e[obj].sneaky = "x";
      const r = validateEnvelope(reseal(e));
      expect(r.ok, obj).toBe(false);
      expect(JSON.stringify((r as { issues: unknown }).issues), obj).toMatch(/unknown field/);
    }
    const e = clone();
    e.manualAttestations.sandbox.sneaky = "x";
    expect(JSON.stringify((validateEnvelope(reseal(e)) as { issues: unknown }).issues)).toMatch(/unknown field in attestation/);
  });
});

describe("P3-4 append-lock takeover only removes what it owns", () => {
  type Priv = { takeOverIfStale(f: string): void; releaseIfOurs(f: string, token: string): void };
  const mk = () => new Ledger(join(tmp(), "ledger"), () => new Date("2026-11-07T12:00:00Z"));
  it("takes over a stale lock and a stale lock does not block", () => {
    const l = mk();
    const lf = join(l.dir, "append.lock");
    writeFileSync(lf, "someone-else");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lf, old, old);
    l.startRun("e1", "h", "r1", { maxRuns: 2, keyFp: "k" }); // append inside succeeds after takeover
    expect(existsSync(lf)).toBe(false);
  });
  it("never removes a fresh lock held by someone else", () => {
    const l = mk();
    const lf = join(l.dir, "append.lock");
    writeFileSync(lf, "fresh-holder");
    (l as unknown as Priv).takeOverIfStale(lf);
    expect(readFileSync(lf, "utf8")).toBe("fresh-holder");
  });
  it("release removes the lock only if it still holds OUR token", () => {
    const l = mk();
    const lf = join(l.dir, "append.lock");
    writeFileSync(lf, "other-token");
    (l as unknown as Priv).releaseIfOurs(lf, "my-token");
    expect(existsSync(lf)).toBe(true);
    writeFileSync(lf, "my-token");
    (l as unknown as Priv).releaseIfOurs(lf, "my-token");
    expect(existsSync(lf)).toBe(false);
  });
});

describe("P3-6 owner-tool hash covers imported files outside the folder; no dynamic loading", () => {
  it("changing an imported proof file changes the owner-tool hash", () => {
    const base = ownerToolsSha256();
    const proofCopy = tmp("d24-proof-copy-");
    for (const f of OWNER_EXTERNAL_FILES) cpSync(join(TOOLS, "..", "d24-m3d-proof", f), join(proofCopy, f));
    expect(ownerToolsSha256(TOOLS, proofCopy)).toBe(base);
    writeFileSync(join(proofCopy, "identity.ts"), `${readFileSync(join(proofCopy, "identity.ts"), "utf8")}\n// tampered\n`);
    expect(ownerToolsSha256(TOOLS, proofCopy)).not.toBe(base);
  });
  it("every import that leaves the folder from an owner-tool file is in the hash list", () => {
    const external = new Set<string>();
    for (const f of ["bins.ts", "canon.ts", "envelope.ts", "exec.ts", "gitverify.ts", "ownercli.ts", "ownermain.ts", "ownersig.ts", "ownerverify.ts", "childenv.ts", "secretprompt.ts"]) {
      for (const m of readFileSync(join(TOOLS, f), "utf8").matchAll(/from "\.\.\/d24-m3d-proof\/([a-z]+)"/g)) external.add(`${m[1]}.ts`);
    }
    for (const x of external) expect(OWNER_EXTERNAL_FILES as readonly string[], x).toContain(x);
    // and the proof files those import in turn (identity -> config, redact)
    for (const x of ["config.ts", "redact.ts"]) expect(OWNER_EXTERNAL_FILES as readonly string[]).toContain(x);
  });
  it("no non-test source loads code dynamically (import() / require()), so the import scan is complete", () => {
    for (const f of readdirSync(TOOLS).filter((x) => x.endsWith(".ts"))) {
      const code = readFileSync(join(TOOLS, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
      expect(code, f).not.toMatch(/(^|[^.\w])(import|require)\s*\(/m);
    }
  });
});

describe("P3-7 key-file hardening", () => {
  it("passphrase: at least 16 characters plus a sanity check", () => {
    for (const bad of ["short", "abcdeedcbaabcdeedcba", "aaaaaaaaaaaaaaaaaaaa", "12345678901234567890", "abcabcabcabcabcabc", "ab".repeat(12)]) expect(passphraseProblem(bad), bad).not.toBeNull();
    expect(passphraseProblem(OWNER_PASS)).toBeNull();
    expect(() => generateOwnerKey("fifteen chars ok", 1 << 10)).not.toThrow(); // 16
    expect(() => generateOwnerKey("fifteen chars o", 1 << 10)).toThrow(/at least 16/);
  });
  it("scrypt cost defaults to N >= 2^17 and a lowered cost in a stored file is refused", () => {
    expect(DEFAULT_SCRYPT_N).toBeGreaterThanOrEqual(1 << 17);
    const k = generateOwnerKey(OWNER_PASS, 1 << 10);
    expect(() => signEnvelopeHash(k.encrypted, OWNER_PASS, "a".repeat(64))).toThrow(/weak or malformed/);
    expect(() => checkEncryptedKey({ ...k.encrypted, n: 1 << 17 }, MIN_SCRYPT_N)).not.toThrow();
    expect(() => checkEncryptedKey({ ...k.encrypted, n: (1 << 17) + 1 })).toThrow(/weak or malformed/);
  });
  it("validates the stored tag, IV and salt lengths and uses a 16-byte tag", () => {
    const k = generateOwnerKey(OWNER_PASS, 1 << 10);
    expect(Buffer.from(k.encrypted.tag, "base64")).toHaveLength(16);
    for (const field of ["tag", "iv", "salt"] as const) {
      const bad = { ...k.encrypted, [field]: Buffer.alloc(field === "tag" ? 4 : 5).toString("base64") };
      expect(() => checkEncryptedKey(bad, 1 << 10), field).toThrow(/unexpected salt, IV or authentication-tag length/);
    }
    expect(() => signEnvelopeHash({ ...k.encrypted, tag: Buffer.alloc(4).toString("base64") }, OWNER_PASS, "a".repeat(64), 1 << 10)).toThrow();
  });
});

describe("P3-7 rotation: key must match the registration; swap is atomic enough", () => {
  const setup = async () => {
    const dir = tmp();
    expect(await ownerKeygen(sink().io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), pristine(), dir)).toBe(0);
    return dir;
  };
  const next = { ownerToolsSha256: "1".repeat(64), registeredAtCommit: SHA, registeredBy: "owner-account" };
  it("refuses when the decrypted old key is not the registered key", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    const other = generateOwnerKey(OWNER_PASS);
    writeFileSync(privateKeyPath(dir), JSON.stringify(other.encrypted)); // key file swapped for another key (same passphrase)
    expect(() => rotateTrust(dir, trust, OWNER_PASS, next, "2026-11-08T00:00:00Z")).toThrow(/does not match the registered public key/);
  });
  it("a failure during the swap restores the old trust AND key files and leaves no .new / .bak behind", async () => {
    const dir = await setup();
    const before = { t: readFileSync(trustPath(dir), "utf8"), k: readFileSync(privateKeyPath(dir), "utf8") };
    const trust = loadTrust(dir)!;
    expect(() => rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: "a brand new passphrase 987" }, "2026-11-08T00:00:00Z", { failSecondRename: true })).toThrow(/simulated failure/);
    expect(readFileSync(trustPath(dir), "utf8")).toBe(before.t);
    expect(readFileSync(privateKeyPath(dir), "utf8")).toBe(before.k);
    expect(readdirSync(dir).filter((f) => /\.(new|bak)$/.test(f))).toEqual([]);
    expect(loadTrust(dir)?.publicKeyFingerprint).toBe(trust.publicKeyFingerprint);
  });
  it("success replaces both files together and removes the backups", async () => {
    const dir = await setup();
    const trust = loadTrust(dir)!;
    const seen: string[] = [];
    const t = rotateTrust(dir, trust, OWNER_PASS, { ...next, newPassphrase: "a brand new passphrase 987" }, "2026-11-08T00:00:00Z", { beforeSwap: () => seen.push(...readdirSync(dir)) });
    expect(seen.filter((f) => /\.bak$/.test(f)).length).toBe(2); // backups existed before the swap
    expect(seen.filter((f) => /\.new$/.test(f)).length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir).filter((f) => /\.(new|bak)$/.test(f))).toEqual([]);
    expect(t.publicKeyFingerprint).not.toBe(trust.publicKeyFingerprint);
    expect(loadTrust(dir)?.publicKeyFingerprint).toBe(t.publicKeyFingerprint);
    // the new key file signs and matches the new registration
    const sig = signEnvelopeHash(readEncryptedKey(dir), "a brand new passphrase 987", "b".repeat(64));
    expect(sig.publicKeyFingerprint).toBe(t.publicKeyFingerprint);
  });
});

describe("P3-8 the same-user warning uses icacls output and honours the separate-account marker", () => {
  const dir = String.raw`C:\Users\x\AppData\Local\DanceFlow\d24-owner`;
  const out = (lines: string[]) => [`${dir} ${lines[0]}`, ...lines.slice(1).map((l) => `                                                      ${l}`), "", "Successfully processed 1 files; Failed processing 0 files"].join("\n");
  it("parses icacls: full control for me, Modify for Users, write-class tokens", () => {
    expect(icaclsGrantsWrite(out([String.raw`PC\me:(OI)(CI)(F)`, String.raw`NT AUTHORITY\SYSTEM:(OI)(CI)(F)`]), dir, "me")).toBe(true);
    expect(icaclsGrantsWrite(out([String.raw`NT AUTHORITY\SYSTEM:(OI)(CI)(F)`, String.raw`BUILTIN\Users:(OI)(CI)(M)`]), dir, "me")).toBe(true);
    expect(icaclsGrantsWrite(out([String.raw`PC\owner:(OI)(CI)(F)`, String.raw`PC\me:(OI)(CI)(R)`, String.raw`BUILTIN\Users:(OI)(CI)(RX)`]), dir, "me")).toBe(false);
    expect(icaclsGrantsWrite(out([String.raw`PC\owner:(OI)(CI)(F)`, String.raw`PC\me:(OI)(CI)(WD,AD)`]), dir, "me")).toBe(true);
    expect(icaclsGrantsWrite(out([String.raw`PC\me:(DENY)(OI)(CI)(W)`]), dir, "me")).toBe(false);
  });
  it("no warning when another account registered the key and this account cannot write; a warning otherwise", () => {
    const trust = { registeredBy: "owner-account" } as never;
    expect(ownerSeparationWarning("D", trust, "engineer", () => false)).toBeNull();
    expect(ownerSeparationWarning("D", trust, "engineer", () => true)).toMatch(/writable by the current account/);
    expect(ownerSeparationWarning("D", { registeredBy: "engineer" } as never, "engineer", () => false)).toMatch(/same Windows account/);
  });
  it("is one line, once", () => {
    const w = ownerSeparationWarning("D", { registeredBy: "engineer" } as never, "engineer", () => true);
    expect(w).not.toMatch(/\n/);
  });
});

describe("P3-2 the approval text is printed before the terms", () => {
  it("owner-sign shows the approval text first", async () => {
    const dir = tmp();
    await ownerKeygen(sink().io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), pristine(), dir);
    const env = makeEnvelope();
    const t = sink();
    await ownerSign(t.io, prompter({ lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: [OWNER_PASS] }), pristine(), writeEnvelope(env), join(tmp(), "s.json"), dir);
    const text = t.out.join("\n");
    expect(text.indexOf("approval text on record")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("approval text on record")).toBeLessThan(text.indexOf("canonical hash recomputed"));
    expect(text.indexOf("approval text on record")).toBeLessThan(text.indexOf("Stripe TEST accounts"));
  });
});

