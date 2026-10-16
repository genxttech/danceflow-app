import { appendSmsOptOutFooter, buildSmsConsentDisclosure, SMS_CONSENT_DISCLOSURE_VERSION } from "@/lib/sms/compliance";

/**
 * TW-4A: DanceFlow-owned campaign content, versioned (`sms_campaign_template` v1). Studios do not edit it; their own values
 * are interpolated. Generated for the owner's review screen only in this slice: nothing is submitted to Twilio.
 *
 * The sample messages are the real dispatcher output shapes (the public /sms-consent page shows the same literals and a test
 * pins both against each other). There is deliberately no appointment-reminder sample: reminders are not an allowed automated
 * template (`SMS_AUTOMATED_TEMPLATES`). No marketing, promotional, bulk or lead-generation text appears anywhere.
 */

export const SMS_CAMPAIGN_TEMPLATE_VERSION = "v1";

export type CampaignPackageInput = {
  displayName: string;
  /** Public origin, e.g. https://www.idanceflow.com (no trailing slash needed). */
  origin: string;
  slug: string;
};

export type CampaignPackage = {
  templateVersion: typeof SMS_CAMPAIGN_TEMPLATE_VERSION;
  consentDisclosureVersion: string;
  description: string;
  messageFlow: string;
  samples: string[];
  optInPageUrl: string;
  termsUrl: string;
  privacyUrl: string;
  hasEmbeddedLinks: false;
  hasEmbeddedPhone: false;
  subscriberOptIn: true;
  ageGated: false;
  directLending: false;
};

const AUTOMATED_SAMPLES = [
  "Hi Alex,\nYour private lesson is confirmed for Wed, Oct 14, 2026, 6:00 PM EDT.\nIt is scheduled to end at Wed, Oct 14, 2026, 6:30 PM EDT.\nInstructor: Jamie Rivera.\nWe look forward to seeing you.",
  "Hi Alex,\nYour private lesson has been rescheduled to Fri, Oct 16, 2026, 5:00 PM EDT.\nIt is scheduled to end at Fri, Oct 16, 2026, 5:30 PM EDT.\nInstructor: Jamie Rivera.\nPlease contact the studio if you have any questions.",
  "Hi Alex,\nYour private lesson scheduled for Fri, Oct 16, 2026, 5:00 PM EDT has been cancelled.\nInstructor: Jamie Rivera.\nPlease contact the studio if you would like to reschedule.",
] as const;

export function staffSample(displayName: string) {
  return `Hi Alex, this is ${displayName}. Does Saturday at 10 AM still work for your lesson?`;
}

export function buildCampaignPackage(input: CampaignPackageInput): CampaignPackage {
  const name = String(input.displayName ?? "").replace(/\s+/g, " ").trim() || "Your dance studio";
  const base = String(input.origin ?? "").replace(/\/+$/, "");
  const slug = encodeURIComponent(input.slug);
  const optInPageUrl = `${base}/studios/${slug}#lead`;
  const termsUrl = `${base}/studios/${slug}/sms-terms`;
  const privacyUrl = `${base}/studios/${slug}/sms-privacy`;
  return {
    templateVersion: SMS_CAMPAIGN_TEMPLATE_VERSION,
    consentDisclosureVersion: SMS_CONSENT_DISCLOSURE_VERSION,
    description:
      `${name} uses DanceFlow, a software platform operated by GenX TotalTech LLC, to send transactional appointment messages ` +
      `(lesson confirmations, reschedules and cancellations) and one-to-one operational messages written by studio staff ` +
      `to the studio's own clients who have opted in. No marketing, promotional, bulk or lead-generation messages are sent.`,
    messageFlow:
      `A person opts in on ${name}'s public DanceFlow page (${optInPageUrl}) by entering a mobile number and checking an optional, ` +
      `unchecked box next to this exact disclosure: "${buildSmsConsentDisclosure(name)}" ` +
      `Consent may also be given directly to the studio, verbally or in writing, after the same disclosure; authorized staff then record it in DanceFlow. ` +
      `Terms: ${termsUrl}. Privacy: ${privacyUrl}.`,
    samples: [
      ...AUTOMATED_SAMPLES.map((body) => appendSmsOptOutFooter(body, name)),
      appendSmsOptOutFooter(staffSample(name), name),
    ],
    optInPageUrl,
    termsUrl,
    privacyUrl,
    hasEmbeddedLinks: false,
    hasEmbeddedPhone: false,
    subscriberOptIn: true,
    ageGated: false,
    directLending: false,
  };
}
