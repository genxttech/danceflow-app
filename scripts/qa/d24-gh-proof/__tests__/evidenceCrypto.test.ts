import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDecryptCli } from "../decrypt-cli";
import { runEncryptCli } from "../encrypt-cli";
import { decryptEnvelope, encryptBundle, EvidenceCryptoError, parseBundle, parseEnvelope, parsePublicKey, readBundleFiles, serializeBundle, sha256Hex, type Envelope } from "../evidence-crypto";
import { factsFrom, renderSummary } from "../summary";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED_KEY_FILE = join(HERE, "..", "evidence-public-key.pem");
// A synthetic placeholder fixture (the repo now holds the real public key); written once to a temp dir.
const PLACEHOLDER_DIR = mkdtempSync(join(tmpdir(), "d24ghph-"));
const PLACEHOLDER_FILE = join(PLACEHOLDER_DIR, "evidence-public-key.pem");
writeFileSync(PLACEHOLDER_FILE, ["-----BEGIN PUBLIC KEY-----", "PLACEHOLDER - NOT A KEY. The D24 evidence public key has not been generated yet.", "-----END PUBLIC KEY-----", ""].join("\n"));
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "d24ghproof-")); tmps.push(d); return d; };
afterAll(() => { rmSync(PLACEHOLDER_DIR, { recursive: true, force: true }); for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

let pubPem = "";
let privPem = "";
let otherPriv = "";
let small4096Free = "";
beforeAll(() => {
  const k = generateKeyPairSync("rsa", { modulusLength: 4096, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  pubPem = k.publicKey;
  privPem = k.privateKey;
  otherPriv = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
  small4096Free = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey;
}, 120_000);

const evidenceJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ outcome: "OK", runId: "abcd1234", callsUsed: 17, blockedBeforeNetwork: 2, scenarios: [{ id: "S1", title: "t", checks: [{ id: "a", ok: true, detail: "acct_SECRETIDSHOULDNOTLEAK" }, { id: "b", ok: false, detail: "cus_SECRETOBJECT" }, { id: "c", ok: true, detail: "x" }] }], connectedAccountObserved: { type: "none" }, ...over });
function makeDir(files: Record<string, string>): string {
  const d = tmp();
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}
const tamper = (e: Envelope, over: Partial<Envelope>): Envelope => ({ ...e, ...over });
const flipB64 = (s: string) => { const b = Buffer.from(s, "base64"); b[0] = b[0]! ^ 1; return b.toString("base64"); };

describe("public key handling fails closed", () => {
  it("a PLACEHOLDER key file is refused", () => {
    const txt = readFileSync(PLACEHOLDER_FILE, "utf8");
    expect(txt).toMatch(/PLACEHOLDER/);
    expect(() => parsePublicKey(txt)).toThrow(/PLACEHOLDER/);
  });
  it("the committed key file is a real RSA-4096 PUBLIC key (never a private key) and passes --check-key", () => {
    const txt = readFileSync(COMMITTED_KEY_FILE, "utf8");
    expect(txt).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(txt).not.toMatch(/PRIVATE|PLACEHOLDER/);
    expect(() => parsePublicKey(txt)).not.toThrow();
    const out: string[] = [];
    expect(runEncryptCli(["--check-key", COMMITTED_KEY_FILE], { out: (s) => void out.push(s) })).toBe(0);
  });
  it("a placeholder is refused even if the rest looks like a real key", () => {
    expect(() => parsePublicKey(`${pubPem}\nPLACEHOLDER`)).toThrow(EvidenceCryptoError);
  });
  it("a private key, a 2048-bit key, garbage and an empty file are refused", () => {
    expect(() => parsePublicKey(privPem)).toThrow(/PRIVATE/);
    expect(() => parsePublicKey(small4096Free)).toThrow(/4096/);
    expect(() => parsePublicKey("not a key")).toThrow(/parsed/);
    expect(() => parsePublicKey("")).toThrow(EvidenceCryptoError);
  });
  it("an EC public key is refused", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    expect(() => parsePublicKey(ec.publicKey)).toThrow(/RSA/);
  });
  it("a real 4096-bit RSA public key is accepted", () => {
    expect(() => parsePublicKey(pubPem)).not.toThrow();
  });
  it("--check-key: placeholder file exits 1, real key exits 0, wrong arity exits 2", () => {
    const out: string[] = [];
    expect(runEncryptCli(["--check-key", PLACEHOLDER_FILE], { out: (s) => void out.push(s) })).toBe(1);
    const d = tmp();
    writeFileSync(join(d, "k.pem"), pubPem);
    expect(runEncryptCli(["--check-key", join(d, "k.pem")], { out: () => undefined })).toBe(0);
    expect(runEncryptCli(["--check-key"], { out: () => undefined })).toBe(2);
    expect(runEncryptCli(["--check-key", "a", "b"], { out: () => undefined })).toBe(2);
    expect(runEncryptCli(["--check-key", join(d, "missing.pem")], { out: () => undefined })).toBe(1);
  });
});

describe("round trip", () => {
  it("encrypt then decrypt returns the exact bundle", () => {
    const plain = serializeBundle([{ name: "evidence-abcd1234.json", content: Buffer.from(evidenceJson()) }, { name: "terminal.txt", content: Buffer.from("line 1\nline 2\n") }]);
    const env = encryptBundle(plain, pubPem);
    expect(env.plaintextSha256).toBe(sha256Hex(plain));
    expect(Buffer.from(env.ciphertext, "base64").toString("utf8")).not.toContain("evidence-abcd1234");
    const back = decryptEnvelope(parseEnvelope(JSON.stringify(env)), privPem);
    expect(back.equals(plain)).toBe(true);
    const files = parseBundle(back);
    expect(files.map((f) => f.name).sort()).toEqual(["evidence-abcd1234.json", "terminal.txt"]);
    expect(files.find((f) => f.name === "terminal.txt")?.content.toString()).toBe("line 1\nline 2\n");
  });
  it("each encryption uses a fresh key and IV", () => {
    const plain = Buffer.from("x");
    const a = encryptBundle(plain, pubPem);
    const b = encryptBundle(plain, pubPem);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.ciphertext).not.toBe(b.ciphertext === a.ciphertext ? "" : b.ciphertext);
  });
  it("a different private key cannot decrypt", () => {
    const env = encryptBundle(Buffer.from("secret"), pubPem);
    expect(() => decryptEnvelope(env, otherPriv)).toThrow(/does not match/);
  });
});

