import { parseAuthLink, resolveEmailOtpType } from "@/lib/authLink";

describe("parseAuthLink", () => {
  it("reads a token hash and its type from the query", () => {
    expect(parseAuthLink("danceflow://auth/callback?token_hash=abc&type=signup")).toEqual({
      code: null,
      tokenHash: "abc",
      type: "signup",
    });
  });

  it("reads a PKCE code from the query or the fragment", () => {
    expect(parseAuthLink("danceflow://auth/callback?code=abc").code).toBe("abc");
    expect(parseAuthLink("danceflow://auth/callback#code=abc").code).toBe("abc");
  });

  it("exposes nothing from raw session tokens in a link", () => {
    const parsed = parseAuthLink(
      "danceflow://auth/callback#access_token=attacker&refresh_token=attacker&expires_in=3600",
    );

    expect(parsed).toEqual({ code: null, tokenHash: null, type: null });
    expect(JSON.stringify(parsed)).not.toContain("attacker");
  });

  it("returns nothing for something that is not a URL", () => {
    expect(parseAuthLink("not a url")).toEqual({ code: null, tokenHash: null, type: null });
  });
});

describe("resolveEmailOtpType", () => {
  it.each(["magiclink", "signup", "email", "recovery"] as const)("keeps %s", (type) => {
    expect(resolveEmailOtpType(type)).toBe(type);
  });

  it("treats a link with no type as a magic link", () => {
    expect(resolveEmailOtpType(null)).toBe("magiclink");
  });

  it.each(["invite", "email_change", "MAGICLINK", "anything"])("refuses %s", (type) => {
    expect(resolveEmailOtpType(type)).toBeNull();
  });
});

import { friendlyAuthLinkError, parseAuthLinkError } from "@/lib/authLink";

describe("parseAuthLinkError", () => {
  it("reads an expired-link redirect from the fragment and never echoes provider text", () => {
    const error = parseAuthLinkError(
      "danceflow://auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(error?.code).toBe("otp_expired");
    expect(error?.message).toMatch(/expired or was already used/);
    expect(error?.message).not.toContain("access_denied");
  });

  it("reads the same from the query", () => {
    expect(parseAuthLinkError("danceflow://auth/callback?error_code=otp_expired")?.code).toBe("otp_expired");
  });

  it("is null for a normal link or junk", () => {
    expect(parseAuthLinkError("danceflow://auth/callback?token_hash=abc&type=magiclink")).toBeNull();
    expect(parseAuthLinkError("nope")).toBeNull();
  });

  it("falls back to a generic sentence for an unknown failure", () => {
    expect(friendlyAuthLinkError("server_error", "boom")).toMatch(/could not finish signing you in/);
  });
});
