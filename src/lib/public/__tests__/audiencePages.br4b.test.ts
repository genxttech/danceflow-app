import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_LINKS,
  INSTRUCTORS_PAGE,
  ORGANIZERS_PAGE,
  STUDIOS_PAGE,
} from "@/lib/public/audienceCopy";
import { buildTrialLine } from "@/lib/public/homeCopy";
import { ORGANIZER_TRIAL_DAYS, STUDIO_TRIAL_DAYS, getPlansByAudience } from "@/lib/billing/plans";

/** BR-4B: audience pathways, public navigation, trial/pricing copy consistency. */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const PAGES = [
  { key: "studios", route: "for-studios", copy: STUDIOS_PAGE, cta: "/get-started/studio" },
  { key: "instructors", route: "for-instructors", copy: INSTRUCTORS_PAGE, cta: "/get-started/studio" },
  { key: "organizers", route: "for-organizers", copy: ORGANIZERS_PAGE, cta: "/get-started/organizer" },
] as const;

describe("audience pages", () => {
  for (const page of PAGES) {
    const source = read("src", "app", page.route, "page.tsx");

    describe(page.route, () => {
      it("exists with its own factual metadata and canonical URL", () => {
        expect(existsSync(join(ROOT, "src", "app", page.route, "page.tsx"))).toBe(true);
        expect(source).toContain(`canonical: "/${page.route}"`);
        expect(source).toContain("title:");
        expect(source).toContain("description:");
        expect(page.copy.metaDescription.length).toBeGreaterThan(60);
        expect(page.copy.metaDescription.length).toBeLessThanOrEqual(200);
      });

      it("has one H1 (via the shared hero), one primary CTA to the existing flow, and a switcher", () => {
        expect(source.match(/<AudienceHero\b/g)).toHaveLength(1);
        expect(source).not.toMatch(/<h1\b/);
        expect(source).toContain(`<AudienceSwitcher active="${page.key}"`);
        expect(page.copy.cta.href).toBe(page.cta);
        expect(existsSync(join(ROOT, "src", "app", ...page.cta.split("/").filter(Boolean), "page.tsx"))).toBe(true);
      });

      it("derives trial wording from the canonical plan definitions", () => {
        expect(source).toContain("getPlansByAudience(");
        expect(source).toContain("isFounderPricingActive()");
        expect(source).toContain("buildTrialLine(");
        expect(source).not.toMatch(/\b\d+-day\b/);
      });

      it("uses the shared public shell with the business nav item active", () => {
        expect(source).toContain('<PublicShell currentPath="business">');
      });
    });
  }

  it("the three pages say meaningfully different things", () => {
    const headlines = PAGES.map((page) => page.copy.headline);
    expect(new Set(headlines).size).toBe(3);
    expect(new Set(PAGES.map((page) => page.copy.metaTitle)).size).toBe(3);

    // Each page uses a different primary structure, not one template with swapped nouns.
    expect(read("src", "app", "for-studios", "page.tsx")).toContain("<ExpandableRows");
    expect(read("src", "app", "for-instructors", "page.tsx")).not.toContain("<ExpandableRows");
    expect(read("src", "app", "for-instructors", "page.tsx")).toContain("INSTRUCTORS_PAGE.steps");
    expect(read("src", "app", "for-organizers", "page.tsx")).toContain("ORGANIZERS_PAGE.flow");
  });

  it("no /for-dancers page exists: dancers stay on Discover", () => {
    expect(existsSync(join(ROOT, "src", "app", "for-dancers"))).toBe(false);
    expect(read("src", "components", "public", "audience", "AudienceParts.tsx")).toContain("DANCER_LINK.href");
    expect(read("src", "lib", "public", "audienceCopy.ts")).toContain('href: "/discover"');
  });

  it("independent instructors use the studio plan: no separate plan, pricing or entitlement is invented", () => {
    const text = JSON.stringify(INSTRUCTORS_PAGE);
    expect(text).not.toMatch(/instructor (plan|pricing|subscription|tier)|instructor-only|separate (plan|price)/i);
    expect(INSTRUCTORS_PAGE.startIntro).toMatch(/studio plans/);
    expect(INSTRUCTORS_PAGE.cta.href).toBe(STUDIOS_PAGE.cta.href);
  });

  it("organizer copy markets only released event capabilities", () => {
    const text = JSON.stringify(ORGANIZERS_PAGE);
    expect(text).not.toMatch(/judg|scoring|placements?|results|awards?|live heat|competition (management|os)/i);
    expect(text).not.toMatch(/feature(d)? event|boost|promot/i);
  });

  it("sitemap lists the three audience pages and no standalone Partner Match page", () => {
    const sitemap = read("src", "app", "sitemap.ts");
    for (const page of PAGES) expect(sitemap).toContain(`/${page.route}\``);
    expect(sitemap).not.toMatch(/discover\/partners/);
  });

  it("the audience list matches the nav and footer", () => {
    expect(AUDIENCE_LINKS.map((link) => link.href)).toEqual(PAGES.map((page) => `/${page.route}`));
  });
});

