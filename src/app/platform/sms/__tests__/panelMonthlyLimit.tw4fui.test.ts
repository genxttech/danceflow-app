import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** TW-4F UI follow-up: each legal business's monthly spending limit next to the setup budget on the platform panel (read-only), and chevrons on every disclosure. */

vi.mock("../panelActions", () => ({
  panelAuthorizeFeeAction: vi.fn(), panelCreateEntityAction: vi.fn(), panelCreatePilotExceptionAction: vi.fn(), panelCreateSubaccountAction: vi.fn(),
  panelDecideLinkAction: vi.fn(), panelDecideTierAction: vi.fn(), panelSetSpendCapAction: vi.fn(), panelWithdrawFeeAction: vi.fn(),
}));

import SmsSubaccountPanel from "../SmsSubaccountPanel";
import { buildStudioPanels, parsePanelOverview } from "@/lib/sms/twilioIsv/panel";
import { loadPanelMonthlyLimits, parsePanelMonthlyLimits, type PanelMonthlyLimits } from "@/lib/billing/smsPanelMonthlyLimits";

const EA = "e6100000-0000-4000-8000-0000000000e1";
const EB = "e6100000-0000-4000-8000-0000000000e2";
const SA = "a6100000-0000-4000-8000-00000000000a";
const SB = "a6100000-0000-4000-8000-00000000000b";
const ACTOR = "a6100000-0000-4000-8000-000000000401";

const row = (entity: string, over: Record<string, unknown> = {}) => ({
  legal_entity_id: entity, legal_business: true, month: "2026-10", timezone: "America/New_York", next_month_timezone: "America/New_York",
  limit_cents: 5000, ceiling_cents: 50000, effective_limit_cents: 5000, next_month_limit_cents: 5000,
  parts: { usage_cents: 1200, recurring_cents: 500, reserved_cents: 300, total_cents: 2000, starts_at: "2026-10-01T04:00:00Z", ends_at: "2026-11-01T04:00:00Z" },
  pilot_business: false,
  recent_changes: [{ effective_month: "2026-10", limit_cents: 5000, previous_limit_cents: 0, spend_at_change_cents: 0, changed_by_role: "owner", created_at: "2026-10-02T12:00:00Z" }],
  ...over,
});

const overview = parsePanelOverview({
  entities: [
    { id: EA, legal_name: "Alpha Dance LLC", ein_last4: "1111", spend_cap_cents: 15000, committed_cents: 0, created_at: "2026-10-01T00:00:00Z",
      studios: [{ studio_id: SA, name: "Alpha Studio", link_kind: "founding", linked_at: "2026-10-01T00:00:00Z", verification_note: "registry checked" }] },
    { id: EB, legal_name: "Beta Ballroom LLC", ein_last4: "2222", spend_cap_cents: 15000, committed_cents: 0, created_at: "2026-10-02T00:00:00Z",
      studios: [{ studio_id: SB, name: "Beta Studio", link_kind: "founding", linked_at: "2026-10-02T00:00:00Z", verification_note: "registry checked" }] },
  ],
  onboardings: [], requests: [], audit: [], prices: { brand: 4600 },
});
const render = (monthlyLimits: PanelMonthlyLimits | null | undefined, focus: string | null = null) =>
  renderToStaticMarkup(createElement(SmsSubaccountPanel, { overview, panels: buildStudioPanels(overview), unavailable: false, notice: null, error: null, now: Date.now(), focusStudioId: focus, monthlyLimits }));
/** the monthly-limit block of one studio's card */
const card = (html: string, studioName: string) => {
  const start = html.indexOf(`data-studio="${studioName}"`);
  const end = html.indexOf("</article>", start);
  return html.slice(start, end);
};
const block = (cardHtml: string) => {
  const start = cardHtml.indexOf('data-testid="monthly-limit"');
  return cardHtml.slice(start, cardHtml.indexOf('<div class="space-y-3"><form', start)); // up to the setup-budget forms that follow it
};

describe("parsePanelMonthlyLimits", () => {
  it("keys rows by legal business and reuses the owner overview's parser", () => {
    const parsed = parsePanelMonthlyLimits([row(EA), row(EB, { limit_cents: 0, effective_limit_cents: 0 })]);
    expect(Object.keys(parsed).sort()).toEqual([EA, EB]);
    expect(parsed[EA]).toMatchObject({ limitCents: 5000, effectiveLimitCents: 5000, spentCents: 2000, usageCents: 1200, recurringCents: 500, setAsideCents: 300, timezone: "America/New_York" });
    expect(parsed[EB].limitCents).toBe(0);
  });

  it("drops anything malformed rather than guessing", () => {
    const parsed = parsePanelMonthlyLimits([row("not-a-uuid"), row(EA, { legal_business: false }), row(EB, { month: "2026-13" }), null, "x", 5]);
    expect(parsed).toEqual({});
    expect(parsePanelMonthlyLimits({ not: "an array" })).toEqual({});
    expect(parsePanelMonthlyLimits(null)).toEqual({});
  });
});

