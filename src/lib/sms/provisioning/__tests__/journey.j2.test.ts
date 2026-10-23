import { describe, expect, it } from "vitest";
import { ONBOARDING_STATES, type OnboardingDisplayState } from "@/lib/sms/onboarding/stateMachine";
import { buildJourney, type ComplianceFact, type FinanceFacts, type JourneyInput, type NumberFact, type ProvisioningFacts, type SenderFact, type StageKey } from "../journey";

/**
 * TW-4F J2: stage derivation from the owner texting-status facts (number, sender, compliance, activation checklist, service coverage) for every fact value.
 * Pure: no database. The real-schema derivation of those facts is localStack.j2owner.test.ts.
 */

const finance: FinanceFacts = {
  legalBusiness: true, availableCents: 10000, onHold: false, pilotBusiness: false, campaignMonthlyKind: "monthly", hasActiveAuthorization: true,
  prices: [{ kind: "brand", customerPriceCents: 4600 }, { kind: "campaign_vetting", customerPriceCents: 1500 }, { kind: "monthly", customerPriceCents: 1000 }, { kind: "number", customerPriceCents: 200 }],
  purchasesOpen: true, authorizationOpen: true,
};
const ALL_OK = (["provider", "number", "sender", "compliance", "billing", "monitoring"] as const).map((area) => ({ area, ok: true }));
const facts = (over: Partial<ProvisioningFacts> = {}): ProvisioningFacts => ({
  campaign: { status: "approved" },
  messagingService: { status: "ready" },
  number: { status: "not_started", display: null, selection: "none" },
  sender: { status: "not_ready" },
  compliance: { status: "pending" },
  activation: null,
  fees: { textingPaused: false, cancellationInProgress: false, items: [] },
  unexpectedResourceReview: false,
  ...over,
});
const input = (over: Partial<JourneyInput> = {}): JourneyInput => ({ state: "campaign_pending", textingOn: false, paused: false, isOwner: true, finance, provisioning: facts(), canEditForm: false, ...over });
const stage = (j: ReturnType<typeof buildJourney>, key: StageKey) => j.stages.find((s) => s.key === key)!;

describe("J2: number stage for every number fact", () => {
  const cases: [NumberFact, string, RegExp][] = [
    ["not_started", "waiting", /opens after your campaign is approved/],
    ["options_available", "current", /options are ready/],
    ["awaiting_owner_approval", "current", /Review and approve/],
    ["selected", "waiting", /You approved your number.*not complete until the provider confirms/],
    ["purchasing", "waiting", /being secured.*not complete until confirmed/],
    ["secured", "done", /in place/],
    ["attention", "attention", /double-checking.*You do not need to do anything/],
    ["failed", "attention", /could not be secured/],
  ];
  for (const [status, expected, detail] of cases) {
    it(`${status} -> ${expected} once the campaign is approved`, () => {
      const s = stage(buildJourney(input({ provisioning: facts({ number: { status, display: status === "secured" ? "***-***-4242" : null, selection: "none" } }) })), "number");
      expect(s.status).toBe(expected);
      expect(s.detail).toMatch(detail);
    });
  }
  it("before carrier approval an offer is not the owner's turn yet, and nothing is 'waiting' that has not started", () => {
    for (const state of ["brand_pending", "service_setup"] as const) {
      const j = buildJourney(input({ state, provisioning: facts({ campaign: { status: "pending" }, number: { status: "options_available", selection: "none" } }) }));
      expect(stage(j, "number").status).toBe("upcoming");
    }
    expect(stage(buildJourney(input({ provisioning: facts({ campaign: { status: "pending" } }) })), "number").status).toBe("upcoming");
  });
  it("a rejected campaign never opens the number step", () => {
    const j = buildJourney(input({ provisioning: facts({ campaign: { status: "rejected" }, number: { status: "options_available", selection: "none" } }) }));
    expect(stage(j, "number").status).toBe("upcoming");
  });
  it("secured shows only the last four digits of the masked number", () => {
    const s = stage(buildJourney(input({ provisioning: facts({ number: { status: "secured", display: "***-***-4242", selection: "used" } }) })), "number");
    expect(s.detail).toBe("Your texting number ending in 4242 is in place.");
    expect(stage(buildJourney(input({ provisioning: facts({ number: { status: "secured", display: null, selection: "used" } }) })), "number").detail).toBe("Your texting number is in place.");
  });
  it("options available without the selection screen (J3) is 'not open yet' with nothing clickable; with an href it is the owner's step", () => {
    const j = buildJourney(input({ provisioning: facts({ number: { status: "options_available", selection: "none" } }) }));
    expect(j.next).toMatchObject({ stage: "number", kind: "unavailable", title: "Choosing your number is not open yet", cta: null });
    const withHref = buildJourney(input({ provisioning: facts({ number: { status: "options_available", selection: "none", actionHref: "#sms-number" } }) }));
    expect(withHref.next).toMatchObject({ kind: "owner", cta: { href: "#sms-number" } });
    const notOwner = buildJourney(input({ isOwner: false, provisioning: facts({ number: { status: "options_available", selection: "none", actionHref: "#sms-number" } }) }));
    expect(notOwner.next.cta).toBeNull();
  });
  it("next action per number fact is never an owner action without an href", () => {
    for (const status of ["not_started", "selected", "purchasing", "attention", "failed"] as NumberFact[]) {
      const j = buildJourney(input({ provisioning: facts({ number: { status, selection: "none" } }) }));
      expect(j.next.stage).toBe("number");
      expect(j.next.cta).toBeNull();
      expect(j.next.kind).toBe(status === "attention" || status === "failed" ? "blocked" : "waiting");
    }
    expect(buildJourney(input({ provisioning: facts({ number: { status: "attention", selection: "used" } }) })).next.title).toBe("DanceFlow is checking your number");
  });
});

