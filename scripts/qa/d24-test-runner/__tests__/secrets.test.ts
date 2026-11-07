import { describe, expect, it } from "vitest";
import { baseEnv, proofEnv } from "../childenv";
import { DpapiFileStore, MemoryStore, WindowsCredentialManagerStore, type PsRunner } from "../credstore";
import { checkEnvironment } from "../../d24-m3d-proof/identity";
import { hasSecretFinding, sanitize, scanForSecrets } from "../scan";
import { analyzeEvidence, redactionScan, renderReport, type RunSummary } from "../postrun";
import { KEY, makeEnvelope, NOW, tmp } from "./helpers";

const HOSTILE = [
  ["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_"),
  ["rk", "test", "ZZZZZZZZZZZZZZZZZZZZ"].join("_"),
  ["pk", "test", "pubpubpubpubpubpub"].join("_"),
  "whsec_abcdefghijklmnop1234",
  "Authorization: Bearer abcdefghijklmnop123456",
  "Bearer abcdefghijklmnopqrstuv",
  "owner@example.com",
];

describe("scan / sanitize with hostile content", () => {
  it("finds every secret shape and never returns the matched text", () => {
    for (const h of HOSTILE) {
      const f = scanForSecrets(`prefix ${h} suffix`);
      expect(hasSecretFinding(f), h).toBe(true);
      expect(JSON.stringify(f)).not.toContain(h);
      expect(sanitize(`x ${h} y`)).not.toContain(h.replace(/^Authorization: /, "").replace(/^Bearer /, ""));
    }
  });
  it("catches a key glued to word characters and the exact credential literal in any text", () => {
    expect(hasSecretFinding(scanForSecrets(`abc_${KEY}def`))).toBe(true);
    expect(scanForSecrets(`token=${KEY.slice(0, 20)}`, [KEY.slice(0, 20)]).map((f) => f.kind)).toContain("exact-credential-literal");
    expect(sanitize(`value ${KEY.slice(0, 24)}`, [KEY.slice(0, 24)])).not.toContain(KEY.slice(0, 24));
  });
  it("flags an unmasked account id as a warning only", () => {
    const f = scanForSecrets("acct_1ABCDEFGHIJKLMN");
    expect(f[0].severity).toBe("warn");
    expect(hasSecretFinding(f)).toBe(false);
  });
});

describe("child environment sanitisation", () => {
  const parent = {
    PATH: "C:\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\t",
    NODE_OPTIONS: "--require evil.js", NODE_USE_SYSTEM_CA: "1", NODE_EXTRA_CA_CERTS: "ca.pem", SSL_CERT_FILE: "x", HTTPS_PROXY: "http://p", http_proxy: "http://p", ALL_PROXY: "x", NODE_USE_ENV_PROXY: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0", DATABASE_URL: "postgres://prod.example/db", SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOi", PGHOST: "db.supabase.co",
    STRIPE_SECRET_KEY: ["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_"), D24_PROOF_STRIPE_KEY: "ambient-should-not-pass", D24_HOSTED_INVOICE_CREATION: "on", RANDOM_VAR: "x",
  };
  it("drops everything not on the allow-list (names only are reported)", () => {
    const b = baseEnv(parent);
    expect(Object.keys(b.env).sort()).toEqual(["PATH", "SystemRoot", "TEMP"]);
    expect(b.droppedNames).toContain("NODE_OPTIONS");
    expect(JSON.stringify(b)).not.toContain("--require");
  });
  it("proof env carries the key only as D24_PROOF_STRIPE_KEY and passes the proof's own environment check", () => {
    const e = makeEnvelope();
    const pe = proofEnv(parent, { key: KEY, evidenceDir: "C:\\ev\\run-1", envelope: e });
    expect(checkEnvironment(pe.env)).toEqual([]);
    expect(Object.entries(pe.env).filter(([, v]) => v.includes(KEY)).map(([k]) => k)).toEqual(["D24_PROOF_STRIPE_KEY"]);
    expect(pe.env.D24_PROOF_PINNED_SHA256).toBe(e.proof.manifestSha256);
    expect(pe.env.D24_PROOF_EXPECT_CONNECTED_ACCT).toBe(e.accounts.connectedAcct);
    expect(pe.env.NODE_OPTIONS).toBeUndefined();
    expect(pe.env.DATABASE_URL).toBeUndefined();
    expect(pe.env.STRIPE_SECRET_KEY).toBeUndefined();
  });
  it("a parent value that looks like a live key is dropped even on an allow-listed name", () => {
    const b = baseEnv({ PATH: ["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_") });
    expect(b.env.PATH).toBeUndefined();
  });
});

