import { describe, expect, it } from "vitest";
import { normalizeLocalRedirectPath } from "@/lib/security/redirects";
import { partnerConnectLoginHref, partnerSearchReturnPath } from "../connectLink";

/**
 * W-5: "Request to connect" on /discover/partners sends a dancer to the public login with a local `next`
 * back to the same listing (filters kept, anchored on the profile), instead of a bare /login.
 */

const NO_FILTERS = {
  intents: [],
  latitude: null,
  longitude: null,
  query: "",
  radiusMiles: 50,
  role: "",
  skill: "",
  styles: [],
};

function parseLoginHref(href: string) {
  const url = new URL(href, "https://danceflow.test");
  return { pathname: url.pathname, intent: url.searchParams.get("intent"), next: url.searchParams.get("next") };
}

describe("partner connect login link", () => {
  it("targets public login with next back to the listing anchor", () => {
    const href = partnerConnectLoginHref(partnerSearchReturnPath(NO_FILTERS), "abc-123");
    expect(parseLoginHref(href)).toEqual({
      pathname: "/login",
      intent: "public",
      next: "/discover/partners#partner-abc-123",
    });
  });

  it("keeps the active filters in next without clashing with the login intent param", () => {
    const returnPath = partnerSearchReturnPath({
      ...NO_FILTERS,
      intents: ["practice", "social"],
      query: "salsa & bachata",
      role: "lead",
      skill: "social",
      styles: ["West Coast Swing"],
      latitude: 40.7128,
      longitude: -74.006,
      radiusMiles: 25,
    });
    const { intent, next } = parseLoginHref(partnerConnectLoginHref(returnPath, "p1"));
    expect(intent).toBe("public");

    const nextUrl = new URL(next ?? "", "https://danceflow.test");
    expect(nextUrl.pathname).toBe("/discover/partners");
    expect(nextUrl.searchParams.getAll("intent")).toEqual(["practice", "social"]);
    expect(nextUrl.searchParams.get("q")).toBe("salsa & bachata");
    expect(nextUrl.searchParams.get("role")).toBe("lead");
    expect(nextUrl.searchParams.get("skill")).toBe("social");
    expect(nextUrl.searchParams.getAll("style")).toEqual(["West Coast Swing"]);
    expect(nextUrl.searchParams.get("lat")).toBe("40.7128");
    expect(nextUrl.searchParams.get("lng")).toBe("-74.006");
    expect(nextUrl.searchParams.get("radius")).toBe("25");
    expect(nextUrl.hash).toBe("#partner-p1");
  });

  it("drops radius when there is no location", () => {
    expect(partnerSearchReturnPath({ ...NO_FILTERS, radiusMiles: 100 })).toBe("/discover/partners");
  });

  it("produces a next the login page accepts unchanged", () => {
    const returnPath = partnerSearchReturnPath({ ...NO_FILTERS, query: "tango", intents: ["competition"] });
    const { next } = parseLoginHref(partnerConnectLoginHref(returnPath, "p2"));
    expect(next).toBeTruthy();
    expect(normalizeLocalRedirectPath(next, "")).toBe(next);
  });
});
