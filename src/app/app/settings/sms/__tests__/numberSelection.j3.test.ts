import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../numberActions", () => ({ approveNumberAction: vi.fn(), withdrawNumberAction: vi.fn() }));

import NumberSelection, { formatNumber } from "../NumberSelection";
import type { OwnerNumberOffers } from "@/lib/sms/provisioning/ownerRead";

const OFFER = "0f0f0000-0000-4000-8000-000000000001";
const base: OwnerNumberOffers = {
  stepOpen: true, monthlyCents: 115, fundingMode: "credit_recurring", pilotCeilingReached: false,
  offer: { offerId: OFFER, expiresAt: "2026-10-23T12:00:00Z", numbers: [{ e164: "+15035550101", locality: "Portland", region: "OR" }, { e164: "+15035550102", locality: null, region: null }] },
  approval: null, blocker: "none",
};
const render = (o: OwnerNumberOffers) => renderToStaticMarkup(createElement(NumberSelection, { offers: o }));

describe("NumberSelection (J3)", () => {
  it("lists the offered numbers with the published monthly price, the recurring-cost wording and an explicit confirmation", () => {
    const html = render(base);
    expect(html).toContain('id="sms-number"');
    expect(html).toContain("(503) 555-0101");
    expect(html).toContain("Portland, OR");
    expect(html).toContain("$1.15 per month");
    expect(html).toContain("This is a recurring cost");
    expect(html).toContain('data-testid="sms-number-confirm"');
    // the approve button starts disabled until a number is chosen and the charge confirmed
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="sms-number-approve"/);
    // only the offer id and the price the owner saw travel with the form; no studio id
    expect(html).toContain(`name="offer_id" value="${OFFER}"`);
    expect(html).toContain('name="ack_price_cents" value="115"');
    expect(html).not.toMatch(/studio_id|AC[0-9a-f]{32}|PN[0-9a-f]{32}/);
  });
  it("pilot funding says each number needs its own written approval", () => {
    expect(render({ ...base, fundingMode: "pilot" })).toContain("pilot arrangement");
  });
  it("no form when the price is not published, the pilot limit is reached or there is nothing to choose", () => {
    for (const o of [{ ...base, monthlyCents: null, blocker: "unpriced" as const }, { ...base, pilotCeilingReached: true, blocker: "pilot_ceiling" as const }, { ...base, offer: null }, { ...base, blocker: "current_number" as const }]) {
      const html = render(o);
      expect(html).not.toContain('data-testid="sms-number-form"');
      expect(html).not.toContain("<button");
    }
  });
  it("an open approval shows the number, the stored statement and a withdraw control (no second approval form)", () => {
    const html = render({ ...base, approval: { selectionId: "0f0f0000-0000-4000-8000-000000000002", e164: "+15035550101", status: "open", expiresAt: "2026-10-24T00:00:00Z", statement: "I approve DanceFlow acquiring …" } });
    expect(html).toContain("You approved");
    expect(html).toContain("I approve DanceFlow acquiring");
    expect(html).toContain('data-testid="sms-number-withdraw"');
    expect(html).not.toContain('data-testid="sms-number-form"');
  });
  it("an open approval stays withdrawable when the step has closed; a closed step with nothing open offers nothing", () => {
    const open = { selectionId: "0f0f0000-0000-4000-8000-000000000002", e164: "+15035550101", status: "open" as const, expiresAt: "2026-10-24T00:00:00Z", statement: "x" };
    expect(render({ ...base, stepOpen: false, blocker: "not_open", approval: open })).toContain('data-testid="sms-number-withdraw"');
    const closed = render({ ...base, stepOpen: false, blocker: "not_open" });
    expect(closed).not.toContain("<button");
    expect(closed).toContain("not open right now");
  });
  it("formats a NANP number", () => {
    expect(formatNumber("+15035550101")).toBe("(503) 555-0101");
  });
});
