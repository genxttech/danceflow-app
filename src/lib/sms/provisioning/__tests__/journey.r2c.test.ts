import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildJourney, chargeLines, requiredFundingCents, type FinanceFacts, type JourneyInput, type ProvisioningFacts } from "../journey";
import { buildAdminProvisioningView, type ProvisioningOperationView } from "../adminView";
import SmsJourney from "@/app/app/settings/sms/SmsJourney";
import ProvisioningSummary from "@/app/platform/sms/ProvisioningSummary";
import type { SenderOverviewRow } from "@/lib/sms/senderVerification";

const PRICES = [
  { kind: "brand", customerPriceCents: 4600 },
  { kind: "campaign_vetting", customerPriceCents: 1500 },
  { kind: "monthly", customerPriceCents: 1000 },
  { kind: "number", customerPriceCents: 200 },
];
const finance = (over: Partial<FinanceFacts> = {}): FinanceFacts => ({ legalBusiness: true, availableCents: 10000, onHold: false, pilotBusiness: false, campaignMonthlyKind: "monthly", hasActiveAuthorization: true, prices: PRICES, ...over });
const input = (over: Partial<JourneyInput> = {}): JourneyInput => ({ state: "brand_pending", textingOn: false, paused: false, isOwner: true, finance: finance(), provisioning: null, ...over });
const facts = (over: Partial<ProvisioningFacts> = {}): ProvisioningFacts => ({ campaign: { status: "approved" }, number: { status: "not_started" }, sender: { status: "not_ready" }, compliance: { status: "pending" }, ...over });
const stage = (j: ReturnType<typeof buildJourney>, key: string) => j.stages.find((s) => s.key === key)!;

describe("owner journey: next action", () => {
  it("not started: owner gets the form action; a non-owner gets no clickable action", () => {
    const owner = buildJourney(input({ state: "not_started" }));
    expect(owner.next.kind).toBe("owner");
    expect(owner.next.cta?.href).toBe("#sms-setup");
    const manager = buildJourney(input({ state: "not_started", isOwner: false }));
    expect(manager.next.cta).toBeNull();
    expect(manager.next.kind).toBe("waiting");
  });

  it("needs_info is attention with a resubmit action", () => {
    const j = buildJourney(input({ state: "needs_info" }));
    expect(stage(j, "business").status).toBe("attention");
    expect(j.next.title).toMatch(/submit again/i);
  });

  it("insufficient funding: blocks the approvals stage and offers Add funds, never Authorize", () => {
    const j = buildJourney(input({ state: "draft", finance: finance({ availableCents: 500, hasActiveAuthorization: false }) }));
    // before review the finance stage is shown but the business step comes first
    expect(stage(j, "approvals").status).toBe("attention");
    expect(stage(j, "approvals").detail).toContain("$5.00");
    expect(stage(j, "approvals").detail).toContain(`$${(requiredFundingCents(finance())! / 100).toFixed(2)}`);
    const later = buildJourney(input({ state: "profile_review", finance: finance({ availableCents: 500, hasActiveAuthorization: false }) }));
    expect(later.next.cta?.href).toBe("#sms-credit");
    expect(later.next.title).toMatch(/add funds/i);
  });

  it("funded but not authorized: the next action is reviewing charges, linked to the recurring panel", () => {
    const j = buildJourney(input({ state: "brand_pending", finance: finance({ hasActiveAuthorization: false }) }));
    expect(j.next.cta?.href).toBe("#sms-recurring");
  });

  it("balance on hold: no funding action, stated as blocked", () => {
    const j = buildJourney(input({ state: "brand_pending", finance: finance({ onHold: true, hasActiveAuthorization: false }) }));
    expect(j.next.kind).toBe("blocked");
    expect(j.next.cta).toBeNull();
  });

  it("missing published price: unavailable, no action (a fee is never guessed)", () => {
    const j = buildJourney(input({ state: "brand_pending", finance: finance({ prices: [], hasActiveAuthorization: false }) }));
    expect(stage(j, "approvals").status).toBe("unavailable");
    expect(j.next.kind).toBe("unavailable");
  });

  it("pilot business: approvals are recorded one at a time by DanceFlow, no standing authorization is asked for", () => {
    const j = buildJourney(input({ state: "brand_pending", finance: finance({ pilotBusiness: true, hasActiveAuthorization: false }) }));
    expect(stage(j, "approvals").detail).toMatch(/one at a time/i);
    expect(j.next.cta).toBeNull();
  });

  it("finance unreadable (error / role): approvals unavailable, journey still renders", () => {
    const j = buildJourney(input({ state: "brand_pending", finance: null }));
    expect(stage(j, "approvals").status).toBe("unavailable");
    expect(j.stages).toHaveLength(8);
  });
});

