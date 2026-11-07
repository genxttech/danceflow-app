import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../cli";
import { approvalTemplate, createEnvelope, materialDigest, validateEnvelope } from "../envelope";
import { ownerKeygen, ownerShow, ownerSign, renderTerms, type Prompter } from "../ownercli";
import { generateOwnerKey, loadTrust, signEnvelopeHash, trustPath, verifyOwnerSignature } from "../ownersig";
import { baseSpec, makeEnvelope, OWNER_PASS, ownerKey, ownerSign as signHelper, ownerTrust, tmp, writeEnvelope } from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const prompter = (answers: { lines?: string[]; hidden?: string[]; tty?: boolean }): Prompter => {
  const lines = [...(answers.lines ?? [])];
  const hidden = [...(answers.hidden ?? [])];
  return { isTty: answers.tty ?? true, line: async () => lines.shift() ?? "", hidden: async () => hidden.shift() ?? "" };
};
const nonTtyStdin = () => ({ isTTY: false }) as unknown as NodeJS.ReadStream;

describe("owner Ed25519 signature", () => {
  const e = makeEnvelope();
  const trust = ownerTrust("L", "A");
  it("verifies a signature made with the owner key", () => {
    expect(verifyOwnerSignature(e.envelopeSha256, signHelper(e), trust).ok).toBe(true);
  });
  it("rejects: no trust, wrong hash, wrong key, tampered signature, malformed doc", () => {
    const sig = signHelper(e);
    expect(verifyOwnerSignature(e.envelopeSha256, sig, null).reason).toMatch(/no owner public key/);
    expect(verifyOwnerSignature("ab".repeat(32), sig, trust).reason).toMatch(/different envelope/);
    const other = generateOwnerKey("another passphrase 12345", 1 << 10);
    const forged = signEnvelopeHash(other.encrypted, "another passphrase 12345", e.envelopeSha256);
    expect(verifyOwnerSignature(e.envelopeSha256, forged, trust).reason).toMatch(/not the registered owner key/);
    // an attacker who claims the registered fingerprint but signs with their own key
    expect(verifyOwnerSignature(e.envelopeSha256, { ...forged, publicKeyFingerprint: trust.publicKeyFingerprint }, trust).ok).toBe(false);
    const flipped = Buffer.from(sig.signatureBase64, "base64");
    flipped[0] ^= 1;
    expect(verifyOwnerSignature(e.envelopeSha256, { ...sig, signatureBase64: flipped.toString("base64") }, trust).ok).toBe(false);
    expect(verifyOwnerSignature(e.envelopeSha256, { nope: 1 }, trust).ok).toBe(false);
    expect(verifyOwnerSignature(e.envelopeSha256, null, trust).ok).toBe(false);
  });
  it("a wrong passphrase cannot sign; a short passphrase cannot create a key", () => {
    expect(() => signEnvelopeHash(ownerKey().encrypted, "not the passphrase", e.envelopeSha256)).toThrow(/wrong passphrase/);
    expect(() => generateOwnerKey("short", 1 << 10)).toThrow(/at least 12/);
  });
  it("the signature is bound to EVERY material field: editing any of them changes the signed hash", () => {
    const base = signHelper(e).envelopeSha256;
    const edits: Array<[string, Parameters<typeof makeEnvelope>[0]]> = [
      ["accounts", { accounts: { platformAcct: "acct_UNITPLATFORM1", connectedAcct: "acct_EVILCONNECTED" } }],
      ["credential fingerprint", { credential: { ...baseSpec().credential, keyFingerprintSha256Prefix: "0".repeat(16) } }],
      ["rule ids", { permittedRuleIds: baseSpec().permittedRuleIds.slice(1) }],
      ["ceiling", { apiCallCeiling: 20 }],
      ["evidenceRoot", { evidenceRoot: join(tmp(), "elsewhere") }],
      ["lockfile", { code: { commitSha: baseSpec().code.commitSha, lockfileSha256: "9".repeat(64) } }],
      ["runner pin", { runner: { manifestSha256: "8".repeat(64), fileCount: 3 } }],
      ["manual attestation", { manualAttestations: { ...baseSpec().manualAttestations, sandbox: { statement: "something else entirely", attestedBy: "unit", reference: "unit-ref" } } }],
    ];
    for (const [name, over] of edits) expect(makeEnvelope(over).envelopeSha256, name).not.toBe(base);
  });
  it("the approval text must carry a digest of all material terms (terms=…), so an old approval cannot be reused for changed terms", () => {
    const spec = baseSpec();
    const ok = createEnvelope(spec, approvalTemplate(spec), "ref ref");
    expect(ok.ok).toBe(true);
    expect(approvalTemplate(spec)).toContain(`terms=${materialDigest(spec as unknown as Record<string, unknown>).slice(0, 16)}`);
    const stale = createEnvelope({ ...spec, accounts: { ...spec.accounts, connectedAcct: "acct_SWAPPEDCONN1" } }, approvalTemplate(spec), "ref ref");
    expect(stale.ok).toBe(false);
    expect(JSON.stringify((stale as { issues: unknown }).issues)).toMatch(/terms=/);
  });
  it("lockfileSha256 and runner pin are mandatory envelope fields", () => {
    const e2 = JSON.parse(JSON.stringify(makeEnvelope())) as Record<string, unknown>;
    delete (e2.code as Record<string, unknown>).lockfileSha256;
    expect(validateEnvelope(e2).ok).toBe(false);
    const e3 = JSON.parse(JSON.stringify(makeEnvelope())) as Record<string, unknown>;
    delete e3.runner;
    expect(validateEnvelope(e3).ok).toBe(false);
  });
});