describe("loadPanelMonthlyLimits", () => {
  it("reads through the platform-admin-only function with the acting admin's id", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    const out = await loadPanelMonthlyLimits({ rpc: (async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: [row(EA)], error: null }; }) as never }, ACTOR);
    expect(calls).toEqual([{ fn: "tw4_panel_monthly_limits", args: { p_actor: ACTOR } }]);
    expect(Object.keys(out!)).toEqual([EA]);
  });

  it("is null (not available), never an empty 'no limit', when refused or not installed", async () => {
    for (const code of ["42501", "42883", "PGRST202"]) {
      expect(await loadPanelMonthlyLimits({ rpc: (async () => ({ data: null, error: { code } })) as never }, ACTOR)).toBeNull();
    }
    expect(await loadPanelMonthlyLimits({ rpc: (async () => { throw new Error("network"); }) as never }, ACTOR)).toBeNull();
  });
});

describe("rendered monthly limit on the panel", () => {
  const limits = parsePanelMonthlyLimits([
    row(EA),
    row(EB, { limit_cents: 80000, effective_limit_cents: 50000, ceiling_cents: 50000, timezone: "Pacific/Auckland", next_month_timezone: "Asia/Tokyo",
      parts: { usage_cents: 50000, recurring_cents: 0, reserved_cents: 0, total_cents: 50000, starts_at: "2026-09-30T11:00:00Z", ends_at: "2026-10-31T11:00:00Z" }, recent_changes: [] }),
  ]);

  it("shows the approved limit, the month's use, what remains and the timezone, inside the setup budget section", () => {
    const a = card(render(limits), "Alpha Studio");
    const m = block(a);
    expect(a.indexOf("Setup budget and fee approvals")).toBeLessThan(a.indexOf('data-testid="monthly-limit"'));
    expect(m).toContain("Monthly spending limit: October 2026");
    expect(m).toMatch(/data-testid="monthly-limit-approved">\$50\.00</);
    expect(m).toMatch(/data-testid="monthly-limit-used">\$20\.00</);
    expect(m).toMatch(/data-testid="monthly-limit-remaining">\$30\.00</);
    expect(m).toMatch(/data-testid="monthly-limit-timezone">America\/New_York</);
    expect(m).toContain(">Approved<");
    expect(m).toContain("approved by the owner");
    expect(m).toContain("The month runs 2026-10-01 to 2026-10-31 (America/New_York)");
    expect(m).toContain("Separate from the cumulative setup budget");
  });

  it("each studio card shows only its own legal business's figures (no cross-business leakage)", () => {
    const html = render(limits);
    const a = block(card(html, "Alpha Studio"));
    const b = block(card(html, "Beta Studio"));
    expect(b).toMatch(/data-testid="monthly-limit-approved">\$800\.00</);
    expect(b).toContain("Capped at $500.00 by the ceiling");
    expect(b).toMatch(/data-testid="monthly-limit-remaining">\$0\.00</);
    expect(b).toContain(">Used up<");
    expect(b).toContain("Asia/Tokyo from next month");
    expect(a).not.toContain("Pacific/Auckland");
    expect(a).not.toContain("$800.00");
    expect(b).not.toContain("America/New_York");
  });

  it("says plainly when no limit has been approved", () => {
    const m = block(card(render(parsePanelMonthlyLimits([row(EA, { limit_cents: 0, effective_limit_cents: 0, next_month_limit_cents: 0, parts: { total_cents: 0 }, recent_changes: [] })])), "Alpha Studio"));
    expect(m).toContain(">Not set<");
    expect(m).toContain("has not approved a monthly limit");
    expect(m).toContain("No limit changes recorded.");
  });

  it("says 'not available' (never $0 or 'not set') when the limits cannot be read, or one business is missing", () => {
    for (const value of [null, undefined]) {
      const m = block(card(render(value), "Alpha Studio"));
      expect(m).toContain("not available in this environment");
      expect(m).not.toContain("monthly-limit-approved");
      expect(m).not.toContain("Not set");
    }
    const html = render(parsePanelMonthlyLimits([row(EA)]));
    expect(block(card(html, "Beta Studio"))).toContain("not available in this environment");
    expect(block(card(html, "Alpha Studio"))).toContain("monthly-limit-approved");
  });

  it("is read-only: no form, input or button in the monthly-limit block", () => {
    const m = block(card(render(limits), "Alpha Studio"));
    expect(m).not.toMatch(/<form|<input|<button|<select/);
  });

  it("no longer says monthly limits will appear later", () => {
    expect(render(limits)).not.toContain("will appear here once it is released");
  });

  it("every disclosure on the panel has a chevron in its summary that turns when it opens", () => {
    const html = render(limits, SA);
    const summaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
    expect(summaries.length).toBeGreaterThanOrEqual(8);
    for (const s of summaries) {
      expect(s).toContain("<svg");
      expect(s).toMatch(/group-open\/[a-z]+:rotate-180/);
    }
    // each chevron is bound to its own disclosure group, so an open outer section never turns a closed inner one
    const groups = [...html.matchAll(/<details[^>]*class="[^"]*group\/([a-z]+)/g)].map((m) => m[1]);
    expect(new Set(groups)).toEqual(new Set(["blockers", "steps", "section", "audit", "fee", "lvs", "monthly"].filter((g) => groups.includes(g))));
    expect(groups).toContain("monthly");
    expect(groups).toContain("section");
  });
});