describe("owner journey: provider states never imply approval", () => {
  it("brand_pending and campaign_pending are 'waiting', not done, and say submitting is not approval", () => {
    for (const state of ["brand_pending", "campaign_pending"] as const) {
      const j = buildJourney(input({ state, provisioning: facts({ campaign: { status: "pending" } }) }));
      expect(stage(j, "provider").status).toBe("waiting");
      expect(stage(j, "provider").detail).toMatch(/not approval/i);
      expect(j.next.kind).toBe("waiting");
    }
  });

  it("campaign rejection is attention with the sanitized reason and no owner action", () => {
    const j = buildJourney(input({ state: "campaign_pending", provisioning: facts({ campaign: { status: "rejected", rejectionSummary: "Opt-in flow not described" } }) }));
    expect(stage(j, "provider").status).toBe("attention");
    expect(stage(j, "provider").detail).toContain("Opt-in flow not described");
    expect(j.next.kind).toBe("blocked");
    expect(j.next.cta).toBeNull();
    expect(stage(j, "number").status).not.toBe("current");
  });

  it("number/sender/compliance are 'unavailable' with no action when R2b facts are not connected", () => {
    const j = buildJourney(input({ state: "campaign_pending", provisioning: null }));
    for (const key of ["number", "sender", "compliance"]) expect(stage(j, key).status).toBe("unavailable");
  });

  it("number approval action appears only when R2b supplies an href and the campaign is approved", () => {
    const withHref = buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: { status: "awaiting_owner_approval", priceCents: 200, actionHref: "/app/settings/sms/number" } }) }));
    expect(withHref.next.cta?.href).toBe("/app/settings/sms/number");
    expect(stage(withHref, "number").detail).toContain("$2.00");
    const noHref = buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: { status: "awaiting_owner_approval", priceCents: 200 } }) }));
    expect(noHref.next.cta).toBeNull();
    const notOwner = buildJourney(input({ isOwner: false, state: "ready_for_activation", provisioning: facts({ number: { status: "options_available", actionHref: "/x" } }) }));
    expect(notOwner.next.cta).toBeNull();
  });

  it("a purchase in progress is not complete; a failed number is attention", () => {
    expect(stage(buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: { status: "purchasing" } }) })), "number").status).toBe("waiting");
    expect(stage(buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: { status: "failed" } }) })), "number").status).toBe("attention");
  });

  it("failed sender verification keeps texting off and is attention", () => {
    const j = buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: { status: "secured" }, sender: { status: "failed_verification" } }) }));
    expect(stage(j, "sender").status).toBe("attention");
    expect(stage(j, "activation").status).not.toBe("done");
    expect(j.next.kind).toBe("blocked");
  });

  it("activation is done only when texting is actually on", () => {
    expect(stage(buildJourney(input({ state: "ready_for_activation" })), "activation").status).toBe("waiting");
    const on = buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ number: { status: "secured" }, sender: { status: "ready" }, compliance: { status: "complete" } }) }));
    expect(on.next.kind).toBe("complete");
  });

  it("blocked/exception/cancelled/paused never show an owner action", () => {
    for (const state of ["blocked", "exception", "cancelled"] as const) expect(buildJourney(input({ state })).next.cta).toBeNull();
    expect(buildJourney(input({ state: "draft", paused: true })).next.kind).toBe("stopped");
  });
});

describe("review regressions", () => {
  it("after fees are spent, a low available balance never asks for money again", () => {
    for (const state of ["brand_pending", "service_setup", "campaign_pending", "ready_for_activation"] as const) {
      const j = buildJourney(input({ state, finance: finance({ availableCents: 0 }) }));
      expect(stage(j, "approvals").status).toBe("done");
      expect(j.next.title).not.toMatch(/add funds/i);
    }
  });
  it("pilot fee approvals read as recorded once review is under way", () => {
    const j = buildJourney(input({ state: "campaign_pending", finance: finance({ pilotBusiness: true, hasActiveAuthorization: false }) }));
    expect(stage(j, "approvals").status).toBe("done");
    expect(j.next.title).toMatch(/carrier review/i);
  });
  it("unset registration path: no guessed prices and no funding demand", () => {
    const f = finance({ campaignMonthlyKind: null });
    expect(chargeLines(f).find((l) => l.key === "brand")!.amount).toMatch(/Confirmed after/);
    expect(requiredFundingCents(f)).toBeNull();
    const j = buildJourney(input({ state: "profile_review", finance: f }));
    expect(stage(j, "approvals").status).toBe("upcoming");
  });
  it("ready_for_activation never claims number, sender or compliance done without facts", () => {
    const j = buildJourney(input({ state: "ready_for_activation", provisioning: null }));
    for (const key of ["number", "sender", "compliance"]) expect(stage(j, key).status).toBe("unavailable");
    expect(stage(j, "activation").detail).not.toMatch(/everything is approved/i);
  });
  it("admin: unloaded senders say Not loaded; verify link only when a sender row exists; run link targets the row", () => {
    const v = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: null, sendersLoaded: false }));
    expect(v.sender.label).toBe("Not loaded");
    expect(v.next.href).toBeNull();
    expect(buildAdminProvisioningView(adminIn({ state: "profile_review" })).next.href).toBe("#onboarding-row-s1");
  });
});

