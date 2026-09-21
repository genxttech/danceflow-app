import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "../AppShellChrome";

/** Branding Relaunch BR-2C: app / platform / portal shell source guards and focus-loop logic. */
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const chrome = read("src", "components", "app", "sidebar", "AppShellChrome.tsx");
const switcher = read("src", "components", "app", "sidebar", "WorkspaceSwitcher.tsx");
const navSection = read("src", "components", "app", "sidebar", "SidebarNavSection.tsx");
const appShell = read("src", "app", "app", "AppSidebarShell.tsx");
const platformLayout = read("src", "app", "platform", "layout.tsx");
const platformNav = read("src", "app", "platform", "PlatformAdminNav.tsx");
const portalLayout = read("src", "app", "portal", "[studioSlug]", "layout.tsx");
const css = read("src", "app", "globals.css");

const shells = { chrome, switcher, navSection, appShell, platformLayout, platformNav, portalLayout };

describe("brand assets", () => {
  it("shells never reference the old padded master, a DF monogram or Revision 3", () => {
    for (const [name, src] of Object.entries(shells)) {
      expect(src, name).not.toMatch(/\/brand\/danceflow-logo\.png/);
      expect(src, name).not.toMatch(/monogram|df-mark|rev3|revision-?3/i);
    }
  });

  it("uses the approved BR-1 variants per surface", () => {
    expect(chrome).toContain("/brand/logo/danceflow-logo-primary-white.png"); // dark sidebar
    expect(chrome).toContain("/brand/logo/danceflow-logo-primary-320.png"); // light drawer
    expect(chrome).toContain("/brand/logo/danceflow-symbol-128.png"); // constrained topbar
    expect(platformLayout).toContain("/brand/logo/danceflow-logo-primary-320.png");
    expect(portalLayout).toContain("/brand/logo/danceflow-symbol-128.png");
  });

  it("uses one logo with alt=DanceFlow and no redundant adjacent brand text", () => {
    expect(chrome).not.toContain('alt="DanceFlow logo"');
    expect(chrome).not.toMatch(/>\s*DanceFlow\s*</);
    expect(chrome).not.toMatch(/<h[12][^>]*>\s*\{studioName\}/);
    expect(platformLayout).toContain('alt="DanceFlow"');
    expect(platformLayout).not.toContain("DanceFlow Platform");
    expect(platformLayout).not.toMatch(/>\s*DanceFlow\s*</);
    expect(platformLayout).toContain("Platform Admin");
    expect(platformLayout).not.toMatch(/<h1[\s>]/); // BR-2D: shell context is a non-heading; pages own the h1
    expect(chrome).toContain('href="/app"');
  });
});

describe("tokens", () => {
  it("removes approved legacy hard-coded values from touched shells", () => {
    for (const [name, src] of Object.entries(shells)) {
      expect(src, name).not.toContain("#FFDCA9");
      expect(src, name).not.toContain("#111b45");
    }
    expect(platformLayout).not.toMatch(/violet-/);
    expect(platformNav).not.toMatch(/violet-/);
  });
});

describe("accessibility", () => {
  it("hamburger and workspace trigger expose expanded/controls state", () => {
    expect(chrome).toMatch(/aria-expanded=\{open\}/);
    expect(chrome).toContain("aria-controls={MOBILE_DRAWER_ID}");
    expect(chrome).toContain("id={MOBILE_DRAWER_ID}");
    expect(switcher).toMatch(/aria-expanded=\{open\}/);
    expect(switcher).toContain("aria-controls={panelId}");
    expect(switcher).toContain("id={panelId}");
    expect(navSection).toContain("aria-expanded={open}");
    expect(navSection.match(/aria-current/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("workspace switcher has a state-changing chevron, Escape close and focus return", () => {
    expect(switcher).toContain("ChevronDown");
    expect(switcher).toContain("ChevronRight");
    expect(switcher).not.toContain("ChevronsUpDown");
    expect(switcher).toContain('"Escape"');
    expect(switcher).toContain("triggerRef.current?.focus()");
    // switching behavior untouched
    expect(switcher).toContain("await switchWorkspaceAction(formData);");
  });

  it("modal drawer contains focus and restores it to the hamburger", () => {
    expect(chrome).toContain('role="dialog"');
    expect(chrome).toContain('aria-modal="true"');
    expect(chrome).toContain("closeButtonRef.current?.focus()");
    expect(chrome).toContain("nextFocusIndex(");
    expect(chrome).toContain('event.key !== "Tab"');
    expect(chrome).toContain('aria-label="Close navigation"');
    expect(chrome).not.toContain("Close navigation backdrop");
    expect(appShell).toContain("menuButtonRef.current?.focus()");
    expect(appShell).toContain("onClose={closeMobile}");
  });

  it("nav and shell controls have visible focus treatment", () => {
    expect(css).toContain(".brand-nav-idle:focus-visible");
    expect(css).toContain(".brand-nav-active:focus-visible");
    expect(navSection).toContain("focus-visible:outline");
    expect(platformNav).toContain("focus-visible:outline");
    expect(switcher).toContain("focus-visible:outline");
  });
});

describe("nextFocusIndex (drawer focus loop)", () => {
  it("wraps Tab from the last focusable to the first", () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, false)).toBe(1);
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(nextFocusIndex(2, 3, true)).toBe(1);
  });

  it("stays on the only focusable item", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });

  it("returns -1 when there is nothing to focus", () => {
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });

  it("enters the loop from outside (focus not in the list)", () => {
    expect(nextFocusIndex(-1, 4, false)).toBe(0);
    expect(nextFocusIndex(-1, 4, true)).toBe(3);
  });
});

describe("portal shell", () => {
  it("reads studio identity fields and falls back from public_name to name", () => {
    expect(portalLayout).toContain('.select("id, slug, name, public_name, public_logo_url")');
    expect(portalLayout).toMatch(/public_name\?\.trim\(\) \|\| studio\.name/);
  });

  it("renders the studio logo with a plain img (repo convention) and an initial fallback", () => {
    expect(portalLayout).toContain("@next/next/no-img-element");
    expect(portalLayout).toMatch(/<img\s/);
    expect(portalLayout).toContain("studioInitial");
    // the local DanceFlow symbol is the only next/image use
    expect(portalLayout.match(/<Image/g)?.length).toBe(1);
  });

  it("does not need a next.config image host change", () => {
    const config = read("next.config.ts");
    expect(config).not.toMatch(/remotePatterns|images\s*:/);
  });

  it("header is non-sticky", () => {
    const header = portalLayout.slice(portalLayout.indexOf("<header"), portalLayout.indexOf("</header>"));
    expect(header).not.toMatch(/sticky|fixed/);
  });
});
