import { friendlyAuthLinkError, LINK_EXPIRED_MESSAGE, LINK_FAILED_MESSAGE, LINK_OFFLINE_MESSAGE } from "@/lib/authLink";
import { failureMessage, signInLinkErrorMessage } from "@/lib/errorKind";

describe("no catch-all: a connection problem never reads as a credential, permission, not-found or unavailable message", () => {
  // Auth errors as supabase-js builds them: the CODE and STATUS carry the meaning; the message wording is deliberately
  // unrelated to prove nothing is read from it.
  const authError = (name: string, code: string | undefined, status: number) =>
    Object.assign(new Error("unrelated vendor wording"), { name, code, status });
  const networkFailure = () => authError("AuthRetryableFetchError", undefined, 0);

  it("sending a sign-in link: a connection failure says offline, not 'check your email address'", () => {
    expect(signInLinkErrorMessage(networkFailure())).toMatch(/offline/i);
    expect(signInLinkErrorMessage(networkFailure())).not.toMatch(/email address/i);
    expect(signInLinkErrorMessage(new TypeError("fetch failed"))).toMatch(/offline/i);
  });

  it("sending a sign-in link: rate limit, bad address and plain failure are three different messages", () => {
    for (const code of ["over_email_send_rate_limit", "over_request_rate_limit", "over_sms_send_rate_limit"]) {
      expect(signInLinkErrorMessage(authError("AuthApiError", code, 429))).toBe("Too many link requests. Wait a minute, then try again.");
    }
    expect(signInLinkErrorMessage(authError("AuthApiError", undefined, 429))).toMatch(/too many/i);
    for (const code of ["email_address_invalid", "validation_failed"]) {
      expect(signInLinkErrorMessage(authError("AuthApiError", code, 422))).toBe("That email address does not look right. Check it and try again.");
    }
    const server = signInLinkErrorMessage(authError("AuthApiError", "unexpected_failure", 500));
    expect(server).toBe("We could not send that link right now. Try again in a moment.");
    expect(server).not.toMatch(/email address/i);
  });

  it("sending a sign-in link: vendor wording alone decides nothing (unknown -> fallback)", () => {
    expect(signInLinkErrorMessage(new Error("Email rate limit exceeded"))).toMatch(/right now/i);
    expect(signInLinkErrorMessage(new Error("Unable to validate email address: invalid format"))).toMatch(/right now/i);
    expect(signInLinkErrorMessage(new Error("Network request failed"))).toMatch(/right now/i);
    expect(signInLinkErrorMessage(undefined)).toMatch(/right now/i);
  });

  it("an auth link that fails on the network is not 'expired or already used'", () => {
    expect(friendlyAuthLinkError(networkFailure())).toBe(LINK_OFFLINE_MESSAGE);
    expect(friendlyAuthLinkError(new TypeError("fetch failed"))).toBe(LINK_OFFLINE_MESSAGE);
  });

  it("an auth link that really expired keeps its wording (verify and code-exchange failures, redirect codes)", () => {
    for (const code of ["otp_expired", "flow_state_expired", "flow_state_not_found"]) {
      expect(friendlyAuthLinkError(authError("AuthApiError", code, 403))).toBe(LINK_EXPIRED_MESSAGE);
      expect(friendlyAuthLinkError(code)).toBe(LINK_EXPIRED_MESSAGE);
    }
    expect(friendlyAuthLinkError("access_denied")).toBe(LINK_EXPIRED_MESSAGE);
  });

  it("any other link failure keeps the generic wording", () => {
    expect(friendlyAuthLinkError(authError("AuthApiError", "unexpected_failure", 500))).toBe(LINK_FAILED_MESSAGE);
    expect(friendlyAuthLinkError(new Error("something broke"))).toBe(LINK_FAILED_MESSAGE);
    expect(friendlyAuthLinkError("server_error")).toBe(LINK_FAILED_MESSAGE);
    expect(friendlyAuthLinkError(null)).toBe(LINK_FAILED_MESSAGE);
    expect(friendlyAuthLinkError(undefined)).toBe(LINK_FAILED_MESSAGE);
  });

  it("a screen's own 'not available yet' wording gives way to offline and signed-out, and only to those", () => {
    const text = "Studios are not available yet. Try again in a moment.";
    expect(failureMessage(new Error("Network request failed"), text)).toMatch(/offline/i);
    expect(failureMessage(new Error("JWT expired"), text)).toMatch(/sign in again/i);
    expect(failureMessage(new Error("Internal server error"), text)).toBe(text);
    expect(failureMessage(null, text)).toBe(text);
  });
});
