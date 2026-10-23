import { describe, expect, it, vi } from "vitest";
import { buildJourney, type FinanceFacts, type ProvisioningFacts } from "../journey";
import { getOwnerNumberOffers, numberChoiceActionable, parseOwnerNumberOffers, withNumberChoice, type OwnerNumberOffers } from "../ownerRead";

const OFFER = "0f0f0000-0000-4000-8000-000000000001";
const SEL = "0f0f0000-0000-4000-8000-000000000002";
const raw = (over: Record<string, unknown> = {}) => ({
  available: true, version: 1, step_open: true, price: { published: true, monthly_cents: 115 }, funding_mode: "credit_recurring", pilot_ceiling_reached: false,
  offer: { offer_id: OFFER, expires_at: "2026-10-23T12:00:00Z", numbers: [{ e164: "+15035550101", locality: "Portland", region: "OR" }] },
  approval: null, blocker: "none", ...over,
});

describe("parseOwnerNumberOffers (J3): strict and fail-closed", () => {
  it("maps the documented contract and nothing else", () => {
    const out = parseOwnerNumberOffers({ ...raw(), twilio_account_sid: `AC${"a".repeat(32)}`, provider_cost_cents: 100 })!;
    expect(out).toEqual({
      stepOpen: true, monthlyCents: 115, fundingMode: "credit_recurring", pilotCeilingReached: false,
      offer: { offerId: OFFER, expiresAt: "2026-10-23T12:00:00Z", numbers: [{ e164: "+15035550101", locality: "Portland", region: "OR" }] },
      approval: null, blocker: "none",
    });
    expect(JSON.stringify(out)).not.toMatch(/AC[0-9a-f]{32}|provider_cost/);
  });
  it("an approval is kept with its statement", () => {
    const out = parseOwnerNumberOffers(raw({ approval: { selection_id: SEL, e164: "+15035550101", status: "open", expires_at: "2026-10-24T00:00:00Z", statement: "I approve …" } }))!;
    expect(out.approval).toMatchObject({ selectionId: SEL, e164: "+15035550101", status: "open" });
  });
  it("an unpublished price is null and nothing else", () => {
    expect(parseOwnerNumberOffers(raw({ price: { published: false, monthly_cents: null }, blocker: "unpriced" }))!.monthlyCents).toBeNull();
  });
  it("returns null for anything unavailable or unexpected", () => {
    const bad: unknown[] = [
      null, {}, { available: false }, raw({ version: 2 }), raw({ step_open: "yes" }), raw({ price: { published: true, monthly_cents: null } }),
      raw({ price: { published: false, monthly_cents: 115 } }), raw({ price: { published: true, monthly_cents: 1.5 } }), raw({ funding_mode: "card" }), raw({ blocker: "adopt" }),
      raw({ offer: { offer_id: "x", expires_at: "2026-10-23T12:00:00Z", numbers: [] } }), raw({ offer: { offer_id: OFFER, expires_at: "soon", numbers: [] } }),
      raw({ offer: { offer_id: OFFER, expires_at: "2026-10-23T12:00:00Z", numbers: [{ e164: "5035550101" }] } }), raw({ offer: { offer_id: OFFER, expires_at: "2026-10-23T12:00:00Z" } }),
      raw({ approval: { selection_id: SEL, e164: "+15035550101", status: "used", expires_at: "2026-10-24T00:00:00Z", statement: "x" } }),
      raw({ pilot_ceiling_reached: undefined }),
    ];
    for (const b of bad) expect(parseOwnerNumberOffers(b), JSON.stringify(b)).toBeNull();
  });
  it("calls the owner read with the studio id only and fails closed", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: raw(), error: null });
    expect(await getOwnerNumberOffers({ rpc } as never, "s1")).not.toBeNull();
    expect(rpc).toHaveBeenCalledWith("get_studio_sms_number_offers", { p_studio_id: "s1" });
    expect(await getOwnerNumberOffers({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) } as never, "s1")).toBeNull();
    expect(await getOwnerNumberOffers({ rpc: vi.fn().mockRejectedValue(new Error("x")) } as never, "s1")).toBeNull();
  });
});

describe("withNumberChoice: the number stage links to the choice only when it is actionable", () => {
  const offers = parseOwnerNumberOffers(raw())!;
  const finance: FinanceFacts = { legalBusiness: true, availableCents: 10000, onHold: false, pilotBusiness: false, campaignMonthlyKind: "monthly", hasActiveAuthorization: true, prices: [], purchasesOpen: true, authorizationOpen: true };
  const facts: ProvisioningFacts = { campaign: { status: "approved" }, messagingService: { status: "ready" }, number: { status: "options_available", selection: "none" }, sender: { status: "not_ready" }, compliance: { status: "pending" } };
  it("options available and approvable: owner call to action to #sms-number with the published price", () => {
    const merged = withNumberChoice(facts, offers)!;
    expect(merged.number).toMatchObject({ actionHref: "#sms-number", priceCents: 115 });
    const j = buildJourney({ state: "campaign_pending", textingOn: false, paused: false, isOwner: true, finance, provisioning: merged, canEditForm: false });
    expect(j.next).toMatchObject({ stage: "number", kind: "owner", cta: { href: "#sms-number", label: "Choose a number" } });
  });
  it("no link when the choice is not actionable", () => {
    const cases: (OwnerNumberOffers | null)[] = [
      null, { ...offers, stepOpen: false }, { ...offers, monthlyCents: null, blocker: "unpriced" }, { ...offers, pilotCeilingReached: true, blocker: "pilot_ceiling" },
      { ...offers, blocker: "current_number" }, { ...offers, offer: null }, { ...offers, offer: { ...offers.offer!, numbers: [] } },
    ];
    for (const c of cases) {
      expect(numberChoiceActionable(c)).toBe(false);
      expect(withNumberChoice(facts, c)!.number!.actionHref).toBeUndefined();
    }
    expect(withNumberChoice(null, offers)).toBeNull();
  });
  it("an open approval is actionable (review or withdraw)", () => {
    expect(numberChoiceActionable({ ...offers, approval: { selectionId: SEL, e164: "+15035550101", status: "open", expiresAt: "2026-10-24T00:00:00Z", statement: "x" } })).toBe(true);
    expect(numberChoiceActionable({ ...offers, stepOpen: false, blocker: "not_open", approval: { selectionId: SEL, e164: "+15035550101", status: "open", expiresAt: "2026-10-24T00:00:00Z", statement: "x" } })).toBe(true);
  });
});
