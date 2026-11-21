/**
 * Marketing M-2a: campaign content validation shared by the studio and organizer campaign actions.
 *
 * Pure functions only (no I/O, no redirects). Each action keeps its own redirect codes and check order and maps the
 * results below, so this module is a behaviour-preserving extraction (pinned by the *.m2a.characterization tests).
 *
 * Known divergences kept on purpose (do not "fix" inside a refactor):
 * - organizer CREATE uses the lax URL normalizer; every other path uses the strict one;
 * - the organizer UPDATE action knows one more event audience than organizer CREATE.
 */

export function readTrimmedFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Strict CTA URL normalization: http/https only, canonical form. Returns "" for empty input or for a value that is not
 * a valid http(s) URL after an `https://` prefix is added to scheme-less input. Callers treat (non-empty raw input,
 * empty result) as invalid.
 */
export function normalizeCampaignCtaUrl(url: string): string {
  const value = url.trim();
  if (!value) return "";

  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

/** Legacy organizer-create normalizer: prefixes https:// and validates nothing. Kept only to preserve behaviour. */
export function normalizeCampaignCtaUrlLax(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

export type StudioCampaignContentIssue = "missing_subject" | "missing_body" | "invalid_cta_url";

/** Studio subject/body/CTA checks, in the order the studio actions apply them. */
export function studioCampaignContentIssue(input: {
  subject: string;
  bodyText: string;
  rawCtaUrl: string;
  ctaUrl: string;
}): StudioCampaignContentIssue | null {
  if (!input.subject) return "missing_subject";
  if (!input.bodyText) return "missing_body";
  if (input.rawCtaUrl && !input.ctaUrl) return "invalid_cta_url";
  return null;
}

/** Organizer name/subject/body presence (the organizer actions report one combined code). */
export function hasOrganizerRequiredContent(input: { name: string; subject: string; bodyText: string }): boolean {
  return Boolean(input.name && input.subject && input.bodyText);
}

export const STUDIO_AUDIENCE_TYPES: ReadonlySet<string> = new Set([
  "manual",
  "all_active_clients",
  "new_leads",
  "inactive_clients",
  "event_attendees",
  "specific_event_registrants",
  "specific_event_checked_in",
  "clients_no_upcoming_lesson",
  "low_package_credits",
]);

export function isStudioSpecificEventAudience(audienceType: string): boolean {
  return audienceType === "specific_event_registrants" || audienceType === "specific_event_checked_in";
}

const ORGANIZER_CREATE_EVENT_AUDIENCES = [
  "specific_event_registrants",
  "specific_event_ticket_buyers",
  "specific_event_unpaid_pending",
  "specific_event_checked_in",
  "specific_event_no_shows",
  "specific_event_refunded",
] as const;

const ORGANIZER_EVENT_ONLY_ON_UPDATE = ["specific_event_registered_not_checked_in"] as const;

export const ORGANIZER_CREATE_EVENT_REQUIRED_AUDIENCES: ReadonlySet<string> = new Set(ORGANIZER_CREATE_EVENT_AUDIENCES);

export const ORGANIZER_CREATE_AUDIENCE_TYPES: ReadonlySet<string> = new Set([
  "all_organizer_contacts",
  ...ORGANIZER_CREATE_EVENT_AUDIENCES,
  "paid_registration_contacts",
]);

export const ORGANIZER_UPDATE_EVENT_REQUIRED_AUDIENCES: ReadonlySet<string> = new Set([
  ...ORGANIZER_CREATE_EVENT_AUDIENCES,
  ...ORGANIZER_EVENT_ONLY_ON_UPDATE,
]);

export const ORGANIZER_UPDATE_AUDIENCE_TYPES: ReadonlySet<string> = new Set([
  ...ORGANIZER_CREATE_AUDIENCE_TYPES,
  ...ORGANIZER_EVENT_ONLY_ON_UPDATE,
]);
