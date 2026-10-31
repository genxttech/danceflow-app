import { describe, expect, it, vi } from "vitest";
import { handleHostedInvoiceEvent } from "../handlers";

const ON = { D24_HOSTED_INVOICE_EVENTS: "on" };
const DEFER = { D24_HOSTED_INVOICE_EVENTS: "defer" };
const event = (over: Record<string, unknown> = {}) =>
  ({
    id: "evt_1", type: "invoice.voided", created: 1_800_000_000, livemode: false, account: "acct_1",
    data: { object: { id: "in_1", status: "void", total: 100, amount_due: 100, amount_paid: 0, amount_remaining: 100, currency: "usd", customer_email: "pii@example.com" } },
    ...over,
  }) as never;
const claim = { eventId: "evt_1", owner: "00000000-0000-0000-0000-0000000000a1" };

function fake(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async (..._a: unknown[]) => ({ data, error }));
  return { supabase: { rpc } as never, rpc };
}
const argsOf = (rpc: ReturnType<typeof vi.fn>, i = 0) => rpc.mock.calls[i][1] as Record<string, unknown>;

describe("off mode", () => {
  it("makes no database call and reports the event as NOT enabled (never as reconciled)", async () => {
    const { supabase, rpc } = fake({ outcome: "applied" });
    expect(await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: {} })).toEqual({ outcome: "d24_not_enabled" });
    expect(await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: { D24_HOSTED_INVOICE_EVENTS: "off" } })).toEqual({ outcome: "d24_not_enabled" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("defer mode", () => {
  it("stores the sanitized event through d24_defer_event and never applies it", async () => {
    const { supabase, rpc } = fake({ outcome: "deferred", duplicate: false });
    expect((await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: DEFER })).outcome).toBe("d24_deferred");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("d24_defer_event");
    expect(argsOf(rpc)).toMatchObject({ p_provider_event_id: "evt_1", p_owner: claim.owner, p_kind: "invoice", p_account: "acct_1" });
    expect(JSON.stringify(argsOf(rpc))).not.toContain("pii@example.com");
  });
  it("maps an already-applied event and throws on database errors so the event is retried", async () => {
    expect((await handleHostedInvoiceEvent({ supabase: fake({ outcome: "already_applied" }).supabase, event: event(), claim, env: DEFER })).outcome).toBe("d24_already_applied");
    await expect(handleHostedInvoiceEvent({ supabase: fake(null, { code: "42883" }).supabase, event: event(), claim, env: DEFER })).rejects.toThrow(/d24 defer failed: 42883/);
    await expect(handleHostedInvoiceEvent({ supabase: fake({ outcome: "???" }).supabase, event: event(), claim, env: DEFER })).rejects.toThrow(/unexpected result/);
  });
});

describe("on mode", () => {
  it("calls d24_apply_event once with the claim owner, scope and sanitized object", async () => {
    const { supabase, rpc } = fake({ outcome: "applied", matched: true });
    expect((await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: ON })).outcome).toBe("d24_applied_matched");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("d24_apply_event");
    expect(argsOf(rpc)).toMatchObject({ p_provider_event_id: "evt_1", p_owner: claim.owner, p_event_type: "invoice.voided", p_account: "acct_1", p_livemode: false, p_kind: "invoice" });
    expect(JSON.stringify(argsOf(rpc))).not.toContain("pii@example.com");
  });

  it("maps unmatched and replayed outcomes", async () => {
    expect((await handleHostedInvoiceEvent({ supabase: fake({ outcome: "applied", matched: false }).supabase, event: event(), claim, env: ON })).outcome).toBe("d24_applied_unmatched");
    expect((await handleHostedInvoiceEvent({ supabase: fake({ outcome: "replayed" }).supabase, event: event(), claim, env: ON })).outcome).toBe("d24_replayed");
  });

  it("platform-scope events pass a null account", async () => {
    const { supabase, rpc } = fake({ outcome: "applied", matched: false });
    await handleHostedInvoiceEvent({ supabase, event: event({ account: undefined }), claim, env: ON });
    expect(argsOf(rpc).p_account).toBeNull();
  });

  it("acknowledges a structurally impossible object without a database call or a retry loop", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { supabase, rpc } = fake({ outcome: "applied" });
    const bad = event({ data: { object: { id: "in_1", status: "paid" } } });
    expect(await handleHostedInvoiceEvent({ supabase, event: bad, claim, env: ON })).toEqual({ outcome: "d24_malformed_ignored" });
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain("pii@example.com");
    err.mockRestore();
  });

  it("throws on a database error (including a lost claim) so the event is retried, never reported as processed", async () => {
    const { supabase } = fake(null, { code: "55000", message: "paywh1_claim_not_owned" });
    await expect(handleHostedInvoiceEvent({ supabase, event: event(), claim, env: ON })).rejects.toThrow(/d24 apply failed: 55000/);
  });

  it("throws on an unexpected result shape", async () => {
    await expect(handleHostedInvoiceEvent({ supabase: fake({ outcome: "???" }).supabase, event: event(), claim, env: ON })).rejects.toThrow(/unexpected result/);
  });

  it("refuses a claim that belongs to a different event", async () => {
    await expect(handleHostedInvoiceEvent({ supabase: fake({ outcome: "applied" }).supabase, event: event(), claim: { ...claim, eventId: "evt_other" }, env: ON })).rejects.toThrow(/claim does not belong/);
  });

  it("the payload hash is stable for the same stored content and changes when the content changes", async () => {
    const hashes: string[] = [];
    for (const total of [100, 100, 200]) {
      const { supabase, rpc } = fake({ outcome: "applied", matched: true });
      const e = event({ data: { object: { id: "in_1", status: "void", total, amount_due: total, amount_paid: 0, amount_remaining: total, currency: "usd", customer_email: "x" + Math.random() + "@example.com" } } });
      await handleHostedInvoiceEvent({ supabase, event: e, claim, env: ON });
      hashes.push(argsOf(rpc).p_payload_hash as string);
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });
});

describe("classification input and test-mode handling", () => {
  it("passes a subscription invoice through as an evidence-flagged fact (never discarded), in both modes", async () => {
    const sub = event({ livemode: true, data: { object: { id: "in_1", status: "void", subscription: "sub_1", total: 1, amount_due: 1, amount_paid: 0, amount_remaining: 1, currency: "usd" } } });
    const cases: Array<[Record<string, string>, unknown, string]> = [[ON, { outcome: "applied", matched: false }, "d24_apply_event"], [DEFER, { outcome: "deferred" }, "d24_defer_event"]];
    for (const [env, result, fn] of cases) {
      const { supabase, rpc } = fake(result);
      await handleHostedInvoiceEvent({ supabase, event: sub, claim, env: { ...env, STRIPE_SECRET_KEY: "sk_live_x" } });
      expect(rpc.mock.calls[0][0]).toBe(fn);
      expect((argsOf(rpc).p_object as Record<string, unknown>).subscription_evidence).toBe(true);
    }
  });
  it("ignores a test-mode event on a live key before any database access", async () => {
    const { supabase, rpc } = fake({ outcome: "applied" });
    expect((await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: { ...ON, STRIPE_SECRET_KEY: "sk_live_x" } })).outcome).toBe("d24_test_mode_ignored");
    expect(rpc).not.toHaveBeenCalled();
  });
});
