import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_COOKIE_NAME,
  ATTRIBUTION_KEYS,
  ATTRIBUTION_MAX_AGE_SECONDS,
  MAX_ATTRIBUTION_VALUE_LENGTH,
  attributionUserMetadata,
  decideAttributionCapture,
  normalizeAttributionValue,
  parseAttributionCookie,
  parseAttributionParams,
  serializeAttribution,
} from "@/lib/public/attribution";

/** BR-4C: first-touch campaign attribution rules. */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-10-03T12:00:00Z");

/** Comments explain the privacy rules, so source guards read code only. */
function code(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

describe("allowlist and normalization", () => {
  it("reads exactly the six campaign keys and ignores everything else", () => {
    expect([...ATTRIBUTION_KEYS]).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
    ]);

    const parsed = parseAttributionParams(
      "utm_source=flyer&utm_medium=qr&utm_campaign=br4&utm_content=a&utm_term=b&ref=jane&fbclid=zzz&email=x&next=/app&gclid=1&role=platform_admin",
    );

    expect(parsed).toEqual({
      utm_source: "flyer",
      utm_medium: "qr",
      utm_campaign: "br4",
      utm_content: "a",
      utm_term: "b",
      ref: "jane",
    });
  });

  it("trims, collapses whitespace, and drops empty values", () => {
    expect(parseAttributionParams("utm_source=%20%20flyer%20%20&utm_medium=&utm_campaign=%20%20&ref=a%20%20%20b")).toEqual({
      utm_source: "flyer",
      ref: "a b",
    });
  });

  it("keeps only a small safe character set", () => {
    expect(normalizeAttributionValue("br5-launch_v2.1~x")).toBe("br5-launch_v2.1~x");
    expect(normalizeAttributionValue("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(normalizeAttributionValue("a;b|c\\d\"e'f")).toBe("abcdef");
    expect(normalizeAttributionValue("tab\tnew\nline")).toBe("tab new line");
    expect(normalizeAttributionValue("%$#!*()")).toBeNull();
  });

  it("caps length by truncating, before any other processing", () => {
    const long = "a".repeat(10_000);
    const value = normalizeAttributionValue(long);
    expect(value).toHaveLength(MAX_ATTRIBUTION_VALUE_LENGTH);

    const parsed = parseAttributionParams({ utm_source: long });
    expect(parsed.utm_source).toHaveLength(MAX_ATTRIBUTION_VALUE_LENGTH);
  });

  it("rejects email-like and URL-like values so no PII or link can be stored", () => {
    for (const value of [
      "jane@example.com",
      "x@y",
      "https://evil.example/path",
      "http://x",
      "//evil.example",
      "www.example.com",
      "ref=a://b",
    ]) {
      expect(normalizeAttributionValue(value), value).toBeNull();
    }
  });

  it("rejects non-string input and uses the first value of a repeated key", () => {
    expect(normalizeAttributionValue(42)).toBeNull();
    expect(normalizeAttributionValue({ a: 1 })).toBeNull();
    expect(parseAttributionParams("utm_source=first&utm_source=second").utm_source).toBe("first");
    expect(parseAttributionParams({ utm_source: ["x", "y"], ref: undefined })).toEqual({ utm_source: "x" });
  });
});

