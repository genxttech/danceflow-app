import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EinCryptoError, decryptEin, einEncryptionConfigured, encryptEin } from "@/lib/sms/onboarding/ein";

const KEY = randomBytes(32).toString("base64");
const ENV = { SMS_EIN_ENCRYPTION_KEY: KEY };
const STUDIO_A = "a5700000-0000-0000-0000-00000000000a";
const STUDIO_B = "a5700000-0000-0000-0000-00000000000b";
const EIN = { digits: "123456789", last4: "6789" };

describe("EIN encryption", () => {
  it("round-trips, binds the studio, and never contains the plaintext", () => {
    const encrypted = encryptEin(STUDIO_A, EIN, ENV);
    expect(encrypted.keyId).toBe("v1");
    expect(encrypted.last4).toBe("6789");
    expect(encrypted.ciphertext).not.toContain("123456789");
    expect(encrypted.ciphertext).not.toContain("12-3456789");
    expect(decryptEin(STUDIO_A, encrypted.ciphertext, ENV)).toBe("123456789");
  });
  it("fits the database column checks (20-400 characters, key id pattern)", () => {
    const encrypted = encryptEin(STUDIO_A, EIN, ENV);
    expect(encrypted.ciphertext.length).toBeGreaterThanOrEqual(20);
    expect(encrypted.ciphertext.length).toBeLessThanOrEqual(400);
    expect(encrypted.keyId).toMatch(/^[a-z0-9_-]{1,32}$/);
  });
  it("uses a fresh IV every time", () => {
    expect(encryptEin(STUDIO_A, EIN, ENV).ciphertext).not.toBe(encryptEin(STUDIO_A, EIN, ENV).ciphertext);
  });
  it("a ciphertext copied to another studio cannot be decrypted there", () => {
    const encrypted = encryptEin(STUDIO_A, EIN, ENV);
    expect(() => decryptEin(STUDIO_B, encrypted.ciphertext, ENV)).toThrow(EinCryptoError);
  });
  it("tampering, truncation and wrong keys fail with a coded error that never carries the value", () => {
    const { ciphertext } = encryptEin(STUDIO_A, EIN, ENV);
    const parts = ciphertext.split(".");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("x".repeat(12)).toString("base64url")].join(".");
    for (const bad of [tampered, parts.slice(0, 3).join("."), "garbage", ""]) {
      try {
        decryptEin(STUDIO_A, bad, ENV);
        throw new Error("should have failed");
      } catch (error) {
        expect(error).toBeInstanceOf(EinCryptoError);
        expect(String((error as Error).message)).not.toContain("123456789");
      }
    }
    expect(() => decryptEin(STUDIO_A, ciphertext, { SMS_EIN_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toThrow(EinCryptoError);
  });
  it("refuses to run without a valid 32-byte key or with a bad key id, and reports configuration honestly", () => {
    expect(() => encryptEin(STUDIO_A, EIN, {})).toThrow(/key_missing/);
    expect(() => encryptEin(STUDIO_A, EIN, { SMS_EIN_ENCRYPTION_KEY: Buffer.from("short").toString("base64") })).toThrow(/key_invalid/);
    expect(() => encryptEin(STUDIO_A, EIN, { ...ENV, SMS_EIN_ENCRYPTION_KEY_ID: "BAD ID!" })).toThrow(/key_invalid/);
    expect(einEncryptionConfigured(ENV)).toBe(true);
    expect(einEncryptionConfigured({})).toBe(false);
    expect(einEncryptionConfigured({ SMS_EIN_ENCRYPTION_KEY: "not-base64-32" })).toBe(false);
  });
  it("rejects values that are not a 9-digit EIN with a matching last4", () => {
    expect(() => encryptEin(STUDIO_A, { digits: "12345678", last4: "5678" }, ENV)).toThrow(/format_invalid/);
    expect(() => encryptEin(STUDIO_A, { digits: "123456789", last4: "0000" }, ENV)).toThrow(/format_invalid/);
  });
  it("supports key rotation: old ciphertexts decrypt with the retained old key while new ones use the new key id", () => {
    const oldEnv = { SMS_EIN_ENCRYPTION_KEY: KEY, SMS_EIN_ENCRYPTION_KEY_ID: "v1" };
    const old = encryptEin(STUDIO_A, EIN, oldEnv);
    const newKey = randomBytes(32).toString("base64");
    const rotated = { SMS_EIN_ENCRYPTION_KEY: newKey, SMS_EIN_ENCRYPTION_KEY_ID: "v2", SMS_EIN_ENCRYPTION_KEY_V1: KEY };
    expect(decryptEin(STUDIO_A, old.ciphertext, rotated)).toBe("123456789");
    const fresh = encryptEin(STUDIO_A, EIN, rotated);
    expect(fresh.keyId).toBe("v2");
    expect(decryptEin(STUDIO_A, fresh.ciphertext, rotated)).toBe("123456789");
    expect(() => decryptEin(STUDIO_A, old.ciphertext, { SMS_EIN_ENCRYPTION_KEY: newKey, SMS_EIN_ENCRYPTION_KEY_ID: "v2" })).toThrow(/key_missing/);
  });
});
