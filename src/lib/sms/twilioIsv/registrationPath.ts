/**
 * TW-4F provider integration: the two registration paths a studio legal business can take, with the semantics Twilio confirmed on support ticket
 * #29647095 (2026-10-19, answer 6: eligible EIN-registered studios may use Low-Volume Standard brands and Low Volume Mixed campaigns, subject to
 * Twilio review) and Twilio's ISV API guide:
 *
 *  - Standard (owner decision D3 for the pilot): BrandType STANDARD, automatic secondary vetting ON, campaign use case MIXED.
 *  - Low-Volume Standard: STILL BrandType STANDARD (there is no separate brand type); `SkipAutomaticSecVet=true`, which Twilio allows only for
 *    Low-Volume Standard brands and 527 political organizations; campaign use case LOW_VOLUME ("Low Volume Mixed").
 *
 * A tier is chosen per onboarding by a platform admin (`tw4_onboarding_set_tier`, frozen once any brand attempt exists). No choice = Standard.
 *
 * PRICING DEPENDENCY (owned by the spending-limit work, not this module): the published price list has ONE active `brand` price, which is the
 * Standard brand (with secondary vetting). A Low-Volume Standard brand costs less, so reserving and capturing the Standard price for it would
 * overcharge the studio's credit. Until a tier-specific price kind exists, `paidBrandSupported` is false for Low-Volume Standard and the runner
 * refuses the PAID brand step before any reservation or Twilio call. A Twilio MOCK brand (free) may use either path.
 */

export const REGISTRATION_TIERS = ["standard", "low_volume_standard"] as const;
export type RegistrationTier = (typeof REGISTRATION_TIERS)[number];

/** Twilio `UsAppToPersonUsecase` values this product registers. */
export type CampaignUseCase = "MIXED" | "LOW_VOLUME";

export type RegistrationPath = {
  tier: RegistrationTier;
  brand: { brandType: "STANDARD"; skipAutomaticSecVet: boolean };
  campaignUseCase: CampaignUseCase;
  /** The price-list kind the paid brand step reserves, or null when no published price exists for this tier yet (the step is refused). */
  brandPriceKind: "brand" | null;
};

const PATHS: Readonly<Record<RegistrationTier, RegistrationPath>> = Object.freeze({
  standard: Object.freeze({ tier: "standard", brand: Object.freeze({ brandType: "STANDARD", skipAutomaticSecVet: false }), campaignUseCase: "MIXED", brandPriceKind: "brand" }),
  low_volume_standard: Object.freeze({ tier: "low_volume_standard", brand: Object.freeze({ brandType: "STANDARD", skipAutomaticSecVet: true }), campaignUseCase: "LOW_VOLUME", brandPriceKind: null }),
}) as Readonly<Record<RegistrationTier, RegistrationPath>>;

export function isRegistrationTier(value: unknown): value is RegistrationTier {
  return typeof value === "string" && (REGISTRATION_TIERS as readonly string[]).includes(value);
}

/** The path for a tier read from the database. Anything unrecognized throws: a run must never guess a brand type or a price. */
export function registrationPath(tier: unknown): RegistrationPath {
  if (!isRegistrationTier(tier)) throw new Error("unknown registration tier");
  return PATHS[tier];
}

/** True when the paid (non-mock) brand step of this path can be reserved at a published price. */
export function paidBrandSupported(path: RegistrationPath): boolean {
  return path.brandPriceKind !== null;
}
