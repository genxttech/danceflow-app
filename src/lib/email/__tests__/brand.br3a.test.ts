import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_CANONICAL_ORIGIN,
  EMAIL_FONT_STACK,
  EMAIL_LEGAL_LINE,
  EMAIL_LOGO_FILES,
  EMAIL_SUBJECT_FALLBACK,
  EMAIL_SUBJECT_MAX_LENGTH,
  EMAIL_TOKENS,
  buildAppUrl,
  emailAssetUrl,
  emailAttribution,
  emailFooterLines,
  escapeHtml,
  resolveInitial,
  resolveStudioDisplayName,
  sanitizeActionUrl,
  sanitizeEmailSubject,
  sanitizePublicImageUrl,
} from "@/lib/email/brand";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("palette and constants", () => {
  it("uses exactly the current application palette", () => {
    expect(EMAIL_TOKENS).toEqual({
      primary: "#5b145e",
      primaryDark: "#431046",
      primarySoft: "#f6edf7",
      accent: "#d88a2d",
      accentDark: "#b86f18",
      accentSoft: "#f7e2c4",
      surface: "#fff9f3",
      border: "#ead9cb",
      text: "#2b1b2a",
      muted: "#6f5b6b",
      white: "#ffffff",
    });
  });

  it("uses the email-safe font stack with no web fonts", () => {
    expect(EMAIL_FONT_STACK).toBe("Arial, Helvetica, sans-serif");
    expect(EMAIL_FONT_STACK).not.toMatch(/sora|inter\b/i);
  });

  it("carries the approved legal line and attribution wording", () => {
    expect(EMAIL_LEGAL_LINE).toBe("DanceFlow is a product of GenX TotalTech LLC.");
    expect(emailAttribution("Michael Curtis Studio")).toBe(
      "Sent by Michael Curtis Studio through DanceFlow.",
    );
    expect(emailFooterLines("studio", "Acme Dance")).toEqual([
      "Sent by Acme Dance through DanceFlow.",
      EMAIL_LEGAL_LINE,
    ]);
    expect(emailFooterLines("system")[0]).toBe("This is a system message from DanceFlow.");
    expect(emailFooterLines("organizer", "  ")[0]).toBe(
      "Sent by Your event organizer through DanceFlow.",
    );
  });
});

describe("identity resolution", () => {
  it("prefers a trimmed public_name over name", () => {
    expect(resolveStudioDisplayName({ public_name: "  Public Name  ", name: "Legal Name" })).toBe(
      "Public Name",
    );
  });

  it("falls back to name when public_name is empty or whitespace", () => {
    expect(resolveStudioDisplayName({ public_name: "   ", name: " Legal Name " })).toBe(
      "Legal Name",
    );
    expect(resolveStudioDisplayName({ public_name: null, name: "Legal Name" })).toBe(
      "Legal Name",
    );
  });

  it("uses one shared fallback when nothing is available", () => {
    expect(resolveStudioDisplayName(null)).toBe("Your dance studio");
    expect(resolveStudioDisplayName({ public_name: "", name: "" }, "Custom")).toBe("Custom");
  });

  it("resolves the first letter or digit as the initial", () => {
    expect(resolveInitial("michael curtis")).toBe("M");
    expect(resolveInitial("  élan studio")).toBe("É");
    expect(resolveInitial("!!! 7 Steps")).toBe("7");
    expect(resolveInitial("")).toBe("S");
    expect(resolveInitial("***", "D")).toBe("D");
    expect(resolveInitial(null)).toBe("S");
  });
});

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;&lt;/a&gt;",
    );
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("sanitizeEmailSubject", () => {
  it("removes CR/LF so a subject cannot smuggle headers", () => {
    const result = sanitizeEmailSubject("Hello\r\nBcc: evil@example.com");
    expect(result).toBe("Hello Bcc: evil@example.com");
    expect(result).not.toMatch(/[\r\n]/);
  });

  it("replaces C0/C1 controls and separators and collapses whitespace", () => {
    const dirty = [
      "A", String.fromCharCode(0), "B", String.fromCharCode(0x1f), "C", String.fromCharCode(0x7f),
      "D", String.fromCharCode(0x85), "E", String.fromCharCode(0x2028), "F   G",
    ].join("");
    expect(sanitizeEmailSubject(dirty)).toBe("A B C D E F G");
  });

  it("uses a deterministic fallback for empty subjects", () => {
    expect(sanitizeEmailSubject("")).toBe(EMAIL_SUBJECT_FALLBACK);
    expect(sanitizeEmailSubject("   \r\n  ")).toBe(EMAIL_SUBJECT_FALLBACK);
    expect(sanitizeEmailSubject(null)).toBe(EMAIL_SUBJECT_FALLBACK);
    expect(sanitizeEmailSubject(undefined, "Custom fallback")).toBe("Custom fallback");
    expect(sanitizeEmailSubject("", "")).toBe("");
  });

  it("caps the subject at 200 characters without splitting characters", () => {
    expect(sanitizeEmailSubject("x".repeat(500))).toHaveLength(EMAIL_SUBJECT_MAX_LENGTH);
    const emoji = sanitizeEmailSubject("😀".repeat(300));
    expect(Array.from(emoji)).toHaveLength(EMAIL_SUBJECT_MAX_LENGTH);
  });
});

