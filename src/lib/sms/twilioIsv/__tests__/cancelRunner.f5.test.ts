import { describe, expect, it } from "vitest";
import {
  buildCancelRunner, cancelEvidenceDigest, type CancelBeginResult, type CancelKind, type CancelLedger, type CancelTarget, type ReleaseAdapters,
} from "../cancelRunner";
import { FakeNumberAdapter, FakeNumberUniverse } from "../fakeNumbers";
import { FakeProvisioningAdapter } from "../fakeProvisioning";
import type { NumberReleaseAdapter } from "../releaseTypes";

/**
 * TW-4F F5: the cancellation runner against the fakes and an in-memory ledger that copies tw4_rfl_cancel_begin / _finish's state rules (authorized ->
 * in_flight on the single claim; in_flight -> confirmed | refused | unknown_outcome; unknown_outcome answers `reconcile`; refused needs code api; confirmed
 * needs a 64-hex digest). No database, no network.
 */

const U = (n: number) => `d${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const ACTOR = U(1);
const REQUESTER = U(2);
const APPROVER = U(3);
const OP = U(10);
const RES = U(11);
const SUB = `AC${"4".repeat(32)}`;

class MemoryLedger implements CancelLedger {
  status = "authorized";
  begins = 0;
  finishes: { outcome: string; digest: string | null; code: string | null }[] = [];
  failFinish = false;
  constructor(public providerSid: string, public kind: CancelKind) {}

  async beginCancel(): Promise<CancelBeginResult> {
    this.begins += 1;
    if (this.status === "in_flight") return { action: "in_progress" };
    if (this.status === "unknown_outcome") return { action: "reconcile" };
    if (this.status !== "authorized") return { action: "skip", status: this.status };
    this.status = "in_flight";
    return { action: "execute", providerSid: this.providerSid, resourceKind: this.kind };
  }

  async finishCancel(_op: string, outcome: "confirmed" | "refused" | "unknown", digest: string | null, code: string | null) {
    if (this.failFinish) throw new Error("db down");
    if (this.status !== "in_flight") throw Object.assign(new Error("TW041"), { code: "TW041" });
    if (outcome === "confirmed" && !/^[0-9a-f]{64}$/.test(digest ?? "")) throw Object.assign(new Error("TW043"), { code: "TW043" });
    if (outcome === "refused" && code !== "api") throw Object.assign(new Error("TW043"), { code: "TW043" });
    this.finishes.push({ outcome, digest, code });
    this.status = outcome === "unknown" ? "unknown_outcome" : outcome;
    return { status: this.status, replayed: false };
  }
}

function world(kind: CancelKind, over: Partial<CancelTarget> = {}) {
  const universe = new FakeNumberUniverse();
  const numbers = new FakeNumberAdapter(SUB, universe);
  const provisioning = new FakeProvisioningAdapter(SUB);
  const ms = provisioning.seedService("df:development:ms");
  let providerSid: string;
  if (kind === "number") {
    numbers.registerService(ms);
    providerSid = numbers.seedOwned("+12025550101");
    numbers.services.get(ms)!.numbers.add(providerSid);
  } else if (kind === "campaign") {
    providerSid = `QE${"9".repeat(32)}`;
    provisioning.campaigns.set(providerSid, {
      sid: providerSid, account_sid: SUB, messaging_service_sid: ms, brand_registration_sid: null, us_app_to_person_usecase: "LOW_VOLUME", campaign_status: "VERIFIED",
      mock: false, errors: "", input: {} as never,
    });
  } else {
    providerSid = ms;
  }
  const ledger = new MemoryLedger(providerSid, kind);
  const target: CancelTarget = {
    operationId: OP, resourceId: RES, operationStatus: "authorized", kind, providerSid, accountSid: SUB, messagingServiceSid: kind === "campaign" ? ms : null, liveDependents: 0,
    dualControl: kind === "number" ? { requestId: U(20), resourceId: RES, requestedBy: REQUESTER, decidedBy: APPROVER, status: "consumed" } : null, ...over,
  };
  const adapters: ReleaseAdapters = { numbers, provisioning };
  /** what the database would answer now: the operation status follows the ledger */
  const liveTarget = async (): Promise<CancelTarget> => ({ ...target, operationStatus: ledger.status === "authorized" ? target.operationStatus : ledger.status });
  let adapterBuilds = 0;
  const runner = buildCancelRunner({
    ledger,
    targets: { target: liveTarget },
    adaptersFor: async () => {
      adapterBuilds += 1;
      return adapters;
    },
    now: () => new Date("2026-10-22T12:00:00Z"),
  });
  const releases = () => numbers.count("releaseNumber") + provisioning.count("deleteCampaign") + provisioning.count("deleteMessagingService") + numbers.count("detachNumber");
  return { numbers, provisioning, ledger, runner, target, liveTarget, ms, providerSid, releases, adapterBuilds: () => adapterBuilds };
}

describe("F5 cancel runner: the happy path for each kind", () => {
  it("number: claims once, releases once, reads back absent, records confirmed with the evidence digest", async () => {
    const w = world("number");
    const out = await w.runner.run(OP, ACTOR);
    expect(out).toMatchObject({ result: "confirmed", status: "confirmed", release: "released" });
    expect(w.ledger.begins).toBe(1);
    expect(w.numbers.count("releaseNumber")).toBe(1);
    expect(w.numbers.count("numberPresence")).toBe(2);   // before the claim and the read-back
    expect(w.numbers.universe.owned.has(w.providerSid)).toBe(false);
    expect(w.numbers.services.get(w.ms)!.numbers.has(w.providerSid)).toBe(false);
    const expected = cancelEvidenceDigest({
      operationId: OP, resourceId: RES, kind: "number", providerSid: w.providerSid, accountSid: SUB, release: "released", readback: "absent", evidenceSource: "fake", observedAt: "2026-10-22T12:00:00.000Z",
    });
    expect(w.ledger.finishes).toEqual([{ outcome: "confirmed", digest: expected, code: null }]);
  });

  it("campaign: deletes it on its service; the service stays", async () => {
    const w = world("campaign");
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "confirmed" });
    expect(w.provisioning.calls.find((c) => c.method === "deleteCampaign")?.input).toEqual({ messagingServiceSid: w.ms, campaignSid: w.providerSid });
    expect(w.provisioning.campaigns.size).toBe(0);
    expect(w.provisioning.services.has(w.ms)).toBe(true);
  });

  it("messaging service: deleted only when nothing live depends on it", async () => {
    const blocked = world("messaging_service", { liveDependents: 1 });
    expect(await blocked.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    expect(blocked.ledger.begins).toBe(0);
    expect(blocked.releases()).toBe(0);
    const w = world("messaging_service");
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "confirmed" });
    expect(w.provisioning.services.has(w.ms)).toBe(false);
  });

  it("review P1-1: a resource these credentials cannot see (already gone, a stale service SID, another subaccount's credentials) is refused BEFORE the claim, never confirmed", async () => {
    const gone = world("number");
    gone.numbers.universe.owned.delete(gone.providerSid);
    expect(await gone.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    const stale = world("campaign", { messagingServiceSid: `MG${"7".repeat(32)}` });
    expect(await stale.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    expect(stale.provisioning.campaigns.size).toBe(1);   // the real campaign is untouched
    const unreadable = world("number");
    unreadable.numbers.failNext("numberPresence", { kind: "account" });   // e.g. a rotated credential: does not consume the authorization
    expect(await unreadable.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    for (const w of [gone, stale, unreadable]) {
      expect(w.ledger.begins).toBe(0);
      expect(w.releases()).toBe(0);
      expect(w.ledger.status).toBe("authorized");
    }
  });

  it("seen before the claim, gone by the release (404/20404): one request, confirmed by the read-back", async () => {
    const w = world("number");
    const releaseOrig = w.numbers.releaseNumber.bind(w.numbers);
    w.numbers.releaseNumber = async (sid) => (w.numbers.universe.owned.delete(sid), releaseOrig(sid));
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "confirmed" });
    expect(w.numbers.count("releaseNumber")).toBe(1);
  });

  it("review P2-1: facts that changed between the check and the claim (a campaign went live on the service) are recorded unknown, nothing deleted", async () => {
    const w = world("messaging_service");
    let reads = 0;
    const runner = buildCancelRunner({
      ledger: w.ledger,
      targets: { target: async () => ({ ...(await w.liveTarget()), liveDependents: reads++ === 0 ? 0 : 1 }) },
      adaptersFor: async () => ({ numbers: w.numbers, provisioning: w.provisioning }),
    });
    expect(await runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "no_call_recheck_failed" });
    expect(w.releases()).toBe(0);
    expect(w.provisioning.services.has(w.ms)).toBe(true);
  });

  it("re-review P2: a Messaging Service with ANY campaign at the provider (even one the inventory does not know) is never deleted", async () => {
    const w = world("messaging_service");
    // an unknown-outcome R2a create / console campaign: it exists at Twilio, the database counts no live dependent
    w.provisioning.campaigns.set(`QE${"8".repeat(32)}`, {
      sid: `QE${"8".repeat(32)}`, account_sid: SUB, messaging_service_sid: w.ms, brand_registration_sid: null, us_app_to_person_usecase: "LOW_VOLUME", campaign_status: "IN_PROGRESS",
      mock: false, errors: "", input: {} as never,
    });
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused", reason: expect.stringContaining("campaign") });
    expect(w.ledger.begins).toBe(0);
    expect(w.releases()).toBe(0);
    // the campaign listing fails: refused too
    const x = world("messaging_service");
    x.provisioning.failNext("findCampaigns", { kind: "transient" });
    expect(await x.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    // a campaign appears between the claim and the delete: recorded unknown, nothing deleted
    const y = world("messaging_service");
    const origBegin = y.ledger.beginCancel.bind(y.ledger);
    y.ledger.beginCancel = async () => {
      const r = await origBegin();
      y.provisioning.campaigns.set(`QE${"6".repeat(32)}`, { sid: `QE${"6".repeat(32)}`, account_sid: SUB, messaging_service_sid: y.ms, brand_registration_sid: null, us_app_to_person_usecase: "LOW_VOLUME", campaign_status: "IN_PROGRESS", mock: false, errors: "", input: {} as never });
      return r;
    };
    expect(await y.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "no_call_recheck_failed" });
    expect(y.provisioning.services.has(y.ms)).toBe(true);
  });

  it("re-review P3-4: an upper-case operation id is normalized, not refused", async () => {
    const w = world("campaign");
    expect(await w.runner.run(OP.toUpperCase(), ACTOR.toUpperCase())).toMatchObject({ result: "confirmed" });
  });

  it("review P1-2: a consumed approval for ANOTHER resource never satisfies a number's dual control", async () => {
    const w = world("number", { dualControl: { requestId: U(20), resourceId: U(99), requestedBy: REQUESTER, decidedBy: APPROVER, status: "consumed" } });
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });
    expect(w.numbers.calls).toHaveLength(0);
  });

  it("review P3-3: the runner never detaches (detachNumber is not part of any cancellation)", async () => {
    const w = world("number");
    await w.runner.run(OP, ACTOR);
    expect(w.numbers.count("detachNumber")).toBe(0);
  });
});

describe("F5 cancel runner: RFL owner invariants", () => {
  it("confirmed is recorded only AFTER a provider read showed the resource gone (a successful delete alone is not evidence)", async () => {
    for (const kind of ["number", "campaign", "messaging_service"] as const) {
      const w = world(kind);
      const order: string[] = [];
      const origFinish = w.ledger.finishCancel.bind(w.ledger);
      w.ledger.finishCancel = async (...args) => (order.push(`finish:${args[1]}`), origFinish(...args));
      await w.runner.run(OP, ACTOR);
      const providerCalls = [...w.numbers.calls, ...w.provisioning.calls].map((c) => c.method).filter((m) => m !== "findCampaigns");   // the service path also lists its campaigns (free reads)
      // pre-claim read, the ONE release, the read-back the evidence is made of
      expect(providerCalls, kind).toHaveLength(3);
      expect(providerCalls[0], kind).toMatch(/Presence$/);
      expect(providerCalls[1], kind).toMatch(/^(release|delete)/);
      expect(providerCalls[2], kind).toMatch(/Presence$/);
      expect(order, kind).toEqual(["finish:confirmed"]);
      expect(w.ledger.finishes[0].digest, kind).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refused is recorded only with code api; every other failure is unknown with a non-api code", async () => {
    const codes = new Set<string | null>();
    for (const failure of [{ kind: "validation" as const }, { kind: "account" as const }, { kind: "transient" as const }, { kind: "unexpected" as const }, { kind: "validation" as const, status: 404 }]) {
      const w = world("number");
      w.numbers.failNext("releaseNumber", failure);
      await w.runner.run(OP, ACTOR);
      const f = w.ledger.finishes[0];
      if (f.outcome === "refused") expect(f.code).toBe("api");
      else expect(f.code).not.toBe("api");
      codes.add(`${f.outcome}:${f.code}`);
    }
    expect(codes).toEqual(new Set(["refused:api", "unknown:release_transient_503", "unknown:release_unexpected", "unknown:release_validation_404"]));
  });

  it("only execute reaches the provider: reconcile, in_progress and skip neither release nor read", async () => {
    for (const status of ["unknown_outcome", "in_flight", "confirmed"]) {
      const w = world("campaign");
      w.ledger.status = status;
      const runner = buildCancelRunner({ ledger: w.ledger, targets: { target: async () => w.target }, adaptersFor: async () => ({ numbers: w.numbers, provisioning: w.provisioning }) });
      expect((await runner.run(OP, ACTOR)).result).toMatch(/reconcile|in_progress|skip/);
      expect(w.releases(), status).toBe(0);
      expect(w.ledger.finishes, status).toHaveLength(0);
    }
  });

  it("no runner outcome carries a provider SID (the UI never renders one)", async () => {
    const w = world("number");
    w.numbers.failNext("releaseNumber", { kind: "transient" });
    const outs = [await w.runner.run(OP, ACTOR), await world("campaign").runner.run(OP, ACTOR), await world("number", { dualControl: null }).runner.run(OP, ACTOR)];
    for (const out of outs) expect(JSON.stringify(out)).not.toMatch(/\b(PN|QE|MG|AC)[0-9a-fA-F]{32}\b/);
  });
});

describe("F5 cancel runner: dual control for numbers (checked before any claim or call)", () => {
  const refusedWith = async (dualControl: CancelTarget["dualControl"]) => {
    const w = world("number", { dualControl });
    const out = await w.runner.run(OP, ACTOR);
    expect(out).toMatchObject({ result: "precondition_refused" });
    expect(w.ledger.begins).toBe(0);
    expect(w.releases()).toBe(0);
    expect(w.numbers.calls).toHaveLength(0);
    expect(w.ledger.status).toBe("authorized");
  };

  it("no approval, an unconsumed one, one administrator acting twice, or a malformed one: refused, nothing claimed", async () => {
    await refusedWith(null);
    await refusedWith({ requestId: U(20), resourceId: RES, requestedBy: REQUESTER, decidedBy: APPROVER, status: "approved" });
    await refusedWith({ requestId: U(20), resourceId: RES, requestedBy: REQUESTER, decidedBy: REQUESTER, status: "consumed" });
    await refusedWith({ requestId: U(20), resourceId: RES, requestedBy: REQUESTER, decidedBy: REQUESTER.toUpperCase(), status: "consumed" });
    await refusedWith({ requestId: "x", resourceId: RES, requestedBy: REQUESTER, decidedBy: APPROVER, status: "consumed" });
  });

  it("campaigns and services do not need it (RFL Ops D3 is numbers only)", async () => {
    expect(await world("campaign").runner.run(OP, ACTOR)).toMatchObject({ result: "confirmed" });
  });
});

describe("F5 cancel runner: unknown outcomes are never repeated", () => {
  it("a lost response (Twilio applied it, the caller saw a timeout) is recorded unknown; every later run answers reconcile and calls nothing", async () => {
    const w = world("number");
    w.numbers.failNext("releaseNumber", { kind: "transient", lostResponse: true });
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", status: "unknown_outcome", errorCode: "release_transient_503" });
    expect(w.ledger.finishes).toEqual([{ outcome: "unknown", digest: null, code: "release_transient_503" }]);
    expect(w.numbers.universe.owned.has(w.providerSid)).toBe(false);   // it really was released
    for (let i = 0; i < 3; i += 1) expect(await w.runner.run(OP, ACTOR)).toEqual({ result: "reconcile" });
    expect(w.numbers.count("releaseNumber")).toBe(1);
    expect(w.numbers.count("numberPresence")).toBe(1);   // the single pre-claim read; no read after reconcile
  });

  it("an unexpected exception, a read-back failure and a read-back that still shows the resource are all unknown", async () => {
    const a = world("campaign");
    a.provisioning.failNext("deleteCampaign", { kind: "unexpected" });
    expect(await a.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "release_unexpected" });

    const b = world("campaign");
    const deleteOrig = b.provisioning.deleteCampaign.bind(b.provisioning);
    b.provisioning.deleteCampaign = async (input) => { const r = await deleteOrig(input); b.provisioning.failNext("campaignPresence", { kind: "transient" }); return r; };
    expect(await b.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "readback_transient_503" });

    const c = world("number");
    const stubborn: NumberReleaseAdapter = { accountSid: SUB, evidenceSource: "fake", releaseNumber: async () => "released", detachNumber: async () => "released", numberPresence: async () => "present" };
    const runner = buildCancelRunner({ ledger: c.ledger, targets: { target: c.liveTarget }, adaptersFor: async () => ({ numbers: stubborn, provisioning: null }) });
    expect(await runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "readback_present" });
  });

  it("a 404 that is not Twilio's 20404, a 429 and a 5xx are unknown, never refused", async () => {
    for (const failure of [{ kind: "validation" as const, status: 404 }, { kind: "transient" as const, status: 429 }, { kind: "transient" as const, status: 500 }]) {
      const w = world("number");
      w.numbers.failNext("releaseNumber", failure);
      expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown" });
    }
  });

  it("a definite provider refusal (parseable 4xx) is recorded refused with code api; nothing changed at the provider", async () => {
    const w = world("number");
    w.numbers.failNext("releaseNumber", { kind: "validation", code: "21000" });
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "refused", status: "refused" });
    expect(w.ledger.finishes).toEqual([{ outcome: "refused", digest: null, code: "api" }]);
    expect(w.numbers.universe.owned.has(w.providerSid)).toBe(true);
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "precondition_refused" });   // closed: a new authorization is needed
    expect(w.numbers.count("releaseNumber")).toBe(1);
  });

  it("the provider acted but recording failed: the outcome and digest come back for a manual record, and nothing is retried", async () => {
    const w = world("number");
    w.ledger.failFinish = true;
    const out = await w.runner.run(OP, ACTOR);
    expect(out).toMatchObject({ result: "record_failed", outcome: "confirmed", errorCode: null });
    expect(out.result === "record_failed" && out.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(w.ledger.status).toBe("in_flight");
    expect(await w.runner.run(OP, ACTOR)).toEqual({ result: "in_progress" });
    expect(w.numbers.count("releaseNumber")).toBe(1);
  });
});

describe("F5 cancel runner: the single claim and the target", () => {
  it("two concurrent runs: only the one the database answered execute reaches the provider", async () => {
    const w = world("campaign");
    // both read the target while it is still authorized, then race for the claim
    const runner = buildCancelRunner({ ledger: w.ledger, targets: { target: w.liveTarget }, adaptersFor: async () => ({ numbers: w.numbers, provisioning: w.provisioning }) });
    const outs = await Promise.all([runner.run(OP, ACTOR), runner.run(OP, ACTOR)]);
    expect(outs.map((o) => o.result).sort()).toEqual(["confirmed", "in_progress"]);
    expect(w.provisioning.count("deleteCampaign")).toBe(1);
  });

  it("a claim about a different resource than the one checked: recorded unknown, nothing called", async () => {
    const w = world("number");
    w.ledger.providerSid = `PN${"e".repeat(32)}`;
    expect(await w.runner.run(OP, ACTOR)).toMatchObject({ result: "unknown", errorCode: "no_call_target_mismatch" });
    expect(w.releases()).toBe(0);
  });

  it("no claim and no call when the target is unreadable, malformed, not authorized, the adapter is missing, built for another account, or cannot be built", async () => {
    const cases: [string, Parameters<typeof world>[1], ((w: ReturnType<typeof world>) => void)?][] = [
      ["unreadable", {}, (w) => Object.assign(w, { runner: buildCancelRunner({ ledger: w.ledger, targets: { target: async () => null }, adaptersFor: async () => ({ numbers: w.numbers, provisioning: w.provisioning }) }) })],
      ["throwing target", {}, (w) => Object.assign(w, { runner: buildCancelRunner({ ledger: w.ledger, targets: { target: async () => { throw new Error("x"); } }, adaptersFor: async () => ({ numbers: w.numbers, provisioning: w.provisioning }) }) })],
      ["kind/sid mismatch", { providerSid: `QE${"1".repeat(32)}` }],
      ["no account", { accountSid: "AC1" }],
      ["withdrawn", { operationStatus: "withdrawn" }],
      ["campaign without service", {}],
      ["no adapter", {}, (w) => Object.assign(w, { runner: buildCancelRunner({ ledger: w.ledger, targets: { target: async () => w.target }, adaptersFor: async () => ({ numbers: null, provisioning: null }) }) })],
      ["other account", {}, (w) => Object.assign(w, { runner: buildCancelRunner({ ledger: w.ledger, targets: { target: async () => w.target }, adaptersFor: async () => ({ numbers: new FakeNumberAdapter(`AC${"5".repeat(32)}`), provisioning: null }) }) })],
      ["adapter build fails", {}, (w) => Object.assign(w, { runner: buildCancelRunner({ ledger: w.ledger, targets: { target: async () => w.target }, adaptersFor: async () => { throw new Error("gate"); } }) })],
    ];
    for (const [name, over, patch] of cases) {
      const w = name === "campaign without service" ? world("campaign", { messagingServiceSid: null }) : world("number", over);
      patch?.(w);
      const out = await w.runner.run(OP, ACTOR);
      expect(out.result, name).toBe("precondition_refused");
      expect(w.ledger.begins, name).toBe(0);
      expect(w.releases(), name).toBe(0);
    }
  });

  it("an operation already in flight or unknown is reported without building an adapter", async () => {
    const a = world("number", { operationStatus: "in_flight" });
    expect(await a.runner.run(OP, ACTOR)).toEqual({ result: "in_progress" });
    const b = world("number", { operationStatus: "unknown_outcome" });
    expect(await b.runner.run(OP, ACTOR)).toEqual({ result: "reconcile" });
    expect(a.adapterBuilds() + b.adapterBuilds()).toBe(0);
    expect(a.ledger.begins + b.ledger.begins).toBe(0);
  });

  it("malformed ids never reach the target source", async () => {
    const w = world("number");
    expect(await w.runner.run("not-a-uuid", ACTOR)).toMatchObject({ result: "precondition_refused" });
    expect(await w.runner.run(OP, "nope")).toMatchObject({ result: "precondition_refused" });
    expect(w.ledger.begins).toBe(0);
  });
});
