import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli";
import { decryptEvidence, encryptEvidence, makeBundle, openBundle, publicKeyProblem, sha256Hex, summaryMarkdown } from "../evidence-crypto";

let pub = "";
let priv = "";
let otherPriv = "";
const pair = (bits: number) => generateKeyPairSync("rsa", { modulusLength: bits, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

beforeAll(() => {
  const a = pair(4096);
  pub = a.publicKey;
  priv = a.privateKey;
  otherPriv = pair(4096).privateKey;
}, 120_000);

const flip = (b64: string) => {
  const b = Buffer.from(b64, "base64");
  b[0] ^= 1;
  return b.toString("base64");
};

describe("evidence encryption", () => {
  it("round-trips and hides the plaintext", () => {
    const plain = Buffer.from("acct_SECRETVALUE cus_123 evidence body");
    const env = encryptEvidence(plain, pub);
    expect(JSON.stringify(env)).not.toContain("SECRETVALUE");
    expect(decryptEvidence(env, priv).equals(plain)).toBe(true);
  });

  it("uses a fresh key and IV per encryption", () => {
    const a = encryptEvidence(Buffer.from("x"), pub);
    const b = encryptEvidence(Buffer.from("x"), pub);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it("detects tampering with every envelope field", () => {
    const env = encryptEvidence(Buffer.from("evidence"), pub);
    for (const f of ["ciphertext", "tag", "iv", "wrappedKey"] as const) expect(() => decryptEvidence({ ...env, [f]: flip(env[f]) }, priv), f).toThrow();
    expect(() => decryptEvidence({ ...env, alg: "none" }, priv)).toThrow();
    expect(() => decryptEvidence({ ...env, v: "d24-evidence-v0" }, priv)).toThrow();
    expect(() => decryptEvidence({ ...env, ciphertext: undefined }, priv)).toThrow();
  });

  it("refuses the wrong private key", () => {
    expect(() => decryptEvidence(encryptEvidence(Buffer.from("e"), pub), otherPriv)).toThrow();
  });

  it("refuses a placeholder, a short key, a private key and garbage as the public key", () => {
    expect(publicKeyProblem(readFileSync(join(import.meta.dirname, "..", "evidence-public-key.pem"), "utf8"))).toMatch(/PLACEHOLDER/);
    expect(publicKeyProblem(pair(2048).publicKey)).toMatch(/2048/);
    expect(publicKeyProblem(priv)).toMatch(/PUBLIC KEY/);
    expect(publicKeyProblem("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toMatch(/parseable/);
    expect(publicKeyProblem(pub)).toBeNull();
    expect(() => encryptEvidence(Buffer.from("e"), "D24-EVIDENCE-PUBLIC-KEY-PLACEHOLDER")).toThrow(/PLACEHOLDER/);
  });
});

describe("bundle", () => {
  it("round-trips files and verifies per-file hashes", () => {
    const files = { "evidence-aaaaaaaa.json": Buffer.from("{}"), "transcript.txt": Buffer.from("t") };
    const out = openBundle(makeBundle(files));
    expect(out["transcript.txt"].toString()).toBe("t");
  });
  it("detects an altered file and unsafe names", () => {
    const b = JSON.parse(makeBundle({ "a.txt": Buffer.from("one") }).toString());
    b.files["a.txt"] = Buffer.from("two").toString("base64");
    expect(() => openBundle(Buffer.from(JSON.stringify(b)))).toThrow(/sha256 mismatch/);
    expect(() => makeBundle({ "../escape": Buffer.from("x") })).toThrow(/unsafe/);
    const evil = JSON.parse(makeBundle({ "a.txt": Buffer.from("one") }).toString());
    evil.files["../x"] = evil.files["a.txt"];
    evil.sha256["../x"] = evil.sha256["a.txt"];
    expect(() => openBundle(Buffer.from(JSON.stringify(evil)))).toThrow(/unsafe/);
  });
});

describe("job summary", () => {
  const evidence = JSON.stringify({
    outcome: "OK",
    callsUsed: 17,
    blockedBeforeNetwork: 2,
    verdicts: { V1: { verdict: "PASS", basis: "acct_SECRET1234 cus_ABC" }, V2: { verdict: "PASS (Stripe side only)", basis: "" }, V3: { verdict: "FAIL", basis: "" }, V4: { verdict: "NOT TESTED", basis: "" } },
    scenarios: [{ id: "S0", checks: [{ ok: true, detail: "in_SECRETINV" }, { ok: false, detail: "cus_LEAK" }] }],
  });
  it("shows counts and hashes and no ids or free text", () => {
    const md = summaryMarkdown({ evidenceJson: evidence, cipherSha256: "c".repeat(64), plainFiles: { "evidence-<runId>.json": sha256Hex(evidence) } });
    expect(md).toContain("outcome: **OK**");
    expect(md).toContain("requests sent: 17");
    expect(md).toContain("PASS 1, PASS (Stripe side only) 1, FAIL 1, NOT TESTED 1");
    expect(md).toContain("1 ok, 1 failed");
    expect(md).not.toMatch(/acct_|cus_|in_SECRET|SECRET/);
  });
  it("treats an unreadable or hostile evidence file as unreadable, without echoing it", () => {
    const md = summaryMarkdown({ evidenceJson: '{"outcome":"acct_HOSTILE","callsUsed":"cus_x"}', cipherSha256: "d".repeat(64), plainFiles: {} });
    expect(md).toContain("outcome: **unreadable**");
    expect(md).not.toMatch(/HOSTILE|cus_x/);
  });
});

describe("cli", () => {
  const out: string[] = [];
  const run = (argv: string[]) => main(argv, (s) => out.push(s));
  it("check-key refuses the committed placeholder", () => {
    expect(run(["check-key", "--key", join(import.meta.dirname, "..", "evidence-public-key.pem")])).toBe(1);
  });
  it("encrypt then decrypt round trip, summary has no evidence content, refuses to overwrite", () => {
    const d = mkdtempSync(join(tmpdir(), "d24gh-"));
    const ev = join(d, "ev");
    mkdirSync(ev);
    writeFileSync(join(ev, "evidence-abcdef12.json"), JSON.stringify({ outcome: "FAILED", callsUsed: 3, blockedBeforeNetwork: 0, verdicts: {}, scenarios: [], secretish: "acct_PRIVATE99" }));
    writeFileSync(join(ev, "transcript-abcdef12.txt"), "transcript acct_PRIVATE99");
    writeFileSync(join(d, "stdout.txt"), "stdout text");
    writeFileSync(join(d, "pub.pem"), pub);
    writeFileSync(join(d, "priv.pem"), priv);
    const enc = join(d, "out.enc.json");
    const sum = join(d, "sum.md");
    expect(run(["encrypt", "--key", join(d, "pub.pem"), "--evidence-dir", ev, "--extra", `live-stdout.txt=${join(d, "stdout.txt")}`, "--out", enc, "--summary", sum])).toBe(0);
    expect(readFileSync(enc, "utf8")).not.toContain("PRIVATE99");
    expect(readFileSync(sum, "utf8")).toContain("outcome: **FAILED**");
    expect(readFileSync(sum, "utf8")).not.toContain("PRIVATE99");
    expect(out.join("\n")).not.toContain("PRIVATE99");
    expect(run(["encrypt", "--key", join(d, "pub.pem"), "--evidence-dir", ev, "--out", enc, "--summary", sum])).not.toBe(0);
    const dec = join(d, "dec");
    expect(run(["decrypt", "--in", enc, "--private-key", join(d, "priv.pem"), "--out", dec])).toBe(0);
    expect(readdirSync(dec).sort()).toEqual(["evidence-abcdef12.json", "live-stdout.txt", "transcript-abcdef12.txt"]);
    expect(readFileSync(join(dec, "transcript-abcdef12.txt"), "utf8")).toContain("PRIVATE99");
    // tamper with the ciphertext file on disk
    const env = JSON.parse(readFileSync(enc, "utf8"));
    env.ciphertext = flip(env.ciphertext);
    writeFileSync(join(d, "bad.enc.json"), JSON.stringify(env));
    expect(run(["decrypt", "--in", join(d, "bad.enc.json"), "--private-key", join(d, "priv.pem"), "--out", join(d, "dec2")])).toBe(1);
    expect(existsSync(join(d, "dec2"))).toBe(false);
  });
  it("encrypt refuses with the placeholder key and with no evidence", () => {
    const d = mkdtempSync(join(tmpdir(), "d24gh-"));
    mkdirSync(join(d, "ev"));
    writeFileSync(join(d, "pub.pem"), pub);
    writeFileSync(join(d, "x.txt"), "x");
    const ph = join(import.meta.dirname, "..", "evidence-public-key.pem");
    expect(run(["encrypt", "--key", ph, "--evidence-dir", join(d, "ev"), "--extra", `x.txt=${join(d, "x.txt")}`, "--out", join(d, "o"), "--summary", join(d, "s")])).toBe(1);
    expect(existsSync(join(d, "o"))).toBe(false);
    expect(run(["encrypt", "--key", join(d, "pub.pem"), "--evidence-dir", join(d, "ev"), "--out", join(d, "o"), "--summary", join(d, "s")])).toBe(1);
  });
});
