import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

import PublicStudioTabs from "../PublicStudioTabs";
import { decodeHashId, resolveDeepLinkTab } from "../deepLink";

/**
 * SMS-A2P-3C: /studios/{slug}#lead must open the Contact tab (which holds the lead form
 * and SMS opt-in) instead of leaving it hidden behind the default tab.
 */

const TABS = ["overview", "about", "dance-styles", "staff", "offerings", "events", "contact"] as const;

/** Models the page DOM: ids -> the tab declared by their panel (`data-studio-tab`). */
function dom(map: Record<string, string | null>) {
  return (id: string) => (id in map ? { panelTab: map[id] } : null);
}

const PANELS = {
  overview: "overview",
  about: "about",
  staff: "staff",
  lead: "contact",
  contact: "contact",
};

describe("resolveDeepLinkTab", () => {
  it("no hash leaves the normal default behavior unchanged", () => {
    expect(resolveDeepLinkTab("", "overview", dom(PANELS), TABS)).toBeNull();
    expect(resolveDeepLinkTab(null, "overview", dom(PANELS), TABS)).toBeNull();
    expect(resolveDeepLinkTab("#", "overview", dom(PANELS), TABS)).toBeNull();
  });

  it("#lead on the default tab selects Contact", () => {
    expect(resolveDeepLinkTab("#lead", "overview", dom(PANELS), TABS)).toBe("contact");
  });

  it("#lead when Contact is already active changes nothing", () => {
    expect(resolveDeepLinkTab("#lead", "contact", dom(PANELS), TABS)).toBeNull();
  });

  it("is generic: any panel hash opens its own tab", () => {
    expect(resolveDeepLinkTab("#staff", "overview", dom(PANELS), TABS)).toBe("staff");
    expect(resolveDeepLinkTab("#about", "contact", dom(PANELS), TABS)).toBe("about");
  });

  it("ignores hashes that are unknown, outside a tab panel, or name an invalid tab", () => {
    expect(resolveDeepLinkTab("#nope", "overview", dom(PANELS), TABS)).toBeNull();
    expect(resolveDeepLinkTab("#footer", "overview", dom({ footer: null }), TABS)).toBeNull();
    expect(resolveDeepLinkTab("#x", "overview", dom({ x: "not-a-tab" }), TABS)).toBeNull();
  });

  it("decodes encoded hashes and rejects malformed ones", () => {
    expect(decodeHashId("#lead")).toBe("lead");
    expect(decodeHashId("#dance%2Dstyles")).toBe("dance-styles");
    expect(decodeHashId("#%E0%A4%A")).toBeNull();
    expect(resolveDeepLinkTab("#le%61d", "overview", dom(PANELS), TABS)).toBe("contact");
  });
});

function currentAnchor(html: string) {
  return (html.match(/<a [^>]*aria-current="page"[^>]*>/) ?? [""])[0];
}

describe("tab bar semantics are unchanged", () => {
  function render(activeTab: string) {
    return renderToStaticMarkup(
      createElement(PublicStudioTabs, {
        studioSlug: "any-studio",
        activeTab,
        tabs: TABS.map((key) => ({ key, label: key })),
      }),
    );
  }

  it("default (no hash) shows Overview selected and Contact still available", () => {
    const html = render("overview");

    expect(html).toContain('aria-label="Studio page tabs"');
    expect(currentAnchor(html)).toContain('href="/studios/any-studio?tab=overview"');
    expect(html).toContain('href="/studios/any-studio?tab=contact"');
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it("Contact selected marks only Contact as current", () => {
    const html = render("contact");

    expect(currentAnchor(html)).toContain('href="/studios/any-studio?tab=contact"');
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });
});

describe("page wiring", () => {
  const root = join(process.cwd(), "src", "app", "studios", "[studioSlug]");
  const page = readFileSync(join(root, "page.tsx"), "utf8").replace(/\r\n/g, "\n");
  const tabs = readFileSync(join(root, "PublicStudioTabs.tsx"), "utf8").replace(/\r\n/g, "\n");

  it("every tab panel and the lead form section declare their tab", () => {
    for (const key of ["overview", "about", "dance-styles", "staff", "offerings", "events", "contact"]) {
      expect(page).toContain(`<section id="${key}" data-studio-tab="${key}"`);
    }
    expect(page).toMatch(/id="lead"\s+data-studio-tab="contact"/);
  });

  it("the default tab selection without a hash is unchanged", () => {
    expect(page).toContain('inquirySuccess ? "contact" : "overview"');
  });

  it("the lead section still renders the lead form with the SMS opt-in", () => {
    const lead = page.slice(page.indexOf('id="lead"'));
    expect(lead).toContain("<PublicLeadForm");
    expect(lead).toContain("successRedirect=");
    const form = readFileSync(join(process.cwd(), "src", "app", "lead", "[studioSlug]", "PublicLeadForm.tsx"), "utf8");
    expect(form).toContain("<SmsConsentCheckbox");
  });

  it("the tab bar applies the deep link on load and on hashchange, then scrolls to the target", () => {
    expect(tabs).toContain("useEffect");
    expect(tabs).toContain("resolveDeepLinkTab");
    expect(tabs).toContain('addEventListener("hashchange"');
    expect(tabs).toContain("scrollIntoView");
  });

  it("is generic: nothing studio-specific is hard-coded", () => {
    const changed = [tabs, readFileSync(join(root, "deepLink.ts"), "utf8")].join("\n");
    expect(changed.toLowerCase()).not.toContain("confidance");
  });
});
