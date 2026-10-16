/**
 * TW-4 R1: the Twilio side of the brand submission runner, as an interface. The runner only ever talks to `IsvAdapter`; the
 * real implementation (`real.ts`) is the only code that can reach Twilio, and it cannot be constructed unless
 * `realCallsAllowed` says so (production only, explicit switch). Tests and DEV use `FakeIsvAdapter`.
 *
 * Every method either returns a resource SID (or a small result) or throws `IsvApiError`. Messages in `IsvApiError` are
 * sanitized: they never contain request attributes (EIN, email, phone, address), only Twilio's own error code/text.
 */

export const ISV_STEP_KEYS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "T1", "T2", "T3", "T4", "T5", "T6", "B1"] as const;
export type IsvStepKey = (typeof ISV_STEP_KEYS)[number];

export type IsvErrorKind =
  /** 4xx: Twilio rejected the request itself (bad field, policy). Fixable by the owner or by us. */
  | "validation"
  /** 429 / 5xx / network: the outcome of a POST is UNKNOWN and must be reconciled before any retry. */
  | "transient"
  /** Credentials, account suspension, forbidden: stop and alert; nothing the studio can fix. */
  | "account"
  | "unknown";

export class IsvApiError extends Error {
  constructor(
    public readonly kind: IsvErrorKind,
    public readonly httpStatus: number | null,
    public readonly twilioCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "IsvApiError";
  }
}

export type EvaluationResult = {
  status: "compliant" | "noncompliant";
  /** Names of the Twilio fields that failed (e.g. `business_name`, `email`); never their values. */
  failedFields: string[];
};

export type BundleStatus = "draft" | "pending-review" | "in-review" | "twilio-rejected" | "twilio-approved" | string;

export type BrandStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "FAILED" | "SUSPENDED" | "DELETION_PENDING" | "DELETION_FAILED" | string;

export interface IsvAdapter {
  // --- Trust Hub: Secondary Customer Profile ---
  getCustomerProfile(profileSid: string): Promise<{ status: BundleStatus; policySid: string | null }>;
  findCustomerProfile(friendlyName: string): Promise<string[]>;
  createCustomerProfile(input: { friendlyName: string; email: string }): Promise<string>;
  createEndUser(input: { friendlyName: string; type: EndUserType; attributes: Record<string, string> }): Promise<string>;
  createAddress(input: { customerName: string; street: string; streetSecondary: string; city: string; region: string; postalCode: string; isoCountry: string }): Promise<string>;
  createSupportingDocument(input: { friendlyName: string; addressSid: string }): Promise<string>;
  assignToCustomerProfile(profileSid: string, objectSid: string): Promise<string>;
  evaluateCustomerProfile(profileSid: string): Promise<{ evaluationSid: string; result: EvaluationResult }>;
  submitCustomerProfile(profileSid: string): Promise<string>;

  // --- Trust Hub: A2P TrustProduct ---
  findTrustProduct(friendlyName: string): Promise<string[]>;
  createTrustProduct(input: { friendlyName: string; email: string }): Promise<string>;
  assignToTrustProduct(trustProductSid: string, objectSid: string): Promise<string>;
  evaluateTrustProduct(trustProductSid: string): Promise<{ evaluationSid: string; result: EvaluationResult }>;
  submitTrustProduct(trustProductSid: string): Promise<string>;

  // --- A2P brand ---
  findBrand(input: { customerProfileSid: string; trustProductSid: string }): Promise<string[]>;
  createBrand(input: { customerProfileSid: string; trustProductSid: string; brandType: "STANDARD"; skipAutomaticSecVet: boolean; mock: boolean }): Promise<string>;
  getBrandStatus(brandSid: string): Promise<BrandStatus>;
}

export type EndUserType = "customer_profile_business_information" | "authorized_representative_1" | "us_a2p_messaging_profile_information";

export type IsvEnvName = "production" | "preview" | "development" | "test";
