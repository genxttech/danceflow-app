import { describe, expect, it } from "vitest";
import { getResumeBanner } from "../resumeBanner";

/**
 * Public Event Registration E2E Harness -- Slice 3 bugfix regression.
 * getResumeBanner is the other half of the `/events` -> `/discover/events`
 * query-string-preservation fix: preserving the query string alone doesn't
 * make an error "visible" if the destination page never reads it.
 */
describe("getResumeBanner", () => {
  it("renders the checkout_resume_failed banner", () => {
    const banner = getResumeBanner({ error: "checkout_resume_failed" });
    expect(banner).toEqual({
      kind: "error",
      message: "We weren't able to resume your registration after signing. Please try again.",
    });
  });

  it("renders the invalid_signing_resume banner", () => {
    const banner = getResumeBanner({ error: "invalid_signing_resume" });
    expect(banner?.kind).toBe("error");
  });

  it("renders the signing_incomplete banner", () => {
    const banner = getResumeBanner({ error: "signing_incomplete" });
    expect(banner?.kind).toBe("error");
  });

  it("renders the checkout_expired banner", () => {
    const banner = getResumeBanner({ error: "checkout_expired" });
    expect(banner?.kind).toBe("error");
  });

  it("renders the registration_complete success banner", () => {
    const banner = getResumeBanner({ success: "registration_complete" });
    expect(banner).toEqual({
      kind: "success",
      message: "Registration completed successfully.",
    });
  });

  it("returns null for no search params (no false-positive banner)", () => {
    expect(getResumeBanner({})).toBeNull();
  });

  it("returns null for an unrecognized error code (e.g. a discover/events filter param, not a resume code)", () => {
    expect(getResumeBanner({ error: "some_other_unrelated_code" })).toBeNull();
  });
});
