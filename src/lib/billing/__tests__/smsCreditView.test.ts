import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SmsCreditPanel from "@/app/app/settings/sms/SmsCreditPanel";
import SmsCreditAdmin from "@/app/platform/sms/SmsCreditAdmin";
import { startCreditCheckout } from "../smsCreditCheckoutClient";
import {
  deriveCreditState,
  formatUsd,
  getAdminCreditOverview,
  getSmsCreditView,
  packFits,
  parseActivity,
  parseAdminOverview,
  parseOverview,
  parsePurchases,
  type CreditView,
} from "../smsCreditView";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";

const rawOverview = (over: Record<string, unknown> = {}) => ({
  legal_business: true, balance_cents: 5000, reserved_cents: 500, available_cents: 4500, on_hold: false, low_balance: false, low_balance_threshold_cents: 1000,
  pending_topups_cents: 0, this_location_net_charges_cents: 120, pilot_ceiling_cents: null, pilot_used_cents: 0, ...over,
});
const view = (over: Record<string, unknown> = {}, extra: Partial<CreditView> = {}): CreditView => ({
  overview: parseOverview(rawOverview(over)),
  activity: [
    { seq: 3, createdAt: "2026-10-19T12:00:00Z", kind: "usage_charge", balanceDeltaCents: -8, thisLocation: true, hasLocation: true },
    { seq: 2, createdAt: "2026-10-19T11:00:00Z", kind: "topup_settled", balanceDeltaCents: 5000, thisLocation: false, hasLocation: true },
    { seq: 1, createdAt: "2026-10-19T10:00:00Z", kind: "reserve", balanceDeltaCents: 0, thisLocation: true, hasLocation: true },
    { seq: 0, createdAt: "2026-10-19T09:00:00Z", kind: "release", balanceDeltaCents: 0, thisLocation: false, hasLocation: true },
    { seq: -1, createdAt: "2026-10-19T08:00:00Z", kind: "adjustment", balanceDeltaCents: 100, thisLocation: false, hasLocation: false },
  ],
  purchases: [
    { createdAt: "2026-10-19T11:00:00Z", amountCents: 5000, refundedCents: 0, disputedCents: 0, status: "settled", thisLocation: false },
    { createdAt: "2026-10-19T12:30:00Z", amountCents: 2500, refundedCents: 0, disputedCents: 0, status: "pending", thisLocation: true },
    { createdAt: "2026-10-18T12:30:00Z", amountCents: 10000, refundedCents: 3000, disputedCents: 0, status: "settled", thisLocation: true },
  ],
  prices: [
    { kind: "monthly", customerPriceCents: 1500, description: "Monthly texting service" },
    { kind: "sms_usage", customerPriceCents: 8, description: "Per text message" },
  ],
  ...extra,
});
const html = (v: CreditView, props: Partial<Parameters<typeof SmsCreditPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(SmsCreditPanel, { view: v, purchasesEnabled: true, returned: null, ...props }));

describe("credit state", () => {
  it("the most blocking state wins: hold, negative, none available, low, ok", () => {
    const state = (over: Record<string, unknown>) => deriveCreditState(parseOverview(rawOverview(over)));
    expect(state({})).toBe("ok");
    expect(state({ low_balance: true })).toBe("low");
    expect(state({ available_cents: 900 })).toBe("low"); // under the $10 threshold even if the flag has not been raised yet
    expect(state({ balance_cents: 500, available_cents: 0 })).toBe("insufficient");
    expect(state({ balance_cents: -200, available_cents: 0 })).toBe("negative");
    expect(state({ on_hold: true, balance_cents: -200 })).toBe("on_hold");
    expect(state({ legal_business: false })).toBe("no_business");
  });
  it("a pack is offered only if balance + pending + pack stays within $500", () => {
    const o = (balance: number, pending: number) => parseOverview(rawOverview({ balance_cents: balance, pending_topups_cents: pending }));
    expect(packFits(o(40000, 0), 10000)).toBe(true);
    expect(packFits(o(40000, 1), 10000)).toBe(false);
    expect(packFits(o(40000, 5000), 5000)).toBe(true);
    expect(packFits(o(45000, 0), 10000)).toBe(false);
    expect(packFits(o(-3000, 0), 10000)).toBe(true); // a negative balance is not extra room
    expect(packFits(o(-3000, 40000), 10000)).toBe(true);
    expect(packFits(o(-3000, 40001), 10000)).toBe(false);
  });
  it("money is formatted in dollars, negatives with a sign", () => {
    expect([formatUsd(2500), formatUsd(8), formatUsd(-1234), formatUsd(0)]).toEqual(["$25.00", "$0.08", "-$12.34", "$0.00"]);
  });
});

