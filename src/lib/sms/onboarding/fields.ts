import { normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * TW-4A: the studio SMS onboarding wizard's fields, normalization and validation.
 *
 * Pure and dependency-free (no I/O). The same rules are enforced again by the database (column checks on
 * `studio_sms_onboarding`) and by the submit RPC (`_sms_onb_missing`), so this module is for fast, friendly feedback
 * and for building exactly what the RPCs accept. Nothing here talks to Twilio.
 */

export const DRAFT_FIELD_KEYS = [
  "legal_name",
  "entity_type",
  "industry",
  "website_choice",
  "website_url",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "rep_first_name",
  "rep_last_name",
  "rep_title",
  "rep_position",
  "rep_email",
  "rep_phone",
  "preferred_area_code",
] as const;
export type DraftFieldKey = (typeof DRAFT_FIELD_KEYS)[number];
export type DraftFields = Record<DraftFieldKey, string>;

/** Wizard keys that are not draft columns (the EIN travels separately and is never part of the draft object). */
export type WizardFieldKey = DraftFieldKey | "ein";

/** Wizard step (0 business, 1 representative, 2 texting number) that holds each field. */
export const FIELD_STEP: Record<WizardFieldKey, 0 | 1 | 2> = {
  legal_name: 0, entity_type: 0, industry: 0, ein: 0, website_choice: 0, website_url: 0, address_line1: 0, address_line2: 0,
  city: 0, region: 0, postal_code: 0,
  rep_first_name: 1, rep_last_name: 1, rep_title: 1, rep_position: 1, rep_email: 1, rep_phone: 1,
  preferred_area_code: 2,
};

/** The earliest wizard step that contains any of the given fields, or null. */
export function firstStepWith(keys: readonly string[]): 0 | 1 | 2 | null {
  let best: 0 | 1 | 2 | null = null;
  for (const key of keys) {
    const step = (FIELD_STEP as Record<string, 0 | 1 | 2 | undefined>)[key];
    if (step !== undefined && (best === null || step < best)) best = step;
  }
  return best;
}

export const ENTITY_TYPES = [
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "non_profit", label: "Non-profit" },
  { value: "cooperative", label: "Co-op" },
] as const;

export const INDUSTRIES = [
  { value: "EDUCATION", label: "Education (dance instruction)" },
  { value: "CONSUMER", label: "Consumer services" },
] as const;

export const REP_POSITIONS = [
  { value: "ceo", label: "CEO / owner" },
  { value: "director", label: "Director" },
  { value: "gm", label: "General manager" },
  { value: "vp", label: "Vice president" },
  { value: "cfo", label: "CFO" },
  { value: "general_counsel", label: "General counsel" },
  { value: "other", label: "Other" },
] as const;

export const WEBSITE_CHOICES = [
  { value: "danceflow", label: "Use my DanceFlow studio page" },
  { value: "own", label: "I have my own website" },
] as const;

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

export const FIELD_LABELS: Record<WizardFieldKey, string> = {
  legal_name: "Legal business name",
  entity_type: "Business type",
  industry: "Industry",
  ein: "EIN",
  website_choice: "Website",
  website_url: "Website address",
  address_line1: "Street address",
  address_line2: "Suite or unit",
  city: "City",
  region: "State",
  postal_code: "ZIP code",
  rep_first_name: "First name",
  rep_last_name: "Last name",
  rep_title: "Job title",
  rep_position: "Position",
  rep_email: "Business email",
  rep_phone: "Mobile number",
  preferred_area_code: "Preferred area code",
};

export function emptyDraft(): DraftFields {
  return Object.fromEntries(DRAFT_FIELD_KEYS.map((key) => [key, ""])) as DraftFields;
}

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "live.com", "msn.com",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com",
]);

const PO_BOX = /^\s*(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb)\b/i;

export type EinResult =
  | { ok: true; digits: string; formatted: string; last4: string }
  | { ok: false; error: string };