describe("credential stores (fake PowerShell runner: no real store access)", () => {
  const spy = () => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    const ps: PsRunner = async (script, stdin) => {
      calls.push({ script, stdin });
      return script.includes("[D24Cred]::Write") ? { code: 0, stdout: "OK\n", stderr: "" } : { code: 0, stdout: `SECRET:${KEY}\n`, stderr: "" };
    };
    return { calls, ps };
  };
  it("write sends the secret only on stdin, never inside the script (which is what reaches argv)", async () => {
    const { calls, ps } = spy();
    await new WindowsCredentialManagerStore(ps).write("unit-label", KEY);
    expect(calls[0].stdin).toBe(KEY);
    expect(calls[0].script).not.toContain(KEY);
  });
  it("read returns the value; a failing helper never echoes its stdout in the error", async () => {
    expect(await new WindowsCredentialManagerStore(spy().ps).read("unit-label")).toBe(KEY);
    const leaky: PsRunner = async () => ({ code: 1, stdout: `SECRET:${KEY}`, stderr: KEY });
    await expect(new WindowsCredentialManagerStore(leaky).read("unit-label")).rejects.toThrow(/exit 1/);
    await new WindowsCredentialManagerStore(leaky).read("unit-label").catch((e: Error) => expect(e.message).not.toContain(KEY));
    const weird: PsRunner = async () => ({ code: 0, stdout: `garbage ${KEY}`, stderr: "" });
    await new WindowsCredentialManagerStore(weird).read("unit-label").catch((e: Error) => expect(e.message).not.toContain(KEY));
  });
  it("rejects labels that could inject into the script and refuses multi-line or empty secrets", async () => {
    const s = new WindowsCredentialManagerStore(spy().ps);
    for (const bad of ["x'; Remove-Item *", "a b", "", "../x", "ab"]) await expect(s.read(bad), bad).rejects.toThrow(/label/);
    await expect(s.write("unit-label", "a\nb")).rejects.toThrow();
    await expect(s.write("unit-label", "")).rejects.toThrow();
  });
  it("MISSING maps to null", async () => {
    const ps: PsRunner = async () => ({ code: 0, stdout: "MISSING\n", stderr: "" });
    expect(await new WindowsCredentialManagerStore(ps).read("unit-label")).toBeNull();
  });
  it("DPAPI store writes only the encrypted blob (the fake returns a non-secret blob) and locks the ACL", async () => {
    const dir = tmp();
    let locked = "";
    const ps: PsRunner = async (script) => (script.includes("::Protect(") ? { code: 0, stdout: "SECRET:QUJDRA==\n", stderr: "" } : { code: 0, stdout: `SECRET:${KEY}\n`, stderr: "" });
    const s = new DpapiFileStore(dir, ps, async (f) => { locked = f; });
    await s.write("unit-label", KEY);
    expect(locked).toMatch(/cred-unit-label\.dpapi$/);
    expect(await s.read("unit-label")).toBe(KEY);
    expect(await s.read("unit-other")).toBeNull();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(locked, "utf8")).not.toContain(KEY);
  });
  it("memory store works", async () => {
    const m = new MemoryStore();
    await m.write("x", "y");
    expect(await m.read("x")).toBe("y");
  });
});

describe("post-run redaction check", () => {
  it("flags secrets planted in the evidence, transcript or child output, with the exact-key literal check", () => {
    const f = redactionScan([{ name: "evidence", text: JSON.stringify({ note: HOSTILE[0] }) }, { name: "child-stdout", text: `hello ${KEY}` }, { name: "ok", text: "nothing here" }], [KEY]);
    const kinds = f.map((x) => x.kind).join("|");
    expect(kinds).toMatch(/stripe-key @ evidence/);
    expect(kinds).toMatch(/exact-credential-literal @ child-stdout/);
    expect(kinds).not.toMatch(/@ ok/);
    expect(JSON.stringify(f)).not.toContain(KEY);
  });
  it("the report never contains hostile content that ended up in evidence fields", () => {
    const e = makeEnvelope();
    const ev = JSON.stringify({ outcome: "OK", mode: "live", scriptManifestSha256: e.proof.manifestSha256, callsUsed: 30, blockedBeforeNetwork: 0, scenarios: [], verdicts: { V4: { verdict: "NOT TESTED" } }, cleanup: { verifiedEmpty: true, unverifiable: [] }, abort: { code: HOSTILE[0], message: `${HOSTILE[1]} owner@example.com` } });
    const analysis = analyzeEvidence(ev, e);
    const summary: RunSummary = { status: "FAIL", statusReason: `bad ${HOSTILE[2]}`, envelope: e, runNo: 1, runId: "r", startedUtc: "s", finishedUtc: "f", childExitCode: 1, analysis, safetyFindings: [], fileHashes: [], gates: [{ id: "g", ok: false, detail: `d ${HOSTILE[3]} ${KEY}` }], dry: true, runnerManifestSha256: "0".repeat(64) };
    const report = renderReport(summary, NOW);
    for (const h of [HOSTILE[0], HOSTILE[1], HOSTILE[2], HOSTILE[3], "owner@example.com"]) expect(report).not.toContain(h);
    expect(report).not.toContain(KEY);
  });
});