describe("parsers never trust the shape of the database answer", () => {
  it("garbage becomes zeros / empty lists and unknown kinds and statuses are dropped", () => {
    expect(parseOverview(null)).toMatchObject({ legalBusiness: false, balanceCents: 0, pilotCeilingCents: null });
    expect(parseOverview({ legal_business: "true", balance_cents: "12" })).toMatchObject({ legalBusiness: false, balanceCents: 12 });
    expect(parseActivity("x")).toEqual([]);
    expect(parseActivity([{ kind: "mystery", seq: 1 }, { kind: "capture", seq: 2, balance_delta_cents: -5, this_location: true }])).toHaveLength(1);
    expect(parsePurchases([{ status: "weird" }, { status: "expired", amount_cents: 2500 }])).toHaveLength(1);
    expect(parseAdminOverview(undefined)).toEqual({ prices: [], accounts: [], stalePending: [], variances: [], pilot: null });
  });
});

describe("getSmsCreditView", () => {
  const fake = (results: Record<string, { data?: unknown; error?: { code: string } | null }>) => {
    const calls: { fn: string; args: unknown }[] = [];
    return { calls, client: { rpc: async (fn: string, args?: unknown) => { calls.push({ fn, args }); const r = results[fn] ?? { data: null, error: { code: "42883" } }; return { data: r.data ?? null, error: r.error ?? null }; } } as never };
  };
  it("the caller's own studio is the only thing asked for, and a refused overview yields nothing at all (no history is requested)", async () => {
    const refused = fake({ sms_credit_overview: { error: { code: "42501" } } });
    expect(await getSmsCreditView(refused.client, STUDIO)).toBeNull();
    expect(refused.calls.map((c) => c.fn)).toEqual(["sms_credit_overview"]);
  });
  it("a studio without a verified business gets the overview only", async () => {
    const none = fake({ sms_credit_overview: { data: rawOverview({ legal_business: false }) } });
    const result = await getSmsCreditView(none.client, STUDIO);
    expect(result?.overview.legalBusiness).toBe(false);
    expect(none.calls).toHaveLength(1);
  });
  it("a failure in one list does not hide the balance", async () => {
    const partial = fake({
      sms_credit_overview: { data: rawOverview() },
      sms_credit_history: { error: { code: "XX000" } },
      sms_credit_purchases: { data: [{ status: "pending", amount_cents: 2500, created_at: "2026-10-19T12:30:00Z" }] },
      sms_price_list: { data: [{ kind: "sms_usage", customer_price_cents: 8, description: "d" }] },
    });
    const result = await getSmsCreditView(partial.client, STUDIO);
    expect(result?.activity).toEqual([]);
    expect(result?.purchases).toHaveLength(1);
    const noList = fake({ sms_credit_overview: { data: rawOverview() }, sms_credit_purchases: { error: { code: "PGRST202" } } });
    expect((await getSmsCreditView(noList.client, STUDIO))?.purchases).toBeNull();
    expect(result?.prices).toHaveLength(1);
    expect((partial.calls.find((c) => c.fn === "sms_credit_history")?.args as { p_studio_id: string }).p_studio_id).toBe(STUDIO);
  });
  it("platform overview is null when the database refuses the caller", async () => {
    expect(await getAdminCreditOverview(fake({ sms_credit_admin_overview: { error: { code: "42501" } } }).client)).toBeNull();
  });
});