/** Accepts 12-3456789 or 123456789. The caller must never log or echo the value. */
export function normalizeEin(input: string | null | undefined): EinResult {
  const raw = String(input ?? "").trim();
  if (!/^\d{2}-?\d{7}$/.test(raw)) {
    return { ok: false, error: "Enter the 9-digit EIN exactly as it appears on your IRS letter (for example 12-3456789)." };
  }
  const digits = raw.replace("-", "");
  if (/^(\d)\1{8}$/.test(digits)) {
    return { ok: false, error: "That EIN does not look valid. Check your IRS letter (CP 575 or 147C)." };
  }
  return { ok: true, digits, formatted: `${digits.slice(0, 2)}-${digits.slice(2)}`, last4: digits.slice(5) };
}

export type WebsiteResult = { ok: true; value: string } | { ok: false; error: string };

export function normalizeWebsite(input: string | null | undefined): WebsiteResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: true, value: "" };
  if (/^http:\/\//i.test(raw)) return { ok: false, error: "Use an https:// address; Twilio and carriers require a secure site." };
  const withScheme = /^https:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  if (withScheme.length > 300 || !/^https:\/\/[^\s/]+\.[^\s/]+(\/[^\s]*)?$/i.test(withScheme)) {
    return { ok: false, error: "Enter a full website address such as https://www.yourstudio.com." };
  }
  return { ok: true, value: withScheme.replace(/^HTTPS:\/\//, "https://") };
}

export type DraftValidation = {
  fields: DraftFields;
  errors: Partial<Record<DraftFieldKey, string>>;
  warnings: Partial<Record<DraftFieldKey, string>>;
};

const oneOf = (list: readonly { value: string }[], value: string) => list.some((entry) => entry.value === value);

/**
 * Normalizes every supplied field and reports problems per field. Empty values are allowed here (a draft may be
 * incomplete); completeness is `missingRequired`. Unknown keys are dropped.
 */
export function validateDraftFields(input: Partial<Record<string, string | null | undefined>>): DraftValidation {
  const fields = emptyDraft();
  const errors: DraftValidation["errors"] = {};
  const warnings: DraftValidation["warnings"] = {};
  const text = (key: DraftFieldKey) => String(input[key] ?? "").trim();

  const legalName = text("legal_name");
  if (legalName && (legalName.length < 2 || legalName.length > 200)) errors.legal_name = "Enter the legal name exactly as on your IRS letter (2-200 characters).";
  fields.legal_name = legalName;

  for (const [key, list, label] of [
    ["entity_type", ENTITY_TYPES, "business type"],
    ["industry", INDUSTRIES, "industry"],
    ["rep_position", REP_POSITIONS, "position"],
    ["website_choice", WEBSITE_CHOICES, "website option"],
  ] as const) {
    const value = text(key);
    if (value && !oneOf(list, value)) errors[key] = `Choose a valid ${label}.`;
    fields[key] = value;
  }

  const website = normalizeWebsite(input.website_url);
  if (!website.ok) errors.website_url = website.error;
  fields.website_url = website.ok ? website.value : text("website_url");

  const line1 = text("address_line1");
  if (line1 && (line1.length < 3 || line1.length > 200)) errors.address_line1 = "Enter your street address.";
  else if (line1 && PO_BOX.test(line1)) warnings.address_line1 = "A PO box usually fails business verification. Use your physical street address.";
  fields.address_line1 = line1;
  fields.address_line2 = text("address_line2").slice(0, 200);

  const city = text("city");
  if (city && (city.length < 2 || city.length > 100)) errors.city = "Enter your city.";
  fields.city = city;

  const region = text("region").toUpperCase();
  if (region && !(US_STATES as readonly string[]).includes(region)) errors.region = "Choose a US state.";
  fields.region = region;

  const zip = text("postal_code");
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) errors.postal_code = "Enter a 5-digit ZIP code.";
  fields.postal_code = zip;

  for (const key of ["rep_first_name", "rep_last_name"] as const) {
    const value = text(key);
    if (value && value.length > 100) errors[key] = "That is too long (100 characters at most).";
    fields[key] = value;
  }
  const title = text("rep_title");
  if (title && (title.length < 2 || title.length > 100)) errors.rep_title = "Enter a job title such as Owner or Director.";
  fields.rep_title = title;

  const email = text("rep_email").toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.rep_email = "Enter a valid business email address.";
  else if (email && FREE_MAIL_DOMAINS.has(email.split("@")[1])) warnings.rep_email = "A business-domain email verifies faster than a free mailbox such as Gmail.";
  fields.rep_email = email;

  const phoneRaw = text("rep_phone");
  if (phoneRaw) {
    const phone = normalizeSmsPhone(phoneRaw);
    if (!phone) errors.rep_phone = "Enter a valid US mobile number.";
    fields.rep_phone = phone ?? phoneRaw;
  }

  const area = text("preferred_area_code");
  if (area && !/^[2-9]\d{2}$/.test(area)) errors.preferred_area_code = "Enter a 3-digit US area code.";
  fields.preferred_area_code = area;

  return { fields, errors, warnings };
}

/** Required fields in setup order; mirrors `public._sms_onb_missing`. */
export function missingRequired(fields: Partial<Record<string, string | null | undefined>>, einOnFile: boolean): WizardFieldKey[] {
  const has = (key: DraftFieldKey) => String(fields[key] ?? "").trim() !== "";
  const missing: WizardFieldKey[] = [];
  if (!has("legal_name")) missing.push("legal_name");
  if (!has("entity_type")) missing.push("entity_type");
  if (!has("industry")) missing.push("industry");
  if (!einOnFile) missing.push("ein");
  if (!has("address_line1")) missing.push("address_line1");
  if (!has("city")) missing.push("city");
  if (!has("region")) missing.push("region");
  if (!has("postal_code")) missing.push("postal_code");
  if (!has("website_choice")) missing.push("website_choice");
  if (String(fields.website_choice ?? "") === "own" && !has("website_url")) missing.push("website_url");
  for (const key of ["rep_first_name", "rep_last_name", "rep_title", "rep_position", "rep_email", "rep_phone"] as const) {
    if (!has(key)) missing.push(key);
  }
  return missing;
}

export type StudioPrefillSource = {
  name?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  public_phone?: string | null;
  public_website_url?: string | null;
};
export type OwnerPrefillSource = { full_name?: string | null; email?: string | null };

/**
 * Starting values only. The legal name is prefilled from the studio name but the wizard flags it for confirmation:
 * it must match the IRS record exactly, which the studio name often does not.
 */
export function prefillDraft(studio: StudioPrefillSource, owner: OwnerPrefillSource): DraftFields {
  const draft = emptyDraft();
  draft.legal_name = String(studio.name ?? "").trim();
  draft.address_line1 = String(studio.address_line_1 ?? "").trim();
  draft.address_line2 = String(studio.address_line_2 ?? "").trim();
  draft.city = String(studio.city ?? "").trim();
  const state = String(studio.state ?? "").trim().toUpperCase();
  draft.region = (US_STATES as readonly string[]).includes(state) ? state : "";
  const zip = String(studio.postal_code ?? "").trim();
  draft.postal_code = /^\d{5}(-\d{4})?$/.test(zip) ? zip : "";
  const site = normalizeWebsite(studio.public_website_url);
  draft.website_choice = site.ok && site.value ? "own" : "danceflow";
  draft.website_url = site.ok ? site.value : "";
  const names = String(owner.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  draft.rep_first_name = names[0] ?? "";
  draft.rep_last_name = names.length > 1 ? names.slice(1).join(" ") : "";
  draft.rep_email = String(owner.email ?? "").trim().toLowerCase();
  const phone = normalizeSmsPhone(String(studio.public_phone ?? ""));
  draft.preferred_area_code = phone ? phone.slice(2, 5) : "";
  return draft;
}
