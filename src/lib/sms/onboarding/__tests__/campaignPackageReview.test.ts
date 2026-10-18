import { describe, expect, it } from "vitest";
import { buildCampaignPackage } from "../campaignTemplate";
import { CAMPAIGN_LIMITS, renderCampaignPackageText, reviewCampaignPackage } from "../campaignPackageReview";

const input = { displayName: "ConfiDance Studio", slug: "confidance-studio" };
const pkg = () => buildCampaignPackage({ ...input, origin: "https://www.idanceflow.com" });
const failedIds = (p = pkg(), over: Partial<typeof input> = {}) => reviewCampaignPackage(p, { ...input, ...over }).checks.filter((c) => !c.ok).map((c) => c.id);

describe("TW-4F-2a campaign package review (read-only, before the Twilio pre-submission review)", () => {
  it("the generated package for a normal studio passes every check", () => {
    const review = reviewCampaignPackage(pkg(), input);
    expect(review.ok).toBe(true);
    expect(review.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["studio_name", "studio_slug", "description_length", "flow_length", "sample_count", "sample_length", "urls_https", "urls_same_site", "flow_mentions_links", "flow_has_disclosure", "samples_no_links", "samples_no_phone", "samples_opt_out", "flags"]));
  });
  it("the limits are Twilio's documented ones", () => {
    expect(CAMPAIGN_LIMITS).toEqual({ description: { min: 40, max: 4096 }, messageFlow: { min: 40, max: 2048 }, samples: { min: 2, max: 5 }, sample: { min: 20, max: 1024 } });
  });
  it("a studio without a name or a public page is flagged, because the links and wording would be wrong", () => {
    expect(failedIds(buildCampaignPackage({ displayName: "", slug: "", origin: "https://www.idanceflow.com" }), { displayName: "", slug: "" })).toEqual(expect.arrayContaining(["studio_name", "studio_slug"]));
  });
  it("a very long name breaks the length limits and is reported with the numbers", () => {
    const long = "A".repeat(2500);
    const review = reviewCampaignPackage(buildCampaignPackage({ displayName: long, slug: "x", origin: "https://www.idanceflow.com" }), { displayName: long, slug: "x" });
    expect(review.ok).toBe(false);
    expect(review.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(expect.arrayContaining(["flow_length"]));
    expect(review.checks.find((c) => c.id === "flow_length")?.detail).toMatch(/\d+ characters/);
  });
  it("an http origin, mixed hosts, a missing link in the flow, a link or phone number in a sample, a missing footer and wrong flags are each caught", () => {
    const http = buildCampaignPackage({ ...input, origin: "http://www.idanceflow.com" });
    expect(failedIds(http)).toContain("urls_https");
    expect(failedIds({ ...pkg(), termsUrl: "https://other.example/terms" })).toEqual(expect.arrayContaining(["urls_same_site", "flow_mentions_links"]));
    expect(failedIds({ ...pkg(), samples: [...pkg().samples.slice(0, 3), "Hi Alex, see https://example.com/promo for details. Reply STOP to opt out. Reply HELP for help."] })).toContain("samples_no_links");
    expect(failedIds({ ...pkg(), samples: [...pkg().samples.slice(0, 3), "Hi Alex, call (503) 555-0123 about your lesson. Reply STOP. Reply HELP."] })).toContain("samples_no_phone");
    expect(failedIds({ ...pkg(), samples: [...pkg().samples.slice(0, 3), "Hi Alex, your lesson is confirmed for Friday at 5 PM."] })).toContain("samples_opt_out");
    expect(failedIds({ ...pkg(), samples: ["too short"] })).toEqual(expect.arrayContaining(["sample_count", "sample_length"]));
    expect(failedIds({ ...pkg(), samples: Array.from({ length: 6 }, () => pkg().samples[0]) })).toContain("sample_count");
    expect(failedIds({ ...pkg(), ageGated: true as never })).toContain("flags");
  });
  it("the message flow must quote the exact consent disclosure", () => {
    expect(failedIds({ ...pkg(), messageFlow: `${pkg().optInPageUrl} ${pkg().termsUrl} ${pkg().privacyUrl} people agree to texts somehow, padded out to be long enough.` })).toContain("flow_has_disclosure");
  });
  it("the plain-text export lists everything Twilio's form asks for, in order, and carries no private data", () => {
    const text = renderCampaignPackageText(pkg(), input);
    const order = ["DESCRIPTION", "MESSAGE FLOW", "SAMPLE MESSAGES (4)", "--- Sample 1 ---", "--- Sample 4 ---", "LINKS", "Opt-in page: https://www.idanceflow.com/studios/confidance-studio#lead", "Terms: https://www.idanceflow.com/studios/confidance-studio/sms-terms", "Privacy policy: https://www.idanceflow.com/studios/confidance-studio/sms-privacy", "DECLARATIONS", "Direct lending or loan arrangement: no"];
    let at = 0;
    for (const marker of order) {
      const next = text.indexOf(marker, at);
      expect(next, marker).toBeGreaterThanOrEqual(at);
      at = next;
    }
    expect(text).toContain("Use case (to be confirmed before submission): MIXED");
    expect(text).not.toMatch(/\b\d{2}-\d{7}\b|@/);
  });
});
