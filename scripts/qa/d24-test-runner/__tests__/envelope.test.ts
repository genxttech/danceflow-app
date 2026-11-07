import { describe, expect, it } from "vitest";
import { approvalTemplate, checkEnvelopeWindow, createEnvelope, envelopeHash, validateEnvelope } from "../envelope";
import { baseSpec, makeEnvelope } from "./helpers";

const issuesOf = (raw: unknown) => {
  const v = validateEnvelope(raw);
  return v.ok ? [] : v.issues.map((i) => `${i.code}: ${i.detail}`);
};
/** re-seal after editing so only the targeted rule can fire */
const seal = (e: Record<string, any>) => ({ ...e, envelopeSha256: envelopeHash(e as any) }); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("envelope validation", () => {
  it("accepts a well-formed envelope and its canonical hash is stable", () => {
    const e = makeEnvelope();
    expect(validateEnvelope(e).ok).toBe(true);
    expect(envelopeHash(e)).toBe(e.envelopeSha256);
    expect(envelopeHash({ ...e, credential: { ...e.credential } })).toBe(e.envelopeSha256);
  });

  it("refuses any edit after creation (hash mismatch)", () => {
    const e = { ...makeEnvelope(), maxRuns: 5 };
    expect(issuesOf(e).join()).toMatch(/hash|approval/);
  });

  it("refuses unknown fields and missing fields", () => {
    expect(issuesOf({ ...makeEnvelope(), extra: 1 }).join()).toMatch(/unknown-field/);
    const { maxRuns: _m, ...rest } = makeEnvelope();
    void _m;
    expect(issuesOf(rest).join()).toMatch(/missing-field/);
  });

  it("refuses unknown and fee-bearing / financial / LIVE operation types", () => {
    for (const bad of ["invoice.finalize", "invoice.send", "invoice.pay", "refund.create", "payout.create", "charge.create", "live.invoice.create"]) {
      const e = seal({ ...makeEnvelope(), permittedRuleIds: [...makeEnvelope().permittedRuleIds, bad].sort() });
      expect(issuesOf(e).join(), bad).toMatch(/unknown-operation/);
    }
    expect(issuesOf(seal({ ...makeEnvelope(), permittedRuleIds: ["invoice.finalize"] })).join()).toMatch(/fee-bearing, financial or LIVE/);
  }, 30_000);

  it("refuses LIVE mode and a relaxed forbidden block", () => {
    expect(issuesOf(seal({ ...makeEnvelope(), mode: "LIVE" })).join()).toMatch(/mode/);
    expect(issuesOf(seal({ ...makeEnvelope(), forbidden: { feeBearing: true, financialMutation: false, liveMode: true } })).join()).toMatch(/forbidden/);
  });

  it("refuses an unlimited or oversized run count and a ceiling above 40", () => {
    for (const n of [0, 6, Infinity, -1, 1.5, null]) expect(issuesOf(seal({ ...makeEnvelope(), maxRuns: n })).join(), String(n)).toMatch(/max-runs/);
    for (const n of [41, 100, 0, 8, NaN]) expect(issuesOf(seal({ ...makeEnvelope(), apiCallCeiling: n })).join(), String(n)).toMatch(/ceiling/);
  });

  it("refuses an envelope that lives longer than 30 days or expires before it starts", () => {
    expect(issuesOf(seal({ ...makeEnvelope(), expiresUtc: "2027-03-01T00:00:00Z" })).join()).toMatch(/at most 30 days|key must outlive/);
    expect(issuesOf(seal({ ...makeEnvelope(), expiresUtc: "2026-11-01T00:00:00Z" })).join()).toMatch(/after createdUtc/);
  });

  it("refuses a credential that is not a restricted rk_test key, or that expires before the envelope", () => {
    for (const k of ["sk_test", "rk_live", "pk_test", "sk_live"]) expect(issuesOf(seal({ ...makeEnvelope(), credential: { ...makeEnvelope().credential, keyKind: k } })).join(), k).toMatch(/keyKind/);
    expect(issuesOf(seal({ ...makeEnvelope(), credential: { ...makeEnvelope().credential, keyExpiresUtc: "2026-11-08T00:00:00Z" } })).join()).toMatch(/outlive/);
  });

  it("requires the required stop conditions and cleanup verification", () => {
    expect(issuesOf(seal({ ...makeEnvelope(), stopConditions: ["any-abort"] })).join()).toMatch(/stop-conditions/);
    expect(issuesOf(seal({ ...makeEnvelope(), cleanup: { required: true, mustVerifyEmpty: false } })).join()).toMatch(/cleanup/);
  });

  it("refuses identical platform/connected ids and a relative evidence root", () => {
    expect(issuesOf(seal({ ...makeEnvelope(), accounts: { platformAcct: "acct_SAMESAMESAME", connectedAcct: "acct_SAMESAMESAME" } })).join()).toMatch(/differ/);
    expect(issuesOf(seal({ ...makeEnvelope(), evidenceRoot: "evidence" })).join()).toMatch(/evidence-root/);
  });
});

describe("owner approval binding (the runner cannot mint its own approval)", () => {
  it("refuses approval text that does not name the exact terms", () => {
    const r = createEnvelope(baseSpec(), "Approved: D24 M3-D Stripe TEST proof as written", "ref");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.map((i) => i.detail).join()).toMatch(/envelope=|code=|manifest=|maxRuns=|expires=/);
  });
  it("refuses empty approval text and text lacking the proof's authorization sentence", () => {
    expect(createEnvelope(baseSpec(), "", "ref").ok).toBe(false);
    const spec = baseSpec();
    expect(createEnvelope(spec, approvalTemplate(spec).replace("Approved: D24 M3-D Stripe TEST proof as written", "ok go"), "ref").ok).toBe(false);
  });
  it("an approval for other terms (more runs, other commit) cannot be reused", () => {
    const old = approvalTemplate(baseSpec({ maxRuns: 1 }));
    expect(createEnvelope(baseSpec({ maxRuns: 2 }), old, "ref").ok).toBe(false);
    expect(createEnvelope(baseSpec({ code: { commitSha: "d".repeat(40), lockfileSha256: baseSpec().code.lockfileSha256 } }), old, "ref").ok).toBe(false);
  });
  it("detects a tampered approval text via its hash", () => {
    const e = makeEnvelope();
    expect(issuesOf(seal({ ...e, ownerApproval: { ...e.ownerApproval, text: `${e.ownerApproval.text} and also anything` } })).join()).toMatch(/textSha256/);
  });
  it("requires a human reference", () => {
    expect(createEnvelope(baseSpec(), approvalTemplate(baseSpec()), "").ok).toBe(false);
  });
});

describe("envelope window", () => {
  it("refuses an expired envelope, a future one and an expired key", () => {
    const e = makeEnvelope();
    expect(checkEnvelopeWindow(e, new Date("2026-11-07T12:00:00Z"))).toEqual([]);
    expect(checkEnvelopeWindow(e, new Date("2026-11-14T10:00:00Z")).map((i) => i.code)).toContain("expired");
    expect(checkEnvelopeWindow(e, new Date("2026-11-01T00:00:00Z")).map((i) => i.code)).toContain("not-yet-valid");
    expect(checkEnvelopeWindow(e, new Date("2026-11-21T00:00:00Z")).map((i) => i.code)).toContain("key-expired");
  });
});
