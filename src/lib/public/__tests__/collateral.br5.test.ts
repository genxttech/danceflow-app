import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { parseAttributionParams } from "@/lib/public/attribution";
import { INSTRUCTORS_PAGE, ORGANIZERS_PAGE, STUDIOS_PAGE } from "@/lib/public/audienceCopy";
import { HOME_DISCOVERY, HOME_HERO } from "@/lib/public/homeCopy";

/**
 * BR-5: focused checks for the print / social collateral. Not an application audit.
 *  - copy.json reuses the BR-4 wording (drift guard) and respects the launch claim restrictions;
 *  - every QR / caption URL is one of the four audience destinations and survives the site's own
 *    attribution parser unchanged (no value would be dropped);
 *  - the committed exports have the documented dimensions, and the layout/QR/image QA recorded by the
 *    builder is clean;
 *  - templates stay static (no scripts, forms, external requests).
 */

const ROOT = process.cwd();
const COLLATERAL = join(ROOT, "docs", "brand", "collateral");
const EXPORTS = join(COLLATERAL, "exports");
const read = (...p: string[]) => readFileSync(join(...p), "utf8").replace(/\r\n/g, "\n");

type Link = { path: string; source: string; medium: string; content: string };
type Block = { title: string; body: string; bullets: string[] };
type Sheet = { link: Link; eyebrow: string; headline: string; support: string; cta: string; blocks: Block[]; note?: string };
const copy = JSON.parse(read(COLLATERAL, "copy.json")) as {
  meta: { baseUrl: string; campaign: string; displayHost: string };
  banner: { link: Link; headline: string; support: string; audiences: string[]; cta: string };
  studios: Sheet;
  instructors: Sheet;
  organizers: Sheet;
  dancers: { link: Link; headline: string; support: string; rows: Array<{ title: string; body: string }>; cta: string };
  social: {
    product: { headline: string; support: string };
    event: { lead: string; eventField: string; support: string };
    links: Array<Link & { name: string }>;
  };
};

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

/** All marketing text (not link tags, which are checked separately). */
const marketing = strings({ ...copy, meta: undefined, links: undefined }).concat(
  strings(copy.social.product),
  strings(copy.social.event),
);
const allText = marketing.join("\n");

const lib = (await import(pathToFileURL(join(ROOT, "scripts", "brand", "collateral-lib.mjs")).href)) as {
  buildUrl: (meta: unknown, link: Link) => string;
  buildQr: (url: string) => { modules: number };
};

describe("BR-5 collateral copy: reuses BR-4 wording", () => {
  it("matches the live audience-page copy", () => {
    expect(copy.banner.headline).toBe(HOME_HERO.headline);
    expect(copy.social.product.headline).toBe(HOME_HERO.headline);
    expect(copy.banner.support).toBe(HOME_HERO.support);
    expect(copy.social.product.support).toBe(HOME_HERO.support);

    expect(copy.studios.headline).toBe(STUDIOS_PAGE.headline);
    expect(copy.studios.support).toBe(STUDIOS_PAGE.support);
    expect(copy.studios.cta).toBe(STUDIOS_PAGE.cta.label);
    expect(copy.studios.blocks.map((b) => b.title)).toEqual([STUDIOS_PAGE.dayHeading, STUDIOS_PAGE.attentionHeading, STUDIOS_PAGE.foundHeading]);
    expect(copy.studios.blocks[1].body).toBe(STUDIOS_PAGE.attentionBody);
    expect(copy.studios.blocks[2].body).toBe(STUDIOS_PAGE.foundBody);

    expect(copy.instructors.headline).toBe(INSTRUCTORS_PAGE.headline);
    expect(copy.instructors.support).toBe(INSTRUCTORS_PAGE.support);
    expect(copy.instructors.blocks.map((b) => [b.title, b.body])).toEqual(INSTRUCTORS_PAGE.stages.map((s) => [s.title, s.body]));
    expect(copy.instructors.note).toBe(INSTRUCTORS_PAGE.startIntro);

    expect(copy.organizers.headline).toBe(ORGANIZERS_PAGE.headline);
    expect(copy.organizers.support).toBe(ORGANIZERS_PAGE.support);
    expect(copy.organizers.cta).toBe(ORGANIZERS_PAGE.cta.label);
    expect(copy.organizers.blocks.map((b) => [b.title, b.body])).toEqual(ORGANIZERS_PAGE.flow.map((s) => [s.title, s.body]));
    expect(copy.organizers.note).toBe(ORGANIZERS_PAGE.pricingNote);

    expect(copy.dancers.headline).toBe(HOME_DISCOVERY.heading);
  });

  it("has one primary action per print asset and a caption link per social export", () => {
    for (const asset of [copy.banner, copy.studios, copy.instructors, copy.organizers, copy.dancers]) {
      expect(typeof asset.cta).toBe("string");
      expect(asset.cta.length).toBeGreaterThan(0);
      expect(asset.link.medium).toBe("qr");
    }
    expect(copy.social.links).toHaveLength(4);
    for (const l of copy.social.links) expect(l.medium).toBe("social");
  });

  it("keeps the event-presence field a replaceable placeholder, not a real event", () => {
    expect(copy.social.event.eventField).toBe("{event}");
    expect(copy.social.event.lead).toBe("Find DanceFlow at");
  });
});

