import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../cli";
import { approvalTemplate, createEnvelope, envelopeHash, materialDigest, UNSAFE_CHARS, validateEnvelope, type Envelope } from "../envelope";
import { createFakeExec } from "../fakeChild";
import { OWNER_TOOL_FILES, ownerCanonicalHash, ownerKeygen, ownerRotate, ownerSign, ownerToolsSha256, renderTerms, show, type Pristine, type Prompter } from "../ownercli";
import { ownerMain } from "../ownermain";
import { generateOwnerKey, signEnvelopeHash } from "../ownersig";
import { defaultOwnerDir, defaultRunnerHome, loadTrust, ownerSeparationWarning, privateKeyPath, trustPath, verifyOwnerSignature } from "../ownerverify";
import { baseSpec, makeEnvelope, OWNER_PASS, ownerKey, ownerSign as signHelper, ownerTrust, REPO, SHA, tmp, writeEnvelope } from "./helpers";

vi.setConfig({ testTimeout: 90_000 }); // scrypt N=2^17 key generation is deliberately slow
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "..");
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
const pristine = (over: { fake?: Parameters<typeof createFakeExec>[0]; toolsDir?: string } = {}): Pristine => ({ repoDir: REPO, commitSha: SHA, exec: createFakeExec({ commitSha: SHA, repoDir: REPO, ...over.fake }), env: {}, toolsDir: over.toolsDir });

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
    const other = generateOwnerKey("another passphrase 1234567", 1 << 10);
    const forged = signEnvelopeHash(other.encrypted, "another passphrase 1234567", e.envelopeSha256, 1 << 10);
    expect(verifyOwnerSignature(e.envelopeSha256, forged, trust).reason).toMatch(/not the registered owner key/);
    expect(verifyOwnerSignature(e.envelopeSha256, { ...forged, publicKeyFingerprint: trust.publicKeyFingerprint }, trust).ok).toBe(false);
    const flipped = Buffer.from(sig.signatureBase64, "base64");
    flipped[0] ^= 1;
    expect(verifyOwnerSignature(e.envelopeSha256, { ...sig, signatureBase64: flipped.toString("base64") }, trust).ok).toBe(false);
    expect(verifyOwnerSignature(e.envelopeSha256, { nope: 1 }, trust).ok).toBe(false);
    expect(verifyOwnerSignature(e.envelopeSha256, null, trust).ok).toBe(false);
  });
  it("a wrong passphrase cannot sign; a short passphrase cannot create a key", () => {
    expect(() => signEnvelopeHash(ownerKey().encrypted, "not the passphrase", e.envelopeSha256, 1 << 10)).toThrow(/wrong passphrase/);
    expect(() => generateOwnerKey("short", 1 << 10)).toThrow(/at least 16/);
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
  it("the approval text must carry a digest of all material terms (terms=…)", () => {
    const spec = baseSpec();
    expect(createEnvelope(spec, approvalTemplate(spec), "ref ref").ok).toBe(true);
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

describe("N-1: the owner directory ignores the environment", () => {
  it("setting LOCALAPPDATA / HOME / USERPROFILE / APPDATA / HOMEDRIVE changes nothing", () => {
    const before = [defaultOwnerDir(), defaultRunnerHome()];
    const saved: Record<string, string | undefined> = {};
    const names = ["LOCALAPPDATA", "APPDATA", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME"];
    for (const n of names) saved[n] = process.env[n];
    try {
      for (const n of names) process.env[n] = join(tmp(), "attacker-controlled");
      expect([defaultOwnerDir(), defaultRunnerHome()]).toEqual(before);
      expect(before[0].startsWith(join(tmp(), "attacker-controlled"))).toBe(false);
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
    expect(before[0]).toBe(join(userInfo().homedir, "AppData", "Local", "DanceFlow", "d24-owner"));
  });
  it("a live `run` reads the trust from the fixed owner dir (ctx is a test seam, not a CLI/env option)", async () => {
    const t = io();
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join(tmp(), "evil");
    try {
      expect(await main(["run", "--envelope", writeEnvelope(makeEnvelope())], t.io, nonTtyStdin())).toBe(2); // fixed dir: no trust registered in this environment's real profile
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });
  it("loud, non-refusing warning when the same account registered/can write the owner dir", () => {
    const t = ownerTrust("L", "A");
    const me = userInfo().username;
    expect(ownerSeparationWarning("D", { ...t, registeredBy: me }, me, () => false)).toMatch(/WARNING.*does NOT separate/);
    expect(ownerSeparationWarning("D", { ...t, registeredBy: "someone-else" }, me, () => true)).toMatch(/writable by the current account/);
    expect(ownerSeparationWarning("D", { ...t, registeredBy: "someone-else" }, me, () => false)).toBeNull();
  });
  it("`run` prints the warning (to stderr) and still refuses on the missing signature; dry prints nothing and is not refused", async () => {
    const ownerDir = tmp();
    mkdirSync(ownerDir, { recursive: true });
    const trust = { ...ownerTrust(join(tmp(), "l"), join(ownerDir, "a.json")), registeredBy: userInfo().username };
    writeFileSync(trustPath(ownerDir), JSON.stringify(trust));
    const live = io();
    expect(await main(["run", "--envelope", writeEnvelope(makeEnvelope())], live.io, nonTtyStdin(), { ownerDir })).toBe(2);
    expect(live.err.join("\n")).toMatch(/WARNING: the owner trust directory/);
    expect(live.out.join("\n")).toMatch(/FAIL {2}owner-signature/);
    const dry = io();
    await main(["run", "--dry", "--envelope", writeEnvelope(makeEnvelope())], dry.io, nonTtyStdin(), { ownerDir });
    expect(dry.err.join("\n")).not.toMatch(/WARNING/);
  });
});

describe("N-1: signing and trust-writing code is not reachable from the runner (static import scan)", () => {
  const imports = (src: string) => [...src.matchAll(/from "(\.\/[a-z]+)"/g)].map((m) => m[1]);
  const files = readdirSync(TOOLS).filter((x) => x.endsWith(".ts"));
  it("only ownercli.ts and ownermain.ts import ownersig; only ownermain.ts imports ownercli; nothing imports ownermain", () => {
    for (const f of files) {
      const imp = imports(readFileSync(join(TOOLS, f), "utf8"));
      if (imp.includes("./ownersig")) expect(["ownercli.ts", "ownermain.ts"], `${f} imports ownersig`).toContain(f);
      if (imp.includes("./ownercli")) expect(["ownermain.ts"], `${f} imports ownercli`).toContain(f);
      expect(imp, `${f} imports ownermain`).not.toContain("./ownermain");
    }
  });
  it("the runner and the runner CLI import verification only", () => {
    for (const f of ["runner.ts", "cli.ts", "ledger.ts", "postrun.ts", "childenv.ts"]) {
      const src = readFileSync(join(TOOLS, f), "utf8");
      expect(imports(src), f).not.toContain("./ownersig");
      expect(imports(src), f).not.toContain("./ownercli");
      expect(src, f).not.toMatch(/signEnvelopeHash|writeTrust|generateOwnerKey|writeEncryptedKey|readEncryptedKey|rotateTrust/);
    }
  });
  it("ownerverify.ts exports nothing that signs or writes", () => {
    expect(readFileSync(join(TOOLS, "ownerverify.ts"), "utf8")).not.toMatch(/writeFileSync|createPrivateKey|sign\(/);
  });
});

describe("N-2: owner commands run only from a pristine, reviewed checkout", () => {
  const keygen = async (pr: Pristine, dir: string) => {
    const t = io();
    const code = await ownerKeygen(t.io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), pr, dir, join(tmp(), "pinned-ledger"));
    return { code, t };
  };
  it("refuses keygen on a dirty tree, a wrong HEAD, or hidden edits; registers nothing", async () => {
    for (const fake of [{ dirty: true }, { commitSha: "d".repeat(40) }, { hiddenEdit: true }]) {
      const dir = tmp();
      const { code, t } = await keygen(pristine({ fake: { commitSha: SHA, repoDir: REPO, ...fake } }), dir);
      expect(code, JSON.stringify(fake)).toBe(2);
      expect(t.err.join()).toMatch(/pristine checkout/);
      expect(existsSync(trustPath(dir))).toBe(false);
    }
  });
  it("keygen records the tool hash, commit and account; a second keygen is refused (no silent re-registration)", async () => {
    const dir = tmp();
    const { code } = await keygen(pristine(), dir);
    expect(code).toBe(0);
    const trust = loadTrust(dir);
    expect(trust?.ownerToolsSha256).toBe(ownerToolsSha256());
    expect(trust?.registeredAtCommit).toBe(SHA);
    expect(trust?.registeredBy).toBe(userInfo().username);
    expect((await keygen(pristine(), dir)).code).toBe(2);
  });
  it("owner-sign refuses on a dirty tree and when the owner-tool files changed since keygen", async () => {
    const dir = tmp();
    await keygen(pristine(), dir);
    const env = makeEnvelope();
    const file = writeEnvelope(env);
    const answers = { lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: [OWNER_PASS] };
    const dirty = io();
    expect(await ownerSign(dirty.io, prompter(answers), pristine({ fake: { commitSha: SHA, repoDir: REPO, dirty: true } }), file, join(tmp(), "s.json"), dir)).toBe(2);
    expect(dirty.err.join()).toMatch(/pristine checkout/);
    // a modified copy of the owner tools
    const copy = tmp("d24-tools-");
    for (const f of OWNER_TOOL_FILES) cpSync(join(TOOLS, f), join(copy, f));
    writeFileSync(join(copy, "ownercli.ts"), `${readFileSync(join(copy, "ownercli.ts"), "utf8")}\n// tampered\n`);
    const tampered = io();
    expect(await ownerSign(tampered.io, prompter(answers), pristine({ toolsDir: copy }), file, join(tmp(), "s2.json"), dir)).toBe(2);
    expect(tampered.err.join()).toMatch(/owner-tool files differ/);
  });
  it("owner-rotate needs the OLD passphrase, signs a rotation statement, and re-binds the tools", async () => {
    const dir = tmp();
    await keygen(pristine(), dir);
    const copy = tmp("d24-tools-");
    for (const f of OWNER_TOOL_FILES) cpSync(join(TOOLS, f), join(copy, f));
    writeFileSync(join(copy, "ownercli.ts"), `${readFileSync(join(copy, "ownercli.ts"), "utf8")}\n// reviewed change\n`);
    await expect(ownerRotate(io().io, prompter({ hidden: ["wrong old passphrase"] }), pristine({ toolsDir: copy }), dir)).rejects.toThrow(/wrong passphrase/);
    const before = loadTrust(dir)!;
    expect(await ownerRotate(io().io, prompter({ hidden: [OWNER_PASS] }), pristine({ toolsDir: copy }), dir)).toBe(0);
    const after = loadTrust(dir)!;
    expect(after.publicKeyFingerprint).toBe(before.publicKeyFingerprint);
    expect(after.ownerToolsSha256).toBe(ownerToolsSha256(copy));
    expect(after.rotation?.statement).toMatch(/D24-OWNER-ROTATE-V1/);
    expect(await ownerRotate(io().io, prompter({ tty: false }), pristine(), dir)).toBe(2);
    expect(existsSync(privateKeyPath(dir))).toBe(true);
  });
  it("owner-sign displays and signs an INDEPENDENTLY recomputed canonical hash", () => {
    for (const e of [makeEnvelope(), makeEnvelope({ manualAttestations: { "123": { statement: "numeric id attestation", attestedBy: "unit", reference: "unit-ref" }, ...baseSpec().manualAttestations } })]) {
      expect(ownerCanonicalHash(e as unknown as Record<string, unknown>)).toBe(e.envelopeSha256);
    }
  });
  it("ownerMain: non-TTY refused; --commit is required", async () => {
    const t = io();
    expect(await ownerMain(["owner-keygen", "--commit", SHA], t.io, nonTtyStdin(), { ownerDir: tmp(), pristine: pristine() })).toBe(2);
    expect(t.err.join()).toMatch(/interactive terminal/);
    const u = io();
    expect(await ownerMain(["owner-sign", "--envelope", "x.json"], u.io, nonTtyStdin(), { ownerDir: tmp() })).toBe(2);
    expect(u.err.join()).toMatch(/--commit/);
  });
});

describe("owner-sign end to end", () => {
  it("prints every escaped term and the recomputed hash, needs the typed hash and passphrase, and leaks no private material", async () => {
    const dir = tmp();
    const k = io();
    expect(await ownerKeygen(k.io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), pristine(), dir, join(tmp(), "pinned-ledger"))).toBe(0);
    const trust = loadTrust(dir);
    expect(trust?.ledgerDir).toMatch(/pinned-ledger$/);
    const keyFile = readFileSync(join(dir, "owner-key.enc.json"), "utf8");
    expect(keyFile).not.toContain("PRIVATE KEY");
    const env = makeEnvelope();
    const file = writeEnvelope(env);
    const out = join(tmp(), "e.sig.json");
    const wrongConfirm = io();
    expect(await ownerSign(wrongConfirm.io, prompter({ lines: ["yes"], hidden: [OWNER_PASS] }), pristine(), file, out, dir)).toBe(2);
    expect(existsSync(out)).toBe(false);
    await expect(ownerSign(io().io, prompter({ lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: ["definitely wrong pass"] }), pristine(), file, out, dir)).rejects.toThrow(/wrong passphrase/);
    const good = io();
    expect(await ownerSign(good.io, prompter({ lines: [`SIGN ${env.envelopeSha256.slice(0, 12)}`], hidden: [OWNER_PASS] }), pristine(), file, out, dir)).toBe(0);
    const shown = good.out.join("\n");
    expect(shown).toContain(`canonical hash recomputed by this tool: ${env.envelopeSha256}`);
    for (const term of renderTerms(env)) expect(shown).toContain(term);
    for (const must of [env.accounts.platformAcct, env.accounts.connectedAcct, env.credential.keyFingerprintSha256Prefix, env.code.lockfileSha256, env.runner.manifestSha256, "invoice.create_draft"]) expect(shown).toContain(must);
    const sigText = readFileSync(out, "utf8");
    expect(verifyOwnerSignature(env.envelopeSha256, JSON.parse(sigText), trust).ok).toBe(true);
    expect(sigText + shown).not.toMatch(/PRIVATE/);
    expect(shown).not.toContain(OWNER_PASS);
  });
  it("refuses an invalid envelope and an unregistered machine", async () => {
    const t = io();
    expect(await ownerSign(t.io, prompter({}), pristine(), writeEnvelope(makeEnvelope()), join(tmp(), "s.json"), tmp())).toBe(2);
    expect(t.err.join()).toMatch(/no owner key/);
  });
});

describe("N-3: terminal-escape injection", () => {
  const evil = ["\u001b[2J\u001b[1;1Hno risk here", "line one\rSIGN something harmless", "approved‮txeT", "nul\u0000byte", "bell\u0007", "line\nbreak", "zero​width", "isolate⁦x"];
  const mutate = (e: Envelope, path: string[], value: string): unknown => {
    const c = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    let cur: Record<string, unknown> = c;
    for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
    cur[path[path.length - 1]] = value;
    return c;
  };
  it("validateEnvelope rejects ANSI, CR, LF, NUL, bell, bidi and zero-width characters in every kind of string field", () => {
    const e = makeEnvelope();
    const targets = [["envelopeId"], ["evidenceRoot"], ["credential", "label"], ["manualAttestations", "sandbox", "statement"], ["manualAttestations", "sandbox", "attestedBy"], ["ownerApproval", "text"], ["ownerApproval", "reference"], ["accounts", "platformAcct"], ["stopConditions"]];
    for (const bad of evil) {
      expect(UNSAFE_CHARS.test(bad)).toBe(true);
      for (const t of targets) {
        const v = mutate(e, t, bad);
        const r = validateEnvelope(t[0] === "stopConditions" ? { ...(v as object), stopConditions: [bad] } : v);
        expect(r.ok, `${JSON.stringify(bad)} in ${t.join(".")}`).toBe(false);
        expect(JSON.stringify((r as { issues: Array<{ code: string }> }).issues[0]), "no raw control characters in the refusal").not.toMatch(/\\u001b|\u001b|\r|‮/);
        expect((r as { issues: Array<{ code: string }> }).issues[0].code).toBe("control-char");
      }
    }
  });
  it("also rejects a control character in an object KEY", () => {
    const e = JSON.parse(JSON.stringify(makeEnvelope())) as Record<string, Record<string, unknown>>;
    e.manualAttestations["bad\u001b[31mkey"] = { statement: "a statement long enough", attestedBy: "unit", reference: "unit-ref" };
    (e as unknown as Record<string, unknown>).envelopeSha256 = envelopeHash(e as unknown as Envelope); // re-seal so only the key is wrong
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
    expect((r as { issues: Array<{ code: string }> }).issues[0].code).toBe("control-char");
  });
  it("the review screen escapes everything: even an envelope that bypassed validation prints no raw control/bidi byte", () => {
    const e = JSON.parse(JSON.stringify(makeEnvelope())) as Envelope;
    e.manualAttestations.sandbox.statement = "\u001b[2J\u001b[1;1H fake screen \r SIGN ‮evil";
    e.envelopeId = "id\u001b[31m";
    const text = renderTerms(e).join("\n") + show("‮\r\u001b");
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    expect(text).toContain("\\u001b");
    expect(text).toContain("\\u202e");
  });
  it("ownerSign refuses an envelope carrying escape sequences and prints none", async () => {
    const dir = tmp();
    await ownerKeygen(io().io, prompter({ hidden: [OWNER_PASS, OWNER_PASS] }), pristine(), dir);
    const t = io();
    const bad = mutate(makeEnvelope(), ["manualAttestations", "sandbox", "statement"], "\u001b[2Jhidden");
    expect(await ownerSign(t.io, prompter({ lines: ["x"], hidden: [OWNER_PASS] }), pristine(), writeEnvelope(bad as Record<string, unknown>), join(tmp(), "s.json"), dir)).toBe(2);
    expect(t.err.join("\n") + t.out.join("\n")).not.toContain("\u001b");
  });
});

describe("self-approval is closed (review P1-1 reproduction)", () => {
  it("approval-template | create-envelope yields a valid envelope that `run` (live) still refuses", async () => {
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
});
