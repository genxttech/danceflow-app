import { createCipheriv, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { activeIntegrationKeyId, decryptIntegrationSecret, encryptIntegrationSecret, encryptIntegrationSecretV2, integrationSecretKeyId } from "../vault";
import * as legacyModule from "../wave/secrets";

const K1 = "00".repeat(32);
const K2 = Buffer.alloc(32, 7).toString("base64");

/** Ciphertext produced by the pre-vault implementation (fixed iv, key K1): must keep decrypting forever. */
function legacyFixture(plain: string) {
  const iv = Buffer.alloc(12, 3);
  const c = createCipheriv("aes-256-gcm", Buffer.from(K1, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

beforeEach(() => {
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = K1;
  delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS;
  delete process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID;
});

describe("S0-g1 integration vault", () => {
  it("decrypts pre-existing v1 ciphertexts and round-trips new v1", () => {
    expect(decryptIntegrationSecret(legacyFixture("refresh-token-abc"))).toBe("refresh-token-abc");
    const v1 = encryptIntegrationSecret("hello");
    expect(v1.startsWith("v1.")).toBe(true);
    expect(decryptIntegrationSecret(v1)).toBe("hello");
  });

  it("the old module path still exports the same functions", () => {
    expect(legacyModule.decryptIntegrationSecret(legacyFixture("x"))).toBe("x");
    expect(legacyModule.encryptIntegrationSecret("y").startsWith("v1.")).toBe(true);
  });

  it("v2 carries the key id and binds the context", () => {
    const v2 = encryptIntegrationSecretV2("secret", "google_calendar:refresh");
    expect(v2.split(".")[0]).toBe("v2");
    expect(v2.split(".")[1]).toBe("k1");
    expect(decryptIntegrationSecret(v2, "google_calendar:refresh")).toBe("secret");
    expect(() => decryptIntegrationSecret(v2, "wave:refresh")).toThrow();
    expect(() => decryptIntegrationSecret(v2)).toThrow();
  });

  it("rotation: both keys decrypt; new secrets use the active key; removing a key fails closed", () => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = JSON.stringify({ k2: K2 });
    const oldV2 = encryptIntegrationSecretV2("a", "c");
    process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID = "k2";
    expect(activeIntegrationKeyId()).toBe("k2");
    const newV2 = encryptIntegrationSecretV2("b", "c");
    expect(integrationSecretKeyId(newV2)).toBe("k2");
    expect(integrationSecretKeyId(oldV2)).toBe("k1");
    expect(decryptIntegrationSecret(oldV2, "c")).toBe("a");
    expect(decryptIntegrationSecret(newV2, "c")).toBe("b");
    expect(integrationSecretKeyId(legacyFixture("z"))).toBe("k1");
    delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS;
    expect(() => decryptIntegrationSecret(newV2, "c")).toThrow(/not configured/);
    expect(decryptIntegrationSecret(oldV2, "c")).toBe("a");
  });

  it("rejects tampering, malformed values, bad key material and bad key ids", () => {
    const v2 = encryptIntegrationSecretV2("secret");
    const parts = v2.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptIntegrationSecret(parts.join("."))).toThrow();
    expect(() => decryptIntegrationSecret("v3.a.b.c")).toThrow(/Unsupported/);
    expect(() => decryptIntegrationSecret("v2.BAD KID.a.b.c")).toThrow(/Unsupported/);
    expect(() => decryptIntegrationSecret("v1.a.b")).toThrow(/Unsupported/);
    expect(integrationSecretKeyId("garbage")).toBeNull();
    process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID = "k2";
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = "not json";
    expect(() => encryptIntegrationSecretV2("x")).toThrow(/JSON/);
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = JSON.stringify({ k2: "short" });
    expect(() => encryptIntegrationSecretV2("x")).toThrow(/32 bytes/);
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = JSON.stringify({ k2: 5 });
    expect(() => encryptIntegrationSecretV2("x")).toThrow(/key value/);
    delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS;
    delete process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID;
    process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID = "nope";
    expect(() => encryptIntegrationSecretV2("x")).toThrow(/not configured/);
    process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID = "bad id";
    expect(() => encryptIntegrationSecretV2("x")).toThrow(/key id/);
  });

  it("a broken or hostile rotation keyring never affects k1 (legacy) secrets", () => {
    const v1 = legacyFixture("keep-me");
    const v2 = encryptIntegrationSecretV2("also", "ctx");
    for (const bad of ["not json", "[]", JSON.stringify({ "Bad.Kid": K2 }), JSON.stringify({ k1: K2 }), JSON.stringify({ k2: "short" })]) {
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = bad;
      expect(decryptIntegrationSecret(v1)).toBe("keep-me");
      expect(decryptIntegrationSecret(v2, "ctx")).toBe("also");
    }
  });

  it("the key id is authenticated and short tags or ivs are refused", () => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEYS = JSON.stringify({ k2: K1 });
    const v2 = encryptIntegrationSecretV2("s", "c");
    const parts = v2.split(".");
    expect(() => decryptIntegrationSecret(["v2", "k2", ...parts.slice(2)].join("."), "c")).toThrow();
    const shortTag = [...parts]; shortTag[3] = Buffer.alloc(4).toString("base64url");
    expect(() => decryptIntegrationSecret(shortTag.join("."), "c")).toThrow(/Unsupported/);
    const shortIv = [...parts]; shortIv[2] = Buffer.alloc(8).toString("base64url");
    expect(() => decryptIntegrationSecret(shortIv.join("."), "c")).toThrow(/Unsupported/);
  });

  it("each encryption uses a fresh iv", () => {
    expect(encryptIntegrationSecretV2("same")).not.toBe(encryptIntegrationSecretV2("same"));
    void randomBytes;
  });
});
