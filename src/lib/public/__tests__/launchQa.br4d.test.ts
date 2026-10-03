import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** BR-4D: final public-site QA guards (empty state, trust surfaces, accessibility mechanics). */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const exists = (...parts: string[]) => existsSync(join(ROOT, ...parts));

describe("Discover empty state", () => {
  const discover = read("src", "app", "discover", "page.tsx");

  it("no longer reads as an unreleased feature", () => {
    expect(discover).not.toContain("Studios coming soon");
    expect(discover).not.toContain("will appear here as studios publish");
  });

  it("says what is true and offers obvious next steps to real destinations", () => {
    expect(discover).toContain("No studio profiles to show right now");
    expect(discover).toContain("Studios appear here when they publish a public profile.");
    for (const href of ["/discover/studios", "/discover/events"]) {
      expect(discover).toContain(`href="${href}"`);
      expect(exists("src", "app", ...href.split("/").filter(Boolean), "page.tsx")).toBe(true);
    }
    expect(discover).toContain("Browse all studios");
    expect(discover).toContain("Explore events");
  });
});

describe("trust surfaces on every public page", () => {
  const footer = read("src", "components", "public", "PublicSiteFooter.tsx");

  it("the shared footer keeps Privacy, Terms, Security, support contact and the business identity line", () => {
    for (const href of ["/privacy", "/terms", "/security"]) expect(footer).toContain(`href="${href}"`);
    expect(footer).toContain("mailto:support@idanceflow.com");
    expect(footer).toContain("DanceFlow is a software platform owned and operated by GenX TotalTech LLC.");
  });

  it("the new audience pages and the homepage use the shared chrome (header and footer)", () => {
    for (const route of ["for-studios", "for-instructors", "for-organizers"]) {
      expect(read("src", "app", route, "page.tsx")).toContain("<PublicShell");
    }
    const home = read("src", "app", "page.tsx");
    expect(home).toContain("<PublicSiteHeader");
    expect(home).toContain("<PublicSiteFooter");
  });

  it("each audience page and the homepage offer a support contact path", () => {
    expect(read("src", "components", "public", "audience", "AudienceParts.tsx")).toContain("Questions? Talk to us");
    expect(read("src", "lib", "public", "audienceCopy.ts")).toContain("mailto:support@idanceflow.com");
    expect(read("src", "lib", "public", "homeCopy.ts")).toContain("mailto:support@idanceflow.com");
  });

  it("makes no compliance-certification claim anywhere on the public launch sources", () => {
    for (const parts of [
      ["src", "app", "page.tsx"],
      ["src", "lib", "public", "homeCopy.ts"],
      ["src", "lib", "public", "audienceCopy.ts"],
      ["src", "app", "get-started", "page.tsx"],
      ["src", "components", "public", "PublicSiteFooter.tsx"],
    ]) {
      expect(read(...parts), parts.join("/")).not.toMatch(/soc\s?-?2|certified|compliant with/i);
    }
  });

  it("the sitemap lists the public launch pages", () => {
    const sitemap = read("src", "app", "sitemap.ts");
    for (const route of ["for-studios", "for-instructors", "for-organizers", "get-started"]) {
      expect(sitemap).toContain(`/${route}\``);
    }
  });
});

describe("accessibility mechanics of the BR-4 surfaces", () => {
  const menu = read("src", "components", "public", "ForBusinessMenu.tsx");
  const parts = read("src", "components", "public", "audience", "AudienceParts.tsx");

  it("For Business is a disclosure: aria-expanded/controls, Escape with focus return, outside click, route close", () => {
    expect(menu).toContain("aria-expanded");
    expect(menu).toContain("aria-controls");
    expect(menu).toContain('"Escape"');
    expect(menu).toContain("triggerRef.current?.focus()");
    expect(menu).toContain("mousedown");
    expect(menu).toContain("usePathname");
    expect(menu).not.toContain('role="menu"');
  });

  it("expandable rows use native details/summary with a visible focus style", () => {
    expect(parts).toContain("<details");
    expect(parts).toContain("<summary");
    expect(parts).toContain("focus-visible:outline");
  });

  it("every audience page has exactly one H1 (in the shared hero) and no skipped heading levels in source", () => {
    expect(parts.match(/<h1\b/g)).toHaveLength(1);
    for (const route of ["for-studios", "for-instructors", "for-organizers"]) {
      const page = read("src", "app", route, "page.tsx");
      expect(page, route).not.toMatch(/<h1\b/);
      expect(page, route).not.toMatch(/<h4\b/);
      // h3 only appears under an h2 section on these pages
      if (/<h3\b/.test(page)) expect(page.indexOf("<h2")).toBeLessThan(page.indexOf("<h3"));
    }
    expect(read("src", "app", "page.tsx").match(/<h1\b/g)).toHaveLength(1);
  });

  it("decorative icons and numerals are hidden from assistive technology", () => {
    expect(parts).toContain('aria-hidden="true"');
    expect(read("src", "app", "for-organizers", "page.tsx")).toContain('aria-hidden="true"');
  });

  it("the audience switcher names its landmark and marks the current page", () => {
    expect(parts).toContain('aria-label="DanceFlow audiences"');
    expect(parts).toContain('aria-current={link.key === active ? "page" : undefined}');
  });
});

describe("eyebrow text contrast", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("the small uppercase eyebrows use a colour that meets 4.5:1 on white and on the cream hero wash", () => {
    const home = read("src", "app", "page.tsx");
    const parts = read("src", "components", "public", "audience", "AudienceParts.tsx");
    for (const source of [home, parts]) {
      expect(source).toContain("uppercase tracking-[0.18em] text-[#9a5a10]");
      expect(source).not.toContain("tracking-[0.18em] text-[var(--brand-accent-dark)]");
    }
    expect(contrast("#9a5a10", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#9a5a10", "#fff7ed")).toBeGreaterThanOrEqual(4.5);
  });
});