describe("J2: sender and compliance stages for every fact", () => {
  const secured = { status: "secured" as const, display: "***-***-4242", selection: "used" as const };
  const senders: [SenderFact, string][] = [["not_ready", "upcoming"], ["verifying", "waiting"], ["ready", "done"], ["failed_verification", "attention"]];
  for (const [status, expected] of senders) {
    it(`sender ${status} -> ${expected}`, () => {
      const j = buildJourney(input({ provisioning: facts({ number: secured, sender: { status } }) }));
      expect(stage(j, "sender").status).toBe(expected);
      if (status !== "ready") expect(j.next.stage).toBe("sender");
      if (status === "failed_verification") expect(j.next.kind).toBe("blocked");
    });
  }
  const compliance: [ComplianceFact, SenderFact, string][] = [
    ["pending", "not_ready", "upcoming"], ["pending", "ready", "waiting"], ["complete", "ready", "done"], ["attention", "ready", "attention"], ["complete", "not_ready", "done"],
  ];
  for (const [status, sender, expected] of compliance) {
    it(`compliance ${status} (sender ${sender}) -> ${expected}`, () => {
      const j = buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: secured, sender: { status: sender }, compliance: { status } }) }));
      expect(stage(j, "compliance").status).toBe(expected);
    });
  }
  it("compliance attention is DanceFlow's to fix: blocked, no action", () => {
    const j = buildJourney(input({ state: "ready_for_activation", provisioning: facts({ number: secured, sender: { status: "ready" }, compliance: { status: "attention" } }) }));
    expect(j.next).toMatchObject({ stage: "compliance", kind: "blocked", cta: null });
  });
});

describe("J2: activation stage from the checklist", () => {
  const ready = facts({ number: { status: "secured", display: "***-***-4242", selection: "used" }, sender: { status: "ready" }, compliance: { status: "complete" } });
  it("every check passed: DanceFlow turns texting on (still not done until active)", () => {
    const j = buildJourney(input({ state: "ready_for_activation", provisioning: { ...ready, activation: { ready: true, checklist: ALL_OK } } }));
    expect(stage(j, "activation")).toMatchObject({ status: "waiting", detail: "Every check has passed. DanceFlow will turn texting on." });
    expect(j.next).toMatchObject({ stage: "activation", kind: "waiting", title: "DanceFlow will turn texting on", cta: null });
  });
  it("lists the open areas in owner words, once each, and never internal codes", () => {
    const checklist = ALL_OK.map((i) => (i.area === "billing" || i.area === "monitoring" ? { ...i, ok: false } : i));
    const s = stage(buildJourney(input({ state: "ready_for_activation", provisioning: { ...ready, activation: { ready: false, checklist: [...checklist, { area: "other", ok: false }] } } })), "activation");
    expect(s.detail).toBe("Carrier approvals are in. DanceFlow still has to confirm the monthly service coverage, its account checks and a final check before texting turns on.");
    expect(s.detail).not.toMatch(/rfl|inventory|funding|_/);
  });
  it("a DanceFlow review item (pilot KI-1) reads in owner words", () => {
    const s = stage(buildJourney(input({ state: "ready_for_activation", provisioning: { ...ready, activation: { ready: false, checklist: [...ALL_OK, { area: "review", ok: false }] } } })), "activation");
    expect(s.detail).toBe("Carrier approvals are in. DanceFlow still has to confirm a DanceFlow review before texting turns on.");
  });
  it("an unreadable checklist falls back to the generic sentence", () => {
    expect(stage(buildJourney(input({ state: "ready_for_activation", provisioning: { ...ready, activation: null } })), "activation").detail).toMatch(/still has to confirm your number, sender and compliance/);
  });
  it("all eight stages are done only when texting is actually on", () => {
    const on = buildJourney(input({ state: "active", textingOn: true, provisioning: { ...ready, activation: { ready: true, checklist: ALL_OK } } }));
    expect(on.stages.map((s) => s.status)).toEqual(Array(8).fill("done"));
    expect(on.next.kind).toBe("complete");
    const almost = buildJourney(input({ state: "ready_for_activation", provisioning: { ...ready, activation: { ready: true, checklist: ALL_OK } } }));
    expect(almost.stages.filter((s) => s.status === "done").map((s) => s.key)).toEqual(["business", "eligibility", "approvals", "provider", "number", "sender", "compliance"]);
  });
});

