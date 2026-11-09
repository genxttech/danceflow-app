import { describe, expect, it } from "vitest";
import type { PanelStore } from "../panel";
import * as commands from "../panelCommands";
import { RunnerStoreError } from "../store";
import { exceptionEvidenceParams, scopeAllowsKind, scopesForKind, spendEvidenceParams, validatePilotEvidence, EVIDENCE_SCOPES, SCOPE_KINDS, type PilotEvidence } from "@/lib/sms/pilotApprovalEvidence";

/** U-4 for every pilot spend approval: the panel commands validate the owner's dated written authorization before any store call; the stores pass it through; credit takes none. */

const ADMIN = "a7000000-0000-4000-8000-000000000401";
const STUDIO = "a7000000-0000-4000-8000-00000000000a";
const ENTITY = "e7000000-0000-4000-8000-0000000000e1";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

type Call = { fn: string; input: Record<string, unknown> };
class Store {
  calls: Call[] = [];
  fail: string | null = null;
  async authorizeSpend(input: Record<string, unknown>) {
    this.calls.push({ fn: "authorizeSpend", input });
    if (this.fail) throw new RunnerStoreError(this.fail);
    return { spendEventId: "s1", replayed: false };
  }
  async createPilotException(entityId: string, ceilingCents: number, approvalRef: string, actorId: string, evidence?: PilotEvidence | null) {
    this.calls.push({ fn: "createPilotException", input: { entityId, ceilingCents, approvalRef, actorId, evidence } });
    if (this.fail) throw new RunnerStoreError(this.fail);
    return { replayed: false };
  }
}
const asStore = (s: Store) => s as unknown as PanelStore;

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const evid = (scope: string, over: Record<string, string> = {}) => ({
  authorizedOn: day(-3), authorizedByRole: "owner_written", scope, documentRef: "AUTH-DOC-2026-10-0001", documentSha256: "a".repeat(64), ...over,
});
const feeScope = (kind: string) => (kind === "brand" || kind === "brand_low_volume" ? "pilot_onboarding_fee" : kind === "number" ? "pilot_number_purchase" : "pilot_campaign_fee");
const fee = (over: Record<string, string> = {}, ev: Record<string, string> = {}) => {
  const kind = over.kind ?? "brand";
  return form({ entityId: ENTITY, studioId: STUDIO, kind, funding: "pilot", amountCents: "4600", approvalRef: "Owner email 2026-10-20 approving the fee", ownerApproved: "on", ...evid(feeScope(kind), ev), ...over });
};
const exception = (over: Record<string, string> = {}, ev: Record<string, string> = {}) =>
  form({ entityId: ENTITY, ceilingDollars: "150", approvalRef: "Founder email 2026-10-20 approving the pilot", understood: "on", ...evid("pilot_exception", { authorizedByRole: "founder_written", ...ev }), ...over });
const ctx = { studioTier: null as string | null };

