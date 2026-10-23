import { describe, expect, it, vi } from "vitest";
import { getOwnerTextingStatus, mergeOwnerFacts, parseOwnerTextingStatus } from "../ownerRead";

const raw = (over: Record<string, unknown> = {}) => ({
  available: true,
  version: 1,
  number: { status: "secured", display: "***-***-4242", selection: "used" },
  sender: { status: "ready" },
  compliance: { status: "complete" },
  activation: { ready: false, checklist: [{ area: "provider", ok: true }, { area: "billing", ok: false }] },
  fees: { texting_paused: false, cancellation_in_progress: false, items: [{ kind: "texting_service", current_period: "covered", next_period: "not_covered", attention: "authorization_needed" }] },
  unexpected_resource_review: false,
  ...over,
});

describe("parseOwnerTextingStatus: strict and fail-closed (J2)", () => {
  it("maps the documented contract and nothing else", () => {
    const out = parseOwnerTextingStatus({ ...raw(), provider_sid: `PN${"a".repeat(32)}`, account_sid: `AC${"a".repeat(32)}`, cost_cents: 115 })!;
    expect(out).toEqual({
      number: { status: "secured", display: "***-***-4242", selection: "used" },
      sender: { status: "ready" },
      compliance: { status: "complete" },
      activation: { ready: false, checklist: [{ area: "provider", ok: true }, { area: "billing", ok: false }] },
      fees: { textingPaused: false, cancellationInProgress: false, items: [{ kind: "texting_service", currentPeriod: "covered", nextPeriod: "not_covered", attention: "authorization_needed" }] },
      unexpectedResourceReview: false,
    });
    expect(JSON.stringify(out)).not.toMatch(/PN[0-9a-f]{32}|AC[0-9a-f]{32}|cents|115/);
  });
  it("drops an unmasked or misplaced number display", () => {
    expect(parseOwnerTextingStatus(raw({ number: { status: "secured", display: "+15035550123", selection: "used" } }))!.number.display).toBeNull();
    expect(parseOwnerTextingStatus(raw({ number: { status: "secured", display: "503-555-0123", selection: "used" } }))!.number.display).toBeNull();
    expect(parseOwnerTextingStatus(raw({ number: { status: "purchasing", display: "***-***-4242", selection: "used" } }))!.number.display).toBeNull();
  });
  it("accepts the review area (pilot KI-1)", () => {
    expect(parseOwnerTextingStatus(raw({ activation: { ready: false, checklist: [{ area: "review", ok: false }] } }))!.activation!.checklist).toEqual([{ area: "review", ok: false }]);
  });
  it("a null activation checklist stays null (unreadable is not progress)", () => {
    expect(parseOwnerTextingStatus(raw({ activation: null }))!.activation).toBeNull();
  });
  it("returns null for anything unavailable, versioned differently or with an unknown value", () => {
    const bad: unknown[] = [
      null, undefined, "x", [], {}, { available: false }, raw({ available: false }), raw({ version: 2 }), raw({ version: undefined }),
      raw({ number: { status: "bought", selection: "used" } }), raw({ number: { status: "secured", selection: "maybe" } }), raw({ number: null }),
      raw({ sender: { status: "almost" } }), raw({ compliance: { status: "fine" } }), raw({ compliance: undefined }),
      raw({ activation: { ready: "yes", checklist: [] } }), raw({ activation: { ready: true, checklist: [{ area: "rfl_ready", ok: true }] } }), raw({ activation: { ready: true } }),
      raw({ fees: { texting_paused: false, cancellation_in_progress: false, items: [{ kind: "orphan", current_period: "covered", next_period: "covered", attention: "none" }] } }),
      raw({ fees: { texting_paused: false, cancellation_in_progress: false, items: [{ kind: "phone_number", current_period: "covered", next_period: "covered", attention: "adopt_it" }] } }),
      raw({ fees: { texting_paused: "no", cancellation_in_progress: false, items: [] } }), raw({ fees: { texting_paused: false, cancellation_in_progress: false } }),
      raw({ unexpected_resource_review: "true" }), raw({ unexpected_resource_review: undefined }),
    ];
    for (const b of bad) expect(parseOwnerTextingStatus(b), JSON.stringify(b)).toBeNull();
  });
});

describe("getOwnerTextingStatus / mergeOwnerFacts", () => {
  it("passes only the studio id; the actor is never an argument", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: raw(), error: null });
    expect(await getOwnerTextingStatus({ rpc } as never, "s1")).toMatchObject({ number: { status: "secured" } });
    expect(rpc).toHaveBeenCalledWith("get_studio_sms_texting_status", { p_studio_id: "s1" });
  });
  it("any error or exception is null (fail closed)", async () => {
    expect(await getOwnerTextingStatus({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) } as never, "s1")).toBeNull();
    expect(await getOwnerTextingStatus({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42883" } }) } as never, "s1")).toBeNull();
    expect(await getOwnerTextingStatus({ rpc: vi.fn().mockRejectedValue(new Error("down")) } as never, "s1")).toBeNull();
  });
  it("merges onto the campaign read; without the campaign read there are no facts at all", () => {
    const t = parseOwnerTextingStatus(raw())!;
    const campaign = { campaign: { status: "approved" as const }, messagingService: { status: "ready" as const } };
    expect(mergeOwnerFacts(campaign, t)).toEqual({ ...campaign, ...t });
    expect(mergeOwnerFacts(campaign, null)).toEqual(campaign);
    expect(mergeOwnerFacts(null, t)).toBeNull();
  });
});