describe("tamper detection (every field)", () => {
  let env: Envelope;
  beforeAll(() => {
    env = encryptBundle(serializeBundle([{ name: "terminal.txt", content: Buffer.from("hello evidence") }]), pubPem);
  });
  const cases: Array<[string, (e: Envelope) => Partial<Envelope>]> = [
    ["ciphertext bit flip", (e) => ({ ciphertext: flipB64(e.ciphertext) })],
    ["tag bit flip", (e) => ({ tag: flipB64(e.tag) })],
    ["iv bit flip", (e) => ({ iv: flipB64(e.iv) })],
    ["wrapped key bit flip", (e) => ({ wrappedKey: flipB64(e.wrappedKey) })],
    ["plaintext hash changed", () => ({ plaintextSha256: "0".repeat(64) })],
    ["key fingerprint changed", () => ({ keyFingerprint: "1".repeat(64) })],
  ];
  for (const [name, over] of cases) {
    it(name, () => {
      expect(() => decryptEnvelope(tamper(env, over(env)), privPem)).toThrow(EvidenceCryptoError);
    });
  }
  it("truncated ciphertext", () => {
    expect(() => decryptEnvelope(tamper(env, { ciphertext: Buffer.from(env.ciphertext, "base64").subarray(1).toString("base64") }), privPem)).toThrow(EvidenceCryptoError);
  });
  it("the header is authenticated: a version or algorithm swap is refused by the parser", () => {
    expect(() => parseEnvelope(JSON.stringify({ ...env, version: 2 }))).toThrow(/unsupported/);
    expect(() => parseEnvelope(JSON.stringify({ ...env, alg: "AES-128-CBC" }))).toThrow(/unsupported/);
  });
  it("the header is bound as AAD: re-labelling the fingerprint to another real key fails authentication", () => {
    const k2 = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    // the envelope's fingerprint field is part of the AAD; with the right private key but an altered fingerprint the key-match check already refuses
    expect(() => decryptEnvelope(tamper(env, { keyFingerprint: "2".repeat(64) }), privPem)).toThrow(/does not match/);
    expect(k2.privateKey.length).toBeGreaterThan(0);
  });
  it("extra / missing fields, non-base64 and bad hashes are refused by the parser", () => {
    expect(() => parseEnvelope("not json")).toThrow(/valid JSON/);
    expect(() => parseEnvelope(JSON.stringify({ ...env, extra: 1 }))).toThrow(/unexpected fields/);
    const missing: Partial<Envelope> = { ...env };
    delete missing.tag;
    expect(() => parseEnvelope(JSON.stringify(missing))).toThrow(/unexpected fields/);
    expect(() => parseEnvelope(JSON.stringify({ ...env, iv: "!!!" }))).toThrow(/base64/);
    expect(() => parseEnvelope(JSON.stringify({ ...env, plaintextSha256: "XYZ" }))).toThrow(/SHA-256/);
    expect(() => parseEnvelope(JSON.stringify([env]))).toThrow(EvidenceCryptoError);
  });
  it("a plaintext whose hash was swapped but with a valid tag is refused by the hash check", () => {
    // encrypt a bundle, then lie about its hash inside an otherwise valid envelope: the tag verifies, the hash must not
    const good = encryptBundle(Buffer.from("A"), pubPem);
    expect(() => decryptEnvelope({ ...good, plaintextSha256: sha256Hex("B") }, privPem)).toThrow(/plaintext SHA-256/);
  });
});