describe("scope map: exhaustive and fail closed", () => {
  it("every scope maps to an explicit list of kinds; an unknown scope or kind is refused", () => {
    expect(Object.keys(SCOPE_KINDS).sort()).toEqual([...EVIDENCE_SCOPES].sort());
    expect(scopeAllowsKind("pilot_onboarding_fee", "brand")).toBe(true);
    expect(scopeAllowsKind("pilot_onboarding_fee", "brand_low_volume")).toBe(true);
    expect(scopeAllowsKind("pilot_onboarding_fee", "number")).toBe(false);
    expect(scopeAllowsKind("pilot_number_purchase", "number")).toBe(true);
    expect(scopeAllowsKind("pilot_number_purchase", "monthly")).toBe(false);
    expect(scopeAllowsKind("pilot_campaign_fee", "campaign_vetting")).toBe(true);
    expect(scopeAllowsKind("pilot_campaign_fee", "monthly_low_volume")).toBe(true);
    expect(scopeAllowsKind("pilot_period_cover", "monthly")).toBe(true);
    expect(scopeAllowsKind("pilot_exception", "brand")).toBe(false);
    for (const kind of ["sms_usage", "", "Brand", "x"]) for (const scope of EVIDENCE_SCOPES) expect(scopeAllowsKind(scope, kind), `${scope}/${kind}`).toBe(false);
    for (const scope of ["", "other", "PILOT_EXCEPTION", "__proto__", "constructor"]) expect(scopeAllowsKind(scope, "brand"), scope).toBe(false);
    expect(scopesForKind("brand")).toEqual(["pilot_onboarding_fee"]);
    expect(scopesForKind("number")).toEqual(["pilot_number_purchase"]);
    expect(scopesForKind("monthly")).toEqual(["pilot_campaign_fee"]);
    expect(scopesForKind("sms_usage")).toEqual([]);
  });

  it("the validator is scope-restricted and period-aware: a non-cover scope names no period, the exception takes only its own scope", () => {
    const base = { authorizedOn: day(-3), authorizedByRole: "owner_written", scope: "pilot_number_purchase", amountCents: 150, periodKey: null, documentRef: "AUTH-DOC-0001", documentSha256: "b".repeat(64) };
    const now = Date.now();
    expect(validatePilotEvidence(base, null, now, ["pilot_number_purchase"]).ok).toBe(true);
    expect(validatePilotEvidence(base, null, now, ["pilot_onboarding_fee"]).ok).toBe(false);
    expect(validatePilotEvidence({ ...base, periodKey: "2026-10" }, null, now, ["pilot_number_purchase"]).ok).toBe(false);
    expect(validatePilotEvidence({ ...base, scope: "pilot_period_cover", periodKey: "2026-10" }, "2026-10", now, ["pilot_period_cover"]).ok).toBe(true);
    expect(validatePilotEvidence({ ...base, scope: "pilot_period_cover", periodKey: null }, "2026-10", now, ["pilot_period_cover"]).ok).toBe(false);
    // the default stays cover-only (the #305 action)
    expect(validatePilotEvidence(base, null, now).ok).toBe(false);
  });

  it("RPC parameter helpers send nothing when there is no evidence (the database then refuses a pilot approval and accepts a credit one)", () => {
    for (const v of Object.values(spendEvidenceParams(null))) expect(v).toBeNull();
    for (const v of Object.values(exceptionEvidenceParams(undefined))) expect(v).toBeNull();
    expect(Object.keys(exceptionEvidenceParams(null))).not.toContain("p_evidence_period_key");
    const e: PilotEvidence = { authorizedOn: day(-1), authorizedByRole: "owner_written", scope: "pilot_campaign_fee", amountCents: 1500, periodKey: null, documentRef: "AUTH-DOC-0001", documentSha256: "c".repeat(64) };
    expect(spendEvidenceParams(e)).toEqual({
      p_evidence_authorized_on: e.authorizedOn, p_evidence_role: "owner_written", p_evidence_scope: "pilot_campaign_fee", p_evidence_amount_cents: 1500, p_evidence_period_key: null,
      p_evidence_document_ref: "AUTH-DOC-0001", p_evidence_sha256: "c".repeat(64),
    });
  });
});