describe("BR-5 collateral claims guard (locked launch restrictions)", () => {
  const rules: Array<[string, RegExp]> = [
    ["featured events / promoted placement", /featured events?|boost(ed|ing)?\b|promoted (event|placement)|sponsored (event|placement)|premium (placement|ranking)|curated featured/i],
    ["algorithmic partner matching", /partner match|algorithm|compatib|smart match|ai[- ]match|matching (technology|engine)|guaranteed (match|connection)|find (a|your) (perfect )?match|rapid/i],
    ["free forever", /free forever/i],
    ["SOC 2", /soc\s?-?2/i],
    ["competition OS", /\bjudg(e|es|ing)\b|\bscoring\b|live heat|heat management|\bawards?\b|competition (management|os|platform|software|results)/i],
    ["ARIA autonomy", /runs? (your|the) (entire|whole) (studio|business)|fully autonomous|autopilot|hands[- ]free|decides for you|on its own for you/i],
    ["hardcoded trial / price / founder", /\b\d+[- ]day\b|\$\s?\d|\bfounder|\bfirst \d+ (studios|organizers)\b|\d+\s?%\s?off|per month|\/mo\b/i],
    ["stale vocabulary", /DanceFlow Discovery|DanceFlow Organizer Workspace|DanceFlow Workspace|Studio Portal|Dance Flow\b/],
  ];
  for (const [name, re] of rules) {
    it(`contains no ${name} wording`, () => {
      expect(allText.match(re)).toBeNull();
    });
  }

  it("describes ARIA only as suggesting, with the owner in control", () => {
    expect(allText).toContain("then suggests the next step");
    expect(allText).toContain("always stay with you");
  });
});

describe("BR-5 QR and caption URLs", () => {
  const links: Array<[string, Link]> = [
    ["banner", copy.banner.link],
    ["studios", copy.studios.link],
    ["instructors", copy.instructors.link],
    ["organizers", copy.organizers.link],
    ["dancers", copy.dancers.link],
    ...copy.social.links.map((l): [string, Link] => [`social:${l.name}`, l]),
  ];
  const destinations: Record<string, string> = {
    banner: "/",
    studios: "/for-studios",
    instructors: "/for-instructors",
    organizers: "/for-organizers",
    dancers: "/discover",
  };

  for (const [name, link] of links) {
    it(`${name}: valid destination and attribution survives the site parser`, () => {
      const url = lib.buildUrl(copy.meta, link);
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://www.idanceflow.com");
      if (destinations[name]) expect(parsed.pathname).toBe(destinations[name]);
      expect(["/", "/for-studios", "/for-instructors", "/for-organizers", "/discover"]).toContain(parsed.pathname);
      expect(parsed.pathname).not.toMatch(/get-started|signup|login/);
      const keys = [...parsed.searchParams.keys()].sort();
      expect(keys).toEqual(["utm_campaign", "utm_content", "utm_medium", "utm_source"]);
      const parsedAttribution = parseAttributionParams(parsed.searchParams);
      expect(parsedAttribution).toEqual(Object.fromEntries(parsed.searchParams.entries()));
      expect(parsedAttribution.utm_campaign).toBe("br5-launch");
      expect(url).not.toMatch(/@|%40/);
    });
  }

  it("print QR codes stay compact enough to print small", () => {
    for (const [name, link] of links.filter(([n]) => !n.startsWith("social"))) {
      expect(lib.buildQr(lib.buildUrl(copy.meta, link)).modules, name).toBeLessThanOrEqual(53);
    }
  });

  it("rejects unsafe attribution values", () => {
    expect(() => lib.buildUrl(copy.meta, { ...copy.banner.link, content: "a@b.com" })).toThrow();
    expect(() => lib.buildUrl(copy.meta, { ...copy.banner.link, source: "https://x.test" })).toThrow();
  });
});

