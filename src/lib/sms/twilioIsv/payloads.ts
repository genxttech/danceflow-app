import type { EndUserType } from "./types";

/**
 * TW-4 R1: turns the owner's saved draft into the Twilio payloads, and maps Twilio's evaluation failures back to the wizard's
 * field names. Pure. The value mappings below come from Twilio's documented Customer Profile / A2P business-information values;
 * they have NOT been exercised against live Twilio. Twilio's own evaluation step (S10 / T5) is the safety net: a wrong value
 * surfaces as `noncompliant` before anything is submitted or paid for.
 */

/** The draft as the runner receives it (`tw4_runner_get_inputs`). Nothing here is an EIN. */
export type RunnerInputs = {
  studio_id: string;
  submission_seq: number;
  state: string;
  studio_name: string;
  studio_slug: string;
  studio_public_name: string | null;
  legal_name: string | null;
  entity_type: string | null;
  industry: string | null;
  website_choice: string | null;
  website_url: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  rep_first_name: string | null;
  rep_last_name: string | null;
  rep_title: string | null;
  rep_position: string | null;
  rep_email: string | null;
  rep_phone: string | null;
  preferred_area_code: string | null;
  ein_last4: string | null;
  missing: string[];
};

export const PUBLIC_ORIGIN = "https://www.idanceflow.com";

const BUSINESS_TYPE: Record<string, string> = {
  llc: "Limited Liability Corporation",
  corporation: "Corporation",
  partnership: "Partnership",
  non_profit: "Non-profit Corporation",
  cooperative: "Co-operative",
};

const JOB_POSITION: Record<string, string> = {
  director: "Director",
  gm: "GM",
  vp: "VP",
  ceo: "CEO",
  cfo: "CFO",
  general_counsel: "General Counsel",
  other: "Other",
};

export class PayloadError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

const required = (value: string | null | undefined, field: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new PayloadError(field, `missing ${field}`);
  return text;
};

export function websiteUrl(inputs: RunnerInputs): string {
  if (inputs.website_choice === "own") return required(inputs.website_url, "website_url");
  return `${PUBLIC_ORIGIN}/studios/${encodeURIComponent(required(inputs.studio_slug, "studio_slug"))}`;
}

export function businessEndUserAttributes(inputs: RunnerInputs, einDigits: string): { type: EndUserType; attributes: Record<string, string> } {
  const type = BUSINESS_TYPE[String(inputs.entity_type)];
  if (!type) throw new PayloadError("entity_type", "unsupported entity type");
  return {
    type: "customer_profile_business_information",
    attributes: {
      business_identity: "direct_customer",
      business_industry: required(inputs.industry, "industry"),
      business_name: required(inputs.legal_name, "legal_name"),
      business_regions_of_operation: "USA_AND_CANADA",
      business_registration_identifier: "EIN",
      business_registration_number: einDigits,
      business_type: type,
      website_url: websiteUrl(inputs),
    },
  };
}

export function representativeEndUserAttributes(inputs: RunnerInputs): { type: EndUserType; attributes: Record<string, string> } {
  const position = JOB_POSITION[String(inputs.rep_position)];
  if (!position) throw new PayloadError("rep_position", "unsupported position");
  return {
    type: "authorized_representative_1",
    attributes: {
      business_title: required(inputs.rep_title, "rep_title"),
      email: required(inputs.rep_email, "rep_email"),
      first_name: required(inputs.rep_first_name, "rep_first_name"),
      job_position: position,
      last_name: required(inputs.rep_last_name, "rep_last_name"),
      phone_number: required(inputs.rep_phone, "rep_phone"),
    },
  };
}

export function a2pEndUserAttributes(inputs: RunnerInputs): { type: EndUserType; attributes: Record<string, string> } {
  return {
    type: "us_a2p_messaging_profile_information",
    attributes: { company_type: inputs.entity_type === "non_profit" ? "non-profit" : "private" },
  };
}

export function addressInput(inputs: RunnerInputs) {
  return {
    customerName: required(inputs.legal_name, "legal_name"),
    street: required(inputs.address_line1, "address_line1"),
    streetSecondary: String(inputs.address_line2 ?? "").trim(),
    city: required(inputs.city, "city"),
    region: required(inputs.region, "region"),
    postalCode: required(inputs.postal_code, "postal_code"),
    isoCountry: "US",
  };
}

/** Twilio field name (as in evaluation results) -> wizard field key. Unknown names return null (the runner then raises an exception for a human). */
const TWILIO_FIELD_TO_WIZARD: Record<string, string> = {
  business_name: "legal_name",
  business_type: "entity_type",
  business_industry: "industry",
  business_registration_number: "ein",
  business_registration_identifier: "ein",
  website_url: "website_url",
  street: "address_line1",
  city: "city",
  region: "region",
  postal_code: "postal_code",
  customer_name: "legal_name",
  first_name: "rep_first_name",
  last_name: "rep_last_name",
  business_title: "rep_title",
  job_position: "rep_position",
  email: "rep_email",
  phone_number: "rep_phone",
};

export function wizardFieldFor(twilioField: string): string | null {
  return TWILIO_FIELD_TO_WIZARD[String(twilioField).trim()] ?? null;
}

/** The first failed Twilio field that maps to a wizard field, or null. */
export function firstWizardField(failedFields: readonly string[]): string | null {
  for (const field of failedFields) {
    const mapped = wizardFieldFor(field);
    if (mapped) return mapped;
  }
  return null;
}

/** Wizard fields the database accepts as "the field to highlight" (mirrors tw4_runner_transition). */
const RUNNER_FIELDS = new Set(["legal_name", "entity_type", "industry", "ein", "address_line1", "city", "region", "postal_code", "website_choice", "website_url", "rep_first_name", "rep_last_name", "rep_title", "rep_position", "rep_email", "rep_phone"]);
export function safeField(field: string | null | undefined): string | null {
  return field && RUNNER_FIELDS.has(field) ? field : null;
}

export function stepFriendlyName(envName: string, studioId: string, step: string, seq: number): string {
  return `df:${envName}:${studioId}:${step}:${seq}`.slice(0, 128);
}
