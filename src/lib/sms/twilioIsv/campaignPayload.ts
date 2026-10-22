import { createHash } from "node:crypto";
import { buildSmsHelpReply, buildSmsStartReply, buildSmsStopReply } from "@/lib/sms/compliance";
import { SMS_FALLBACK_HELP_KEYWORDS, SMS_FALLBACK_OPT_IN_KEYWORDS, SMS_FALLBACK_OPT_OUT_KEYWORDS } from "@/lib/sms/inboundKeywords";
import { buildCampaignPackage } from "@/lib/sms/onboarding/campaignTemplate";
import { reviewCampaignPackage, type PackageReview } from "@/lib/sms/onboarding/campaignPackageReview";
import type { CampaignCreateInput } from "./provisioningTypes";
import type { CampaignUseCase } from "./registrationPath";

/**
 * TW-4F R2a: the Twilio campaign (UsAppToPerson) request for ONE studio, built from DanceFlow's versioned campaign template (`buildCampaignPackage`) and
 * the compliance replies and keywords the inbound handler already understands. Pure: no I/O. The package is reviewed against Twilio's documented length
 * limits BEFORE any fee is reserved; a package that does not pass is never submitted.
 *
 * The digest identifies the request (not the studio): it is stored with the operation so a later reader can tell which template a campaign was submitted with.
 */

export type CampaignRequest = { input: CampaignCreateInput; review: PackageReview; digest: string; templateVersion: string };

const sorted = (values: ReadonlySet<string>) => [...values].sort();

export function buildCampaignRequest(args: {
  messagingServiceSid: string;
  brandSid: string;
  useCase: CampaignUseCase;
  displayName: string;
  slug: string;
  origin: string;
}): CampaignRequest {
  const pkg = buildCampaignPackage({ displayName: args.displayName, origin: args.origin, slug: args.slug });
  const review = reviewCampaignPackage(pkg, { displayName: args.displayName, slug: args.slug });
  const input: CampaignCreateInput = {
    messagingServiceSid: args.messagingServiceSid,
    brandSid: args.brandSid,
    useCase: args.useCase,
    description: pkg.description,
    messageFlow: pkg.messageFlow,
    messageSamples: [...pkg.samples],
    hasEmbeddedLinks: pkg.hasEmbeddedLinks,
    hasEmbeddedPhone: pkg.hasEmbeddedPhone,
    subscriberOptIn: pkg.subscriberOptIn,
    ageGated: pkg.ageGated,
    directLending: pkg.directLending,
    optInMessage: buildSmsStartReply(args.displayName),
    optOutMessage: buildSmsStopReply(args.displayName),
    helpMessage: buildSmsHelpReply(args.displayName),
    optInKeywords: sorted(SMS_FALLBACK_OPT_IN_KEYWORDS),
    optOutKeywords: sorted(SMS_FALLBACK_OPT_OUT_KEYWORDS),
    helpKeywords: sorted(SMS_FALLBACK_HELP_KEYWORDS),
  };
  return { input, review, digest: requestDigest(input), templateVersion: pkg.templateVersion };
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
