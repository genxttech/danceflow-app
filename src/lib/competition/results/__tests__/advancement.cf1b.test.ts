import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  advancementPanel,
  callWithRetryOnce,
  canCosign,
  effectivelyExcludedEntryIds,
  errorText,
  exclusionWindowOpen,
  isRetryableError,
  parseAdvancementPreview,
  parseExclusionReasonKind,
  parseExclusionRows,
  parseWithdrawalState,
  pendingExclusionRequests,
  validateExclusionReason,
  withdrawalReasonLooksSubstantive,
  withRetryOnce,
  type RpcCall,
  type RpcResult,
} from "../advancement";
import { hasResultMessage, resultErrorMessage, RETRYABLE_MESSAGE } from "../messages";
import { parseReviewExcluded } from "../reviewTypes";

const ok = (data: unknown = {}): RpcResult => ({ data, error: null });
const fail = (message: string, code?: string): RpcResult => ({ data: null, error: { message, code } });

describe("CF1 B: retry once on 40P01 / 55P03 (U28 mapping side)", () => {
  it("recognises the SQLSTATE on error.code and the text form PostgREST/heatLock.ts use", () => {
    expect(isRetryableError({ message: "x", code: "40P01" })).toBe(true);
    expect(isRetryableError({ message: "x", code: "55P03" })).toBe(true);
    expect(isRetryableError({ message: "deadlock detected" })).toBe(true);
    expect(isRetryableError({ message: "could not obtain lock on row in relation" })).toBe(true);
    expect(isRetryableError({ message: "COMP_ADVANCEMENT_CONCURRENT_CHANGE: another change" })).toBe(true);
    expect(isRetryableError({ message: "canceling statement due to statement timeout", code: "57014" })).toBe(true);
  });

  it("does not treat a permanent code as retryable", () => {
    for (const message of ["COMP_ADVANCEMENT_BLOCKED: tie", "COMP_ROSTER_ENTRY_UNAVAILABLE: x", "COMP_FORBIDDEN: no", "permission denied"]) {
      expect(isRetryableError({ message, code: "P0001" })).toBe(false);
    }
    expect(isRetryableError(null)).toBe(false);
  });

  it("repeats a retryable failure exactly once with the same arguments (same request id)", async () => {
    const call = vi.fn<RpcCall>().mockResolvedValueOnce(fail("deadlock detected", "40P01")).mockResolvedValueOnce(ok({ replayed: true }));
    const args = { p_round_id: "r", p_request_id: "q" };
    const result = await callWithRetryOnce(call, "apply_competition_round_advancement", args);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
    expect(result.error).toBeNull();
  });

  it("gives up after one repeat and the message is the try-again copy", async () => {
    const call = vi.fn<RpcCall>().mockResolvedValue(fail("could not obtain lock", "55P03"));
    const result = await callWithRetryOnce(call, "lock_competition_round_ballots", { p_request_id: "q" });
    expect(call).toHaveBeenCalledTimes(2);
    expect(errorText(result.error)).toBe(RETRYABLE_MESSAGE);
  });

  it("never repeats a permanent refusal or a success", async () => {
    const permanent = vi.fn<RpcCall>().mockResolvedValue(fail("COMP_ADVANCEMENT_BLOCKED: tie"));
    await callWithRetryOnce(permanent, "apply_competition_round_advancement", {});
    expect(permanent).toHaveBeenCalledTimes(1);
    const success = vi.fn<RpcCall>().mockResolvedValue(ok());
    await callWithRetryOnce(success, "x", {});
    expect(success).toHaveBeenCalledTimes(1);
  });

  it("withRetryOnce wraps an rpc for calculate, approve and the other request-id actions", async () => {
    const inner = vi.fn<RpcCall>().mockResolvedValueOnce(fail("deadlock detected", "40P01")).mockResolvedValueOnce(ok());
    const wrapped = withRetryOnce(inner);
    await wrapped("approve_competition_round_result", { p_request_id: "q" });
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("CF1 B: message map", () => {
  const migrations = join(__dirname, "..", "..", "..", "supabase", "migrations");
  const files = readdirSync(migrations).filter((name) => /^20270120\d{6}_competition_cf1_.*\.sql$/.test(name));

  it("explains every CF1 ADVANCEMENT / ROSTER / EXCLUSION / WITHDRAWAL / CALLBACK_TARGET / CAPACITY code the CF1 migrations can raise", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    const codes = new Set<string>();
    for (const name of files) {
      const sql = readFileSync(join(migrations, name), "utf8");
      for (const match of sql.matchAll(/'(COMP_(?:ADVANCEMENT|ROSTER|EXCLUSION|WITHDRAWAL|CALLBACK_TARGET|CAPACITY)_[A-Z0-9_]+)\b/g)) codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(40);
    const missing = [...codes].filter((code) => !hasResultMessage(code));
    expect(missing).toEqual([]);
  });

  it("explains the codes the contracts list (not only those found in SQL text)", () => {
    for (const code of [
      "COMP_ADVANCEMENT_ROSTER_STALE", "COMP_ADVANCEMENT_ROSTER_INCOMPLETE", "COMP_ADVANCEMENT_BELOW_MINIMUM", "COMP_ADVANCEMENT_FINAL_CANCELLED",
      "COMP_ROSTER_ENTRY_UNAVAILABLE", "COMP_ROSTER_BELOW_MINIMUM", "COMP_EXCLUSION_NOT_DANCED", "COMP_EXCLUSION_COSIGNER_CONFLICT",
      "COMP_CALLBACK_TARGET_BELOW_MINIMUM", "COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY", "COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY",
    ]) {
      expect(hasResultMessage(code)).toBe(true);
      expect(resultErrorMessage(code)).not.toBe("That could not be done. Reload the page and try again.");
    }
  });

  it("does not expose per-entry payment reasons or ids from an error detail (coarsened)", () => {
    const raw =
      'COMP_ROSTER_ENTRY_UNAVAILABLE: 2 entries are not available {"stage":"lock","entries":[{"entry_id":"6d1f0c7e-1111-4111-8111-111111111111","reason":"registration_payment_refunded"}]}';
    const shown = resultErrorMessage(raw);
    expect(shown).not.toMatch(/registration_|order_|payment_|entry_id|6d1f0c7e/);
    const advancement = resultErrorMessage('COMP_ADVANCEMENT_ENTRY_UNAVAILABLE: {"entries":[{"entry_id":"x","reason":"order_payment_failed"}]}');
    expect(advancement).not.toMatch(/order_|payment_failed|entry_id/);
  });

  it("maps a raw deadlock with no COMP code to the try-again copy, and keeps unknown text generic", () => {
    expect(resultErrorMessage("deadlock detected")).toBe(RETRYABLE_MESSAGE);
    expect(resultErrorMessage("40P01")).toBe(RETRYABLE_MESSAGE);
    expect(resultErrorMessage("COMP_ADVANCEMENT_CONCURRENT_CHANGE: x")).toContain("Nothing was saved");
    expect(resultErrorMessage("syntax error at or near")).toBe("That could not be done. Reload the page and try again.");
  });

  it("the T<2 refusal copy matches the organizer text of callbackTarget.ts", () => {
    expect(resultErrorMessage("COMP_CALLBACK_TARGET_BELOW_MINIMUM: the callback target (T) must be at least 2")).toMatch(/2 or more/);
  });
});

describe("CF1 B: advancement preview model", () => {
  it("parses ready / blocked / applied / revoked and treats anything unreadable as not applicable", () => {
    expect(parseAdvancementPreview({ state: "ready", advanced_entries: 6, target_round_id: "t", target_capacity: 8, heats: 1, generation: 1 })).toMatchObject({
      state: "ready", advancedEntries: 6, targetCapacity: 8,
    });
    expect(parseAdvancementPreview({ state: "weird" }).state).toBe("not_applicable");
    expect(parseAdvancementPreview(null).state).toBe("not_applicable");
    expect(parseAdvancementPreview("x").state).toBe("not_applicable");
  });

  it("offers apply only to a manager, only when ready, only on an approved round", () => {
    const ready = parseAdvancementPreview({ state: "ready", advanced_entries: 6 });
    expect(advancementPanel(ready, { isManager: true, roundStatus: "approved" }).canApply).toBe(true);
    expect(advancementPanel(ready, { isManager: true, roundStatus: "calculated" }).canApply).toBe(false);
    expect(advancementPanel(ready, { isManager: false, roundStatus: "approved" }).show).toBe(false);
    for (const state of ["blocked", "applied", "revoked"]) {
      expect(advancementPanel(parseAdvancementPreview({ state }), { isManager: true, roundStatus: "approved" }).canApply).toBe(false);
    }
    expect(advancementPanel(parseAdvancementPreview({ state: "not_applicable" }), { isManager: true, roundStatus: "approved" }).show).toBe(false);
  });

  it("a blocked tie has no override control: no apply, and blockers are shown as copy without per-entry detail", () => {
    const preview = parseAdvancementPreview({
      state: "blocked",
      blockers: [
        { code: "COMP_ADVANCEMENT_BLOCKED", detail: { tie_over_capacity: true } },
        { code: "COMP_ADVANCEMENT_ENTRY_UNAVAILABLE", detail: { entries: [{ entry_id: "e", reason: "registration_payment_refunded" }] } },
      ],
    });
    const panel = advancementPanel(preview, { isManager: true, roundStatus: "approved" });
    expect(panel.canApply).toBe(false);
    expect(panel.blockerMessages).toHaveLength(2);
    expect(panel.blockerMessages.join(" ")).not.toMatch(/registration_|payment_|entry_id/);
  });

  it("states carried withdrawals and the generation when applied", () => {
    const panel = advancementPanel(parseAdvancementPreview({ state: "applied", advanced_entries: 5, generation: 2, carried_withdrawals: [{ entry_id: "e" }] }), {
      isManager: true, roundStatus: "approved",
    });
    expect(panel.headline).toMatch(/generation 2/);
    expect(panel.headline).toMatch(/1 withdrawn couple was carried/);
  });
});

describe("CF1 B: exclusion model", () => {
  const rows = parseExclusionRows({
    rows: [
      { id: "r1", seq: 1, kind: "exclude_requested", entry_id: "e1", reason_kind: "refunded", reason: "Refund after the heat", actor: "u1", actor_role: "manager", at: "t", completed: true },
      { id: "r2", seq: 2, kind: "exclude_cosigned", entry_id: "e1", reason_kind: "refunded", reason: "Refund after the heat", actor: "u2", actor_role: "chair", at: "t", decision_id: "r1" },
      { id: "r3", seq: 3, kind: "exclude_requested", entry_id: "e2", reason_kind: "ineligible", reason: "Not a member", actor: "u1", actor_role: "manager", at: "t", completed: false },
      { id: "bad", seq: 9, kind: "nonsense", entry_id: "e3", reason_kind: "other" },
      { id: "bad2", seq: 8, kind: "exclude_requested", entry_id: "e3", reason_kind: "who knows" },
    ],
  });

  it("drops malformed rows and orders by seq", () => {
    expect(rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(parseExclusionRows(null)).toEqual([]);
  });

  it("lists pending requests and lets only a different person co-sign", () => {
    const pending = pendingExclusionRequests(rows);
    expect(pending.map((r) => r.id)).toEqual(["r3"]);
    expect(canCosign(pending[0], "u1")).toBe(false);
    expect(canCosign(pending[0], "u2")).toBe(true);
  });

  it("derives the effectively excluded couples from co-signed rows, latest seq wins", () => {
    expect([...effectivelyExcludedEntryIds(rows)]).toEqual(["e1"]);
    const reversed = [
      ...rows,
      ...parseExclusionRows({ rows: [{ id: "r4", seq: 4, kind: "reverse_cosigned", entry_id: "e1", reason_kind: "refunded", reason: "Fixed", actor: "u2", actor_role: "chair", at: "t" }] }),
    ];
    expect(effectivelyExcludedEntryIds(reversed).size).toBe(0);
  });

  it("requires a reason of 3-500 characters and a known reason kind; window is active or ballots_locked", () => {
    expect(validateExclusionReason("  ").ok).toBe(false);
    expect(validateExclusionReason("ab").ok).toBe(false);
    expect(validateExclusionReason("x".repeat(501)).ok).toBe(false);
    expect(validateExclusionReason(" Refunded ")).toEqual({ ok: true, value: "Refunded" });
    expect(parseExclusionReasonKind("refunded")).toBe("refunded");
    expect(parseExclusionReasonKind("no_show")).toBeNull();
    expect(["active", "ballots_locked"].every(exclusionWindowOpen)).toBe(true);
    for (const status of ["scheduled", "calculated", "approved", "published", "complete"]) expect(exclusionWindowOpen(status)).toBe(false);
  });

  it("reads the A3 review `excluded` section", () => {
    const excluded = parseReviewExcluded({
      excluded: [{ entry_id: "e1", exclusion_id: "x1", reason_kind: "refunded", reason: "Refund", state: "excluded" }, { entry_id: "e2" }],
    });
    expect(excluded).toHaveLength(1);
    expect(parseReviewExcluded({})).toEqual([]);
  });
});

describe("CF1 B: withdrawal model", () => {
  it("parses the state RPC and ignores malformed items", () => {
    const state = parseWithdrawalState({
      withdrawn: [{ entry_id: "e1", withdrawal_id: "w1" }, { nope: 1 }],
      pending: [
        { request_id: "q1", kind: "withdraw", entry_id: "e2", requested_by: "u1", reason: "Injury in the warm up", at: "t" },
        { request_id: "q2", kind: "other", entry_id: "e3" },
      ],
    });
    expect(state.withdrawn).toEqual([{ entryId: "e1", withdrawalId: "w1" }]);
    expect(state.pending.map((p) => p.requestId)).toEqual(["q1"]);
    expect(parseWithdrawalState(null)).toEqual({ withdrawn: [], pending: [] });
  });

  it("hints at the substantive-reason rule without being the authority", () => {
    expect(withdrawalReasonLooksSubstantive("sick")).toBe(false);
    expect(withdrawalReasonLooksSubstantive("a a a a a a a a a a a a")).toBe(false);
    expect(withdrawalReasonLooksSubstantive("Partner injured her ankle in warm up")).toBe(true);
  });
});