describe("cookie format", () => {
  it("serializes only validated values plus a UTC capture date, and round-trips", () => {
    const serialized = serializeAttribution({ utm_source: "flyer", ref: "jane" }, NOW)!;
    expect(parseAttributionCookie(serialized)).toEqual({
      utm_source: "flyer",
      ref: "jane",
      captured_on: "2026-10-03",
    });
    expect(decodeURIComponent(serialized)).not.toMatch(/http|@|\//);
    expect(serialized.length).toBeLessThan(400);
  });

  it("serializes nothing when there is no attribution", () => {
    expect(serializeAttribution({}, NOW)).toBeNull();
  });

  it("re-validates the (client-controlled) cookie: unknown keys, bad values and malformed data are dropped", () => {
    const forged = encodeURIComponent(
      JSON.stringify({
        utm_source: "flyer",
        utm_medium: "jane@example.com",
        utm_campaign: "https://evil.example",
        role: "platform_admin",
        studio_id: "11111111-1111-4111-8111-111111111111",
        access_token: "secret",
        captured_on: "2026-10-03",
      }),
    );

    expect(parseAttributionCookie(forged)).toEqual({ utm_source: "flyer", captured_on: "2026-10-03" });
    expect(parseAttributionCookie("not json")).toBeNull();
    expect(parseAttributionCookie("%E0%A4%A")).toBeNull();
    expect(parseAttributionCookie(encodeURIComponent("[]"))).toBeNull();
    expect(parseAttributionCookie(encodeURIComponent('"x"'))).toBeNull();
    expect(parseAttributionCookie(encodeURIComponent("{}"))).toBeNull();
    expect(parseAttributionCookie(encodeURIComponent('{"utm_source":"a"}'))).toBeNull(); // no capture date
    expect(parseAttributionCookie(encodeURIComponent('{"utm_source":"a","captured_on":"yesterday"}'))).toBeNull();
    expect(parseAttributionCookie("a".repeat(5000))).toBeNull();
    expect(parseAttributionCookie(null)).toBeNull();
    expect(parseAttributionCookie(undefined)).toBeNull();
  });
});

describe("first-touch capture rule", () => {
  const base = { existingCookieValue: null, secure: true, now: NOW } as const;

  it("a tagged first visit sets one first-party cookie with the documented attributes", () => {
    const decision = decideAttributionCapture({
      ...base,
      search: "?utm_source=test&utm_medium=qr&utm_campaign=br4",
    });

    expect(decision.action).toBe("set");
    if (decision.action !== "set") return;

    const [pair, ...attributes] = decision.cookie.split("; ");
    expect(pair.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`)).toBe(true);
    expect(attributes).toEqual([`Max-Age=${ATTRIBUTION_MAX_AGE_SECONDS}`, "Path=/", "SameSite=Lax", "Secure"]);
    expect(ATTRIBUTION_MAX_AGE_SECONDS).toBe(2_592_000);
    expect(parseAttributionCookie(pair.slice(ATTRIBUTION_COOKIE_NAME.length + 1))).toEqual({
      utm_source: "test",
      utm_medium: "qr",
      utm_campaign: "br4",
      captured_on: "2026-10-03",
    });
  });

  it("omits Secure on plain http (local development)", () => {
    const decision = decideAttributionCapture({ ...base, secure: false, search: "?utm_source=test" });
    expect(decision.action === "set" && decision.cookie).not.toContain("Secure");
  });

  it("does nothing when there are no campaign parameters (normal internal navigation)", () => {
    expect(decideAttributionCapture({ ...base, search: "" })).toEqual({
      action: "none",
      reason: "no_campaign_params",
    });
    expect(decideAttributionCapture({ ...base, search: "?page=2&q=salsa&fbclid=abc" })).toEqual({
      action: "none",
      reason: "no_campaign_params",
    });
    expect(decideAttributionCapture({ ...base, search: "?utm_source=%20&ref=a@b.com" })).toEqual({
      action: "none",
      reason: "no_campaign_params",
    });
  });

  it("survives navigation: an existing valid cookie is never overwritten, even by a later campaign link", () => {
    const first = serializeAttribution({ utm_source: "flyer" }, NOW)!;

    expect(
      decideAttributionCapture({ ...base, existingCookieValue: first, search: "?utm_source=banner&utm_campaign=other" }),
    ).toEqual({ action: "none", reason: "first_touch_exists" });
    expect(decideAttributionCapture({ ...base, existingCookieValue: first, search: "" })).toEqual({
      action: "none",
      reason: "no_campaign_params",
    });
  });

  it("an invalid or forged existing cookie does not block a real first touch", () => {
    const decision = decideAttributionCapture({ ...base, existingCookieValue: "garbage", search: "?utm_source=flyer" });
    expect(decision.action).toBe("set");
  });
});

describe("signup metadata", () => {
  it("emits only namespaced, validated attribution fields", () => {
    const meta = attributionUserMetadata(
      parseAttributionCookie(serializeAttribution({ utm_source: "flyer", utm_medium: "qr", ref: "jane" }, NOW)),
    );

    expect(meta).toEqual({
      attribution_utm_source: "flyer",
      attribution_utm_medium: "qr",
      attribution_ref: "jane",
      attribution_captured_on: "2026-10-03",
    });
    expect(Object.keys(meta).every((key) => key.startsWith("attribution_"))).toBe(true);
  });

  it("is empty when no attribution exists, so signup is unchanged", () => {
    expect(attributionUserMetadata(null)).toEqual({});
    expect(attributionUserMetadata(undefined)).toEqual({});
    expect(attributionUserMetadata({ captured_on: "2026-10-03" })).toEqual({});
  });

  it("a forged cookie cannot inject arbitrary metadata keys", () => {
    const forged = encodeURIComponent(
      JSON.stringify({
        utm_source: "flyer",
        full_name: "Evil",
        signup_intent: "platform_admin",
        role: "platform_admin",
        captured_on: "2026-10-03",
      }),
    );

    expect(attributionUserMetadata(parseAttributionCookie(forged))).toEqual({
      attribution_utm_source: "flyer",
      attribution_captured_on: "2026-10-03",
    });
  });
});

describe("wiring and privacy guards (source)", () => {
  it("one shared capture point in the public header, with no page-specific tracking", () => {
    const header = read("src", "components", "public", "PublicSiteHeader.tsx");
    expect(header.match(/<AttributionCapture \/>/g)).toHaveLength(1);

    const component = code(read("src", "components", "public", "AttributionCapture.tsx"));
    expect(component).toContain("decideAttributionCapture");
    expect(component).not.toMatch(/localStorage|sessionStorage|fetch\(|XMLHttpRequest|sendBeacon|document\.referrer|<img|<script|new Image/);
    expect(component).not.toContain("window.location.href");
  });

  it("the capture reads only the query string and stores no URL, referrer or identity", () => {
    const lib = code(read("src", "lib", "public", "attribution.ts"));
    expect(lib).not.toMatch(/document\.referrer|location\.href|localStorage|studio_id|client_id|email\b.*=|access_token/);
  });

  it("signup writes attribution only through the validated server helper and never lets it override fixed keys", () => {
    const actions = read("src", "app", "(auth)", "actions.ts");
    expect(actions).toContain("readSignupAttributionMetadata()");
    expect(actions.match(/\.\.\.attributionMetadata,\n\s+full_name: fullName,/g)).toHaveLength(2);
    expect(actions).not.toMatch(/formData\.get\("attribution/);
  });

  it("adds no database migration for attribution", () => {
    expect(code(read("src", "lib", "public", "attributionServer.ts"))).not.toMatch(/\.from\(|supabase/);
  });
});
