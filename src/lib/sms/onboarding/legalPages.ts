/**
 * TW-4A: per-studio SMS Terms and SMS Privacy pages, generated from versioned DanceFlow templates (design 18.3).
 *
 * The pages state the studio's names, DanceFlow's ISV role, message types, optional consent, frequency, rates, STOP/HELP,
 * support contacts, and the mobile-information non-sharing statement carriers require. They contain no Twilio identifiers,
 * no EIN and no personal data. Domain strategy for studios with their own website is HELD (Twilio question Q3): these pages
 * live on the DanceFlow domain only and nothing here is submitted anywhere in this slice.
 */

export const SMS_LEGAL_TEMPLATE_VERSION = "sms-legal-v1";
export const SMS_LEGAL_EFFECTIVE_DATE = "October 15, 2026";
export const DANCEFLOW_SUPPORT_EMAIL = "support@idanceflow.com";
export const DANCEFLOW_OPERATOR = "GenX TotalTech LLC";

export type LegalSection = { heading: string; paragraphs: string[] };
export type LegalDocument = { title: string; intro: string; sections: LegalSection[] };
export type StudioSmsLegalDocuments = { version: string; effectiveDate: string; terms: LegalDocument; privacy: LegalDocument };

export type StudioSmsLegalInput = {
  displayName: string;
  /** Shown only after the owner has submitted and attested (the database withholds it earlier). */
  legalName?: string | null;
  supportEmail?: string | null;
};

function names(input: StudioSmsLegalInput) {
  const display = String(input.displayName ?? "").replace(/\s+/g, " ").trim() || "Your dance studio";
  const legal = String(input.legalName ?? "").replace(/\s+/g, " ").trim();
  const operatedBy = legal && legal.toLowerCase() !== display.toLowerCase() ? `${display} (operated by ${legal})` : display;
  return { display, operatedBy };
}

export function buildStudioSmsLegalDocuments(input: StudioSmsLegalInput): StudioSmsLegalDocuments {
  const { display, operatedBy } = names(input);
  const studioContact = String(input.supportEmail ?? "").trim();
  const contact = studioContact
    ? `Contact ${display} directly at ${studioContact}, or DanceFlow support at ${DANCEFLOW_SUPPORT_EMAIL}.`
    : `Contact ${display} directly, or DanceFlow support at ${DANCEFLOW_SUPPORT_EMAIL}.`;

  const terms: LegalDocument = {
    title: `${display} SMS Terms`,
    intro:
      `These terms describe the text messages ${operatedBy} sends through DanceFlow, a software platform owned and operated by ` +
      `${DANCEFLOW_OPERATOR}. ${DANCEFLOW_OPERATOR} provides the software and messaging infrastructure; it does not operate the studio.`,
    sections: [
      {
        heading: "Who sends the messages",
        paragraphs: [
          `Messages come from ${display} through DanceFlow and are limited to people who opted in to receive texts from ${display}. Each message names the studio.`,
        ],
      },
      {
        heading: "What messages you will receive",
        paragraphs: [
          `Service messages only: lesson and appointment confirmations, schedule changes and cancellations, and one-to-one messages written by studio staff about your lessons or inquiry. ` +
            `We do not send marketing or promotional texts under this program.`,
        ],
      },
      {
        heading: "Consent",
        paragraphs: [
          `Agreeing to receive texts is optional and is not a condition of purchase or of taking lessons. You may opt in by checking the optional box on the studio's DanceFlow inquiry or booking form, ` +
            `or by giving consent directly to the studio, which then records it. Texts are sent only after you opt in.`,
        ],
      },
      {
        heading: "Message frequency and costs",
        paragraphs: ["Message frequency varies with your lessons and appointments. Message and data rates may apply."],
      },
      {
        heading: "How to opt out and get help",
        paragraphs: [
          `Reply STOP at any time to stop receiving texts from ${display}. Reply START to resubscribe if you previously opted in. Reply HELP for help. ${contact}`,
        ],
      },
      {
        heading: "Carriers",
        paragraphs: ["Wireless carriers are not liable for delayed or undelivered messages."],
      },
      {
        heading: "Changes",
        paragraphs: [`We may update these terms. The current version is ${SMS_LEGAL_TEMPLATE_VERSION}, effective ${SMS_LEGAL_EFFECTIVE_DATE}.`],
      },
    ],
  };

  const privacy: LegalDocument = {
    title: `${display} SMS Privacy Policy`,
    intro:
      `This policy explains how ${operatedBy} and DanceFlow (${DANCEFLOW_OPERATOR}) handle information connected to text messages. ` +
      `It supplements the DanceFlow Privacy Policy.`,
    sections: [
      {
        heading: "Information we collect",
        paragraphs: [
          `Your mobile phone number, when you give it to ${display}; a record of your text-message consent (when, where and which disclosure version you accepted); and a log of the messages sent to you and their delivery status.`,
        ],
      },
      {
        heading: "How we use it",
        paragraphs: [
          `To send the service messages described in the SMS Terms, to honor your opt-out, and to keep records of your consent.`,
        ],
      },
      {
        heading: "Mobile information is not shared for marketing",
        paragraphs: [
          "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. " +
            "Information may be shared with subcontractors in support of the service, such as message delivery. " +
            "Text-messaging originator opt-in data and consent will not be shared with any third parties.",
        ],
      },
      {
        heading: "Retention",
        paragraphs: [
          "Consent records and opt-out records are kept for as long as needed to show that messages were permitted and to honor opt-outs.",
        ],
      },
      {
        heading: "Your choices and contact",
        paragraphs: [`Reply STOP to opt out of texts at any time. ${contact}`],
      },
      {
        heading: "Version",
        paragraphs: [`Template ${SMS_LEGAL_TEMPLATE_VERSION}, effective ${SMS_LEGAL_EFFECTIVE_DATE}.`],
      },
    ],
  };

  return { version: SMS_LEGAL_TEMPLATE_VERSION, effectiveDate: SMS_LEGAL_EFFECTIVE_DATE, terms, privacy };
}

export function legalDocumentText(doc: LegalDocument): string {
  return [doc.title, doc.intro, ...doc.sections.flatMap((section) => [section.heading, ...section.paragraphs])].join("\n");
}