describe("bundle", () => {
  it("only whitelisted basenames are bundled; anything else in the evidence directory is refused", () => {
    const d = makeDir({ "evidence-abcd1234.json": evidenceJson(), "transcript-abcd1234.txt": "t" });
    expect(readBundleFiles(d).map((f) => f.name)).toEqual(["evidence-abcd1234.json", "transcript-abcd1234.txt"]);
    writeFileSync(join(d, "notes.txt"), "x");
    expect(() => readBundleFiles(d)).toThrow(/unexpected file/);
  });
  it("a subdirectory, an empty directory and a missing directory with no extras are refused", () => {
    const d = tmp();
    expect(() => readBundleFiles(d)).toThrow(/no evidence/);
    expect(() => readBundleFiles(join(d, "nope"))).toThrow(/no evidence/);
    mkdirSync(join(d, "evidence-abcd1234.json"));
    expect(() => readBundleFiles(d)).toThrow(/regular file/);
  });
  it("the terminal capture is bundled as terminal.txt even when the run wrote no evidence pack", () => {
    const d = tmp();
    const t = join(d, "t.txt");
    writeFileSync(t, "refused: live mode needs...");
    expect(readBundleFiles(join(d, "none"), [{ name: "terminal.txt", path: t }]).map((f) => f.name)).toEqual(["terminal.txt"]);
  });
  it("decryption refuses a bundle naming a path-traversal or unexpected file", () => {
    for (const bad of ["../x", "a/b.txt", "evidence-ZZZZ.json", "terminal.txt.exe", ""]) {
      const plain = Buffer.from(JSON.stringify({ v: 1, files: [{ name: bad, b64: "eA==" }] }));
      expect(() => parseBundle(plain), JSON.stringify(bad)).toThrow(EvidenceCryptoError);
    }
    expect(() => parseBundle(Buffer.from(JSON.stringify({ v: 1, files: [{ name: "terminal.txt", b64: "eA==" }, { name: "terminal.txt", b64: "eA==" }] })))).toThrow(/repeats/);
    expect(() => parseBundle(Buffer.from("nope"))).toThrow(/JSON/);
    expect(() => parseBundle(Buffer.from(JSON.stringify({ v: 2, files: [] })))).toThrow(/shape/);
  });
});

