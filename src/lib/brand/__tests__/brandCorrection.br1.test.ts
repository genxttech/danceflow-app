import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BR-1 brand source correction guards: the approved Candidate A artwork is the only logo source,
 * every input is tracked in the repository, and the retired dancing-couple/script master is gone.
 */
const ROOT = process.cwd();
const p = (...parts: string[]) => join(ROOT, ...parts);
const read = (...parts: string[]) => readFileSync(p(...parts));

function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const MASTERS: Record<string, { sha: string; dims: string }> = {
  "danceflow-logo-primary-gradient.svg": { sha: "b80612ffecd5383a1c0dc0b2a5486ea686288221a278d053221e5e077ab3b459", dims: "600x150" },
  "danceflow-logo-primary-white.svg": { sha: "2d75e3e700118228f2f1aba9e3d517b8acdbf70f4c5be0b6a47bd9423946b05c", dims: "600x150" },
  "danceflow-symbol-gradient.svg": { sha: "e2c5fe2f12f9c04f8f51d4337f3e7cb31f385589e88ab02929fc828c3d74ee7d", dims: "197x272" },
  "danceflow-symbol-white.svg": { sha: "eb4ed1f0ff12ce4743aef5b740b5934a8b59494a89b052e905e312ec9591d3d2", dims: "197x272" },
  "danceflow-app-icon-1024.png": { sha: "ea0cb3560d92900f404cf96240771f93b23d8fec0e3328f90415878848c91261", dims: "1024x1024" },
  "danceflow-social-avatar-1080.png": { sha: "94c357b9e862560ec667b845c30d17a8606ef5c0bb61fc98b04e52d4ff42eff4", dims: "1080x1080" },
};

