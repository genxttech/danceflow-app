import { buildSmsConsentDisclosure } from "@/lib/sms/compliance";
import type { CampaignPackage } from "./campaignTemplate";

/**
 * TW-4F-2a: a platform-side, read-only review of the generated campaign package before it is sent to Twilio for pre-submission review
 * (owner decision D6 in the TW-4F plan). Pure functions: no I/O, no Twilio call, no studio-private data (the package is built from the
 * studio's public display name, slug and the DanceFlow template only).
 *
 * The limits are the ones Twilio documents for a UsAppToPerson campaign: Description 40-4096 characters, MessageFlow 40-2048,
 * MessageSamples 2-5 samples of 20-1024 characters each. A failed check does not change anything: it tells the platform admin what to
 * fix before any package is shared or submitted.
 */

export const CAMPAIGN_LIMITS = {
  description: { min: 40, max: 4096 },
  messageFlow: { min: 40, max: 2048 },
  samples: { min: 2, max: 5 },
  sample: { min: 20, max: 1024 },
} as const;

export type PackageCheck = { id: string; label: string; ok: boolean; detail: string };
export type PackageReview = { ok: boolean; checks: PackageCheck[] };

const LINK = /https?:\/\/|www\./i;
const PHONE = /(?:\+?\d[\s().-]{0,2}){9,}\d/;

const check = (id: string, label: string, ok: boolean, detail: string): PackageCheck => ({ id, label, ok, detail });
const within = (length: number, range: { min: number; max: number }) => length >= range.min && length <= range.max;