describe("sanitizePublicImageUrl", () => {
  it("accepts ordinary https image URLs", () => {
    expect(sanitizePublicImageUrl("https://cdn.example.com/logos/a.png")).toBe(
      "https://cdn.example.com/logos/a.png",
    );
    expect(
      sanitizePublicImageUrl(
        "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/studio-public-assets/a.webp",
      ),
    ).toContain("supabase.co");
  });

  it.each([
    ["plain http", "http://cdn.example.com/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/png;base64,AAAA"],
    ["embedded credentials", "https://user:pass@cdn.example.com/a.png"],
    ["localhost", "https://localhost/a.png"],
    ["localhost with port", "https://localhost:3000/a.png"],
    [".local host", "https://printer.local/a.png"],
    [".internal host", "https://svc.internal/a.png"],
    ["IPv4 literal", "https://10.0.0.5/a.png"],
    ["IPv6 literal", "https://[::1]/a.png"],
    ["single-label host", "https://intranet/a.png"],
    ["whitespace", "https://cdn.example.com/a b.png"],
    ["control characters", "https://cdn.example.com/a\r\n.png"],
    ["empty", ""],
    ["not a URL", "not a url"],
  ])("rejects %s", (_label, value) => {
    expect(sanitizePublicImageUrl(value)).toBeNull();
  });

  it("rejects overly long URLs", () => {
    expect(sanitizePublicImageUrl(`https://cdn.example.com/${"a".repeat(2100)}.png`)).toBeNull();
  });

  it("only allows insecure fixtures through the explicit test option", () => {
    expect(sanitizePublicImageUrl("http://localhost:3000/logo.png")).toBeNull();
    expect(
      sanitizePublicImageUrl("http://localhost:3000/logo.png", { allowInsecureImageUrls: true }),
    ).toBe("http://localhost:3000/logo.png");
    expect(
      sanitizePublicImageUrl("javascript:alert(1)", { allowInsecureImageUrls: true }),
    ).toBeNull();
    expect(
      sanitizePublicImageUrl("https://user:pw@cdn.example.com/a.png", {
        allowInsecureImageUrls: true,
      }),
    ).toBeNull();
  });
});

