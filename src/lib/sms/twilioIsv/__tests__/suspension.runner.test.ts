import { describe, expect, it, vi } from "vitest";
import { ownedSubaccount, runSubaccountStatusChange, sameSid, runSubaccountVerification, suspensionMessage, type ChangeInput } from "../suspension";
import { FakeSubaccountStatusProvider } from "../suspensionFake";

/**
 * TW-4F slice E: the suspension runner against the in-memory fake provider and scripted database answers. No network, no database, no Twilio.
 * The database's own refusals (session, registered admin, switch, identity, confirmation, idempotency, concurrency) are covered against a real schema
 * by localStack.suspension.test.ts; here: what the server does with each answer and each provider behaviour.
 */

vi.mock("server-only", () => ({}));

const PARENT = `AC${"a".repeat(32)}`;
const SUB = `AC${"b".repeat(31)}1`;
const OTHER_PARENT = `AC${"c".repeat(32)}`;
const ATTEMPT = "00000000-0000-4000-8000-0000000000a1";

type Call = { fn: string; args: Record<string, unknown> };
function db(answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string } | null }) {
  const calls: Call[] = [];
  return { calls, rpc: async (fn: string, args: Record<string, unknown> = {}) => (calls.push({ fn, args }), answer(fn, args)) };
}
const proceed = (action: "suspend" | "reactivate", sid = SUB) => db(() => ({ data: { decision: "proceed", attempt_id: ATTEMPT, action, account_sid: sid, locations: 2, holds_placed: action === "suspend" ? 2 : 0 }, error: null }));
const recorder = () => db(() => ({ data: { recorded: true }, error: null }));
const input = (action: "suspend" | "reactivate" = "suspend"): ChangeInput => ({
  studioId: "00000000-0000-4000-8000-000000000001", action, studioName: "Studio One", sidTail: SUB.slice(-6), authorizationRef: "owner email 2026-11-26", reason: "emergency: traffic we did not send", idempotencyKey: "k".repeat(20), locationCount: 2,
});
const outcomes = (admin: ReturnType<typeof recorder>) => admin.calls.filter((c) => c.fn === "tw4susp_record").map((c) => [c.args.p_step, c.args.p_outcome, c.args.p_state_before, c.args.p_state_after, c.args.p_code]);

