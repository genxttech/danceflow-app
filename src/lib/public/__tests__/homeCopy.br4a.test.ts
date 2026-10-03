import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOME_AUDIENCES,
  HOME_CONCEPTS,
  HOME_DISCOVERY,
  HOME_FINAL_CTA,
  HOME_HERO,
  HOME_JSON_LD,
  HOME_TRUST,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_OG_DESCRIPTION,
  SITE_TITLE,
  SITE_TWITTER_DESCRIPTION,
  buildTrialLine,
} from "@/lib/public/homeCopy";

/**
 * BR-4A: public marketing copy must only describe capabilities that exist today, and the
 * homepage hierarchy must stay simple.
 *
 * The claims guard is intentionally a short list of rules, one per restricted area, each with
 * a reason. It scans only the public marketing sources listed below, not the product code
 * (where names such as `featuredStudios` or competition features legitimately appear). When a
 * restricted capability genuinely ships, change the rule and the roadmap together.
 */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const MARKETING_SOURCES = [
  ["src", "lib", "public", "homeCopy.ts"],
  ["src", "app", "page.tsx"],
  ["src", "app", "layout.tsx"],
  // BR-4B additions
  ["src", "lib", "public", "audienceCopy.ts"],
  ["src", "app", "for-studios", "page.tsx"],
  ["src", "app", "for-instructors", "page.tsx"],
  ["src", "app", "for-organizers", "page.tsx"],
  ["src", "app", "discover", "page.tsx"],
] as const;

/** Comments document the restrictions themselves, so the guard reads code and copy only. */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const marketingText = MARKETING_SOURCES.map((parts) => stripComments(read(...parts))).join("\n");

const CLAIM_RULES: Array<{ area: string; pattern: RegExp; why: string }> = [
  {
    area: "Featured Events",
    pattern: /featured events?|boosted|promoted (event|placement)|sponsored (event|placement)|premium (placement|ranking)/i,
    why: "Featured Events has no governed product model yet (roadmap: Featured Events module).",
  },
  {
    area: "Partner Match",
    pattern:
      /partner match|algorithm|compatib|smart match|ai[- ]match|matching (technology|engine)|guaranteed (match|connection)|instant match|free forever/i,
    why: "Partner Match is a directory of listings, not matching technology (roadmap: Partner Match module).",
  },
  {
    area: "SOC 2",
    pattern: /soc\s?-?2/i,
    why: "SOC 2 Type II is later roadmap work; no certification or compliance claim is allowed.",
  },
  {
    area: "Competition OS",
    pattern:
      /\bjudg(e|es|ing)\b|\bscoring\b|live heat|heat management|competition (management|os|platform|software|results)|\bawards?\b/i,
    why: "Competition OS (judging, scoring, results, live heats) is materially incomplete.",
  },
  {
    area: "ARIA autonomy",
    pattern:
      /runs? (your|the) (entire|whole) (studio|business)|runs (everything|itself)|fully autonomous|autonomous(ly)?|autopilot|hands[- ]free/i,
    why: "ARIA suggests and runs approved automation within owner-set limits; it is not unrestricted.",
  },
];

describe("claims guard (public marketing copy)", () => {
  for (const rule of CLAIM_RULES) {
    it(`${rule.area}: no unsupported claim`, () => {
      const hit = marketingText.match(rule.pattern);
      expect(hit, `${rule.why} Found: "${hit?.[0]}"`).toBeNull();
    });
  }

  it("the guard itself catches what it is meant to catch", () => {
    const samples: Array<[string, string]> = [
      ["Featured Events", "Boost your event with Featured Events"],
      ["Partner Match", "Find your perfect partner with our matching algorithm"],
      ["SOC 2", "We are SOC 2 compliant"],
      ["Competition OS", "Run judging and scoring for your competition"],
      ["ARIA autonomy", "ARIA runs your entire studio"],
    ];
    for (const [area, sample] of samples) {
      const rule = CLAIM_RULES.find((candidate) => candidate.area === area)!;
      expect(rule.pattern.test(sample), area).toBe(true);
    }
  });

  it("describes partners only as listings", () => {
    expect(HOME_DISCOVERY.links.map((link) => link.label)).toContain("Dance partner listings");
  });
});

