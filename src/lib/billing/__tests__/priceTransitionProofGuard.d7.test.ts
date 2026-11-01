import { describe, expect, it } from "vitest";
import {
  PROOF_ALLOWED_OPERATIONS,
  assertOperationAllowed,
  checkSandboxIdentity,
  recordProofEntry,
  redactSecrets,
  validateProofKey,
  type ProofLogEntry,
} from "../priceTransitionProofGuard";

describe("proof guard", () => {
  it("accepts only a restricted test key", () => {
    expect(validateProofKey("rk_test_abc123")).toEqual({ ok: true, kind: "restricted_test" });
    for (const bad of ["", undefined, "sk_test_abc", "sk_live_abc", "rk_live_abc", "whatever"]) {
      expect(validateProofKey(bad).ok).toBe(false);
    }
  });

  it("requires the exact approved sandbox and refuses an excluded one", () => {
    expect(checkSandboxIdentity({ accountId: "acct_A", expectedAccountId: "acct_A" })).toEqual({ ok: true });
    expect(checkSandboxIdentity({ accountId: "acct_A", expectedAccountId: undefined }).ok).toBe(false);
    expect(checkSandboxIdentity({ accountId: "acct_B", expectedAccountId: "acct_A" }).ok).toBe(false);
    const excluded = checkSandboxIdentity({ accountId: "acct_C6", expectedAccountId: "acct_C6", excludedAccountIds: ["acct_C6"] });
    expect(excluded.ok).toBe(false);
  });

  it("allows only the documented operations and nothing destructive on live-like objects", () => {
    for (const op of PROOF_ALLOWED_OPERATIONS) expect(() => assertOperationAllowed(op)).not.toThrow();
    for (const op of ["charges.create", "refunds.create", "payouts.create", "webhookEndpoints.create", "accounts.update", "subscriptions.cancel", "customers.del"]) {
      expect(() => assertOperationAllowed(op)).toThrow(/not in the approved proof plan/);
    }
  });

  it("redacts credentials from evidence", () => {
    const cleaned = redactSecrets({ headers: { Authorization: "Bearer rk_test_secretvalue" }, note: "key sk_live_abcdef and whsec_123abc" });
    expect(JSON.stringify(cleaned)).not.toMatch(/secretvalue|abcdef|123abc/);
    const log: ProofLogEntry[] = [];
    recordProofEntry(log, "subscriptionSchedules.create", { from_subscription: "sub_X", key: "rk_test_zzz999" }, { id: "sub_sched_1" });
    expect(JSON.stringify(log)).not.toContain("zzz999");
    expect(() => recordProofEntry(log, "charges.create", {}, {})).toThrow();
  });
});
