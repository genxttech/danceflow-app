import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Branding Relaunch BR-2D: durable shell accessibility guards (skip links, landmarks, heading semantics). */
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const skipLink = read("src", "components", "shell", "SkipToMainLink.tsx");
const publicHeader = read("src", "components", "public", "PublicSiteHeader.tsx");
const appShell = read("src", "app", "app", "AppSidebarShell.tsx");
const chrome = read("src", "components", "app", "sidebar", "AppShellChrome.tsx");
const platformLayout = read("src", "app", "platform", "layout.tsx");
const platformNav = read("src", "app", "platform", "PlatformAdminNav.tsx");
const portalLayout = read("src", "app", "portal", "[studioSlug]", "layout.tsx");
const kbLayout = read("src", "app", "knowledgebase", "layout.tsx");

const count = (src: string, needle: string | RegExp) =>
  src.match(typeof needle === "string" ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : needle)?.length ?? 0;

function pageFiles(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pageFiles(p, out);
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

describe("SkipToMainLink", () => {
  it("has the exact text and target and is hidden until focused", () => {
    expect(skipLink).toContain('href="#main-content"');
    expect(skipLink).toContain("Skip to main content");
    expect(skipLink).toContain("sr-only");
    expect(skipLink).toContain("focus:not-sr-only");
  });
});

describe("public shell skip link", () => {
  it("PublicSiteHeader renders one skip link and one #main-content target", () => {
    expect(count(publicHeader, "<SkipToMainLink")).toBe(1);
    expect(count(publicHeader, 'id="main-content"')).toBe(1);
    expect(publicHeader).toContain("tabIndex={-1}");
    // no DOM-query / scripted fallbacks
    expect(publicHeader).not.toMatch(/querySelector|scrollIntoView|getElementById/);
  });

  it("no page defines its own #main-content (target stays unique per route)", () => {
    const pages = pageFiles(join(ROOT, "src", "app"));
    for (const file of pages) {
      const src = readFileSync(file, "utf8");
      expect(src.includes('id="main-content"'), file).toBe(false);
    }
  });
});

describe("studio app shell", () => {
  it("has one skip link and the main id", () => {
    expect(count(appShell, "<SkipToMainLink")).toBe(1);
    expect(appShell).toMatch(/<main id="main-content" tabIndex=\{-1\}/);
    expect(count(appShell, "<main")).toBe(1);
  });

  it("labels the sidebar aside and the navigation landmarks (desktop + drawer)", () => {
    expect(chrome).toContain('aria-label="Workspace sidebar"');
    expect(count(chrome, '<nav aria-label="Workspace"')).toBe(2);
    // BR-2C drawer focus behavior preserved
    expect(chrome).toContain("nextFocusIndex(");
    expect(chrome).toContain("closeButtonRef.current?.focus()");
    expect(chrome).toContain('aria-modal="true"');
  });
});

describe("platform shell", () => {
  it("has one skip link and the main id", () => {
    expect(count(platformLayout, "<SkipToMainLink")).toBe(1);
    expect(platformLayout).toMatch(/<main id="main-content" tabIndex=\{-1\}/);
  });

  it("shows 'Platform Admin' as a context label but adds no shell <h1>", () => {
    expect(platformLayout).toContain("Platform Admin");
    expect(platformLayout).not.toMatch(/<h1[\s>]/);
    expect(platformLayout).toContain('alt="DanceFlow"');
  });

  it("keeps the header sticky only from lg and gives main a scroll margin", () => {
    const header = platformLayout.match(/<header className="([^"]*)"/)?.[1] ?? "";
    expect(header.split(/\s+/)).not.toContain("sticky");
    expect(header.split(/\s+/)).not.toContain("top-0");
    expect(header).toContain("lg:sticky");
    expect(header).toContain("lg:top-0");
    const main = platformLayout.match(/<main id="main-content"[^>]*className="([^"]*)"/)?.[1] ?? "";
    expect(main.split(/\s+/)).toContain("scroll-mt-28");
  });

  it("labels the platform nav", () => {
    expect(platformNav).toContain('aria-label="Platform sections"');
  });
});

describe("portal shell", () => {
  it("has one skip link and the main id", () => {
    expect(count(portalLayout, "<SkipToMainLink")).toBe(1);
    expect(portalLayout).toContain('id="main-content"');
    expect(count(portalLayout, "<main")).toBe(1);
  });
});

describe("knowledgebase shell", () => {
  it("wraps content in a semantic main with no geometry classes", () => {
    expect(kbLayout).toMatch(/<main>\{[a-z]+\}<\/main>/);
    expect(kbLayout).not.toMatch(/max-w-|className|padding|px-\d|py-\d/);
  });

  it("knowledgebase pages define no <main> of their own (no nesting)", () => {
    for (const file of pageFiles(join(ROOT, "src", "app", "knowledgebase"))) {
      expect(readFileSync(file, "utf8").includes("<main"), file).toBe(false);
    }
  });
});
