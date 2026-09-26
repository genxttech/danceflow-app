import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SmsConsentCheckbox from "@/components/public/SmsConsentCheckbox";
import { buildSmsConsentDisclosure } from "@/lib/sms/compliance";

/** A2P-1B: public SMS consent checkbox renders the canonical optional disclosure. */

const STUDIO = "Harbor Dance Studio";
const html = renderToStaticMarkup(createElement(SmsConsentCheckbox, { studioName: STUDIO }));

function visibleText(markup: string) {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("SmsConsentCheckbox", () => {
  const input = html.match(/<input[^>]*>/)?.[0] ?? "";

  it("is an optional, unchecked checkbox submitting smsConsent=yes", () => {
    expect(input).toContain('type="checkbox"');
    expect(input).toContain('name="smsConsent"');
    expect(input).toContain('value="yes"');
    expect(input).not.toMatch(/\bchecked\b/);
    expect(input).not.toMatch(/\brequired\b/);
    expect(input).not.toMatch(/defaultChecked/);
  });

  it("shows the full canonical disclosure for the studio", () => {
    expect(visibleText(html)).toBe(buildSmsConsentDisclosure(STUDIO));
  });

  it.each([
    STUDIO,
    "through DanceFlow",
    "a software platform owned and operated by GenX TotalTech LLC",
    "lesson bookings and appointments (including confirmations, changes and cancellations)",
    "Message frequency varies.",
    "Message and data rates may apply.",
    "Reply STOP to opt out or HELP for help.",
    "Consent is optional and is not a condition of purchase.",
    "See our Terms and Privacy Policy.",
  ])("disclosure includes %s", (phrase) => {
    expect(visibleText(html)).toContain(phrase);
  });

  it("links Terms and Privacy Policy safely in a new tab", () => {
    expect(html).toMatch(/<a href="\/terms" target="_blank" rel="noopener noreferrer"[^>]*>Terms<\/a>/);
    expect(html).toMatch(
      /<a href="\/privacy" target="_blank" rel="noopener noreferrer"[^>]*>Privacy Policy<\/a>/,
    );
  });

  it("does not mention events, tickets, reminders or marketing", () => {
    expect(visibleText(html)).not.toMatch(/event|ticket|reminder|marketing|promotional/i);
  });

  it("falls back to a neutral studio label when no name is available", () => {
    expect(buildSmsConsentDisclosure("  ")).toContain("from your dance studio through DanceFlow");
  });

  it("is not coupled to the preferred-contact field in either form", () => {
    const component = readFileSync(
      join(process.cwd(), "src", "components", "public", "SmsConsentCheckbox.tsx"),
      "utf8",
    );
    expect(component).not.toMatch(/preferredContact/i);

    for (const form of [
      ["src", "app", "lead", "[studioSlug]", "PublicLeadForm.tsx"],
      ["src", "app", "book", "[studioSlug]", "BookingRequestForm.tsx"],
    ]) {
      const source = readFileSync(join(process.cwd(), ...form), "utf8");
      expect(source).toContain("<SmsConsentCheckbox studioName=");
      expect(source).not.toMatch(/smsConsent[^"]*checked|defaultChecked/);
      expect(source).toContain("useState(() => String(Date.now()))");
    }
  });
});