describe("founder pricing is derived, never hard-coded", () => {
  const page = read("src", "app", "page.tsx");

  it("contains no studio-count claim", () => {
    expect(marketingText).not.toMatch(/first\s+25|25\s+studios|\b\d+\s+(founding|founder)\s+studios/i);
  });

  it("reads the trial length and founder status from the pricing logic", () => {
    expect(page).toContain('getPlansByAudience("studio")');
    expect(page).toContain("isFounderPricingActive()");
    expect(page).toContain("buildTrialLine(");
  });

  it("buildTrialLine adds founder wording only when founder pricing is active", () => {
    expect(buildTrialLine({ trialDays: 30, founderPricingActive: true })).toBe(
      "30-day free trial for studios. Founder pricing is available during launch.",
    );
    expect(buildTrialLine({ trialDays: 30, founderPricingActive: false })).toBe("30-day free trial for studios.");
  });
});

describe("homepage hierarchy", () => {
  const page = read("src", "app", "page.tsx");

  it("uses the approved H1 and a single H1", () => {
    expect(HOME_HERO.headline).toBe("The dance platform that helps do the work—not just track it.");
    expect(page.match(/<h1\b/g)).toHaveLength(1);
  });

  it("has one primary hero action plus one quiet path, and one final primary action", () => {
    expect(Object.keys(HOME_HERO).filter((key) => key.endsWith("Cta")).sort()).toEqual([
      "primaryCta",
      "secondaryCta",
    ]);
    expect(Object.keys(HOME_FINAL_CTA).filter((key) => key.endsWith("Cta"))).toEqual(["primaryCta"]);
    // Only the two primary CTAs use the filled brand button style.
    expect(page.match(/rounded-2xl bg-\[var\(--brand-primary\)\]/g)).toHaveLength(2);
  });

  it("covers the four audiences without four competing cards", () => {
    expect(HOME_AUDIENCES.map((audience) => audience.name)).toEqual([
      "Studio owners",
      "Independent instructors",
      "Organizers",
      "Dancers",
    ]);
    expect(page).not.toMatch(/audienceCards|featureCards|discoveryCards/);
    expect(page).not.toContain("rounded-[2rem] border");
  });

  it("describes the work in four concepts, each backed by shipped capabilities", () => {
    expect(HOME_CONCEPTS).toHaveLength(4);
    for (const concept of HOME_CONCEPTS) {
      expect(concept.proof.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("links each audience to its dedicated page; dancers stay on Discover (BR-4B)", () => {
    expect(HOME_AUDIENCES.map((audience) => [audience.name, audience.href])).toEqual([
      ["Studio owners", "/for-studios"],
      ["Independent instructors", "/for-instructors"],
      ["Organizers", "/for-organizers"],
      ["Dancers", "/discover"],
    ]);
  });

  it("every internal link points at a real route", () => {
    const hrefs = [
      HOME_HERO.primaryCta.href,
      HOME_HERO.secondaryCta.href,
      HOME_FINAL_CTA.primaryCta.href,
      ...HOME_AUDIENCES.map((audience) => audience.href),
      ...HOME_DISCOVERY.links.map((link) => link.href),
      ...HOME_TRUST.links.map((link) => link.href),
    ];
    for (const href of hrefs) {
      const path = href.split(/[?#]/)[0];
      expect(path.startsWith("/"), href).toBe(true);
      const dir = join(ROOT, "src", "app", ...path.split("/").filter(Boolean));
      expect(existsSync(join(dir, "page.tsx")), `no page for ${href}`).toBe(true);
    }
  });
});

describe("site metadata and structured data (BR-4A)", () => {
  const GENERIC = /CRM, Scheduler, and Event Management/i;

  it("no longer presents DanceFlow as generic studio CRM software", () => {
    for (const text of [
      SITE_TITLE,
      SITE_DESCRIPTION,
      SITE_OG_DESCRIPTION,
      SITE_TWITTER_DESCRIPTION,
      ...Object.values(HOME_JSON_LD),
    ]) {
      expect(text).not.toMatch(GENERIC);
    }
    expect(read("src", "app", "page.tsx")).not.toMatch(GENERIC);
    expect(read("src", "app", "layout.tsx")).not.toMatch(GENERIC);
  });

  it("represents the broader platform: business tools plus dancer discovery", () => {
    expect(SITE_DESCRIPTION).toMatch(/studios, instructors and organizers/);
    expect(SITE_DESCRIPTION).toMatch(/dancers/);
    expect(SITE_TITLE).toContain("helps do the work");
  });

  it("keywords stay concrete and short", () => {
    expect(SITE_KEYWORDS.length).toBeLessThanOrEqual(10);
    expect(new Set(SITE_KEYWORDS).size).toBe(SITE_KEYWORDS.length);
  });

  it("the sitemap and page metadata keep the canonical home URL", () => {
    expect(read("src", "app", "page.tsx")).toContain('canonical: "/"');
  });
});