describe("authorizeFee: a pilot approval needs evidence, a credit approval takes none", () => {
  it("a bare reference is refused before any store call", async () => {
    const store = new Store();
    const bare = form({ entityId: ENTITY, studioId: STUDIO, kind: "brand", funding: "pilot", amountCents: "4600", approvalRef: "Owner email 2026-10-20 approving the fee", ownerApproved: "on" });
    const r = await commands.authorizeFee(asStore(store), ADMIN, bare, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Nothing was authorized/);
    expect(store.calls).toHaveLength(0);
  });

  const refusals: [string, Record<string, string>][] = [
    ["missing date", { authorizedOn: "" }],
    ["future date", { authorizedOn: day(1) }],
    ["too old", { authorizedOn: day(-402) }],
    ["wrong role", { authorizedByRole: "policy_lapse" }],
    ["blank role", { authorizedByRole: "" }],
    ["missing scope", { scope: "" }],
    ["scope that does not allow the kind", { scope: "pilot_number_purchase" }],
    ["the cover scope (not offered for a fee approval)", { scope: "pilot_period_cover" }],
    ["the exception scope", { scope: "pilot_exception" }],
    ["missing document", { documentRef: "" }],
    ["document with a query string", { documentRef: "https://docs.example.com/a?token=1" }],
    ["document with a semicolon", { documentRef: "https://docs.example.com/a;b" }],
    ["javascript-style id", { documentRef: "javascript:alert1" }],
    ["short sha", { documentSha256: "abc" }],
    ["non-hex sha", { documentSha256: "z".repeat(64) }],
    ["missing sha", { documentSha256: "" }],
  ];
  for (const [name, ev] of refusals) {
    it(`refuses ${name} before any store call`, async () => {
      const store = new Store();
      const r = await commands.authorizeFee(asStore(store), ADMIN, fee({}, ev), ctx);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Nothing was authorized/);
      expect(store.calls).toHaveLength(0);
    });
  }

  it("a valid pilot approval reaches the store with the evidence (amount = the published price form value, no period), upper-case sha lower-cased", async () => {
    const store = new Store();
    const r = await commands.authorizeFee(asStore(store), ADMIN, fee({}, { documentSha256: "ABCDEF0123456789".repeat(4) }), ctx);
    expect(r.ok).toBe(true);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].input.evidence).toEqual({
      authorizedOn: day(-3), authorizedByRole: "owner_written", scope: "pilot_onboarding_fee", amountCents: 4600, periodKey: null, documentRef: "AUTH-DOC-2026-10-0001", documentSha256: "abcdef0123456789".repeat(4),
    });
  });

  it("every fee kind reaches the store with a scope that allows it", async () => {
    // the panel form offers these four kinds (the monthly kinds are approved through the period-cover and recurring paths, not this form)
    for (const kind of ["brand", "brand_low_volume", "campaign_vetting", "number"]) {
      const store = new Store();
      const r = await commands.authorizeFee(asStore(store), ADMIN, fee({ kind, amountCents: "150", approvalRef: `Owner email 2026-10-20 approving ${kind}` }), { studioTier: kind === "brand_low_volume" ? "low_volume_standard" : null });
      expect(r.ok, `${kind}: ${r.message}`).toBe(true);
      const e = store.calls[0].input.evidence as PilotEvidence;
      expect(scopeAllowsKind(e.scope, kind), kind).toBe(true);
    }
  });

  it("a credit-funded approval sends no evidence even if evidence fields are posted", async () => {
    const store = new Store();
    const r = await commands.authorizeFee(asStore(store), ADMIN, fee({ funding: "credit" }), ctx);
    expect(r.ok).toBe(true);
    expect(store.calls[0].input.evidence).toBeNull();
  });

  it("the database's evidence refusal reads as a fixed sentence and echoes nothing typed", async () => {
    const store = new Store();
    store.fail = "TW052";
    const r = await commands.authorizeFee(asStore(store), ADMIN, fee({}, { documentRef: "AUTH-DOC-SECRETISH-0001" }), ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/evidence is missing or inconsistent/);
    expect(r.message).not.toContain("SECRETISH");
    expect(r.message).not.toContain("a".repeat(64));
  });
});

describe("createPilotException: the founder's dated written authorization of THIS ceiling", () => {
  it("a bare reference is refused before any store call", async () => {
    const store = new Store();
    const bare = form({ entityId: ENTITY, ceilingDollars: "150", approvalRef: "Founder email 2026-10-20 approving the pilot", understood: "on" });
    const r = await commands.createPilotException(asStore(store), ADMIN, bare);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Nothing was recorded/);
    expect(store.calls).toHaveLength(0);
  });

  it("only the exception scope, the usual date/role/document/sha rules; the evidence amount is the ceiling", async () => {
    const bads: Record<string, string>[] = [{ scope: "pilot_onboarding_fee" }, { scope: "" }, { authorizedOn: day(1) }, { authorizedOn: day(-402) }, { authorizedByRole: "x" }, { documentRef: "bad ref" }, { documentSha256: "1" }];
    for (const ev of bads) {
      const store = new Store();
      expect((await commands.createPilotException(asStore(store), ADMIN, exception({}, ev))).ok, JSON.stringify(ev)).toBe(false);
      expect(store.calls).toHaveLength(0);
    }
    const store = new Store();
    const r = await commands.createPilotException(asStore(store), ADMIN, exception({ ceilingDollars: "100.50" }));
    expect(r.ok).toBe(true);
    expect(store.calls[0].input).toMatchObject({ ceilingCents: 10050, evidence: { scope: "pilot_exception", amountCents: 10050, periodKey: null, authorizedByRole: "founder_written" } });
  });

  it("the existing ceiling and acknowledgement checks come first and are unchanged", async () => {
    const store = new Store();
    expect((await commands.createPilotException(asStore(store), ADMIN, exception({ ceilingDollars: "150.01" }))).ok).toBe(false);
    expect((await commands.createPilotException(asStore(store), ADMIN, exception({ understood: "" }))).ok).toBe(false);
    expect(store.calls).toHaveLength(0);
  });

  it("the database's evidence refusal reads as a fixed sentence", async () => {
    const store = new Store();
    store.fail = "TW052";
    const r = await commands.createPilotException(asStore(store), ADMIN, exception());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/evidence is missing or inconsistent/);
  });
});
