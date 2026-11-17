import { friendlyAuthLinkError, LINK_EXPIRED_MESSAGE, LINK_FAILED_MESSAGE, LINK_OFFLINE_MESSAGE } from "@/lib/authLink";
import { failureMessage, signInLinkErrorMessage } from "@/lib/errorKind";

describe("no catch-all: a connection problem never reads as a credential, permission, not-found or unavailable message", () => {
  it("sending a sign-in link: offline says offline, not 'check your email address'", () => {
    expect(signInLinkErrorMessage(new Error("Network request failed"))).toMatch(/offline/i);
    expect(signInLinkErrorMessage(new Error("Network request failed"))).not.toMatch(/email address/i);
    expect(signInLinkErrorMessage(new Error("Request timed out"))).toMatch(/offline/i);
  });

  it("sending a sign-in link: rate limit, bad address and plain failure are three different messages", () => {
    const limited = Object.assign(new Error("Email rate limit exceeded"), { status: 429 });
    expect(signInLinkErrorMessage(limited)).toMatch(/too many/i);
    expect(signInLinkErrorMessage(new Error("For security purposes, you can only request this after 52 seconds."))).toMatch(/too many/i);
    expect(signInLinkErrorMessage(new Error("Unable to validate email address: invalid format"))).toMatch(/does not look right/i);
    const server = signInLinkErrorMessage(Object.assign(new Error("Internal server error"), { status: 500 }));
    expect(server).toMatch(/right now/i);
    expect(server).not.toMatch(/email address/i);
  });

  it("an auth link that fails on the network is not 'expired or already used'", () => {
    expect(friendlyAuthLinkError(null, "Network request failed")).toBe(LINK_OFFLINE_MESSAGE);
    expect(friendlyAuthLinkError(undefined, "Failed to fetch")).toBe(LINK_OFFLINE_MESSAGE);
    expect(friendlyAuthLinkError(null, "timeout of 10000ms exceeded")).toBe(LINK_OFFLINE_MESSAGE);
  });

  it("an auth link that really expired or failed keeps its wording", () => {
    expect(friendlyAuthLinkError("otp_expired", "Email link is invalid or has expired")).toBe(LINK_EXPIRED_MESSAGE);
    expect(friendlyAuthLinkError(null, "something broke")).toBe(LINK_FAILED_MESSAGE);
  });

  it("a screen's own 'not available yet' wording gives way to offline and signed-out, and only to those", () => {
    const text = "Studios are not available yet. Try again in a moment.";
    expect(failureMessage(new Error("Network request failed"), text)).toMatch(/offline/i);
    expect(failureMessage(new Error("JWT expired"), text)).toMatch(/sign in again/i);
    expect(failureMessage(new Error("Internal server error"), text)).toBe(text);
    expect(failureMessage(null, text)).toBe(text);
  });
});
