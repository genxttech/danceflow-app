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
  /**
   * `compliant` ONLY when Twilio's own `status` is exactly "compliant" and no failing field is reported. `noncompliant` is Twilio's
   * explicit "noncompliant" (failedFields may be empty if the reply named none). Anything else (missing, malformed, unknown value,
   * contradictory) is `unrecognized` and is treated as NOT compliant everywhere: a successful API call is not a successful evaluation.
   */
  status: "compliant" | "noncompliant" | "unrecognized";
  /** Names of the Twilio fields that failed (e.g. `business_name`, `email`); never their values. */
  failedFields: string[];
};

export type BundleStatus = "draft" | "pending-review" | "in-review" | "twilio-rejected" | "twilio-approved" | string;

export type BrandStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "FAILED" | "SUSPENDED" | "DELETION_PENDING" | "DELETION_FAILED" | string;

export interface IsvAdapter {
  /**
   * TW-4F-3a (D2): the Twilio account (a studio legal entity's SUBACCOUNT, AC...) every call of this adapter runs in. An adapter is built for exactly
   * one account; the runner refuses to use it unless this equals the account recorded in the database for the studio's legal entity.
   */
  readonly accountSid: string;

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
  /** Read-only (GET): where Twilio's review of the trust product stands. Never writes. */
  getTrustProductStatus(trustProductSid: string): Promise<{ status: BundleStatus }>;

  // --- A2P brand ---
  findBrand(input: { customerProfileSid: string; trustProductSid: string }): Promise<string[]>;
  createBrand(input: { customerProfileSid: string; trustProductSid: string; brandType: "STANDARD"; skipAutomaticSecVet: boolean; mock: boolean }): Promise<string>;
  getBrandStatus(brandSid: string): Promise<BrandStatus>;
}

/**
 * TW-4F-3a: the parent (ISV) account's account-management surface. It can find and create subaccounts and read a subaccount's auth token, and
 * NOTHING else that writes: it carries no registration methods, so parent credentials can never create or submit Trust Hub or A2P resources
 * (Twilio ticket #29647095, answer 2: those operations need subaccount-scoped credentials).
 */
export interface IsvParentAdapter {
  findSubaccount(friendlyName: string): Promise<string[]>;
  createSubaccount(friendlyName: string): Promise<string>;
  /** The subaccount's auth token, fetched at call time. Callers keep it in memory only (see SubaccountTokenProvider). */
  getSubaccountToken(accountSid: string): Promise<string>;
  /**
   * TW-4F provider integration: read-only (GET) status and policy of the ISV PRIMARY Customer Profile, which lives in the PARENT account. Only the
   * configured Primary profile SID can be read (no argument). The run preflight uses this instead of a subaccount read: Twilio confirmed the Primary
   * can be ASSIGNED to a Secondary profile inside a subaccount (answer 1), not that a subaccount can read it.
   */
  getPrimaryProfile(): Promise<{ status: BundleStatus; policySid: string | null }>;
}

/** What the runner's preflight needs: the Primary profile's state, read with parent credentials. */
export type PrimaryProfileReader = Pick<IsvParentAdapter, "getPrimaryProfile">;

export type EndUserType = "customer_profile_business_information" | "authorized_representative_1" | "us_a2p_messaging_profile_information";

export type IsvEnvName = "production" | "preview" | "development" | "test";