describe("startCreditCheckout", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("sends only the pack and follows only an https payment URL", async () => {
    let sent: { url: string; init?: RequestInit } | null = null;
    const spy = (async (url: string, init?: RequestInit) => { sent = { url, init }; return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await startCreditCheckout(5000, spy)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(sent!.url).toBe("/api/billing/sms-credits/checkout");
    expect(JSON.parse(String(sent!.init?.body))).toEqual({ packCents: 5000 });
    for (const bad of ["http://checkout.example/x", "javascript:alert(1)", "not a url", 12, null]) {
      expect((await startCreditCheckout(5000, respond(200, { url: bad }))).ok).toBe(false);
    }
  });
  it("every failure says nothing was charged or that purchases are not open, and never throws", async () => {
    expect(await startCreditCheckout(5000, respond(404, {}))).toEqual({ ok: false, message: "Credit purchases are not open yet." });
    expect(await startCreditCheckout(5000, respond(409, { error: "This would take your SMS credit balance above $500." }))).toEqual({ ok: false, message: "This would take your SMS credit balance above $500." });
    expect(await startCreditCheckout(5000, respond(503, "x"))).toMatchObject({ ok: false, message: expect.stringContaining("Nothing was charged") });
    const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await startCreditCheckout(5000, boom)).toMatchObject({ ok: false, message: expect.stringContaining("Nothing was charged") });
  });
});