export function reviewCampaignPackage(pkg: CampaignPackage, input: { displayName: string; slug: string }): PackageReview {
  const checks: PackageCheck[] = [];
  const name = String(input.displayName ?? "").trim();
  const slug = String(input.slug ?? "").trim();

  checks.push(check("studio_name", "The studio has its own display name", Boolean(name) && name !== "Your dance studio", name ? "Display name present." : "The studio has no name; the package would say \"Your dance studio\"."));
  checks.push(check("studio_slug", "The studio has a public page (slug)", slug.length > 0, slug ? "Public page present." : "No slug: the opt-in, Terms and Privacy links would be broken."));

  checks.push(check("description_length", `Description is ${CAMPAIGN_LIMITS.description.min}-${CAMPAIGN_LIMITS.description.max} characters`, within(pkg.description.length, CAMPAIGN_LIMITS.description), `${pkg.description.length} characters.`));
  checks.push(check("flow_length", `Message flow is ${CAMPAIGN_LIMITS.messageFlow.min}-${CAMPAIGN_LIMITS.messageFlow.max} characters`, within(pkg.messageFlow.length, CAMPAIGN_LIMITS.messageFlow), `${pkg.messageFlow.length} characters.`));
  checks.push(check("sample_count", `${CAMPAIGN_LIMITS.samples.min}-${CAMPAIGN_LIMITS.samples.max} sample messages`, within(pkg.samples.length, CAMPAIGN_LIMITS.samples), `${pkg.samples.length} samples.`));
  const badLengths = pkg.samples.map((sample, index) => ({ index: index + 1, length: sample.length })).filter((sample) => !within(sample.length, CAMPAIGN_LIMITS.sample));
  checks.push(check("sample_length", `Each sample is ${CAMPAIGN_LIMITS.sample.min}-${CAMPAIGN_LIMITS.sample.max} characters`, badLengths.length === 0, badLengths.length === 0 ? `Lengths: ${pkg.samples.map((s) => s.length).join(", ")}.` : `Out of range: sample ${badLengths.map((s) => `${s.index} (${s.length})`).join(", ")}.`));

  const urls = [pkg.optInPageUrl, pkg.termsUrl, pkg.privacyUrl];
  checks.push(check("urls_https", "Opt-in, Terms and Privacy links are https", urls.every((url) => /^https:\/\/[^\s/]+\.[^\s/]+\//.test(url)), urls.every((url) => /^https:\/\//.test(url)) ? "All https." : "At least one link is not an https address."));
  const hosts = new Set(urls.map((url) => { try { return new URL(url).host; } catch { return "invalid"; } }));
  checks.push(check("urls_same_site", "The three links are on one site", hosts.size === 1 && !hosts.has("invalid"), [...hosts].join(", ")));
  checks.push(check("flow_mentions_links", "The message flow cites the opt-in page, Terms and Privacy", urls.every((url) => pkg.messageFlow.includes(url)), "Each link appears in the message flow."));
  const packageName = name.replace(/\s+/g, " ").trim() || "Your dance studio";
  checks.push(check("flow_has_disclosure", "The message flow quotes the exact consent disclosure shown on the opt-in page", pkg.messageFlow.includes(buildSmsConsentDisclosure(packageName)), `Disclosure version ${pkg.consentDisclosureVersion}.`));

  const withLink = pkg.samples.map((sample, index) => ({ index: index + 1, hit: LINK.test(sample) })).filter((sample) => sample.hit);
  checks.push(check("samples_no_links", "Samples contain no links (the campaign declares none)", !pkg.hasEmbeddedLinks && withLink.length === 0, withLink.length === 0 ? "No links." : `Links in sample ${withLink.map((s) => s.index).join(", ")}.`));
  const withPhone = pkg.samples.map((sample, index) => ({ index: index + 1, hit: PHONE.test(sample) })).filter((sample) => sample.hit);
  checks.push(check("samples_no_phone", "Samples contain no phone numbers (the campaign declares none)", !pkg.hasEmbeddedPhone && withPhone.length === 0, withPhone.length === 0 ? "No phone numbers." : `Phone number in sample ${withPhone.map((s) => s.index).join(", ")}.`));
  const missingOptOut = pkg.samples.map((sample, index) => ({ index: index + 1, hit: /reply stop/i.test(sample) && /reply help/i.test(sample) })).filter((sample) => !sample.hit);
  checks.push(check("samples_opt_out", "Every sample carries the STOP / HELP footer", missingOptOut.length === 0, missingOptOut.length === 0 ? "All samples carry it." : `Missing in sample ${missingOptOut.map((s) => s.index).join(", ")}.`));
  checks.push(check("flags", "Declared flags: opt-in yes; embedded links, embedded phone, age-gated, direct lending no", pkg.subscriberOptIn && !pkg.hasEmbeddedLinks && !pkg.hasEmbeddedPhone && !pkg.ageGated && !pkg.directLending, "As declared by the template."));

  return { ok: checks.every((item) => item.ok), checks };
}

/** Plain text of the package in the order Twilio's campaign form asks for it, for copy and paste into the pre-submission review request. */
export function renderCampaignPackageText(pkg: CampaignPackage, input: { displayName: string }): string {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  return [
    `DanceFlow studio campaign package (template ${pkg.templateVersion}, consent disclosure ${pkg.consentDisclosureVersion})`,
    `Studio display name: ${String(input.displayName ?? "").trim()}`,
    "Use case (to be confirmed before submission): MIXED",
    "",
    "DESCRIPTION",
    pkg.description,
    "",
    "MESSAGE FLOW (how people opt in)",
    pkg.messageFlow,
    "",
    `SAMPLE MESSAGES (${pkg.samples.length})`,
    ...pkg.samples.flatMap((sample, index) => [`--- Sample ${index + 1} ---`, sample, ""]),
    "LINKS",
    `Opt-in page: ${pkg.optInPageUrl}`,
    `Terms: ${pkg.termsUrl}`,
    `Privacy policy: ${pkg.privacyUrl}`,
    "",
    "DECLARATIONS",
    `Subscriber opt-in: ${yesNo(pkg.subscriberOptIn)}`,
    `Embedded links: ${yesNo(pkg.hasEmbeddedLinks)}`,
    `Embedded phone numbers: ${yesNo(pkg.hasEmbeddedPhone)}`,
    `Age-gated content: ${yesNo(pkg.ageGated)}`,
    `Direct lending or loan arrangement: ${yesNo(pkg.directLending)}`,
    "",
  ].join("\n");
}
