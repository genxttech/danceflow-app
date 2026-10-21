import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn() }) }));
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: "a" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { parseDual, parseExposures, parseHealth, parseOverview, parseVariances, type RflOps } from "@/lib/sms/providerFeeOps";
import RecurringFees from "../RecurringFees";

const U = (n: number) => `c${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const ME = U(90);
const OTHER = U(91);
const ENTITY = U(10);
const STUDIO = U(11);
const NUM = U(20);
const CAMP = U(21);
const NOW = Date.parse("2026-10-21T12:00:00Z");

const resource = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  resource_id: id, legal_entity_id: ENTITY, studio_id: STUDIO, kind, fee_kind: "number_rent", provider_state: "active", df_sending: true,
  current_period: "covered:charge", next_period: "covered:charge", open_cancel_operation: null, ...over,
});

function ops(over: Partial<Record<keyof RflOps, unknown>> = {}): RflOps {
  const raw = {
    health: { scan_switch: false, delivery_switch: false, stale: true, last_run_at: null, last_success_at: null, alerts_pending: 2, alerts_failed: 1, alerts_exhausted: 1, oldest_pending_alert_age_seconds: 600, open_exposure_count: 1, open_cancel_operations: 0 },
    overview: { resources: [resource(NUM, "number"), resource(CAMP, "campaign")], alerts_waiting: 2, cancel_operations_open: 0 },
    exposures: [{ legal_entity_id: ENTITY, studio_id: STUDIO, resource_id: NUM, resource_kind: "number", fee_kind: "number_rent", period_key: "2026-10", reason: "provider_billed_uncovered", state: "open", first_detected_at: "2026-10-01T00:00:00Z", age_days: 20, aging_bucket: "8-30", expected_provider_cents: 115, provider_billed_cents: 125, dual_request_status: null }],
    variances: [{ charge_id: U(30), legal_entity_id: ENTITY, studio_id: STUDIO, kind: "number_rent", provider_ref: "SECRETREF", expected_cost_cents: 115, provider_cost_cents: 150, variance_cents: 35, acknowledged: false }],
    dual: [],
    ...over,
  } as Record<string, unknown>;
  return {
    health: parseHealth(raw.health), overview: parseOverview(raw.overview), exposures: parseExposures(raw.exposures), variances: parseVariances(raw.variances), dual: parseDual(raw.dual),
  };
}

const render = (o: RflOps, props: { notice?: string | null; error?: string | null } = {}) => renderToStaticMarkup(createElement(RecurringFees, { ops: o, adminId: ME, now: NOW, ...props }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RecurringFees panel", () => {
  it("degrades to not available when nothing is installed", () => {
    const html = render({ health: null, overview: null, exposures: null, variances: null, dual: null });
    expect(html).toContain("Not available: recurring provider fee operations are not installed");
    expect(count(html, "not available")).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain("<form");
  });

  it("every collapsible has an open/closed indicator and an accessible label", () => {
    const html = render(ops());
    const details = count(html, "<details");
    expect(details).toBeGreaterThan(6);
    expect(count(html, "[+]")).toBe(details);
    expect(count(html, "[-]")).toBe(details);
    expect(count(html, "Press to expand")).toBe(details);
    expect(count(html, "Press to collapse")).toBe(details);
    expect(html).toContain("Expanded. Press to collapse Scheduler readiness and alerts.");
    // attention sections start open; quiet ones start closed
    expect(html).toMatch(/<details open="" class="group[^"]*">\s*<summary[^>]*>[^]*?Scheduler readiness and alerts/);
    const quiet = render(ops({ health: { scan_switch: true, delivery_switch: true, stale: false, last_run_at: "2026-10-21T01:00:00Z", last_success_at: "2026-10-21T01:00:00Z" }, exposures: [], variances: [], dual: [] }));
    expect(quiet).not.toMatch(/<details open=""[^>]*>\s*<summary[^>]*>[^]*?Scheduler readiness/);
  });

  it("shows the scheduler heartbeat, the stale warning and the alert counts; switches need a reason and a confirmation", () => {
    const html = render(ops());
    expect(html).toContain("No scan has completed in the last 26 hours");
    expect(html).toContain("scan OFF · delivery OFF · STALE");
    expect(html).toContain("exhausted after 5 attempts 1");
    expect(html).toContain("escalated to platform administrators");
    expect(html).toContain('name="switch" value="scan"');
    expect(html).toContain('name="enabled" value="on"');
    expect(count(html, 'name="confirm"')).toBe(2);
    expect(html).toContain("Turn scan ON");
    expect(html).toContain("No schedule is registered by this panel");
  });

  it("shows exposure per business with dollars and a plain-language reason", () => {
    const html = render(ops());
    expect(html).toContain("The provider billed this fee and no payment covers it.");
    expect(html).toContain("Expected provider cost $1.15 · provider billed $1.25");
    expect(html).toContain("8-30 days 1");
    expect(html).toContain("DanceFlow bears this cost; it is never charged to the studio");
    expect(html).not.toMatch(/\b115\b|\b125\b/);
  });

  it("offers the absorb request first, the absorb form only after approval", () => {
    let html = render(ops());
    expect(html).toContain("Request approval to absorb");
    expect(html).not.toContain("Absorb exposure");

    html = render(ops({ dual: [{ request_id: U(40), action: "absorb_exposure", resource_id: NUM, requested_by: OTHER, status: "pending", period_key: "2026-10", reason: "Write off the failed charge." }] }));
    expect(html).not.toContain("Request approval to absorb");
    expect(html).not.toContain(">Absorb exposure<");
    expect(html).toContain("waiting for a second platform administrator");

    html = render(ops({ dual: [{ request_id: U(40), action: "absorb_exposure", resource_id: NUM, requested_by: OTHER, status: "approved", period_key: "2026-10", reason: "Write off the failed charge." }] }));
    expect(html).toContain(">Absorb exposure<");
    expect(html).toContain("Write off the failed charge.");
    // a different period's approval does not unlock it
    html = render(ops({ dual: [{ request_id: U(40), action: "absorb_exposure", resource_id: NUM, requested_by: OTHER, status: "approved", period_key: "2026-09", reason: "other" }] }));
    expect(html).not.toContain(">Absorb exposure<");
  });

  it("variances: DanceFlow-borne statement, an acknowledgement form, no provider reference", () => {
    const html = render(ops());
    expect(html).toContain("DanceFlow bears this cost; it is never charged to the studio.");
    expect(html).toContain("Acknowledge as DanceFlow-borne");
    expect(html).toContain("difference $0.35");
    expect(html).toContain('minLength="10"');
    expect(html).toContain('maxLength="500"');
    expect(html).not.toContain("SECRETREF");
    const acked = render(ops({ variances: [{ charge_id: U(30), kind: "number_rent", expected_cost_cents: 115, provider_cost_cents: 150, variance_cents: 35, acknowledged: true, acknowledged_at: "2026-10-20T10:00:00Z", note: "Reviewed by finance." }] }));
    expect(acked).not.toContain("Acknowledge as DanceFlow-borne</button>");
    expect(acked).toContain("Reviewed by finance.");
  });

  it("dual control: the requester has no approve control, another administrator does", () => {
    const pending = (by: string) => ({ dual: [{ request_id: U(41), action: "cancel_number", resource_id: NUM, requested_by: by, status: "pending", reason: "Retire the unused number." }] });
    const mine = render(ops(pending(ME)));
    expect(mine).not.toContain("Approve request");
    expect(mine).toContain("a different administrator must approve it");
    expect(mine).toContain("Withdraw request");
    const theirs = render(ops(pending(OTHER)));
    expect(theirs).toContain("Approve request");
    expect(theirs).toContain("Reject request");
    expect(theirs).toContain("You can never approve your own request");
  });

  it("number cancellation: authorize only after approval; other kinds without; never says DanceFlow cancels", () => {
    let html = render(ops());
    // number needs dual control, the campaign does not
    expect(html).toContain("A number needs an approved dual-control request");
    expect(count(html, "Authorize cancellation</button>")).toBe(1);
    expect(html).toContain("DanceFlow never cancels anything at Twilio");
    expect(html).toContain("evidence digest");

    html = render(ops({ dual: [{ request_id: U(42), action: "cancel_number", resource_id: NUM, requested_by: OTHER, status: "approved", reason: "Retire the unused number." }] }));
    expect(html).not.toContain("A number needs an approved dual-control request");
    expect(count(html, "Authorize cancellation</button>")).toBe(2);
    expect(html).toContain('name="irreversibleAck"');
    expect(html).toContain("cannot be undone");
  });

  it("shows the right follow-up form for each open cancellation state", () => {
    const withOp = (status: string) => render(ops({ overview: { resources: [resource(CAMP, "campaign", { open_cancel_operation: status })], cancel_operations_open: 1 }, dual: [] }));
    expect(withOp("authorized")).toContain("Begin cancellation claim");
    expect(withOp("authorized")).toContain("Withdraw authorization");
    expect(withOp("authorized")).not.toContain("Authorize cancellation</button>");
    expect(withOp("in_flight")).toContain("Record outcome");
    expect(withOp("unknown_outcome")).toContain("Resolve operation");
  });

  it("immediate safety suspension is always offered, needs no approval and says it stops DanceFlow sending only", () => {
    const html = render(ops({ dual: [] }));
    expect(html).toContain("Suspend DanceFlow sending now");
    expect(html).toContain("never waits for a second administrator");
    expect(html).toContain("It does not cancel, release or change anything at Twilio");
  });

  it("pilot form only for pilot resources, with the ceiling explanation, and only for uncovered periods", () => {
    expect(render(ops())).not.toContain("Pilot per-period written approvals");
    const pilot = ops({ overview: { resources: [resource(NUM, "number", { current_period: "uncovered:no_pilot_approval", next_period: "covered:pilot_approval" }), resource(CAMP, "campaign", { current_period: "covered:charge", next_period: "covered:charge" })], cancel_operations_open: 0 } });
    const html = renderToStaticMarkup(createElement(RecurringFees, { ops: pilot, adminId: ME, now: NOW }));
    expect(html).toContain("Pilot per-period written approvals");
    expect(html).toContain("1 resource(s) of the pilot business");
    expect(html).toContain("cumulative $150 pilot ceiling");
    expect(html).toContain("never released or replenished automatically");
    expect(html).toContain("no standing authorization");
    expect(html).toContain('<option value="2026-10">2026-10</option>');
    expect(html).not.toContain('<option value="2026-11">2026-11</option>');
    expect(html).toContain("Record period approval");
    expect(count(html, "Record period approval")).toBe(1);
    // the year boundary
    const dec = renderToStaticMarkup(createElement(RecurringFees, { ops: ops({ overview: { resources: [resource(NUM, "number", { current_period: "uncovered:no_pilot_approval", next_period: "uncovered:no_pilot_approval" })], cancel_operations_open: 0 } }), adminId: ME, now: Date.parse("2026-12-15T00:00:00Z") }));
    expect(dec).toContain('<option value="2026-12">2026-12</option>');
    expect(dec).toContain('<option value="2027-01">2027-01</option>');
  });

  it("offers no standing authorization, renewal or charge control anywhere", () => {
    const html = render(ops({ dual: [{ request_id: U(41), action: "cancel_number", resource_id: NUM, requested_by: OTHER, status: "pending", reason: "x".repeat(12) }] }));
    expect(html).not.toMatch(/>\s*(Renew|Charge|Authorize standing|Standing authorization|Extend)[^<]*</i);
    expect(html).not.toMatch(/<button[^>]*>[^<]*(renew|charge now|standing)/i);
    expect(html).not.toContain('name="standing"');
  });

  it("never renders a provider SID, token or secret, and amounts only as dollars", () => {
    const html = render(ops({ dual: [{ request_id: U(41), action: "cancel_number", resource_id: NUM, requested_by: OTHER, status: "approved", reason: "Retire." + "x".repeat(10) }] }));
    expect(html).not.toMatch(/\b(AC|PN|MG|QE|CM|SK|KN|SM)[0-9a-f]{32}\b/);
    expect(html).not.toMatch(/auth[_ ]?token|api[_ ]?key|secret|whsec_|sk_live|sk_test/i);
    expect(html).not.toMatch(/\bcents\b/i);
    expect(html).not.toContain("SECRETREF");
  });

  it("shows the flash banners", () => {
    expect(render(ops(), { notice: "Saved." })).toContain('role="status"');
    expect(render(ops(), { error: "Nope." })).toContain('role="alert"');
  });
});
