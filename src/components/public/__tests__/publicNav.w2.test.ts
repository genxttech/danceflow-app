import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_NAV_CHILDREN,
  DANCER_NAV_CHILDREN,
  PUBLIC_AUTH_ACTIONS,
  PUBLIC_NAV_ITEMS,
  activePublicNavKey,
  isCurrentPublicNavChild,
} from "../publicNav";

/** W-2: two-audience public navigation, distinct account vs trial actions, public signup. */
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const exists = (...p: string[]) => existsSync(join(ROOT, ...p));

const header = read("src", "components", "public", "PublicSiteHeader.tsx");
const links = read("src", "components", "public", "PublicNavLinks.tsx");
const menu = read("src", "components", "public", "AudienceMenu.tsx");
const mobile = read("src", "components", "public", "PublicMobileMenu.tsx");
const footer = read("src", "components", "public", "PublicSiteFooter.tsx");
const signupPage = read("src", "app", "(auth)", "signup", "page.tsx");
const publicSignup = read("src", "app", "(auth)", "signup", "PublicSignup.tsx");

describe("nav model", () => {
  it("For Dancers comes before For Business, and there is no /for-dancers route", () => {
    expect(PUBLIC_NAV_ITEMS[0].label).toBe("For Dancers");
    expect(PUBLIC_NAV_ITEMS[1].label).toBe("For Business");
    expect(JSON.stringify(PUBLIC_NAV_ITEMS)).not.toContain("/for-dancers");
    expect(exists("src", "app", "for-dancers")).toBe(false);
  });

  it("every grouped destination is a real route", () => {
    for (const child of [...DANCER_NAV_CHILDREN, ...BUSINESS_NAV_CHILDREN]) {
      const path = child.href.split("#")[0];
      expect(exists("src", "app", ...path.split("/").filter(Boolean), "page.tsx"), child.href).toBe(true);
    }
  });

  it("separates the business audiences from plans with a divider", () => {
    expect(BUSINESS_NAV_CHILDREN.find((c) => c.dividerBefore)?.label).toBe("Plans & free trial");
    expect(menu).toContain("dividerBefore");
    expect(links).toContain("dividerBefore");
  });

  it("maps dancer surfaces to For Dancers", () => {
    for (const p of ["/discover", "/discover/classes", "/marketplace", "/marketplace/x", "/studios/a", "/events/b"]) {
      expect(activePublicNavKey(p), p).toBe("discover");
    }
    expect(activePublicNavKey("/studios-and-more")).toBeNull();
  });

  it("hash links are never the current page", () => {
    expect(isCurrentPublicNavChild("/for-studios", "/for-studios#meet-aria")).toBe(false);
    expect(isCurrentPublicNavChild("/for-studios", "/for-studios")).toBe(true);
  });
});

describe("signed-out actions", () => {
  it("account creation and the business trial are distinct actions", () => {
    expect(PUBLIC_AUTH_ACTIONS.createAccount.href).toBe("/signup?intent=public");
    expect(PUBLIC_AUTH_ACTIONS.startTrial).toEqual({ label: "Start free trial", href: "/get-started/studio" });
    expect(PUBLIC_AUTH_ACTIONS.createAccount.href).not.toBe(PUBLIC_AUTH_ACTIONS.startTrial.href);
  });

  it("the trial shows in the bar only from lg; the menu carries both full-width buttons", () => {
    expect(header).toContain("hidden lg:inline-flex ${trialAction}");
    expect(header.match(/PUBLIC_AUTH_ACTIONS\.startTrial\.href/g)).toHaveLength(2);
    expect(header.match(/block w-full/g)).toHaveLength(2);
  });

  it("does not link to the bare /signup that bounces to /login", () => {
    expect(header).not.toMatch(/href="\/signup"/);
    expect(footer).not.toMatch(/href="\/signup"/);
  });
});

describe("menus", () => {
  it("the audience disclosure closes on same-page link clicks too", () => {
    expect(menu).toContain("onClick={() => setOpenedAt(null)}");
    expect(mobile).toContain('closest("a")');
  });

  it("the mobile panel groups are labelled and scroll within the viewport", () => {
    expect(links).toContain('role="group"');
    expect(links).toContain("aria-labelledby={headingId}");
    expect(mobile).toContain("overflow-y-auto");
  });

  it("the old ForBusinessMenu is gone", () => {
    expect(exists("src", "components", "public", "ForBusinessMenu.tsx")).toBe(false);
  });
});

describe("footer", () => {
  it("renames Explore to For Dancers, adds Classes and Plans & free trial", () => {
    expect(footer).not.toContain(">Explore</p>");
    expect(footer).toContain(">For Dancers</p>");
    expect(footer).toContain('href="/discover/classes"');
    expect(footer).toContain(">Plans &amp; free trial</Link>");
  });
});

describe("public signup", () => {
  it("renders the dancer signup for an explicit public intent instead of bouncing", () => {
    expect(signupPage).toContain('if (signupIntent === "public")');
    expect(signupPage).toContain("<PublicSignup");
    expect(signupPage).toContain("if (!signupIntent)");
  });

  it("posts the public intent to the existing signup action", () => {
    expect(publicSignup).toContain('name="signupIntent" value="public"');
    expect(publicSignup).toContain('name="fullName"');
    expect(publicSignup).toContain('name="email"');
    expect(publicSignup).toContain("/get-started/studio");
    expect(publicSignup).not.toMatch(/partner match|algorithm|autonomous|featured/i);
  });
});
