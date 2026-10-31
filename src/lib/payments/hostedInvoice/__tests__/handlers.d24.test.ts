import { describe, expect, it, vi } from "vitest";
import { handleHostedInvoiceEvent } from "../handlers";

const ON = { D24_HOSTED_INVOICE_EVENTS: "on" };
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

describe("handleHostedInvoiceEvent", () => {
  it("is dark by default: no database call at all", async () => {
    const { supabase, rpc } = fake({ outcome: "applied" });
    expect(await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: {} })).toEqual({ outcome: "d24_disabled" });
    expect(rpc).not.toHaveBeenCalled();
  });

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

  it("ignores test-mode events when the deployment key is live, and subscription invoices, without a database call", async () => {
    const { supabase, rpc } = fake({ outcome: "applied" });
    const liveEnv = { ...ON, STRIPE_SECRET_KEY: "sk_live_x" };
    expect((await handleHostedInvoiceEvent({ supabase, event: event(), claim, env: liveEnv })).outcome).toBe("d24_not_applicable_ignored");
    const sub = event({ livemode: true, data: { object: { id: "in_1", status: "void", subscription: "sub_1", total: 1, amount_due: 1, amount_paid: 0, amount_remaining: 1, currency: "usd" } } });
    expect((await handleHostedInvoiceEvent({ supabase, event: sub, claim, env: liveEnv })).outcome).toBe("d24_not_applicable_ignored");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws on a database error (including a lost claim) so the event is retried, never reported as processed", async () => {
    const { supabase } = fake(null, { code: "55000", message: "paywh1_claim_not_owned" });
    await expect(handleHostedInvoiceEvent({ supabase, event: event(), claim, env: ON })).rejects.toThrow(/d24_apply_event failed: 55000/);
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
      const e = event({ data: { object: { id: "in_1", status: "void", total, amount_due: total, amount_paid: 0, amount_remaining: total, currency: "usd", customer_email: `x${Math.random()}@example.com` } } });
      await handleHostedInvoiceEvent({ supabase, event: e, claim, env: ON });
      hashes.push(argsOf(rpc).p_payload_hash as string);
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });
});
