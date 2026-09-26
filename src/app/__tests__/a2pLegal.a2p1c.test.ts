import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSmsConsentDisclosure } from "@/lib/sms/compliance";

/** A2P-1C: GenX TotalTech LLC / DanceFlow relationship and accurate SMS documentation. */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const RELATIONSHIP = "DanceFlow is a software platform owned and operated by GenX TotalTech LLC";

function collapse(source: string) {
  return source.replace(/\s+/g, " ");
}

const footer = read("src", "components", "public", "PublicSiteFooter.tsx");
const terms = read("src", "app", "terms", "page.tsx");
const privacy = read("src", "app", "privacy", "page.tsx");
const smsConsent = read("src", "app", "sms-consent", "page.tsx");
const staffCard = read("src", "app", "app", "clients", "[id]", "ClientSmsConsentCard.tsx");

describe("canonical relationship statement", () => {
  it.each([
    ["footer", footer],
    ["terms", terms],
    ["privacy", privacy],
    ["sms-consent", smsConsent],
  ])("%s states the relationship verbatim", (_name, source) => {
    expect(collapse(source)).toContain(RELATIONSHIP);
  });

  it("footer no longer uses the old public relationship wording", () => {
    expect(footer).not.toContain("DanceFlow is a product of GenX TotalTech LLC.");
  });

  it("the email legal line is intentionally unchanged", () => {
    expect(read("src", "lib", "email", "brand.ts")).toContain(
      'EMAIL_LEGAL_LINE = "DanceFlow is a product of GenX TotalTech LLC."',
    );
  });

  it("Terms and Privacy define DanceFlow as the GenX-operated platform", () => {
    for (const source of [terms, privacy]) {
      expect(collapse(source)).toContain(
        "DanceFlow is a software platform owned and operated by GenX TotalTech LLC (&ldquo;DanceFlow,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;).",
      );
    }
  });

  it("Terms §8 limits SMS to transactional/service messages and excludes marketing SMS", () => {
    const text = collapse(terms);
    expect(text).toContain(
      "Customers may use DanceFlow to send transactional or marketing email, push notifications, and related communications.",
    );
    expect(text).not.toMatch(/marketing email,\s*SMS/);
    expect(text).toContain(
      "SMS text messaging through DanceFlow is limited to transactional and service-related messages",
    );
    expect(text).toContain(
      "Customers may send SMS only to people who have given the required consent to receive texts from them.",
    );
    expect(text).toContain("Marketing and promotional SMS is not part of the DanceFlow SMS program.");
  });

  it("Privacy SMS section covers STOP, HELP, frequency and rates", () => {
    const text = collapse(privacy);
    expect(text).toContain("reply STOP to opt out or HELP for help");
    expect(text).toContain("Message frequency varies, and message and data rates may apply.");
  });
});

describe("/sms-consent documents only real opt-in methods", () => {
  const text = collapse(smsConsent);

  it("renders the canonical disclosure", () => {
    expect(smsConsent).toContain('buildSmsConsentDisclosure("[Studio Name]")');
    expect(buildSmsConsentDisclosure("[Studio Name]")).toContain(
      "Yes, I agree to receive text messages from [Studio Name] through DanceFlow",
    );
  });

  it("lists exactly the three supported opt-in methods", () => {
    expect(smsConsent.match(/<ConsentPathCard title=/g)).toHaveLength(3);
    expect(text).toContain('<ConsentPathCard title="Studio inquiry form">');
    expect(text).toContain('<ConsentPathCard title="Intro lesson booking form">');
    expect(text).toContain('<ConsentPathCard title="Consent given directly to the studio">');
  });

  it.each([
    /portal/i,
    /event/i,
    /ticket/i,
    /organizer/i,
    /check-in/i,
    /floor rental/i,
    /reminder/i,
    /A2P 10DLC/i,
    /DanceFlow: /,
    /idanceflow\.com\/lead\//,
  ])("makes no unsupported claim matching %s", (pattern) => {
    expect(smsConsent).not.toMatch(pattern);
  });

  it("mentions marketing only to exclude it", () => {
    const marketing = text.match(/[^.]*\b(marketing|promotional)\b[^.]*\./gi) ?? [];
    expect(marketing.length).toBeGreaterThan(0);
    for (const sentence of marketing) {
      expect(sentence).toMatch(/\bno\b|\bnot\b/i);
    }
  });

  it.each([
    "Who sends messages",
    "One-to-one messages from authorized studio staff",
    "Lesson appointment confirmations",
    "Lesson appointment reschedules",
    "Lesson appointment cancellations",
    "Message frequency varies",
    "Message and data rates may apply",
    "<strong>STOP</strong>",
    "<strong>HELP</strong>",
    "is not a condition of purchase",
    'href="/terms"',
    'href="/privacy"',
    "Reply STOP to opt out. Reply HELP for help.",
    "Examples use a fictional studio and client.",
  ])("covers %s", (phrase) => {
    expect(text).toContain(phrase);
  });

  it("links Terms and Privacy directly (no redirect aliases)", () => {
    expect(smsConsent).not.toContain("/terms-and-conditions");
    expect(smsConsent).not.toContain("/privacy-policy");
  });
});

describe("staff consent script alignment", () => {
  it("uses the canonical disclosure with the real studio name", () => {
    expect(staffCard).toContain("buildSmsConsentDisclosure(studioName)");
    expect(staffCard).not.toContain("SMS_CONSENT_DISCLOSURE");
    expect(staffCard).toContain("updateClientSmsConsentAction");
  });

  it("threads the studio name page -> workspace -> card", () => {
    expect(read("src", "app", "app", "clients", "[id]", "page.tsx")).toContain(
      "studioName={studio?.name ?? null}",
    );
    expect(read("src", "app", "app", "clients", "[id]", "ClientCommunicationWorkspace.tsx")).toContain(
      "studioName={studioName}",
    );
  });

  it("the obsolete disclosure constant no longer exists", () => {
    expect(read("src", "lib", "sms", "compliance.ts")).not.toMatch(/export const SMS_CONSENT_DISCLOSURE\b/);
  });
});