describe("runSubaccountStatusChange", () => {
  it("a database refusal (or a refused session / non-admin) is returned as-is and the provider is never touched", async () => {
    for (const [answer, code] of [
      [{ data: { decision: "refused", code: "wrong_sid_tail" }, error: null }, "wrong_sid_tail"],
      [{ data: { decision: "refused", code: "switched_off" }, error: null }, "switched_off"],
      [{ data: null, error: { code: "42501" } }, "not_allowed"],
      [{ data: null, error: { code: "22023" } }, "invalid"],
    ] as const) {
      const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
      const admin = recorder();
      const r = await runSubaccountStatusChange({ user: db(() => answer as never), admin, provider, parentSid: PARENT }, input());
      expect(r).toEqual({ kind: "refused", code });
      expect(provider.reads).toEqual([]);
      expect(provider.writes).toEqual([]);
      expect(admin.calls).toEqual([]);
    }
  });

  it("a replay of the same key returns the stored result and calls nothing", async () => {
    const provider = new FakeSubaccountStatusProvider();
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: db(() => ({ data: { decision: "replay", state: "closed", outcome: "succeeded", provider_state_after: "suspended" }, error: null })), admin, provider, parentSid: PARENT }, input());
    expect(r).toEqual({ kind: "replay", state: "closed", outcome: "succeeded", providerStateAfter: "suspended" });
    expect(provider.reads.length + provider.writes.length + admin.calls.length).toBe(0);
  });

  it("success: GET (owned subaccount) -> write suspended -> GET read-back -> recorded succeeded", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ kind: "done", outcome: "succeeded", stateBefore: "active", stateAfter: "suspended", recorded: true });
    expect(provider.writes).toEqual([{ sid: SUB, status: "suspended" }]);
    expect(provider.reads).toEqual([SUB, SUB]);
    expect(outcomes(admin)).toEqual([["precheck", null, "active", null, null], ["outcome", "succeeded", "active", "suspended", null]]);
    expect(suspensionMessage(r).message).toMatch(/not a spending ceiling/);
  });

  it("reactivation writes active (never closed) after a confirmed suspension", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "suspended" });
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("reactivate"), admin, provider, parentSid: PARENT }, input("reactivate"));
    expect(r).toMatchObject({ outcome: "succeeded", stateAfter: "active" });
    expect(provider.writes).toEqual([{ sid: SUB, status: "active" }]);
  });

  it("NEVER the parent: the parent SID is refused before any provider call, and so is a missing parent configuration", async () => {
    for (const parentSid of [SUB, "", "not-a-sid"]) {
      const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: null, status: "active" });
      const admin = recorder();
      const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid }, input());
      expect(r).toMatchObject({ kind: "done", outcome: "refused", code: parentSid === SUB ? "parent_account" : "parent_unknown" });
      expect(provider.reads).toEqual([]);
      expect(provider.writes).toEqual([]);
      expect(outcomes(admin)).toEqual([["outcome", "refused", "not_called", null, parentSid === SUB ? "parent_account" : "parent_unknown"]]);
    }
  });

  it("refuses an account the provider does not report as a subaccount of THIS parent (another owner, no owner, or a reply about another sid)", async () => {
    for (const acct of [
      { sid: SUB, ownerAccountSid: OTHER_PARENT, status: "active" },
      { sid: SUB, ownerAccountSid: null, status: "active" },
      { sid: SUB, ownerAccountSid: SUB, status: "active" },
    ]) {
      const provider = new FakeSubaccountStatusProvider().add(acct);
      const admin = recorder();
      const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
      expect(r).toMatchObject({ outcome: "refused", code: "not_owned_by_parent" });
      expect(provider.writes).toEqual([]);
    }
    expect(ownedSubaccount({ sid: OTHER_PARENT, ownerAccountSid: PARENT, status: "active" }, SUB, PARENT)).toBe(false);
  });

  it("a CLOSED account is refused and never written (closing is permanent)", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "closed" });
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("reactivate"), admin, provider, parentSid: PARENT }, input("reactivate"));
    expect(r).toMatchObject({ outcome: "refused", code: "closed" });
    expect(provider.writes).toEqual([]);
    expect(suspensionMessage(r).message).toMatch(/CLOSED/);
  });

  it("already in the target state: recorded without any write", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "suspended" });
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ outcome: "already_in_state", stateAfter: "suspended" });
    expect(provider.writes).toEqual([]);
  });

  it("the pre-check read fails: a definite failure (nothing was changed), no write", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" }).failNextReadOnce();
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ outcome: "failed", stateBefore: "unreadable" });
    expect(provider.writes).toEqual([]);
    // accurate wording: Twilio was never asked to change anything
    expect(suspensionMessage(r).message).toMatch(/Twilio was NOT called.*could not be read/);
    expect(suspensionMessage(r).message).not.toMatch(/refused/i);
  });

  it("provider error: a definite 4xx with the state unchanged is FAILED", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" }).failNextWrite("definite");
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ outcome: "failed", stateAfter: "active" });
    expect(provider.writes).toHaveLength(1);
  });

  it("unknown outcome: a transient error with the state unchanged, a write the provider ignored, or an unreadable read-back are UNKNOWN and never retried", async () => {
    for (const kind of ["transient", "silently_ignored", "readback_fails"] as const) {
      const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" }).failNextWrite(kind);
      const admin = recorder();
      const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
      expect(r, kind).toMatchObject({ outcome: "unknown" });
      expect(provider.writes, kind).toHaveLength(1); // exactly one write: no blind retry, and no automatic reversal
      expect(suspensionMessage(r).message).toMatch(/UNKNOWN.*will not be retried/);
    }
  });

  it("a lost reply whose read-back shows the target is SUCCEEDED (the read-back decides)", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" }).failNextWrite("applied_then_transient");
    const admin = recorder();
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ outcome: "succeeded", stateAfter: "suspended" });
  });

  it("F2: a pre-check that cannot be recorded ends the attempt as FAILED before any write to the provider", async () => {
    for (const failing of [{ data: null, error: { code: "XX000" } }, "throw"] as const) {
      const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
      const admin = db((fn, args) => {
        if (args.p_step === "precheck") {
          if (failing === "throw") throw new Error("db down");
          return failing;
        }
        return { data: { recorded: true }, error: null };
      });
      const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
      expect(r).toMatchObject({ kind: "done", outcome: "failed", code: "precheck_unrecorded" });
      expect(provider.writes).toEqual([]);
      expect(suspensionMessage(r).message).toMatch(/Twilio was NOT called.*checked and recorded/);
      expect(suspensionMessage(r).message).not.toMatch(/refused/i);
    }
  });

  it("an outcome that cannot be recorded is reported as such (the attempt stays open in the database)", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
    const admin = db((_fn, args) => (args.p_step === "outcome" ? { data: null, error: { code: "XX000" } } : { data: { recorded: true }, error: null }));
    const r = await runSubaccountStatusChange({ user: proceed("suspend"), admin, provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ outcome: "succeeded", recorded: false });
    expect(suspensionMessage(r).message).toMatch(/could NOT be recorded/);
  });

  it("F4: SID comparisons ignore case: a differently cased parent is refused, an owner SID in another case still proves ownership", async () => {
    const upperParent = PARENT.toUpperCase().replace(/^AC/, "AC");
    // the recorded SID is the parent in another case: refused before any provider call
    const p1 = new FakeSubaccountStatusProvider().add({ sid: PARENT, ownerAccountSid: null, status: "active" });
    expect(await runSubaccountStatusChange({ user: proceed("suspend", PARENT), admin: recorder(), provider: p1, parentSid: upperParent }, input())).toMatchObject({ outcome: "refused", code: "parent_account" });
    expect(p1.reads).toEqual([]);
    // the provider reports the owner in upper case: still the parent, so the change proceeds
    const p2 = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: upperParent, status: "active" });
    expect(await runSubaccountStatusChange({ user: proceed("suspend"), admin: recorder(), provider: p2, parentSid: PARENT }, input())).toMatchObject({ outcome: "succeeded" });
    // the provider reports the account as the parent itself in another case: refused
    expect(ownedSubaccount({ sid: upperParent, ownerAccountSid: PARENT, status: "active" }, PARENT, PARENT)).toBe(false);
    expect(sameSid(SUB, SUB.toUpperCase().replace(/^AC/, "AC"))).toBe(true);
    expect(sameSid("", "")).toBe(false);
  });

  it("F7: the result reports how many locations the subaccount serves and how many holds were placed", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
    const user = proceed("suspend");
    const r = await runSubaccountStatusChange({ user, admin: recorder(), provider, parentSid: PARENT }, input());
    expect(r).toMatchObject({ locations: 2, holdsPlaced: 2 });
    expect(suspensionMessage(r).message).toMatch(/serves 2 location\(s\); 2 new traffic hold\(s\)/);
    expect(user.calls[0].args.p_location_count).toBe(2);
  });

  it("a begin answer that does not match the request (wrong action, invalid sid) is refused without a provider call", async () => {
    for (const user of [proceed("reactivate"), proceed("suspend", "ACnotasid")]) {
      const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
      expect(await runSubaccountStatusChange({ user, admin: recorder(), provider, parentSid: PARENT }, input())).toEqual({ kind: "refused", code: "unavailable" });
      expect(provider.reads).toEqual([]);
    }
  });
});