describe("trial and founder-pricing copy is consistent", () => {
  it("organizer trial length is canonical: checkout and display use the same plan value", () => {
    expect(ORGANIZER_TRIAL_DAYS).toBe(30);
    expect(STUDIO_TRIAL_DAYS).toBe(30);
    expect(getPlansByAudience("organizer")[0].trialDays).toBe(ORGANIZER_TRIAL_DAYS);
    expect(read("src", "app", "api", "billing", "checkout", "route.ts")).toContain("trial_period_days: sharedPlan.trialDays");
  });

  it("no public pricing surface hard-codes a trial length or a founder studio count", () => {
    const surfaces = [
      ["src", "lib", "billing", "plans.ts"],
      ["src", "app", "get-started", "page.tsx"],
      ["src", "app", "get-started", "studio", "page.tsx"],
      ["src", "app", "get-started", "organizer", "page.tsx"],
    ];
    for (const parts of surfaces) {
      const source = read(...parts);
      expect(source, parts.join("/")).not.toMatch(/first\s+25|25\s+studios/i);
      expect(source, parts.join("/")).not.toMatch(/\b(14|30)-day free trial/i);
    }
  });

  it("the get-started chooser and organizer page derive the organizer trial from the plan", () => {
    expect(read("src", "app", "get-started", "page.tsx")).toContain('getPlansByAudience("organizer")[0].trialDays');
    expect(read("src", "app", "get-started", "organizer", "page.tsx")).toContain("organizerPlan.trialDays");
    expect(read("src", "app", "get-started", "studio", "page.tsx")).toContain("studioPlans[0].trialDays");
  });

  it("founder wording appears only while founder pricing is active, with the organizer audience label", () => {
    expect(buildTrialLine({ trialDays: 30, founderPricingActive: true, audience: "organizers" })).toBe(
      "30-day free trial for organizers. Founder pricing is available during launch.",
    );
    expect(buildTrialLine({ trialDays: 30, founderPricingActive: false, audience: "organizers" })).toBe(
      "30-day free trial for organizers.",
    );
    // Independent instructors use the studio plans but are not called "studios".
    expect(buildTrialLine({ trialDays: 30, founderPricingActive: false, audience: "instructors" })).toBe(
      "30-day free trial for independent instructors.",
    );
    expect(read("src", "app", "for-instructors", "page.tsx")).toContain('audience: "instructors"');
  });
});

describe("discover keeps its role as the dancer entry point", () => {
  const discover = read("src", "app", "discover", "page.tsx");

  it("uses current terminology and links to the business pages", () => {
    expect(discover).not.toContain("DanceFlow Discovery");
    expect(discover).toContain('href="/for-studios"');
  });

  it("describes partners only as listings", () => {
    expect(discover).not.toMatch(/Meet Dance Partners|Connect with dancers/);
    expect(discover).toContain("Browse partner listings");
  });
});
