import { signInFailureKind } from "../signInError";

describe("signInFailureKind", () => {
  it("is unreachable for network failures and server errors", () => {
    expect(signInFailureKind(new TypeError("Network request failed"))).toBe("unreachable");
    expect(signInFailureKind({ name: "AuthRetryableFetchError", message: "x", status: 0 })).toBe("unreachable");
    expect(signInFailureKind({ status: 502 })).toBe("unreachable");
    expect(signInFailureKind(new Error("Failed to fetch"))).toBe("unreachable");
    expect(signInFailureKind(new Error("request timed out"))).toBe("unreachable");
  });

  it("is refused for a rejected login and for anything unrecognised", () => {
    expect(signInFailureKind({ name: "AuthApiError", status: 400, message: "Invalid login credentials" })).toBe("refused");
    expect(signInFailureKind({ status: 429, message: "rate limited" })).toBe("refused");
    expect(signInFailureKind(new Error("no"))).toBe("refused");
    expect(signInFailureKind(undefined)).toBe("refused");
    expect(signInFailureKind(null)).toBe("refused");
  });
});
