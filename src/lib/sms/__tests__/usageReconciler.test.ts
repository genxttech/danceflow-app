import { describe, expect, it } from "vitest";
import { reconcileSmsUsage } from "../usageReconciler";
import { FakeBilledSmsProvider } from "../usageProvider";

const ACCOUNT = `AC${"a".repeat(32)}`;
const sidOf = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;
const row = (n: number) => ({ attempt_id: `attempt-${n}`, account_sid: ACCOUNT, provider_sid: sidOf(n) });

type Reply = { data?: unknown; error?: { code?: string } | null };
function fakeRpc(handlers: Record<string, (args: Record<string, unknown> | undefined) => Reply | Promise<Reply>>) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      const reply = await handlers[fn](args);
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
  };
  return { admin: admin as unknown as Parameters<typeof reconcileSmsUsage>[0], calls };
}

describe("reconcileSmsUsage", () => {
  it("releases unsent first, then settles each due row and counts outcomes", async () => {
    const provider = new FakeBilledSmsProvider();
    const outcomes: Record<string, Reply> = {
      "attempt-1": { data: { outcome: "settled", charged_cents: 2, replayed: false } },
      "attempt-2": { data: { outcome: "settled", charged_cents: 5, replayed: true } },
      "attempt-3": { data: { outcome: "pending", replayed: false } },
      "attempt-4": { data: { outcome: "review", reason: "x", replayed: false } },
    };
    const { admin, calls } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 3 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2), row(3), row(4)] }),
      tw4_usage_settle: (args) => outcomes[String(args?.p_attempt_id)],
    });
    const summary = await reconcileSmsUsage(admin, provider);
    expect(calls[0].fn).toBe("tw4_usage_release_unsent");
    expect(calls[1]).toEqual({ fn: "tw4_usage_due", args: { p_limit: 100 } });
    expect(summary).toEqual({ releasedUnsent: 3, due: 4, settled: 2, chargedCents: 2, pending: 1, review: 1, retrying: 0, errors: 0, evidenceRead: true, truncated: false });
    const settleArgs = calls.filter((c) => c.fn === "tw4_usage_settle").map((c) => c.args);
    expect(settleArgs[0]).toMatchObject({ p_attempt_id: "attempt-1", p_evidence: { sid: sidOf(1), account_sid: ACCOUNT, status: "delivered" } });
  });

  it("passes the limit option through", async () => {
    const { admin, calls } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [] }),
      tw4_usage_settle: () => ({}),
    });
    const summary = await reconcileSmsUsage(admin, new FakeBilledSmsProvider(), { limit: 7 });
    expect(calls[1].args).toEqual({ p_limit: 7 });
    expect(summary.due).toBe(0);
  });

  it("counts a fetch failure or a settle error and continues", async () => {
    const provider = new FakeBilledSmsProvider().failFetch(sidOf(1));
    const { admin, calls } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2), row(3)] }),
      tw4_usage_settle: (args) =>
        args?.p_attempt_id === "attempt-2" ? { error: { code: "XX000" } } : { data: { outcome: "settled", charged_cents: 3, replayed: false } },
    });
    const summary = await reconcileSmsUsage(admin, provider);
    expect(summary).toMatchObject({ due: 3, settled: 1, chargedCents: 3, errors: 2 });
    expect(calls.filter((c) => c.fn === "tw4_usage_settle")).toHaveLength(2);
  });

  it("counts a thrown settle call as an error and continues", async () => {
    const { admin } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2)] }),
      tw4_usage_settle: (args) => {
        if (args?.p_attempt_id === "attempt-1") throw new Error("boom");
        return { data: { outcome: "pending" } };
      },
    });
    expect(await reconcileSmsUsage(admin, new FakeBilledSmsProvider())).toMatchObject({ errors: 1, pending: 1 });
  });

  it("skips malformed due rows", async () => {
    const { admin, calls } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [null, "x", { attempt_id: "a" }, { attempt_id: "a", account_sid: ACCOUNT, provider_sid: "" }, row(1)] }),
      tw4_usage_settle: () => ({ data: { outcome: "settled", charged_cents: 1, replayed: false } }),
    });
    const summary = await reconcileSmsUsage(admin, new FakeBilledSmsProvider());
    expect(summary).toMatchObject({ due: 1, settled: 1, errors: 0 });
    expect(calls.filter((c) => c.fn === "tw4_usage_settle")).toHaveLength(1);
  });

  it("throws on release or due errors with the code only", async () => {
    const releaseFail = fakeRpc({
      tw4_usage_release_unsent: () => ({ error: { code: "42501" } }),
      tw4_usage_due: () => ({ data: [] }),
      tw4_usage_settle: () => ({}),
    });
    await expect(reconcileSmsUsage(releaseFail.admin, new FakeBilledSmsProvider())).rejects.toThrow(/stale release failed \(42501\)/);
    expect(releaseFail.calls).toHaveLength(1);
    const dueFail = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ error: { code: "57014" } }),
      tw4_usage_settle: () => ({}),
    });
    await expect(reconcileSmsUsage(dueFail.admin, new FakeBilledSmsProvider())).rejects.toThrow(/due failed \(57014\)/);
  });
});

describe("reconcileSmsUsage: a failing text never blocks the queue", () => {
  it("before 20261205 (no evidence_failed): stamps a text whose evidence could not be read or settled (best effort), and not one that settled", async () => {
    const provider = new FakeBilledSmsProvider();
    provider.failFetch(sidOf(1));
    const { admin, calls } = fakeRpc({
      tw4_usage_release_unsent: () => ({ data: { released: 0 } }),
      tw4_usage_due: () => ({ data: [row(1), row(2), row(3)] }),
      tw4_usage_settle: (args) => (args?.p_attempt_id === "attempt-2" ? { error: { code: "42501" } } : { data: { outcome: "settled", charged_cents: 3, replayed: false } }),
      tw4_usage_evidence_failed: () => ({ error: { code: "PGRST202" } }),
      tw4_usage_touch: () => {
        throw new Error("touch failed"); // a failed stamp is ignored
      },
    });
    const summary = await reconcileSmsUsage(admin, provider);
    expect(summary).toMatchObject({ due: 3, settled: 1, errors: 2 });
    expect(calls.filter((c) => c.fn === "tw4_usage_touch").map((c) => c.args)).toEqual([{ p_attempt_id: "attempt-1" }, { p_attempt_id: "attempt-2" }]);
  });
});
