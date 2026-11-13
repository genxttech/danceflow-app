import { parseAuthLink, resolveEmailOtpType } from "@/lib/authLink";

describe("auth callback links", () => {
  it("reads a PKCE code from danceflow-business://auth/callback", () => {
    expect(parseAuthLink("danceflow-business://auth/callback?code=abc123")).toEqual({ code: "abc123", tokenHash: null, type: null });
  });

  it("reads an email token hash and its type, from the query or the fragment", () => {
    expect(parseAuthLink("danceflow-business://auth/callback?token_hash=h1&type=magiclink")).toEqual({ code: null, tokenHash: "h1", type: "magiclink" });
    expect(parseAuthLink("danceflow-business://auth/callback#token_hash=h2&type=recovery")).toEqual({ code: null, tokenHash: "h2", type: "recovery" });
  });

  it("never reads raw access or refresh tokens from a link", () => {
    const parsed = parseAuthLink("danceflow-business://auth/callback#access_token=evil&refresh_token=evil2&type=magiclink");
    expect(parsed).toEqual({ code: null, tokenHash: null, type: "magiclink" });
    expect(JSON.stringify(parsed)).not.toContain("evil");
  });

  it("treats a malformed link as carrying nothing", () => {
    expect(parseAuthLink("not a url")).toEqual({ code: null, tokenHash: null, type: null });
  });

  it("accepts only known email OTP types and defaults a missing type to magiclink", () => {
    expect(resolveEmailOtpType(null)).toBe("magiclink");
    expect(resolveEmailOtpType("signup")).toBe("signup");
    expect(resolveEmailOtpType("phone_change")).toBeNull();
  });
});
