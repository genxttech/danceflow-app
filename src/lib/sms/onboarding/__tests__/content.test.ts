import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SMS_AUTOMATED_TEMPLATES, SMS_CONSENT_DISCLOSURE_VERSION } from "@/lib/sms/compliance";
import { SMS_CAMPAIGN_TEMPLATE_VERSION, buildCampaignPackage, staffSample } from "@/lib/sms/onboarding/campaignTemplate";
import {
  DANCEFLOW_OPERATOR,
  DANCEFLOW_SUPPORT_EMAIL,
  SMS_LEGAL_TEMPLATE_VERSION,
  buildStudioSmsLegalDocuments,
  legalDocumentText,
} from "@/lib/sms/onboarding/legalPages";

const consentPage = readFileSync(join(process.cwd(), "src", "app", "sms-consent", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

/** The sample message literals shown on the public /sms-consent page, with escapes resolved as React renders them. */
function pageSamples(footer: string) {
  return [...consentPage.matchAll(/<SampleMessage>\s*\{`([\s\S]*?)`\}\s*<\/SampleMessage>/g)].map((match) =>
    match[1].replace(/\\n/g, "\n").replace("${STOP_HELP_FOOTER}", footer),
  );
}

describe("campaign package v1", () => {
  const pkg = buildCampaignPackage({ displayName: "Harbor Dance Studio", origin: "https://idanceflow.com/", slug: "harbor-dance" });

  it("is versioned and carries the approved campaign flags", () => {
    expect(pkg.templateVersion).toBe(SMS_CAMPAIGN_TEMPLATE_VERSION);
    expect(pkg.consentDisclosureVersion).toBe(SMS_CONSENT_DISCLOSURE_VERSION);
    expect(pkg).toMatchObject({ hasEmbeddedLinks: false, hasEmbeddedPhone: false, subscriberOptIn: true, ageGated: false, directLending: false });
  });
  it("the four samples equal what the public /sms-consent page shows for the same studio (one source of truth, pinned)", () => {
    const footer = "Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.";
    const expected = pageSamples(footer);
    expect(expected).toHaveLength(4);
    expect(pkg.samples).toEqual(expected);
  });
  it("describes transactional appointment and one-to-one staff texts only: no marketing sample, no reminder", () => {
    expect(pkg.samples.join("\n")).not.toMatch(/reminder|promo|sale|discount|offer|% off|limited time|click|http/i);
    expect(pkg.description).toMatch(/transactional appointment messages/i);
    expect(pkg.description).toMatch(/No marketing, promotional, bulk or lead-generation messages/i);
    expect(pkg.description).toContain("GenX TotalTech LLC");
    // only the three allowed automated templates exist as samples (confirmed, rescheduled, cancelled) plus one staff message
    expect([...SMS_AUTOMATED_TEMPLATES].sort()).toEqual(["appointment_cancelled", "appointment_confirmed", "appointment_rescheduled"]);
  });
  it("every sample ends with the studio's STOP/HELP footer exactly once", () => {
    for (const sample of pkg.samples) {
      expect(sample.endsWith("Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.")).toBe(true);
      expect(sample.split("Reply STOP to opt out").length - 1).toBe(1);
    }
    expect(pkg.samples[3]).toContain(staffSample("Harbor Dance Studio"));
  });
  it("the message flow names the real opt-in page, the exact disclosure, consent given to staff, and the legal pages", () => {
    expect(pkg.optInPageUrl).toBe("https://idanceflow.com/studios/harbor-dance#lead");
    expect(pkg.termsUrl).toBe("https://idanceflow.com/studios/harbor-dance/sms-terms");
    expect(pkg.privacyUrl).toBe("https://idanceflow.com/studios/harbor-dance/sms-privacy");
    expect(pkg.messageFlow).toContain("optional, unchecked box");
    expect(pkg.messageFlow).toContain("Harbor Dance Studio through DanceFlow");
    expect(pkg.messageFlow).toMatch(/verbally or in writing/);
    expect(pkg.messageFlow).toContain(pkg.termsUrl);
  });
  it("a blank name falls back safely and slugs are URL-encoded", () => {
    const fallback = buildCampaignPackage({ displayName: "  ", origin: "https://idanceflow.com", slug: "a b/c" });
    expect(fallback.samples[0].endsWith("Your dance studio: Reply STOP to opt out. Reply HELP for help.")).toBe(true);
    expect(fallback.termsUrl).toBe("https://idanceflow.com/studios/a%20b%2Fc/sms-terms");
  });
});

describe("per-studio SMS legal pages", () => {
  const docs = buildStudioSmsLegalDocuments({ displayName: "Harbor Dance", legalName: "Harbor Dance Studio LLC" });
  const terms = legalDocumentText(docs.terms);
  const privacy = legalDocumentText(docs.privacy);

  it("terms carry every required statement", () => {
    expect(terms).toContain("Harbor Dance (operated by Harbor Dance Studio LLC)");
    expect(terms).toContain(`owned and operated by ${DANCEFLOW_OPERATOR}`);
    for (const phrase of [
      "Message frequency varies",
      "Message and data rates may apply",
      "Reply STOP",
      "Reply HELP",
      "not a condition of purchase",
      "We do not send marketing or promotional texts",
      "Wireless carriers are not liable",
      DANCEFLOW_SUPPORT_EMAIL,
    ]) {
      expect(terms).toContain(phrase);
    }
  });
  it("privacy carries the mobile-information non-sharing statement and consent-data statement", () => {
    expect(privacy).toContain("No mobile information will be shared with third parties or affiliates for marketing or promotional purposes");
    expect(privacy).toContain("Text-messaging originator opt-in data and consent will not be shared with any third parties");
    expect(privacy).toContain("Reply STOP");
  });
  it("is versioned, has no placeholders, and exposes no identifiers or personal contact data", () => {
    expect(docs.version).toBe(SMS_LEGAL_TEMPLATE_VERSION);
    for (const text of [terms, privacy]) {
      expect(text).not.toMatch(/\[Studio|\{\{|undefined|null/);
      expect(text).not.toMatch(/\b(?:BU|BN|MG|QE|PN|AC)[0-9a-f]{32}\b/i);
      expect(text).not.toMatch(/\bEIN\b/);
    }
  });
  it("uses the display name alone when no legal name is known or it is the same", () => {
    expect(legalDocumentText(buildStudioSmsLegalDocuments({ displayName: "Harbor Dance" }).terms)).not.toContain("operated by Harbor Dance Studio");
    expect(legalDocumentText(buildStudioSmsLegalDocuments({ displayName: "Harbor Dance", legalName: "harbor dance" }).terms)).not.toContain("(operated by");
  });
  it("names a studio contact only when one is supplied", () => {
    const withContact = legalDocumentText(buildStudioSmsLegalDocuments({ displayName: "Harbor Dance", supportEmail: "front@harbor.example" }).terms);
    expect(withContact).toContain("front@harbor.example");
    expect(terms).not.toContain("front@harbor.example");
  });
});