describe("runSubaccountVerification (read-only)", () => {
  const begin = (sid = SUB) => db(() => ({ data: { decision: "proceed", attempt_id: ATTEMPT, action: "suspend", account_sid: sid }, error: null }));

  it("records the observed state and never writes to the provider", async () => {
    const provider = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "suspended" });
    const admin = recorder();
    expect(await runSubaccountVerification({ user: begin(), admin, provider, parentSid: PARENT }, { studioId: "s", reason: "verify the unknown attempt" })).toEqual({ kind: "verified", observed: "suspended", recorded: true });
    expect(provider.writes).toEqual([]);
    expect(outcomes(admin)).toEqual([["reconciled", "reconciled", null, "suspended", null]]);
  });

  it("refuses the parent, a non-owned account, and an unreadable provider (attempt stays open, nothing recorded)", async () => {
    const owned = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: OTHER_PARENT, status: "active" });
    expect(await runSubaccountVerification({ user: begin(PARENT), admin: recorder(), provider: owned, parentSid: PARENT }, { studioId: "s", reason: "verify" })).toEqual({ kind: "refused", code: "parent_account" });
    const a = recorder();
    expect(await runSubaccountVerification({ user: begin(), admin: a, provider: owned, parentSid: PARENT }, { studioId: "s", reason: "verify" })).toEqual({ kind: "refused", code: "not_owned_by_parent" });
    const down = new FakeSubaccountStatusProvider().add({ sid: SUB, ownerAccountSid: PARENT, status: "active" }).failNextReadOnce();
    expect(await runSubaccountVerification({ user: begin(), admin: a, provider: down, parentSid: PARENT }, { studioId: "s", reason: "verify" })).toEqual({ kind: "refused", code: "provider_unreadable" });
    expect(a.calls).toEqual([]);
  });

  it("passes a database refusal through (e.g. nothing to verify)", async () => {
    const provider = new FakeSubaccountStatusProvider();
    expect(await runSubaccountVerification({ user: db(() => ({ data: { decision: "refused", code: "nothing_to_verify" }, error: null })), admin: recorder(), provider, parentSid: PARENT }, { studioId: "s", reason: "verify" })).toEqual({ kind: "refused", code: "nothing_to_verify" });
    expect(provider.reads).toEqual([]);
  });
});

describe("messages never claim a spending ceiling", () => {
  it("no message calls suspension a cap or a limit on spending", () => {
    const all = ["succeeded", "already_in_state", "failed", "refused", "unknown"].map((o) => suspensionMessage({ kind: "done", outcome: o as never, code: null, stateBefore: "active", stateAfter: "suspended", recorded: true, locations: 1, holdsPlaced: 1 }).message);
    for (const m of all) expect(m.replace(/not a spending ceiling/g, "")).not.toMatch(/ceiling|\bcap\b|guarantee|hard limit|spending limit/i);
  });
});
