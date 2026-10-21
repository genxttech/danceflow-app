import { describe, expect, it, vi } from "vitest";
import { getOwnerProvisioning, parseOwnerProvisioning, scrubSummary } from "../ownerRead";
import { buildJourney, type FinanceFacts, type JourneyInput, type ProvisioningFacts } from "../journey";

const ok = (campaign: Record<string, unknown>, service = "ready") => ({ available: true, messaging_service: { status: service }, campaign });
const finance: FinanceFacts = {
  legalBusiness: true, availableCents: 10000, onHold: false, pilotBusiness: false, campaignMonthlyKind: "monthly", hasActiveAuthorization: true,
  prices: [{ kind: "brand", customerPriceCents: 4600 }, { kind: "campaign_vetting", customerPriceCents: 1500 }, { kind: "monthly", customerPriceCents: 1000 }, { kind: "number", customerPriceCents: 200 }],
  purchasesOpen: true, authorizationOpen: true,
};
const input = (over: Partial<JourneyInput> = {}): JourneyInput => ({ state: "campaign_pending", textingOn: false, paused: false, isOwner: true, finance, provisioning: null, canEditForm: false, ...over });
const facts = (status: ProvisioningFacts["campaign"]["status"], extra: Partial<ProvisioningFacts["campaign"]> = {}): ProvisioningFacts => ({ campaign: { status, ...extra }, messagingService: { status: "ready" } });
const stage = (j: ReturnType<typeof buildJourney>, key: string) => j.stages.find((s) => s.key === key)!;

describe("parseOwnerProvisioning: strict and fail-closed", () => {
  it("accepts the documented shape and exposes only enums, the scrubbed summary and no identifiers", () => {
    const raw = { ...ok({ status: "rejected", rejection_summary: "Opt-in unclear", checked_at: "2026-10-21T00:00:00Z", provider_sid: `QE${"a".repeat(32)}`, error_code: "x" }), account_sid: `AC${"a".repeat(32)}` };
    const out = parseOwnerProvisioning(raw)!;
    expect(out).toEqual({ campaign: { status: "rejected", rejectionSummary: "Opt-in unclear" }, messagingService: { status: "ready" } });
    expect(JSON.stringify(out)).not.toMatch(/QE[0-9a-f]{32}|AC[0-9a-f]{32}|error/);
  });
  it("returns null for unavailable, malformed or unrecognized answers", () => {
    for (const bad of [null, undefined, "x", [], {}, { available: false }, { available: true }, { available: true, campaign: { status: "pending" } }, ok({ status: "approvedish" }), ok({ status: "pending" }, "almost")]) {
      expect(parseOwnerProvisioning(bad)).toBeNull();
    }
  });
  it("keeps the rejection summary only for a rejected campaign", () => {
    expect(parseOwnerProvisioning(ok({ status: "pending", rejection_summary: "should not show" }))!.campaign.rejectionSummary).toBeNull();
  });
  it("scrubs identifiers, links, addresses, long numbers and control characters, and bounds the length", () => {
    const dirty = `QE${"a".repeat(32)} https://x.test/a b@c.io 5035550123 \u0007ok ${"z".repeat(400)}`;
    const out = scrubSummary(dirty)!;
    expect(out).not.toMatch(/QE[0-9a-f]{32}|https|@|5035550123|\u0007/);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(scrubSummary("")).toBeNull();
    expect(scrubSummary(42)).toBeNull();
  });
});

describe("getOwnerProvisioning", () => {
  it("passes only the studio id; the actor is never an argument", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ok({ status: "pending" }), error: null });
    expect(await getOwnerProvisioning({ rpc } as never, "s1")).toMatchObject({ campaign: { status: "pending" } });
    expect(rpc).toHaveBeenCalledWith("get_studio_sms_provisioning", { p_studio_id: "s1" });
  });
  it("any error or exception is null (fail closed)", async () => {
    expect(await getOwnerProvisioning({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) } as never, "s1")).toBeNull();
    expect(await getOwnerProvisioning({ rpc: vi.fn().mockRejectedValue(new Error("down")) } as never, "s1")).toBeNull();
  });
});

describe("journey with campaign facts (R2b facts absent)", () => {
  it("pending is carrier review, not approval; preparing is NOT described as submitted to the carriers", () => {
    const pending = buildJourney(input({ provisioning: facts("pending") }));
    expect(stage(pending, "provider").status).toBe("waiting");
    expect(stage(pending, "provider").detail).toMatch(/under carrier review/);
    const preparing = buildJourney(input({ provisioning: facts("preparing") }));
    expect(stage(preparing, "provider").detail).toMatch(/not been confirmed with the carriers/);
    expect(preparing.next.title).toBe("DanceFlow is preparing your campaign");
  });
  it("approved completes only the provider stage; number, sender, compliance and activation stay not done", () => {
    for (const state of ["campaign_pending", "ready_for_activation"] as const) {
      const j = buildJourney(input({ state, provisioning: facts("approved") }));
      expect(stage(j, "provider").status).toBe("done");
      for (const key of ["number", "sender", "compliance"]) expect(stage(j, key).status).toBe("unavailable");
      expect(stage(j, "activation").status).not.toBe("done");
      expect(j.next.kind).toBe("unavailable");
      expect(j.next.cta).toBeNull();
    }
  });
  it("rejected: attention with the summary, and the exception state explains it instead of the generic message", () => {
    const j = buildJourney(input({ state: "exception", provisioning: facts("rejected", { rejectionSummary: "Opt-in flow not described" }) }));
    expect(j.next.title).toBe("The carriers did not approve your campaign");
    expect(j.next.detail).toContain("Opt-in flow not described");
    expect(j.next.cta).toBeNull();
    expect(stage(j, "provider").status).toBe("attention");
  });
  it("attention is owner-silent; not_started changes nothing from the state-based text", () => {
    expect(buildJourney(input({ provisioning: facts("attention") })).next.detail).toMatch(/You do not need to do anything/);
    const base = buildJourney(input({ provisioning: null }));
    const none = buildJourney(input({ provisioning: facts("not_started") }));
    expect(stage(none, "provider")).toEqual(stage(base, "provider"));
  });
  it("campaign facts never complete the owner's journey on their own", () => {
    const j = buildJourney(input({ state: "campaign_pending", provisioning: facts("approved") }));
    expect(j.stages.filter((s) => s.status === "done").map((s) => s.key)).not.toContain("activation");
    expect(j.next.kind).not.toBe("complete");
  });
});