describe("owner-side commands", () => {
  it("refuse a non-TTY stdin (a piped passphrase/confirmation defeats the control)", async () => {
    const dir = tmp();
    const t = io();
    expect(await ownerKeygen(t.io, prompter({ tty: false, hidden: [OWNER_PASS, OWNER_PASS] }), dir)).toBe(2);
    expect(existsSync(trustPath(dir))).toBe(false);
    expect(await main(["owner-keygen"], t.io, nonTtyStdin(), { ownerDir: dir })).toBe(2);
    expect(await main(["owner-sign", "--envelope", writeEnvelope(makeEnvelope())], t.io, nonTtyStdin(), { ownerDir: dir })).toBe(2);
    expect(t.err.join("\n")).toMatch(/interactive terminal/);
  });

  it("keygen registers only the PUBLIC key + pinned ledger; sign prints terms, needs the typed hash and the passphrase; output has no private material", async () => {
    const dir = tmp();
    const t = io();
    expect(await ownerKeygen(t.io, prompter({ hidden: [OWNER_PASS, "mismatch passphrase 99"] }), dir)).toBe(2);
    expect(await ownerKeygen(t.io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), dir, join(tmp(), "pinned-ledger"))).toBe(0);
    const trust = loadTrust(dir);
    expect(trust?.ledgerDir).toMatch(/pinned-ledger$/);
    const keyFile = readFileSync(join(dir, "owner-key.enc.json"), "utf8");
    expect(keyFile).not.toContain("PRIVATE KEY");
    expect(JSON.parse(keyFile).ct).toBeTruthy();
    // a second keygen is refused (no silent rotation)
    expect(await ownerKeygen(t.io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), dir)).toBe(2);

    const env = makeEnvelope();
    const file = writeEnvelope(env);
    const out = join(tmp(), "e.sig.json");
    const wrongConfirm = io();
    expect(await ownerSign(wrongConfirm.io, prompter({ lines: ["yes"], hidden: [OWNER_PASS] }), file, out, dir)).toBe(2);
    expect(existsSync(out)).toBe(false);
    const wrongPass = io();
    await expect(ownerSign(wrongPass.io, prompter({ lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: ["definitely wrong pass"] }), file, out, dir)).rejects.toThrow(/wrong passphrase/);
    const good = io();
    expect(await ownerSign(good.io, prompter({ lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: [OWNER_PASS] }), file, out, dir)).toBe(0);
    const shown = good.out.join("\n");
    // every material term is displayed before signing
    for (const term of renderTerms(env)) expect(shown).toContain(term);
    for (const must of [env.accounts.platformAcct, env.accounts.connectedAcct, env.credential.keyFingerprintSha256Prefix, env.code.lockfileSha256, env.runner.manifestSha256, env.evidenceRoot, "invoice.create_draft"]) expect(shown).toContain(must);
    const sigText = readFileSync(out, "utf8");
    expect(verifyOwnerSignature(env.envelopeSha256, JSON.parse(sigText), trust).ok).toBe(true);
    expect(sigText + shown).not.toMatch(/PRIVATE|passphrase/i);
    expect(shown).not.toContain(OWNER_PASS);
    // owner-show prints only public information
    const sh = io();
    expect(ownerShow(sh.io, dir)).toBe(0);
    expect(sh.out.join("\n")).toContain(trust!.publicKeyFingerprint);
  });

  it("owner-sign refuses an invalid envelope and an unregistered machine", async () => {
    const t = io();
    expect(await ownerSign(t.io, prompter({}), writeEnvelope(makeEnvelope()), join(tmp(), "s.json"), tmp())).toBe(2);
    expect(t.err.join()).toMatch(/no owner key/);
  });
});

describe("self-approval is closed (review P1-1 reproduction)", () => {
  it("approval-template | create-envelope yields a valid envelope that `run` (live) still refuses: no owner key, then no/forged signature", async () => {
    const dir = tmp();
    const ownerDir = join(dir, "owner");
    const spec = baseSpec();
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
    const t = io();
    expect(await main(["approval-template", "--spec", join(dir, "spec.json")], t.io, nonTtyStdin(), { ownerDir })).toBe(0);
    writeFileSync(join(dir, "appr.txt"), t.out[0]);
    expect(await main(["create-envelope", "--spec", join(dir, "spec.json"), "--approval-file", join(dir, "appr.txt"), "--approval-ref", "chat self", "--out", join(dir, "e.json")], t.io, nonTtyStdin(), { ownerDir })).toBe(0);
    const live = io();
    expect(await main(["run", "--envelope", join(dir, "e.json")], live.io, nonTtyStdin(), { ownerDir })).toBe(2);
    expect(live.err.join("\n")).toMatch(/no owner public key is registered/);
  });

  it("live run refuses --ledger-dir, --repo and --home overrides", async () => {
    const t = io();
    for (const f of ["--ledger-dir", "--repo", "--home"]) expect(await main(["run", "--envelope", "x.json", f, "somewhere"], t.io, nonTtyStdin(), { ownerDir: tmp() })).toBe(2);
    expect(t.err.join("\n")).toMatch(/not accepted/);
  });

  it("no signing or trust-writing code is reachable from the runner path (static check)", () => {
    const dir = join(HERE, "..");
    const forbidden = /signEnvelopeHash|writeTrust|generateOwnerKey|writeEncryptedKey|readEncryptedKey/;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      if (["ownersig.ts", "ownercli.ts"].includes(f)) continue;
      expect(forbidden.test(readFileSync(join(dir, f), "utf8")), `${f} must not contain signing / trust-writing code`).toBe(false);
    }
    // and cli.ts only reaches them through ownercli's interactive, TTY-only commands
    expect(readFileSync(join(dir, "cli.ts"), "utf8")).toMatch(/ownerKeygen|ownerSign/);
  });
});