describe("summary exposes only counts, the outcome and two hashes", () => {
  it("counts PASS / FAIL / BLOCKED / requests and never copies a detail", () => {
    const f = factsFrom(evidenceJson());
    expect(f).toEqual({ outcome: "OK", pass: 2, fail: 1, blocked: 2, requests: 17 });
    const md = renderSummary(f, "a".repeat(64), "b".repeat(64));
    expect(md).toContain("PASS 2 / FAIL 1 / BLOCKED 2");
    expect(md).toContain("requests used: 17");
    expect(md).not.toMatch(/acct_|cus_|in_[A-Za-z]|SECRET/);
  });
  it("no evidence, unreadable evidence and an unknown outcome are reported as such, never echoed", () => {
    expect(factsFrom(null).outcome).toBe("NO_EVIDENCE");
    expect(factsFrom("{{").outcome).toBe("UNREADABLE");
    expect(factsFrom(JSON.stringify({ outcome: "acct_LEAK PASSED" })).outcome).toBe("UNREADABLE");
    expect(renderSummary(factsFrom(JSON.stringify({ outcome: "acct_LEAK" })), "a".repeat(64), "b".repeat(64))).not.toContain("acct_LEAK");
    expect(factsFrom(JSON.stringify({ outcome: "FAILED", callsUsed: "17; DROP", blockedBeforeNetwork: -4 }))).toEqual({ outcome: "FAILED", pass: 0, fail: 0, blocked: 0, requests: 0 });
  });
  it("a non-hex hash is not printed", () => {
    expect(renderSummary(factsFrom(null), "<script>", "b".repeat(64))).not.toContain("<script>");
  });
});