describe("studio credit panel", () => {
  it("shows available, reserved and waiting-for-payment, never the provider cost, and offers Add credit and Activity", () => {
    const out = html(view({ pending_topups_cents: 2500 }));
    expect(out).toContain("$45.00");
    expect(out).toContain("$5.00");
    expect(out).toContain("$25.00");
    expect(out).toContain("Add credit");
    expect(out).toContain("Activity");
    expect(out).not.toMatch(/provider/i);
    expect(out).not.toContain("role=\"dialog\"");
  });
  it("states: low balance, nothing available, negative, hold, and no verified business", () => {
    expect(html(view({ low_balance: true }))).toContain("running low");
    expect(html(view({ balance_cents: 0, available_cents: 0 }))).toContain("No credit is available");
    expect(html(view({ balance_cents: -300, available_cents: 0 }))).toContain("below zero");
    expect(html(view({ on_hold: true }))).toContain("on hold");
    const none = html(view({ legal_business: false }));
    expect(none).toContain("once your legal business is verified");
    expect(none).not.toContain("Add credit");
    expect(html(view())).not.toContain("role=\"alert\"");
  });
  it("the Add credit panel lists the three packs, the prices with the recurring item marked, the terms, and no automatic top-up", () => {
    const out = html(view(), { initialPanel: "add" });
    expect(out).toContain('role="dialog"');
    for (const pack of ["$25.00", "$50.00", "$100.00"]) expect(out).toContain(pack);
    expect(out).toContain("Monthly service");
    expect(out).toContain("Recurring");
    expect(out).toContain("$15.00");
    expect(out).toContain("never tops up automatically");
    expect(out).toContain("Final purchase terms are not yet published.");
    expect(out).toContain("Choose a pack");
    expect(out).not.toMatch(/auto-?reload|auto-?recharge|saved card on file/i);
  });
  it("with the flag off nothing can be bought; with it on and a pack chosen the button names the amount", () => {
    const off = html(view(), { initialPanel: "add", purchasesEnabled: false, initialPack: 5000 });
    expect(off).toContain("Credit purchases are not open yet.");
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Pay \$50\.00 securely/);
    const on = html(view(), { initialPanel: "add", purchasesEnabled: true, initialPack: 5000 });
    expect(on).not.toContain("not open yet");
    expect(on).toMatch(/<button(?![^>]*disabled="")[^>]*>Pay \$50\.00 securely/);
  });
  it("packs that would pass the $500 limit are disabled", () => {
    const out = html(view({ balance_cents: 45000, available_cents: 45000 }), { initialPanel: "add" });
    expect(out).toContain("Would go over $500.00");
    expect(out.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2); // $100 and $50 would pass the limit, $25 fits
    const pendingOut = html(view({ balance_cents: 30000, pending_topups_cents: 20000, available_cents: 30000 }), { initialPanel: "add" });
    expect(pendingOut.match(/Would go over/g)?.length).toBe(3);
  });
  it("Activity lists purchases (pending, paid, refunded part) and ledger entries with the location in words, never an id", () => {
    const out = html(view(), { initialPanel: "activity" });
    expect(out).toContain("Waiting for payment");
    expect(out).toContain("Paid, credit added");
    expect(out).toContain("$30.00 refunded or disputed");
    expect(out).toContain("Texting usage");
    expect(out).toContain("Another location");
    expect(out).toContain("This location");
    expect(out).toContain("held");
    expect(out).toContain("released");
    expect(out).toContain("DanceFlow</span>"); // an adjustment belongs to no location
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
  it("a negative balance is shown as an amount, and a hold pauses buying", () => {
    expect(html(view({ balance_cents: -8000, available_cents: 0 }))).toContain("Balance: -$80.00");
    expect(html(view())).not.toContain("Balance:");
    const held = html(view({ on_hold: true }), { initialPanel: "add", initialPack: 5000 });
    expect(held).toContain("purchases are paused");
    expect(held).toMatch(/<button[^>]*disabled=""[^>]*>Pay \$50\.00 securely/);
    expect(held).not.toContain("nothing is charged while");
  });
  it("an unreadable purchase list is never reported as empty", () => {
    expect(html(view({}, { purchases: null }), { initialPanel: "activity" })).toContain("Purchases could not be loaded");
    expect(html(view({}, { purchases: [] }), { initialPanel: "activity" })).toContain("No purchases yet.");
  });
  it("the pilot allowance is shown as a separate non-credit line only when one exists", () => {
    const out = html(view({ pilot_ceiling_cents: 15000, pilot_used_cents: 3000 }));
    expect(out).toContain("Pilot allowance: $30.00 of $150.00");
    expect(out).toContain("not credit");
    expect(html(view())).not.toContain("Pilot allowance");
    expect(html(view({ pilot_ceiling_cents: 15000 }))).not.toContain("$195");
  });
  it("returning from checkout never claims the credit has arrived", () => {
    const ok = html(view(), { returned: "success" });
    expect(ok).toContain("once your payment is confirmed");
    expect(ok).not.toMatch(/credit (has been|was) added/i);
    expect(html(view(), { returned: "cancelled" })).toContain("Nothing was charged");
  });
});

describe("platform admin credit section", () => {
  const overview = parseAdminOverview({
    prices: [{ kind: "brand", customer_price_cents: 5000, provider_cost_cents: 4600, description: "Brand" }],
    accounts: [
      { legal_entity_id: "e1", legal_name: "Negative LLC", balance_cents: -200, reserved_cents: 0, hold: false, low_balance: false, pending_cents: 0, locations: 2, attention: true },
      { legal_entity_id: "e2", legal_name: "Fine LLC", balance_cents: 9000, reserved_cents: 0, hold: false, low_balance: false, pending_cents: 0, locations: 1, attention: false },
    ],
    stale_pending: [{ legal_name: "Stuck LLC", amount_cents: 5000, created_at: "2026-10-18T10:00:00Z", expires_at: "2026-10-18T10:35:00Z" }],
    variances: [{ legal_name: "Var LLC", kind: "brand", provider_cost_cents: 4700, expected_cost_cents: 4600, variance_cents: 100, created_at: "2026-10-18T10:00:00Z" }],
    pilot: { legal_name: "ConfiDance Unlimited, LLC", ceiling_cents: 15000, used_cents: 4600 },
  });
  it("shows prices with provider cost, accounts needing attention only, stale pending, variances and the pilot ceiling; no controls", () => {
    const out = renderToStaticMarkup(createElement(SmsCreditAdmin, { overview }));
    expect(out).toContain("Negative LLC");
    expect(out).not.toContain("Fine LLC");
    expect(out).toContain("Stuck LLC");
    expect(out).toContain("Var LLC");
    expect(out).toContain("provider $46.00");
    expect(out).toContain("$46.00 of $150.00");
    expect(out).toContain("not credit");
    expect(out).not.toMatch(/<form|<button|<input/);
  });
  it("renders nothing for anyone the database refused", () => {
    expect(renderToStaticMarkup(createElement(SmsCreditAdmin, { overview: null }))).toBe("");
  });
});
