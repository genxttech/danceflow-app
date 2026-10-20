/**
 * TW-4F provider integration: the two registration paths a studio legal business can take, with the semantics Twilio confirmed on support ticket
 * #29647095 (2026-10-19, answer 6: eligible EIN-registered studios may use Low-Volume Standard brands and Low Volume Mixed campaigns, subject to
 * Twilio review) and Twilio's ISV API guide:
 *
 *  - Standard (owner decision D3 for the pilot): BrandType STANDARD, automatic secondary vetting ON, campaign use case MIXED.
 *  - Low-Volume Standard: STILL BrandType STANDARD (there is no separate brand type); `SkipAutomaticSecVet=true`, which Twilio allows only for
 *    Low-Volume Standard brands and 527 political organizations; campaign use case LOW_VOLUME ("Low Volume Mixed").
 *
 * A tier is chosen per onboarding by a platform admin (`tw4_onboarding_decide_tier`, frozen once any brand attempt exists). No choice = Standard.
 *
 * PRICING (20261202090000): each path has its own price-list kinds, so a Low-Volume Standard brand is never reserved or captured at the Standard
 * (secondary-vetted) price: `brand` / `monthly` for Standard, `brand_low_volume` / `monthly_low_volume` for Low-Volume Standard (campaign vetting is
 * the shared `campaign_vetting` kind). The database refuses a kind that does not match the location's path, and a low-volume kind unless the path
 * is VERIFIED (the latest tier decision carries the complete eligibility checklist and the legal business's EIN matches). Prices stay unpublished
 * (DRAFT) until the owner approves them; without a published price nothing can be authorized. Before any Twilio write, a paid Low-Volume Standard
 * run asks the database whether the path is verified and its brand price published (`needsPathReadiness`); the Standard path is unchanged.
 */

export const REGISTRATION_TIERS = ["standard", "low_volume_standard"] as const;
export type RegistrationTier = (typeof REGISTRATION_TIERS)[number];

/** Twilio `UsAppToPersonUsecase` values this product registers. */
export type CampaignUseCase = "MIXED" | "LOW_VOLUME";

export type BrandPriceKind = "brand" | "brand_low_volume";
export type CampaignMonthlyPriceKind = "monthly" | "monthly_low_volume";

export type RegistrationPath = {
  tier: RegistrationTier;
  brand: { brandType: "STANDARD"; skipAutomaticSecVet: boolean };
  campaignUseCase: CampaignUseCase;
  /** The price-list kind the paid brand step reserves and settles. */
  brandPriceKind: BrandPriceKind;
  /** The price-list kind of the campaign's monthly fee (recurring authorization). */
  campaignMonthlyPriceKind: CampaignMonthlyPriceKind;
};

const PATHS: Readonly<Record<RegistrationTier, RegistrationPath>> = Object.freeze({
  standard: Object.freeze({ tier: "standard", brand: Object.freeze({ brandType: "STANDARD", skipAutomaticSecVet: false }), campaignUseCase: "MIXED", brandPriceKind: "brand", campaignMonthlyPriceKind: "monthly" }),
  low_volume_standard: Object.freeze({ tier: "low_volume_standard", brand: Object.freeze({ brandType: "STANDARD", skipAutomaticSecVet: true }), campaignUseCase: "LOW_VOLUME", brandPriceKind: "brand_low_volume", campaignMonthlyPriceKind: "monthly_low_volume" }),
}) as Readonly<Record<RegistrationTier, RegistrationPath>>;

export function isRegistrationTier(value: unknown): value is RegistrationTier {
  return typeof value === "string" && (REGISTRATION_TIERS as readonly string[]).includes(value);
}

/** The path for a tier read from the database. Anything unrecognized throws: a run must never guess a brand type or a price. */
export function registrationPath(tier: unknown): RegistrationPath {
  if (!isRegistrationTier(tier)) throw new Error("unknown registration tier");
  return PATHS[tier];
}

/** True when a paid brand of this path may only start after the database confirms the path is verified and its brand price is published. */
export function needsPathReadiness(path: RegistrationPath): boolean {
  return path.tier === "low_volume_standard";
}

/** The location's fee path as the database reports it (`tw4_location_fee_kinds` / `tw4_runner_fee_kinds`). */
export type LocationFeeKinds = {
  path: "standard" | "low_volume_standard" | "low_volume_unverified";
  brandKind: BrandPriceKind | null;
  campaignMonthlyKind: CampaignMonthlyPriceKind | null;
  brandPriceCents: number | null;
  campaignMonthlyPriceCents: number | null;
};

const PATH_NAMES = new Set(["standard", "low_volume_standard", "low_volume_unverified"]);
const cents = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** Parses the database answer; anything unrecognized reads as unverified with no kinds (fail closed). */
export function parseLocationFeeKinds(data: unknown): LocationFeeKinds {
  const o = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const path = PATH_NAMES.has(String(o.path)) ? (o.path as LocationFeeKinds["path"]) : "low_volume_unverified";
  const brandKind = o.brand_kind === "brand" || o.brand_kind === "brand_low_volume" ? o.brand_kind : null;
  const campaignMonthlyKind = o.campaign_monthly_kind === "monthly" || o.campaign_monthly_kind === "monthly_low_volume" ? o.campaign_monthly_kind : null;
  return { path, brandKind, campaignMonthlyKind, brandPriceCents: cents(o.brand_price_cents), campaignMonthlyPriceCents: cents(o.campaign_monthly_price_cents) };
}

/**
 * Why a paid brand of `path` cannot start, or null when it can: the database must report the SAME verified path, the same brand kind, and a published
 * brand price. "ineligible" = the path is not verified (or the database disagrees); "unpriced" = verified, but no price is published yet.
 */
export function paidBrandRefusal(path: RegistrationPath, fees: LocationFeeKinds): "ineligible" | "unpriced" | null {
  if (fees.path !== path.tier || fees.brandKind !== path.brandPriceKind) return "ineligible";
  if (fees.brandPriceCents === null) return "unpriced";
  return null;
}
