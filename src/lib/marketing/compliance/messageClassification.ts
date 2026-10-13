/**
 * Marketing M-0 (owner decision D1): which queued client emails are commercial and must pass marketing compliance
 * controls (scope + platform suppression at the dispatch boundary, unsubscribe link and one-click headers, the
 * workspace postal address, the marketing sender), and which are operational.
 *
 * Classified by each template's actual content and business purpose, not by its automation name:
 *  - re-engagement, rebooking, renewal / retention and post-intro conversion messages are COMMERCIAL;
 *  - account / service notices about something the recipient already has or asked for are OPERATIONAL.
 * Ambiguous cases fail closed to COMMERCIAL: the message still reaches eligible recipients, but only through every
 * marketing control, so it can never bypass suppression. That covers:
 *  - a key this registry does not know (for example a staff-reviewed draft of an ARIA suggestion queued through the legacy
 *    automation draft path as `automation_<rule>`);
 *  - studio-customized content of an operational template (it cannot be verified as operational);
 *  - an operational template without the producer's content-origin stamp (queued before M-0, or by an unknown producer).
 */

export type OutboundEmailClass = "operational" | "commercial";

type RegistryEntry = { class: Exclude<OutboundEmailClass, "unclassified">; purpose: string };

/** Only queue producers whose keys start with these prefixes are subject to this registry; every other template keeps
 * its existing (operational, PAY-DC-3) handling. */
export const CLASSIFIED_TEMPLATE_PREFIXES = ["aria_execution_", "automation_"] as const;

export const OUTBOUND_EMAIL_CLASSIFICATION: Record<string, RegistryEntry> = {
  // ARIA executions (content fixed in code: src/app/app/automations/actions.ts getAriaExecutionEmail)
  aria_execution_aria_low_package_balance: {
    class: "commercial",
    purpose: "Package nearly used up; invites the client to renew/buy a package (renewal sale).",
  },
  aria_execution_aria_stale_active_student: {
    class: "commercial",
    purpose: "No upcoming lesson; asks the client to book again (re-engagement).",
  },
  aria_execution_aria_intro_no_purchase: {
    class: "commercial",
    purpose: "After an intro lesson with no purchase; invites the next step (conversion).",
  },
  aria_execution_aria_membership_canceling: {
    class: "commercial",
    purpose: "Membership set to end; invites the client to discuss options (retention). Ambiguous: fails closed.",
  },
  aria_execution_aria_membership_past_due: {
    class: "operational",
    purpose: "Billing attention needed on an existing membership (account notice; no offer).",
  },
  // Legacy studio automations (default content: AUTOMATION_TEMPLATE_DEFAULTS; studios may customize it)
  automation_low_package_balance: {
    class: "commercial",
    purpose: "Renew your lesson package (renewal sale).",
  },
  automation_no_upcoming_lesson: {
    class: "commercial",
    purpose: "Request your next lesson time (re-engagement).",
  },
  automation_first_lesson_follow_up: {
    class: "commercial",
    purpose: "Thanks for your first lesson; book the next one (conversion).",
  },
  automation_unsigned_document: {
    class: "operational",
    purpose: "A document still needs the client's signature (service notice).",
  },
  automation_pending_booking_request: {
    class: "operational",
    purpose: "Acknowledges the client's own lesson request (transactional response).",
  },
};

/** Content origin stamped by the queue producers (outbound_deliveries.payload.content_origin). */
export const CONTENT_ORIGIN_SYSTEM = "system_default";
export const CONTENT_ORIGIN_CUSTOMIZED = "studio_customized";

export function isClassifiedTemplateKey(templateKey: string) {
  return CLASSIFIED_TEMPLATE_PREFIXES.some((prefix) => templateKey.startsWith(prefix));
}

/**
 * The class that decides how a queued email is sent. Keys outside the classified prefixes are operational (existing
 * behavior). Within them: unknown keys are commercial; operational keys stay operational only when the producer stamped
 * the content as the unmodified system template.
 */
export function classifyOutboundEmail(templateKey: string, payload: Record<string, unknown> | null | undefined): OutboundEmailClass {
  if (!isClassifiedTemplateKey(templateKey)) return "operational";
  const entry = OUTBOUND_EMAIL_CLASSIFICATION[templateKey];
  if (!entry) return "commercial";
  if (entry.class === "commercial") return "commercial";
  return payload?.content_origin === CONTENT_ORIGIN_SYSTEM ? "operational" : "commercial";
}