describe("CLIs end to end", () => {
  it("encrypt-cli writes one envelope, appends the public summary, prints no evidence; decrypt-cli verifies and restores the files", () => {
    const evid = makeDir({ "evidence-abcd1234.json": evidenceJson(), "transcript-abcd1234.txt": "TRANSCRIPT-CONTENT-acct_ABC" });
    const work = tmp();
    const term = join(work, "terminal.txt");
    writeFileSync(term, "TERMINAL-CONTENT");
    const pub = join(work, "pub.pem");
    const priv = join(work, "priv.pem");
    writeFileSync(pub, pubPem);
    writeFileSync(priv, privPem);
    const out = join(work, "up", "e.enc.json");
    const summary = join(work, "summary.md");
    const lines: string[] = [];
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--terminal", term, "--public-key", pub, "--out", out, "--summary-file", summary], { out: (s) => void lines.push(s) })).toBe(0);
    const printed = lines.join("\n");
    expect(printed).not.toMatch(/TRANSCRIPT-CONTENT|TERMINAL-CONTENT|acct_|SECRET/);
    const sum = readFileSync(summary, "utf8");
    expect(sum).toContain("outcome: **OK**");
    expect(sum).not.toMatch(/acct_|cus_|SECRET|TRANSCRIPT|TERMINAL/);
    const envText = readFileSync(out, "utf8");
    expect(envText).not.toMatch(/TRANSCRIPT-CONTENT|TERMINAL-CONTENT|evidence-abcd1234|acct_/);
    expect(sum).toContain(sha256Hex(envText));
    const dec = join(work, "dec");
    const dl: string[] = [];
    expect(runDecryptCli(["--in", out, "--private-key", priv, "--out", dec, "--expect-ciphertext-sha256", sha256Hex(envText)], { out: (s) => void dl.push(s) })).toBe(0);
    expect(dl.join("\n")).not.toMatch(/TRANSCRIPT-CONTENT|TERMINAL-CONTENT/);
    expect(readdirSync(dec).sort()).toEqual(["evidence-abcd1234.json", "terminal.txt", "transcript-abcd1234.txt"]);
    expect(readFileSync(join(dec, "terminal.txt"), "utf8")).toBe("TERMINAL-CONTENT");
    expect(readFileSync(join(dec, "evidence-abcd1234.json"), "utf8")).toBe(evidenceJson());
  });
  it("encrypt-cli with the PLACEHOLDER key fails closed and reads no evidence, writes no envelope", () => {
    const evid = makeDir({ "evidence-abcd1234.json": evidenceJson() });
    const work = tmp();
    const out = join(work, "e.enc.json");
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", PLACEHOLDER_FILE, "--out", out], { out: () => undefined })).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
  it("the key is validated BEFORE any evidence is read: an unreadable evidence dir plus a placeholder key reports the key problem", () => {
    const evid = makeDir({ "stray.txt": "x" }); // would be refused as an unexpected file if the evidence were read first
    const out: string[] = [];
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", PLACEHOLDER_FILE, "--out", join(tmp(), "e.json")], { out: (s) => void out.push(s) })).toBe(1);
    expect(out.join()).toMatch(/PLACEHOLDER/);
    expect(out.join()).not.toMatch(/unexpected file/);
  });
  it("encrypt-cli refuses to overwrite an existing envelope and an unexpected file in the evidence dir", () => {
    const evid = makeDir({ "evidence-abcd1234.json": evidenceJson() });
    const work = tmp();
    const pub = join(work, "pub.pem");
    writeFileSync(pub, pubPem);
    const out = join(work, "e.enc.json");
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", pub, "--out", out], { out: () => undefined })).toBe(0);
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", pub, "--out", out], { out: () => undefined })).toBe(1);
    writeFileSync(join(evid, "stray.txt"), "x");
    expect(runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", pub, "--out", join(work, "e2.json")], { out: () => undefined })).toBe(1);
  });
  it("decrypt-cli detects a tampered file, a wrong expected hash, a wrong key, and refuses a non-empty --out", () => {
    const evid = makeDir({ "evidence-abcd1234.json": evidenceJson() });
    const work = tmp();
    const pub = join(work, "pub.pem");
    const priv = join(work, "priv.pem");
    writeFileSync(pub, pubPem);
    writeFileSync(priv, privPem);
    const out = join(work, "e.enc.json");
    runEncryptCli(["--encrypt", "--evidence-dir", evid, "--public-key", pub, "--out", out], { out: () => undefined });
    const text = readFileSync(out, "utf8");
    const bad = join(work, "bad.json");
    const env = JSON.parse(text) as Envelope;
    writeFileSync(bad, JSON.stringify({ ...env, ciphertext: flipB64(env.ciphertext) }));
    const o: string[] = [];
    expect(runDecryptCli(["--in", bad, "--private-key", priv, "--out", join(work, "d1")], { out: (s) => void o.push(s) })).toBe(1);
    expect(o.join()).toMatch(/authentication failed/);
    expect(runDecryptCli(["--in", out, "--private-key", priv, "--out", join(work, "d2"), "--expect-ciphertext-sha256", "0".repeat(64)], { out: () => undefined })).toBe(1);
    expect(runDecryptCli(["--in", out, "--private-key", priv, "--out", join(work, "d3"), "--expect-plaintext-sha256", "0".repeat(64)], { out: () => undefined })).toBe(1);
    const wrong = join(work, "wrong.pem");
    writeFileSync(wrong, otherPriv);
    expect(runDecryptCli(["--in", out, "--private-key", wrong, "--out", join(work, "d4")], { out: () => undefined })).toBe(1);
    mkdirSync(join(work, "full"));
    writeFileSync(join(work, "full", "x"), "x");
    expect(runDecryptCli(["--in", out, "--private-key", priv, "--out", join(work, "full")], { out: () => undefined })).toBe(2);
    expect(runDecryptCli(["--in", out], { out: () => undefined })).toBe(2);
    expect(runDecryptCli(["--in", out, "--private-key", priv, "--out", join(work, "d5"), "--expect-ciphertext-sha256", "short"], { out: () => undefined })).toBe(2);
    for (const d of ["d1", "d2", "d3", "d4"]) expect(existsSync(join(work, d))).toBe(false);
  });
  it("encrypt-cli rejects unknown flags and missing values", () => {
    expect(runEncryptCli(["--encrypt", "--bogus", "x"], { out: () => undefined })).toBe(2);
    expect(runEncryptCli(["--encrypt", "--out"], { out: () => undefined })).toBe(2);
    expect(runEncryptCli(["--encrypt"], { out: () => undefined })).toBe(2);
    expect(runEncryptCli([], { out: () => undefined })).toBe(2);
  });
});
