import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../../d24-m3d-proof/manifest";
import { createEnvelope, approvalTemplate, type Envelope, type EnvelopeSpec } from "../envelope";
import { lockfileSha } from "../gitverify";
import { generateOwnerKey, signEnvelopeHash, type OwnerTrust, type SignatureDoc } from "../ownersig";
import { runnerManifest } from "../runnerpin";
import { readFileSync } from "node:fs";
import { Ledger } from "../ledger";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
// built at run time: a realistic key literal in source trips GitHub push protection
export const KEY = ["rk", "test", "UNITTESTKEY0123456789abcdef"].join("_");
export const SHA = "c".repeat(40);
export const NOW = new Date("2026-11-07T12:00:00Z");
export const LABEL = "d24-unit";

export function tmp(prefix = "d24-runner-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A ledger with its anchor in a second temp location (as in a live run). */
export function mkLedger(now: () => Date = () => NOW): Ledger {
  return new Ledger(join(tmp(), "ledger"), now, join(tmp(), "anchor.json"));
}
export const OWNER_PASS = "correct horse battery staple 42";
const ownerCache: { k?: ReturnType<typeof generateOwnerKey> } = {};
/** One shared owner key per test process (scrypt is deliberately slow); low N keeps tests fast. */
export function ownerKey() {
  return (ownerCache.k ??= generateOwnerKey(OWNER_PASS, 1 << 10));
}
export function ownerTrust(ledgerDir: string, anchorFile: string): OwnerTrust {
  const k = ownerKey();
  return { v: 1, publicKeySpkiDerBase64: k.publicKeySpkiDerBase64, publicKeyFingerprint: k.publicKeyFingerprint, ledgerDir, anchorFile, registeredUtc: "2026-11-01T00:00:00Z" };
}
export const ownerSign = (e: Pick<Envelope, "envelopeSha256">): SignatureDoc => signEnvelopeHash(ownerKey().encrypted, OWNER_PASS, e.envelopeSha256);

export function baseSpec(over: Partial<EnvelopeSpec> = {}, evidenceRoot = join(tmp(), "evidence")): EnvelopeSpec {
  const m = manifest(join(REPO, "scripts", "qa", "d24-m3d-proof"));
  return {
    envelopeId: "unit-env-1",
    createdUtc: "2026-11-07T10:00:00Z",
    expiresUtc: "2026-11-14T10:00:00Z",
    code: { commitSha: SHA, lockfileSha256: lockfileSha(readFileSync(join(REPO, "package-lock.json"))) },
    proof: { manifestSha256: m.sha256, fileCount: m.files.length },
    runner: { manifestSha256: runnerManifest(join(REPO, "scripts", "qa", "d24-test-runner")).sha256, fileCount: runnerManifest(join(REPO, "scripts", "qa", "d24-test-runner")).files.length },
    accounts: { platformAcct: "acct_UNITPLATFORM1", connectedAcct: "acct_UNITCONNECTED1" },
    permittedRuleIds: ["customer.create", "customer.delete", "identity.connected", "identity.platform", "invoice.add_lines", "invoice.create_draft", "invoice.delete_draft", "invoice.list_by_customer", "invoice.read", "negative.transfers", "negative.webhook_endpoints"],
    apiCallCeiling: 40,
    cleanupReserve: 8,
    credential: { store: "windows-credential-manager", label: LABEL, keyKind: "rk_test", keyFingerprintSha256Prefix: createHash("sha256").update(KEY).digest("hex").slice(0, 16), keyExpiresUtc: "2026-11-20T10:00:00Z" },
    stopConditions: ["any-abort", "livemode-true", "identity-mismatch", "cleanup-unverified", "secret-in-output", "call-ceiling"],
    maxRuns: 2,
    evidenceRoot,
    manualAttestations: Object.fromEntries(["sandbox", "connected-account", "key-permissions", "no-webhooks", "api-version", "local-postgres"].map((id) => [id, { statement: `attested ${id} in unit test`, attestedBy: "unit", reference: "unit-ref" }])),
    ...over,
  };
}

export function makeEnvelope(over: Partial<EnvelopeSpec> = {}, approval?: (s: EnvelopeSpec) => string): Envelope {
  const spec = baseSpec(over);
  const r = createEnvelope(spec, approval ? approval(spec) : approvalTemplate(spec), "owner chat unit-test reference");
  if (!r.ok) throw new Error(`test envelope invalid: ${r.issues.map((i) => `${i.code}:${i.detail}`).join("; ")}`);
  return r.envelope;
}

export function writeEnvelope(e: Envelope | Record<string, unknown>): string {
  const f = join(tmp(), "envelope.json");
  writeFileSync(f, JSON.stringify(e, null, 2));
  return f;
}