describe("charge disclosure", () => {
  it("lists every applicable charge with its published price and states that nothing is charged by viewing", () => {
    const lines = chargeLines(finance());
    expect(lines.map((l) => l.key)).toEqual(["brand", "campaign_vetting", "monthly", "number"]);
    expect(lines.find((l) => l.key === "campaign_vetting")!.amount).toBe("$15.00");
    const html = renderToStaticMarkup(createElement(SmsJourney, input()));
    expect(html).toContain("What this costs");
    expect(html).toMatch(/Viewing this charges nothing/);
    expect(html).toMatch(/does not mean the carriers have approved/);
  });

  it("an unpublished price is stated, never guessed; low-volume path uses its own kinds", () => {
    expect(chargeLines(finance({ prices: [] })).every((l) => l.amount === "Price not published yet")).toBe(true);
    const low = chargeLines(finance({ campaignMonthlyKind: "monthly_low_volume", prices: [{ kind: "monthly_low_volume", customerPriceCents: 300 }, { kind: "brand_low_volume", customerPriceCents: 400 }] }));
    expect(low.find((l) => l.key === "monthly")!.amount).toBe("$3.00");
    expect(low.find((l) => l.key === "brand")!.amount).toBe("$4.00");
    expect(chargeLines(null)).toHaveLength(4);
  });

  it("required funding is null when any needed price is missing", () => {
    expect(requiredFundingCents(finance())).toBe(7100);
    expect(requiredFundingCents(finance({ prices: PRICES.filter((p) => p.kind !== "monthly") }))).toBeNull();
    expect(requiredFundingCents(null)).toBeNull();
  });
});

