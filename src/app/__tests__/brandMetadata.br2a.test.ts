import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../manifest";
import { metadata, viewport } from "../layout";

/**
 * Branding Relaunch BR-2A: universal icons and metadata mechanics.
 * Canonical icons come from the BR-1 family in public/brand/icons (couple symbol, never the legacy DF mark);
 * metadata fixes are mechanical (no marketing copy).
 */
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p));

function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function icoSizes(buf: Buffer) {
  expect(buf.readUInt16LE(2)).toBe(1); // ICO
  const n = buf.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => buf.readUInt8(6 + i * 16)).sort((a, b) => a - b);
}
function listPages(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listPages(p, out);
    else if (/^(page|layout)\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

describe("icon wiring (BR-1 family)", () => {
  it("web icons are byte-identical to the canonical BR-1 assets", () => {
    expect(read("src", "app", "favicon.ico").equals(read("public", "brand", "icons", "danceflow-favicon.ico"))).toBe(true);
    expect(read("src", "app", "icon.png").equals(read("public", "brand", "icons", "danceflow-pwa-512.png"))).toBe(true);
    expect(read("src", "app", "apple-icon.png").equals(read("public", "brand", "icons", "danceflow-apple-touch-icon-180.png"))).toBe(true);
  });

  it("favicon covers 16/32/48 and icon sizes are correct", () => {
    expect(icoSizes(read("src", "app", "favicon.ico"))).toEqual([16, 32, 48]);
    expect(pngSize(read("src", "app", "icon.png"))).toEqual({ w: 512, h: 512 });
    expect(pngSize(read("src", "app", "apple-icon.png"))).toEqual({ w: 180, h: 180 });
    for (const s of [16, 32, 48]) {
      expect(pngSize(read("public", "brand", "icons", `danceflow-favicon-${s}.png`))).toEqual({ w: s, h: s });
    }
  });
});

describe("web app manifest", () => {
  const m = manifest();

  it("uses the DanceFlow name, brand colours and browser display", () => {
    expect(m.name).toBe("DanceFlow");
    expect(m.short_name).toBe("DanceFlow");
    expect(m.display).toBe("browser");
    expect(m.theme_color).toBe("#5b145e");
    expect(m.background_color).toBe("#fff9f3");
  });

  it("references only existing canonical icons with their real dimensions", () => {
    expect(m.icons?.length).toBe(3);
    for (const icon of m.icons ?? []) {
      expect(icon.src).toMatch(/^\/brand\/icons\/danceflow-pwa-/);
      const { w, h } = pngSize(read("public", icon.src));
      expect(icon.sizes).toBe(`${w}x${h}`);
    }
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("never references the legacy DF monogram or the mobile app icon set", () => {
    expect(JSON.stringify(m)).not.toMatch(/monogram|adaptive-foreground|danceflow-app-icon\.png|mobile\/student/);
  });
});

describe("root metadata mechanics", () => {
  it("keeps the single '%s | DanceFlow' template and a theme colour from the brand primary", () => {
    expect((metadata.title as { template: string }).template).toBe("%s | DanceFlow");
    expect(viewport.themeColor).toBe("#5b145e");
  });

  it("no longer sets a site-wide canonical (it was inherited by every page)", () => {
    expect(metadata.alternates).toBeUndefined();
  });

  it("Open Graph and Twitter use the correctly sized brand-neutral card", () => {
    const og = (metadata.openGraph as { images: { url: string; width: number; height: number }[] }).images[0];
    expect(og).toMatchObject({ url: "/brand/danceflow-og-1200x630.png", width: 1200, height: 630 });
    expect(pngSize(read("public", "brand", "danceflow-og-1200x630.png"))).toEqual({ w: 1200, h: 630 });
    expect((metadata.twitter as { images: string[] }).images).toEqual(["/brand/danceflow-og-1200x630.png"]);
  });
});

describe("title mechanics (source guards)", () => {
  const pages = listPages(join(ROOT, "src", "app"));

  it("no page metadata title hard-codes a trailing '| DanceFlow' (the root template adds it)", () => {
    const offenders: string[] = [];
    for (const file of pages) {
      const src = readFileSync(file, "utf8");
      if (/^\s*title:\s*["'`][^"'`\n]*\|\s*DanceFlow["'`],?\s*$/m.test(src)) offenders.push(file.replace(ROOT, ""));
    }
    expect(offenders).toEqual([]);
  });

  it("the home page keeps its own canonical", () => {
    expect(readFileSync(join(ROOT, "src", "app", "page.tsx"), "utf8")).toMatch(/canonical:\s*"\/"/);
  });

  it("previously title-less public pages now export a plain title", () => {
    const expected: Record<string, string> = {
      "(auth)/login": "Log In",
      "(auth)/signup": "Create Free Account",
      "reset-password": "Reset Password",
      "get-started": "Get Started",
      "get-started/studio": "Studio Pricing",
      "get-started/organizer": "Organizer Pricing",
      "get-started/ambassador": "Ambassador Invitation",
      "get-started/explorer": "Explorer Account",
      discover: "Discover",
      "discover/studios": "Find a Dance Studio",
      "discover/events": "Find Dance Events",
      marketplace: "Marketplace",
      knowledgebase: "Knowledgebase",
      favorites: "Favorites",
    };
    for (const [route, title] of Object.entries(expected)) {
      const src = readFileSync(join(ROOT, "src", "app", ...route.split("/"), "page.tsx"), "utf8");
      expect(src, route).toMatch(new RegExp(`export const metadata: Metadata = \\{\\s*title: "${title}",`));
    }
  });

  it("dynamic pages no longer fall back to the old hero image for social cards", () => {
    for (const rel of ["events/[slug]/page.tsx", "studios/[studioSlug]/page.tsx"]) {
      const src = readFileSync(join(ROOT, "src", "app", ...rel.split("/")), "utf8");
      const metaFallback = src.split("export async function generateMetadata")[1]?.split("export default")[0] ?? "";
      expect(metaFallback, rel).not.toContain("danceflow-home-hero.png");
      expect(metaFallback, rel).toContain("danceflow-og-1200x630.png");
    }
  });
});
