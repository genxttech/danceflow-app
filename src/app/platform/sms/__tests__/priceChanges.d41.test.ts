import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn() }) }));
vi.mock("@/lib/auth/platform-assurance", () => ({ requirePlatformStepUp: async () => ({ id: "a" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { loadPriceChanges, type PriceChangeOverview } from "@/lib/sms/priceChange";
import PriceChanges from "../PriceChanges";

/**
 * D4-1: the platform price-change section. The UI REFLECTS the database (which is the authority): the proposer is shown no approve control and the separation-of-duties
 * wording; another administrator is. Nothing here asserts that hiding a button is a control.
 */

const U = (n: number) => `d4${String(n).padStart(6, "0")}-0000-4000-8000-000000000001`;
const ME = U(90);
const OTHER = U(91);
const REQ1 = U(1);
const REQ2 = U(2);

const raw = (over: Record<string, unknown> = {}) => ({
  request_id: REQ1, kind: "number", customer_price_cents: 325, provider_cost_cents: 115, description: "Phone number rent", reason: "Twilio raised the monthly number rent",
  base_price_id: U(5), base_customer_price_cents: 200, base_provider_cost_cents: 115, status: "pending", requested_by: OTHER, requested_at: "2026-10-31T10:00:00Z",
  expires_at: "2026-11-01T10:00:00Z", decided_by: null, decided_at: null, decision_note: null, applied_price_id: null, base_changed: false, ...over,
});
const client = (data: unknown, error: { code: string } | null = null) => ({ rpc: async () => ({ data, error }) }) as never;

async function overview(requests: Record<string, unknown>[]): Promise<PriceChangeOverview> {
  const o = await loadPriceChanges(client({ active: [{ price_id: U(5), kind: "number", customer_price_cents: 200, provider_cost_cents: 115, description: "Phone number", created_at: "2026-10-01T00:00:00Z" }], requests }), ME);
  if (!o) throw new Error("overview");
  return o;
}
const render = (o: PriceChangeOverview | null, props: { notice?: string | null; error?: string | null } = {}) => renderToStaticMarkup(createElement(PriceChanges, { overview: o, adminId: ME, ...props }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("PriceChanges section", () => {
  it("degrades to not available when the control is not installed (the read returns nothing)", async () => {
    expect(await loadPriceChanges(client(null, { code: "42883" }), ME)).toBeNull();
    const html = render(null);
    expect(html).toContain("Not available: price change control is not installed");
    expect(count(html, "<form")).toBe(0);
  });

  it("another administrator's pending proposal: current vs proposed are shown, the approve control is offered, and the separation-of-duties wording is on the page", async () => {
    const html = render(await overview([raw()]));
    expect(html).toContain("Two different platform administrators are required for every price change");
    expect(html).toContain("You can never approve your own proposal");
    expect(html).toContain("Active when proposed");
    expect(html).toContain("$2.00");
    expect(html).toContain("Proposed");
    expect(html).toContain("$3.25");
    expect(html).toContain("Approve and publish this price");
    expect(html).toContain("Reject proposal");
    expect(html).not.toContain("Withdraw proposal");
    expect(html).toContain(`value="${REQ1}"`);
  });

  it("MY OWN pending proposal: no approve control or button at all, an explanation, and a withdraw control", async () => {
    const html = render(await overview([raw({ requested_by: ME })]));
    expect(html).not.toContain("Approve and publish this price");
    expect(html).not.toContain("Approval note");
    expect(html).toContain("You proposed this change, so a different administrator must approve it");
    expect(html).toContain("Withdraw proposal");
    expect(html).toContain("proposed");
  });

  it("a stale proposal says so; decided proposals are listed with the decider and the note and offer no control", async () => {
    const html = render(await overview([
      raw({ base_changed: true }),
      raw({ request_id: REQ2, status: "applied", requested_by: OTHER, decided_by: ME, decided_at: "2026-10-31T11:00:00Z", decision_note: "approved after checking the Twilio invoice", applied_price_id: U(6) }),
      raw({ request_id: U(3), status: "invalidated", decision_note: "invalidated: the active price changed after the proposal was made" }),
    ]));
    expect(html).toContain("The active price changed after this proposal was made");
    expect(html).toContain("approved and in effect");
    expect(html).toContain("approved after checking the Twilio invoice");
    expect(html).toContain("decided by you");
    expect(html).toContain("invalidated");
    expect(count(html, "Approve and publish this price")).toBe(1); // only the open one
  });

  it("the propose form is validated in the browser and posts only business fields (no actor, no requester, no status field exists)", async () => {
    const html = render(await overview([]));
    expect(html).toContain("Propose price change");
    for (const name of ["kind", "customerUsd", "providerUsd", "description", "reason"]) expect(html).toContain(`name="${name}"`);
    for (const forbidden of ["actor", "requestedBy", "status", "decidedBy", "p_actor"]) expect(html).not.toContain(`name="${forbidden}"`);
    expect(html).toContain("does not change any price");
    expect(count(html, "required")).toBeGreaterThanOrEqual(5);
  });

  it("shows result banners as status / alert regions and never renders markup from administrator-written text", async () => {
    const html = render(await overview([raw({ reason: "<script>alert(1)</script>", description: "<img src=x onerror=alert(1)>" })]), { notice: "Proposal recorded.", error: "Refused." });
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("drops malformed rows instead of rendering them (defensive parsing)", async () => {
    const o = await overview([raw({ request_id: "not-a-uuid" }), raw({ status: "weird" }), raw({ customer_price_cents: "3.25" }), raw({ request_id: REQ2 })]);
    expect(o.requests.map((r) => r.requestId)).toEqual([REQ2]);
  });
});