describe("sanitizeActionUrl", () => {
  it("accepts https links", () => {
    expect(sanitizeActionUrl("https://www.idanceflow.com/sign/abc")).toBe(
      "https://www.idanceflow.com/sign/abc",
    );
  });

  it("rejects unsafe schemes and credentials", () => {
    expect(sanitizeActionUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeActionUrl("data:text/html,x")).toBeNull();
    expect(sanitizeActionUrl("mailto:a@b.com")).toBeNull();
    expect(sanitizeActionUrl("https://u:p@www.idanceflow.com/x")).toBeNull();
    expect(sanitizeActionUrl("http://www.idanceflow.com/x")).toBeNull();
    expect(sanitizeActionUrl("")).toBeNull();
    expect(sanitizeActionUrl(null)).toBeNull();
  });

  it("allows http localhost only when explicitly non-production", () => {
    expect(sanitizeActionUrl("http://localhost:3000/x", { allowLocalHttp: true })).toBe(
      "http://localhost:3000/x",
    );
    expect(sanitizeActionUrl("http://localhost:3000/x", { allowLocalHttp: false })).toBeNull();
    expect(sanitizeActionUrl("http://evil.example.com/x", { allowLocalHttp: true })).toBeNull();
  });

  it("follows NODE_ENV by default: rejected in production, allowed otherwise", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sanitizeActionUrl("http://localhost:3000/x")).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    expect(sanitizeActionUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });
});

describe("emailAssetUrl", () => {
  it("builds canonical URLs only for the approved logo family", () => {
    for (const [asset, file] of Object.entries(EMAIL_LOGO_FILES)) {
      expect(emailAssetUrl(asset as keyof typeof EMAIL_LOGO_FILES)).toBe(
        `${EMAIL_CANONICAL_ORIGIN}/brand/logo/${file}`,
      );
    }
    expect(emailAssetUrl("primary-white")).toBe(
      "https://www.idanceflow.com/brand/logo/danceflow-logo-primary-white.png",
    );
  });

  it("never emits localhost or preview hosts, whatever the environment says", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.stubEnv("VERCEL_URL", "danceflow-app-git-x-dance-flow.vercel.app");
    const url = emailAssetUrl("primary-white");
    expect(url).not.toMatch(/localhost|vercel\.app/);
    expect(url.startsWith("https://www.idanceflow.com/")).toBe(true);
  });

  it("rejects unknown assets and allows only an explicit, validated base override", () => {
    expect(() => emailAssetUrl("danceflow-logo" as never)).toThrow();
    expect(() => emailAssetUrl("__proto__" as never)).toThrow();
    expect(emailAssetUrl("symbol-128", { baseUrl: "https://assets.example.test/" })).toBe(
      "https://assets.example.test/brand/logo/danceflow-symbol-128.png",
    );
    expect(() => emailAssetUrl("symbol-128", { baseUrl: "javascript:alert(1)" })).toThrow();
    expect(() => emailAssetUrl("symbol-128", { baseUrl: "https://u:p@x.test" })).toThrow();
  });
});

describe("buildAppUrl", () => {
  it("returns canonical customer links in production", () => {
    expect(buildAppUrl("/sign/abc?x=1", { env: { NODE_ENV: "production" } })).toBe(
      "https://www.idanceflow.com/sign/abc?x=1",
    );
  });

  it("ignores preview and arbitrary site URLs in production (previews report NODE_ENV=production)", () => {
    expect(
      buildAppUrl("/portal", {
        env: {
          NODE_ENV: "production",
          NEXT_PUBLIC_SITE_URL: "https://danceflow-app-git-x-dance-flow.vercel.app",
        },
      }),
    ).toBe("https://www.idanceflow.com/portal");
  });

  it("allows a validated local site URL outside production only", () => {
    expect(
      buildAppUrl("/app", {
        env: { NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000/ignored" },
      }),
    ).toBe("http://localhost:3000/app");
    expect(
      buildAppUrl("/app", {
        env: { NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: "https://evil.example.com" },
      }),
    ).toBe("https://www.idanceflow.com/app");
    expect(buildAppUrl("/app", { env: { NODE_ENV: "test" } })).toBe(
      "https://www.idanceflow.com/app",
    );
  });

  it("refuses paths that could change the origin", () => {
    for (const bad of ["//evil.example.com/x", "https://evil.example.com", "app", "/a\\b", "/a b"]) {
      expect(() => buildAppUrl(bad, { env: { NODE_ENV: "production" } })).toThrow();
    }
  });
});
