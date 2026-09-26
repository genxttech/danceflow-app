import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_NAV_ITEMS, activePublicNavKey } from "../publicNav";

/** Branding Relaunch BR-2B: shared public/auth/legal shell source guards and nav mechanics. */
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const header = read("src", "components", "public", "PublicSiteHeader.tsx");
const footer = read("src", "components", "public", "PublicSiteFooter.tsx");
const shell = read("src", "components", "public", "PublicShell.tsx");
const menu = read("src", "components", "public", "PublicMobileMenu.tsx");

const shellPages: string[][] = [
  ...[
    "terms",
    "privacy",
    "dpa",
    "acceptable-use",
    "electronic-signature-consent",
    "refund-policy",
    "security",
    "sms-consent",
  ].map((p) => ["src", "app", p, "page.tsx"]),
  ["src", "app", "(auth)", "login", "page.tsx"],
  ["src", "app", "(auth)", "signup", "page.tsx"],
  ["src", "app", "reset-password", "page.tsx"],
];

describe("header branding", () => {
  it("uses only BR-1 logo assets", () => {
    expect(header).toContain("/brand/logo/danceflow-symbol-128.png");
    expect(header).toContain("/brand/logo/danceflow-logo-primary-640.png");
    expect(header).not.toMatch(/\/brand\/danceflow-logo\.png/);
    expect(header + footer).not.toMatch(/monogram|df-mark|rev3|revision-?3/i);
  });

  it("drops redundant wordmark text and tagline", () => {
    expect(header).not.toContain("Studio software + public discovery");
    expect(header).not.toMatch(/>\s*DanceFlow\s*</);
    expect(header).not.toContain("uppercase tracking");
  });

  it("keeps auth actions and destinations", () => {
    for (const s of [
      "Log In",
      "Create Free Account",
      "Go to Workspace",
      "My Account",
      "/login?intent=public",
      "/signup",
      "/app",
      "/account",
    ]) {
      expect(header).toContain(s);
    }
  });
});

describe("footer", () => {
  it("has the approved mission and relationship line verbatim", () => {
    expect(footer).toContain("DanceFlow helps run the studio, so you can focus on teaching.");
    expect(footer).toContain(
      "DanceFlow is a software platform owned and operated by GenX TotalTech LLC.",
    );
    expect(footer).not.toContain("so owners can focus");
  });

  it("normalizes labels and keeps legal destinations", () => {
    expect(footer).not.toContain("Discovery Home");
    expect(footer).toContain(">Discover</Link>");
    expect(footer).toContain("Create Free Account");
    for (const h of [
      "/terms",
      "/privacy",
      "/acceptable-use",
      "/dpa",
      "/electronic-signature-consent",
      "/sms-consent",
      "/refund-policy",
      "/security",
    ]) {
      expect(footer).toContain(`href="${h}"`);
    }
  });
});

describe("PublicShell", () => {
  it("resolves auth via the shared helper unless overridden and imposes no layout", () => {
    expect(shell).toContain("getPublicAuthState");
    expect(shell).toContain("isAuthenticated ??");
    expect(shell).not.toMatch(/max-w-|className|px-\d/);
  });

  it("auth helper does not swallow exceptions", () => {
    const helper = read("src", "lib", "public", "authState.ts");
    expect(helper).not.toMatch(/\btry\b|\bcatch\b/);
    expect(helper).toContain("cache(");
  });
});

describe("mobile menu accessibility", () => {
  it("wires aria-expanded/aria-controls, Escape focus return, outside click and route close", () => {
    expect(menu).toContain("aria-expanded");
    expect(menu).toContain("aria-controls");
    expect(menu).toContain('"Escape"');
    expect(menu).toContain("triggerRef.current?.focus()");
    expect(menu).toContain("mousedown");
    expect(menu).toContain("usePathname");
  });
});

describe("routes use the shared shell", () => {
  it.each(shellPages.map((p) => [p.slice(2).join("/"), p]))(
    "%s uses PublicShell and no hard-coded signed-out header",
    (_name, parts) => {
      const src = read(...(parts as string[]));
      expect(src).toContain("<PublicShell>");
      expect(src).not.toMatch(/PublicSiteHeader|PublicSiteFooter|isAuthenticated=\{false\}/);
    },
  );

  it("discover pages no longer render their own header/footer; layout owns chrome", () => {
    for (const d of ["studios", "events", "jobs", "partners"]) {
      expect(read("src", "app", "discover", d, "page.tsx")).not.toMatch(
        /PublicSiteHeader|PublicSiteFooter/,
      );
    }
    const layout = read("src", "app", "discover", "layout.tsx");
    expect(layout).toContain("PublicShell");
    expect(layout).toContain("DiscoverSubNav");
    expect(layout).not.toContain("DanceFlow Discovery");
    expect(read("src", "components", "public", "DiscoverSubNav.tsx")).not.toContain(
      "DanceFlow Discovery",
    );
  });

  it("marketplace and knowledgebase layouts are shell-only", () => {
    for (const d of ["marketplace", "knowledgebase"]) {
      const src = read("src", "app", d, "layout.tsx");
      expect(src).toContain("<PublicShell>{children}</PublicShell>");
      expect(src).not.toMatch(/max-w-|className|padding/);
    }
  });

  it("explorer uses the shell with the known signed-in state", () => {
    expect(read("src", "app", "get-started", "explorer", "page.tsx")).toContain(
      "<PublicShell isAuthenticated>",
    );
  });
});

describe("nav mechanics", () => {
  it("preserves destinations and only shows account items when signed in", () => {
    const pub = PUBLIC_NAV_ITEMS.filter((i) => !i.authOnly).map((i) => [i.label, i.href]);
    expect(pub).toEqual([
      ["Home", "/"],
      ["Discover", "/discover"],
      ["Studios", "/discover/studios"],
      ["Events", "/discover/events"],
      ["Marketplace", "/marketplace"],
      ["Pricing", "/get-started"],
    ]);
    expect(PUBLIC_NAV_ITEMS.filter((i) => i.authOnly).map((i) => i.label)).toEqual([
      "Favorites",
      "Account",
    ]);
  });

  it("derives the active item from the pathname", () => {
    expect(activePublicNavKey("/")).toBe("home");
    expect(activePublicNavKey("/discover")).toBe("discover");
    expect(activePublicNavKey("/discover/studios")).toBe("studios");
    expect(activePublicNavKey("/studios/some-studio")).toBe("studios");
    expect(activePublicNavKey("/discover/events")).toBe("events");
    expect(activePublicNavKey("/events/x")).toBe("events");
    expect(activePublicNavKey("/marketplace/abc")).toBe("marketplace");
    expect(activePublicNavKey("/get-started/studio")).toBe("pricing");
    expect(activePublicNavKey("/terms")).toBeNull();
    expect(activePublicNavKey("/discover/jobs")).toBeNull();
  });
});