describe("tracked approved masters", () => {
  const sums = readFileSync(p("docs", "brand", "masters", "SHA256SUMS.txt"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.trim().split(/\s+/));

  it("exist with the pinned SHA-256 and dimensions, and SHA256SUMS.txt records them", () => {
    expect(sums.map((s) => s[1]).sort()).toEqual(Object.keys(MASTERS).sort());
    for (const [name, m] of Object.entries(MASTERS)) {
      const buf = read("docs", "brand", "masters", name);
      expect(createHash("sha256").update(buf).digest("hex"), name).toBe(m.sha);
      const row = sums.find((s) => s[1] === name)!;
      expect(row[0], name).toBe(m.sha);
      expect(row[2], name).toBe(m.dims);
      expect(row[3], name).toBe(String(buf.length));
      if (name.endsWith(".png")) {
        const { w, h } = pngSize(buf);
        expect(`${w}x${h}`, name).toBe(m.dims);
      } else {
        expect(buf.toString("utf8"), name).toContain(`viewBox="0 0 ${m.dims.replace("x", " ")}"`);
        expect(buf.toString("utf8"), name).not.toMatch(/<image|<text/);
      }
    }
  });
});

describe("retired old logo", () => {
  it("has no source reference to /brand/danceflow-logo.png", () => {
    const offenders = walk(p("src"))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"))
      .filter((f) => readFileSync(f, "utf8").includes("/brand/danceflow-logo.png"));
    expect(offenders).toEqual([]);
  }, 60_000);

  it("is absent from the public runtime asset tree", () => {
    expect(existsSync(p("public", "brand", "danceflow-logo.png"))).toBe(false);
  });

  it("home page uses the approved symbol and primary logo paths", () => {
    const home = readFileSync(p("src", "app", "page.tsx"), "utf8");
    expect(home).toContain("/brand/logo/danceflow-symbol-256.png");
    expect(home).toContain("/brand/logo/danceflow-logo-primary-640.png");
  });
});

describe("generated family dimensions", () => {
  const dims: Record<string, [number, number]> = {
    "logo/danceflow-logo-primary.png": [2400, 600],
    "logo/danceflow-logo-primary-640.png": [640, 160],
    "logo/danceflow-logo-primary-320.png": [320, 80],
    "logo/danceflow-logo-primary-white.png": [1200, 300],
    "logo/danceflow-logo-primary-mono-purple.png": [1200, 300],
    "logo/danceflow-symbol.png": [788, 1088],
    "logo/danceflow-symbol-256.png": [256, 353],
    "logo/danceflow-symbol-128.png": [128, 177],
    "logo/danceflow-symbol-white.png": [788, 1088],
    "logo/danceflow-symbol-mono-purple.png": [788, 1088],
    "icons/danceflow-icon-source-1024.png": [1024, 1024],
    "icons/danceflow-app-icon-source-1024.png": [1024, 1024],
    "icons/danceflow-app-icon-source-1024-reversed.png": [1024, 1024],
    "icons/danceflow-favicon-16.png": [16, 16],
    "icons/danceflow-favicon-32.png": [32, 32],
    "icons/danceflow-favicon-48.png": [48, 48],
    "icons/danceflow-apple-touch-icon-180.png": [180, 180],
    "icons/danceflow-pwa-192.png": [192, 192],
    "icons/danceflow-pwa-512.png": [512, 512],
    "icons/danceflow-pwa-maskable-512.png": [512, 512],
    "icons/danceflow-social-avatar-1024.png": [1024, 1024],
  };

  it("matches the approved sizes", () => {
    for (const [rel, [w, h]] of Object.entries(dims)) {
      expect(pngSize(read("public", "brand", ...rel.split("/"))), rel).toEqual({ w, h });
    }
  });

  it("primary is 4:1 and the symbol keeps the approved ~0.72:1 ratio", () => {
    const primary = pngSize(read("public", "brand", "logo", "danceflow-logo-primary.png"));
    expect(primary.w / primary.h).toBe(4);
    const symbol = pngSize(read("public", "brand", "logo", "danceflow-symbol.png"));
    expect(symbol.w / symbol.h).toBeGreaterThan(0.71);
    expect(symbol.w / symbol.h).toBeLessThan(0.73);
  });

  it("app icon source and runtime copies derive from the approved master", () => {
    expect(read("public", "brand", "icons", "danceflow-app-icon-source-1024.png").equals(read("docs", "brand", "masters", "danceflow-app-icon-1024.png"))).toBe(true);
  });

  it("canonical src/app icon copies are byte-identical to the canonical icons", () => {
    expect(read("src", "app", "favicon.ico").equals(read("public", "brand", "icons", "danceflow-favicon.ico"))).toBe(true);
    expect(read("src", "app", "icon.png").equals(read("public", "brand", "icons", "danceflow-pwa-512.png"))).toBe(true);
    expect(read("src", "app", "apple-icon.png").equals(read("public", "brand", "icons", "danceflow-apple-touch-icon-180.png"))).toBe(true);
  });

  it("Open Graph card is 1200x630", () => {
    expect(pngSize(read("public", "brand", "danceflow-og-1200x630.png"))).toEqual({ w: 1200, h: 630 });
  });
});

describe("brand scope", () => {
  it("public/brand holds no descriptor, compact, DF monogram or Rev3 production asset", () => {
    const files = walk(p("public", "brand")).map((f) => f.slice(p("public", "brand").length).toLowerCase());
    expect(files.filter((f) => /descriptor|compact|monogram|rev-?3|proof|df-mark|studio-operating/.test(f))).toEqual([]);
  });

  it("generator reads only tracked inputs (no external source locations)", () => {
    const script = readFileSync(p("scripts", "brand", "build-logo-family.mjs"), "utf8");
    expect(script).not.toMatch(/_tmp|downloads|onedrive/i);
    expect(script).not.toContain("danceflow-logo.png");
    expect(script).toContain("docs/brand/masters");
  });

  it("next.config.ts has no image host configuration", () => {
    const config = readFileSync(p("next.config.ts"), "utf8");
    expect(config).not.toMatch(/remotePatterns|images\s*:/);
  });
});
