import { describe, expect, it } from "vitest";
import { totp } from "../totp";

describe("E2E TOTP helper (RFC 6238, SHA-1)", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"
  it("matches the RFC test vectors (last six digits of the published eight-digit values)", () => {
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1_111_111_109_000)).toBe("081804");
    expect(totp(secret, 1_234_567_890_000)).toBe("005924");
  });
  it("is stable within a 30 second step and changes in the next one", () => {
    expect(totp(secret, 60_000)).toBe(totp(secret, 89_999));
    expect(totp(secret, 60_000)).not.toBe(totp(secret, 90_000));
  });
  it("ignores case, spaces and padding, and refuses anything that is not base32", () => {
    expect(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====", 59_000)).toBe("287082");
    expect(() => totp("not base32 !", 0)).toThrow("not a base32 secret");
  });
});