describe("BR-5 templates stay static", () => {
  const dir = join(COLLATERAL, "templates");
  for (const file of readdirSync(dir)) {
    it(`${file} has no scripts, forms or external requests`, () => {
      const text = read(dir, file);
      expect(text).not.toMatch(/<script|<form|<input|<iframe|@import|https?:\/\//i);
    });
  }

  it("keeps print masters out of public/", () => {
    expect(existsSync(join(ROOT, "public", "brand", "collateral"))).toBe(false);
  });
});

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("BR-5 committed exports", () => {
  it("social exports are exact pixel sizes", () => {
    const expected: Record<string, [number, number]> = {
      "df-social-awareness-square-v1.png": [1080, 1080],
      "df-social-event-square-v1.png": [1080, 1080],
      "df-social-awareness-story-v1.png": [1080, 1920],
      "df-social-event-story-v1.png": [1080, 1920],
    };
    for (const [file, size] of Object.entries(expected)) expect(pngSize(join(EXPORTS, "social", file)), file).toEqual(size);
  });

  it("print PDFs have the documented page size, page count and trim/bleed boxes", async () => {
    const specs: Array<[string, string, number, number, number, number]> = [
      ["print", "df-sheet-studios-letter-v1.pdf", 2, 8.5, 11, 0.125],
      ["print", "df-sheet-instructors-letter-v1.pdf", 2, 8.5, 11, 0.125],
      ["print", "df-sheet-organizers-letter-v1.pdf", 2, 8.5, 11, 0.125],
      ["print", "df-card-dancers-4x6-v1.pdf", 2, 4, 6, 0.125],
      ["review", "df-banner-booth-33x81-v1-vendor-neutral-master.pdf", 1, 33, 81, 0.5],
    ];
    for (const [sub, file, pages, trimW, trimH, bleed] of specs) {
      const doc = await PDFDocument.load(readFileSync(join(EXPORTS, sub, file)));
      expect(doc.getPageCount(), file).toBe(pages);
      const page = doc.getPage(0);
      const { width, height } = page.getSize();
      expect(width / 72, file).toBeCloseTo(trimW + 2 * bleed, 3);
      expect(height / 72, file).toBeCloseTo(trimH + 2 * bleed, 3);
      const trim = page.getTrimBox();
      expect(trim.width / 72, file).toBeCloseTo(trimW, 3);
      expect(trim.height / 72, file).toBeCloseTo(trimH, 3);
    }
  });

  it("labels the banner as a vendor-neutral master, not a printer-ready file", async () => {
    const dir = join(EXPORTS, "review");
    expect(existsSync(join(dir, "df-banner-booth-33x81-v1-vendor-neutral-master.pdf"))).toBe(true);
    expect(existsSync(join(EXPORTS, "print", "df-banner-booth-33x81-v1.pdf"))).toBe(false);
    const doc = await PDFDocument.load(readFileSync(join(dir, "df-banner-booth-33x81-v1-vendor-neutral-master.pdf")));
    expect(doc.getSubject()).toContain("VENDOR-NEUTRAL MASTER - FINAL PRINTER FIT PENDING");
  });

  it("builder QA recorded no layout issues and met the QR and image minimums", () => {
    const report = JSON.parse(read(EXPORTS, "BUILD_REPORT.json")) as {
      qa: Record<string, string[]>;
      qr: Record<string, { symbolIn: number; moduleMm: number; centreFromTrimBottomIn?: number }>;
      images: Record<string, { effectiveDpi?: number; minDpi?: number }>;
      pdfs: Record<string, { embedded: boolean; fonts: string[] }>;
    };
    for (const [name, issues] of Object.entries(report.qa)) expect(issues, name).toEqual([]);
    expect(report.qr["df-banner-booth-33x81-v1"].symbolIn).toBeGreaterThanOrEqual(4.5);
    expect(report.qr["df-banner-booth-33x81-v1"].centreFromTrimBottomIn).toBeGreaterThanOrEqual(36);
    expect(report.qr["df-banner-booth-33x81-v1"].centreFromTrimBottomIn).toBeLessThanOrEqual(54);
    for (const key of ["studios", "instructors", "organizers"]) expect(report.qr[`df-sheet-${key}-letter-v1`].symbolIn).toBeGreaterThanOrEqual(1.1);
    expect(report.qr["df-card-dancers-4x6-v1"].symbolIn).toBeGreaterThanOrEqual(1.0);
    for (const q of Object.values(report.qr)) expect(q.moduleMm).toBeGreaterThanOrEqual(0.4);
    const photo = report.images["df-card-dancers-4x6-v1"];
    expect(photo.effectiveDpi).toBeGreaterThanOrEqual(photo.minDpi ?? 300);
    for (const [name, pdf] of Object.entries(report.pdfs)) {
      expect(pdf.embedded, name).toBe(true);
      expect(pdf.fonts.length, name).toBeGreaterThan(0);
    }
  });
});