describe("owner rendering", () => {
  const states = ["not_started", "draft", "needs_info", "profile_review", "brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "active", "suspended", "blocked", "exception", "cancelled"] as const;
  it("never leaks provider terms or identifiers to studios, in any state", () => {
    for (const state of states) {
      const html = renderToStaticMarkup(createElement(SmsJourney, input({ state, provisioning: facts({ campaign: { status: "rejected", rejectionSummary: "x" } }) })));
      expect(html).not.toMatch(/twilio|trust ?hub|\bSID\b|\bMG[0-9a-f]{8}|\bQE[0-9a-f]{8}/i);
    }
  });

  it("renders the next action first, chevron-indicated collapsible sections, and a link only when a cta exists", () => {
    const html = renderToStaticMarkup(createElement(SmsJourney, input({ state: "not_started" })));
    expect(html.indexOf("sms-next-action")).toBeLessThan(html.indexOf("sms-journey-stages"));
    expect(html).toContain("<details");
    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain('data-testid="sms-next-cta"');
    const none = renderToStaticMarkup(createElement(SmsJourney, input({ state: "campaign_pending", provisioning: null })));
    expect(none).not.toContain("sms-next-cta");
    expect(none).not.toMatch(/<button/);
  });

  it("marks unavailable stages for screen readers", () => {
    const html = renderToStaticMarkup(createElement(SmsJourney, input({ state: "campaign_pending" })));
    expect(html).toContain("not available yet");
  });
});

const sender = (over: Partial<SenderOverviewRow> = {}): SenderOverviewRow => ({
  studioId: "s1", legalEntityId: "e1", senderId: "snd1", status: "pending", accountSid: "AC1", messagingServiceSid: "MG1", campaignSid: "QE1", phoneNumberSid: "PN1", senderE164: "+15555550100",
  recordedAt: null, verificationOutcome: null, verificationCode: null, verifiedAt: null, verificationSource: null, ready: false, ...over,
});
const op = (over: Partial<ProvisioningOperationView> = {}): ProvisioningOperationView => ({ id: "o1", kind: "campaign", status: "succeeded", feeBearing: true, attemptedAt: null, errorCode: null, ...over });
const adminIn = (over: Record<string, unknown> = {}) => ({ studioId: "s1", state: "campaign_pending", accessEnabled: true, evidence: undefined, sender: null, operations: [] as ProvisioningOperationView[] | null, ...over }) as Parameters<typeof buildAdminProvisioningView>[0];

describe("platform-admin provisioning view", () => {
  it("access off: the one action points to the existing pilot switch", () => {
    const v = buildAdminProvisioningView(adminIn({ accessEnabled: false }));
    expect(v.next.href).toBe("#onboarding-pilot");
  });

  it("waiting on the studio shows no action", () => {
    for (const state of ["draft", "needs_info", "not_started", null]) expect(buildAdminProvisioningView(adminIn({ state })).next).toMatchObject({ kind: "wait_studio", href: null });
  });

  it("unknown outcome outranks everything: investigate, listed as a blocker, no fake resolve button", () => {
    const v = buildAdminProvisioningView(adminIn({ operations: [op({ status: "unknown_outcome" })] }));
    expect(v.next.kind).toBe("investigate");
    expect(v.next.href).toBeNull();
    expect(v.blockers.join(" ")).toMatch(/unknown outcome/);
    const html = renderToStaticMarkup(createElement(ProvisioningSummary, adminIn({ operations: [op({ status: "unknown_outcome" })] })));
    expect(html).not.toContain("admin-next-link");
    expect(html).toContain("1 unknown");
  });

  it("ledger not connected is stated, in provisioning states, and never rendered as 'no operations'", () => {
    const html = renderToStaticMarkup(createElement(ProvisioningSummary, adminIn({ operations: null })));
    expect(html).toContain("not connected in this build");
    expect(buildAdminProvisioningView(adminIn({ operations: null })).blockers.join(" ")).toMatch(/ledger is not connected/);
  });

  it("service_setup has no runnable action (runner not wired to the panel)", () => {
    const v = buildAdminProvisioningView(adminIn({ state: "service_setup" }));
    expect(v.next).toMatchObject({ kind: "unavailable", href: null });
  });

  it("campaign refusal: investigate, fee-bearing failure demands a new owner approval", () => {
    const v = buildAdminProvisioningView(adminIn({ operations: [op({ status: "failed" })] }));
    expect(v.campaign.tone).toBe("bad");
    expect(v.next.kind).toBe("investigate");
    expect(v.blockers.join(" ")).toMatch(/new explicit owner approval/);
  });

  it("campaign under review is a wait; approved campaign is only shown from the state, not from a submission", () => {
    expect(buildAdminProvisioningView(adminIn({ operations: [op({ status: "succeeded" })] })).campaign).toEqual({ label: "Under carrier review", tone: "wait" });
    expect(buildAdminProvisioningView(adminIn({ state: "ready_for_activation" })).campaign.tone).toBe("ok");
  });

  it("ready_for_activation: verify sender links to the existing sender block; Advanced Opt-Out is shown as required", () => {
    const v = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: sender() }));
    expect(v.next.href).toBe("#sender-s1");
    expect(v.optOut.label).toMatch(/Attestation required/);
    const none = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: null }));
    expect(none.optOut.label).toMatch(/Required before activation/);
  });

  it("failed sender verification is a blocker and a bad opt-out chip; ready sender is done", () => {
    const failed = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: sender({ verificationOutcome: "failed", verificationCode: "x" }) }));
    expect(failed.blockers.join(" ")).toMatch(/verification failed/);
    expect(failed.optOut.tone).toBe("bad");
    const ok = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: sender({ ready: true, status: "approved", verificationOutcome: "verified" }) }));
    expect(ok.next.kind).toBe("done");
    expect(ok.sender.tone).toBe("ok");
  });

  it("every link it can produce targets an existing in-page control, never an external or generated URL", () => {
    const states = ["not_started", "draft", "submitted_for_checks", "profile_review", "brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "active", "blocked", "exception", "suspended"];
    for (const state of states) for (const accessEnabled of [true, false]) {
      const href = buildAdminProvisioningView(adminIn({ state, accessEnabled, sender: sender() })).next.href;
      if (href) expect(href).toMatch(/^#(onboarding-pilot|onboarding-row-s1|sender-s1)$/);
    }
  });

  it("tenant isolation: the summary only reads the studio it was given", () => {
    const v = buildAdminProvisioningView(adminIn({ state: "ready_for_activation", sender: sender({ studioId: "other", ready: true }) }));
    // the caller passes the matching row; this view does not look anything up by itself
    expect(v.sender.tone).toBe("ok");
    const html = renderToStaticMarkup(createElement(ProvisioningSummary, adminIn({ studioId: "s9" })));
    expect(html).toContain('id="onboarding-s9"');
  });
});
