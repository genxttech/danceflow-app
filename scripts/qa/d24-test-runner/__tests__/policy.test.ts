import { describe, expect, it } from "vitest";
import { confirmFirstGroup, envelopeFingerprint, fingerprintOfFile, firstGroup, termsLines } from "../fingerprint";
import { clampEnvelopeToPolicy, parsePolicy, type ClampCtx, type Policy } from "../policy";
import { makeEnvelope, baseSpec } from "./helpers";
import { testAuth } from "./softauth";

const PM = baseSpec().proof.manifestSha256;
const POL: Policy = {
  v: 1, stripeMode: "test", keyKind: "rk_test", credentialStore: "dpapi-file",
  platformAcct: "acct_UNITPLATFORM1", connectedAcct: "acct_UNITCONNECTED1",
  maxCallsPerRun: 40, maxRunsPerEnvelope: 2, maxEnvelopeValidityDays: 7, maxRunsPerDay: 2,
  allowListSha256: PM, amountCeilingMinor: 20_000, anchorFingerprint: testAuth.anchor.fingerprintSha256,
  runAsAccount: "d24run", ownerAccount: "ownerperson",
};
const CTX: ClampCtx = { proofManifestSha256: PM, proofMaxLineCents: 20_000, evidenceRootAllowed: () => true, runsToday: 0 };
const ev = (over = {}) => makeEnvelope({ credential: { store: "dpapi-file", label: "d24-unit", keyKind: "rk_test", keyFingerprintSha256Prefix: "a".repeat(16), keyExpiresUtc: "2026-11-20T10:00:00Z" }, ...over });

describe("parsePolicy", () => {
  it("accepts the reference policy", () => expect(parsePolicy(POL, 40).ok).toBe(true));
  it("refuses anything that widens or changes the contract", () => {
    const bad = (o: object) => parsePolicy({ ...POL, ...o }, 40);
    expect(bad({ stripeMode: "live" }).ok).toBe(false);
    expect(bad({ keyKind: "sk_live" }).ok).toBe(false);
    expect(bad({ credentialStore: "windows-credential-manager" }).ok).toBe(false);
    expect(bad({ maxCallsPerRun: 41 }).ok).toBe(false);
    expect(parsePolicy({ ...POL, maxCallsPerRun: 40 }, 30).ok).toBe(false); // above the proof's own cap
    expect(bad({ maxRunsPerEnvelope: 6 }).ok).toBe(false);
    expect(bad({ maxEnvelopeValidityDays: 31 }).ok).toBe(false);
    expect(bad({ platformAcct: POL.connectedAcct }).ok).toBe(false);
    expect(bad({ runAsAccount: "ownerperson" }).ok).toBe(false);
    expect(bad({ anchorFingerprint: "xyz" }).ok).toBe(false);
    expect(bad({ extra: 1 }).ok).toBe(false);
    expect(parsePolicy({ ...POL, amountCeilingMinor: undefined }, 40).ok).toBe(false);
    expect(parsePolicy(null, 40).ok).toBe(false);
  });
});

describe("clampEnvelopeToPolicy: an envelope may equal or narrow the policy, never widen it", () => {
  it("a conforming envelope has no issue; a narrower one also passes", () => {
    expect(clampEnvelopeToPolicy(ev(), POL, CTX)).toEqual([]);
    expect(clampEnvelopeToPolicy(ev({ maxRuns: 1 }), POL, CTX)).toEqual([]);
  });
  it("each ceiling, pin and scope is enforced separately", () => {
    const one = (e: ReturnType<typeof ev>, pol = POL, ctx = CTX) => clampEnvelopeToPolicy(e, pol, ctx);
    expect(one(ev({ maxRuns: 3 })).join()).toMatch(/maxRuns 3/);
    expect(one(ev(), { ...POL, maxCallsPerRun: 30 }).join()).toMatch(/apiCallCeiling 40/);
    expect(one(ev({ expiresUtc: "2026-11-15T10:00:00Z" })).join()).toMatch(/validity/);
    expect(one(ev({ accounts: { platformAcct: "acct_OTHERPLAT01", connectedAcct: POL.connectedAcct } })).join()).toMatch(/platform account/);
    expect(one(ev({ accounts: { platformAcct: POL.platformAcct, connectedAcct: "acct_OTHERCONN01" } })).join()).toMatch(/connected account/);
    expect(one(ev({ hardwareAnchorFingerprintSha256: "b".repeat(64) })).join()).toMatch(/different hardware anchor/);
    expect(one(ev(), POL, { ...CTX, runsToday: 2 }).join()).toMatch(/already started today/);
    expect(one(ev(), POL, { ...CTX, proofManifestSha256: "c".repeat(64) }).join()).toMatch(/installed proof folder/);
    expect(one(ev({ proof: { manifestSha256: "d".repeat(64), fileCount: 3 } })).join()).toMatch(/envelope's proof manifest/);
    expect(one(ev(), POL, { ...CTX, proofMaxLineCents: 20_001 }).join()).toMatch(/amount ceiling/);
    expect(one(ev(), POL, { ...CTX, proofMaxLineCents: null }).join()).toMatch(/unreadable/);
    expect(one(ev(), POL, { ...CTX, evidenceRootAllowed: () => false }).join()).toMatch(/evidenceRoot/);
  });
  it("user-profile credential back ends are refused for installed runs", () => {
    expect(clampEnvelopeToPolicy(makeEnvelope(), POL, CTX).join()).toMatch(/credential store must be dpapi-file/);
  });
});

describe("envelope fingerprint", () => {
  it("is 12 uppercase hex in three groups, derived from the content, and differs per envelope", () => {
    const a = ev();
    const b = ev({ envelopeId: "unit-env-2" });
    const fa = envelopeFingerprint(a.envelopeSha256);
    expect(fa).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(envelopeFingerprint(b.envelopeSha256)).not.toBe(fa);
    expect(() => envelopeFingerprint("short")).toThrow();
  });
  it("confirmation needs exactly the first group (case-insensitive), nothing more, nothing less", () => {
    const fp = "7F3A-91C2-0B5D";
    expect(firstGroup(fp)).toBe("7F3A");
    expect(confirmFirstGroup("7f3a", fp)).toBe(true);
    expect(confirmFirstGroup(" 7F3A ", fp)).toBe(true);
    for (const t of ["", "7F3", "7F3A-91C2", "91C2", "7F3A7F3A", "yes"]) expect(confirmFirstGroup(t, fp), t).toBe(false);
  });
  it("fingerprintOfFile recomputes from content: an edited body with the old hash field is refused", () => {
    const e = ev();
    expect(fingerprintOfFile(e).ok).toBe(true);
    const edited = { ...e, maxRuns: 1 };
    const r = fingerprintOfFile(edited);
    expect(r.ok).toBe(false);
    const t = termsLines(e).join("\n");
    expect(t).toContain(envelopeFingerprint(e.envelopeSha256));
    expect(t).toContain(e.accounts.platformAcct);
  });
});