describe("J2: service coverage and unexpected resources in the journey", () => {
  const on = facts({ number: { status: "secured", display: "***-***-4242", selection: "used" }, sender: { status: "ready" }, compliance: { status: "complete" } });
  it("the fee sending gate while texting is on: activation needs attention, next action is a neutral hold with no action", () => {
    const j = buildJourney(input({ state: "active", textingOn: true, provisioning: { ...on, fees: { textingPaused: true, cancellationInProgress: false, items: [] } } }));
    expect(stage(j, "activation").status).toBe("attention");
    expect(j.next).toMatchObject({ stage: "activation", kind: "blocked", title: "Texting is paused", cta: null });
    expect(j.next.detail).not.toMatch(/\$|pay|authorize/i);
  });
  it("a pause from an open cancellation says so instead of pointing at coverage", () => {
    const j = buildJourney(input({ state: "active", textingOn: true, provisioning: { ...on, fees: { textingPaused: true, cancellationInProgress: true, items: [] } } }));
    expect(j.next.detail).toBe("Texting is paused while DanceFlow completes a cancellation for this location. You do not need to do anything.");
  });
  it("the gate before activation changes nothing (texting was never on)", () => {
    const base = buildJourney(input({ state: "ready_for_activation", provisioning: on }));
    const gated = buildJourney(input({ state: "ready_for_activation", provisioning: { ...on, fees: { textingPaused: true, cancellationInProgress: false, items: [] } } }));
    expect(gated).toEqual(base);
  });
  it("an unexpected resource never changes a stage or the next action", () => {
    for (const state of ["campaign_pending", "ready_for_activation", "active"] as OnboardingDisplayState[]) {
      const a = buildJourney(input({ state, textingOn: state === "active", provisioning: on }));
      const b = buildJourney(input({ state, textingOn: state === "active", provisioning: { ...on, unexpectedResourceReview: true } }));
      expect(b).toEqual(a);
    }
  });
});

describe("J2: a location where texting is already on", () => {
  it("activated before these facts were recorded (or with aged evidence): number, sender and compliance are not shown as unfinished", () => {
    for (const sender of ["not_ready", "verifying"] as SenderFact[]) {
      const j = buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ sender: { status: sender } }) }));
      expect(j.stages.map((s) => s.status)).toEqual(Array(8).fill("done"));
      expect(j.next.kind).toBe("complete");
    }
  });
  it("an unconfirmed replacement purchase or a cancellation in progress is not shown as in place", () => {
    for (const status of ["selected", "purchasing"] as NumberFact[]) {
      expect(stage(buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ number: { status, selection: "used" } }) })), "number").status, status).toBe("waiting");
    }
    const cancelling = buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ fees: { textingPaused: false, cancellationInProgress: true, items: [] } }) }));
    expect(stage(cancelling, "number").status).not.toBe("done");
  });
  it("a stage that positively reports a problem keeps it", () => {
    const j = buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ number: { status: "attention", selection: "used" }, sender: { status: "failed_verification" }, compliance: { status: "attention" } }) }));
    for (const key of ["number", "sender", "compliance"] as StageKey[]) expect(stage(j, key).status, key).toBe("attention");
    expect(stage(buildJourney(input({ state: "active", textingOn: true, provisioning: facts({ number: { status: "failed", selection: "used" } }) })), "number").status).toBe("attention");
  });
});

describe("J2: every onboarding state with full facts", () => {
  const states: OnboardingDisplayState[] = ["not_started", ...ONBOARDING_STATES];
  const variants: ProvisioningFacts[] = [
    facts(),
    facts({ number: { status: "secured", display: "***-***-4242", selection: "used" }, sender: { status: "ready" }, compliance: { status: "complete" }, activation: { ready: true, checklist: ALL_OK } }),
    facts({ number: { status: "failed", selection: "used" }, sender: { status: "failed_verification" }, compliance: { status: "attention" }, activation: { ready: false, checklist: ALL_OK.map((i) => ({ ...i, ok: false })) } }),
  ];
  it("eight stages, one next action, a call to action only for the owner and only to a known anchor", () => {
    for (const state of states) {
      for (const provisioning of variants) {
        for (const isOwner of [true, false]) {
          const j = buildJourney(input({ state, isOwner, provisioning, canEditForm: isOwner }));
          expect(j.stages.map((s) => s.key)).toEqual(["business", "eligibility", "approvals", "provider", "number", "sender", "compliance", "activation"]);
          if (!isOwner) expect(j.next.cta).toBeNull();
          if (j.next.cta) expect(["#sms-setup", "#sms-credit", "#sms-recurring"]).toContain(j.next.cta.href);
          // activation is complete only when texting is on
          expect(stage(j, "activation").status === "done").toBe(state === "active");
          expect(JSON.stringify(j)).not.toMatch(/[A-Z]{2}[0-9a-f]{32}|\+1[0-9]{10}/);
        }
      }
    }
  });
});
