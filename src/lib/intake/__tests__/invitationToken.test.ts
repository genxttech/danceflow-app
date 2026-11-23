import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INTAKE_ROOT_SECRET_ENV,
  INTAKE_ROOT_SECRET_PREVIOUS_ENV,
  IntakeSecretError,
  decodeSecret,
  deriveEmailCode,
  deriveInvitationToken,
  hashToken,
  keyIdOf,
  loadIntakeKeyring,
  newInvitationMaterial,
  newSessionToken,
  parseInvitationToken,
  rateLimitBucket,
  safeEqualBytes,
  sessionHash,
  toPgBytea,
  tokenFromFragment,
} from "@/lib/intake/invitationToken";

// Test-only values: not real secrets, never used outside this file.
// Test-only 32-byte values (hex); not real secrets.
const SECRET_A = "5b1f0c8a93d24e67a1c0d9b83f4e72156c8a0b9d3e1f47a2b6c5d8e0f9a13c47";
const SECRET_B = "e3a7d19c4b0f58216d9a3c7e1b5f40829ad6c3e8f1b27d405c9a6e3b1d8f7024";
const ID = "a5200000-0000-0000-0000-000000000501";
const SALT = Buffer.from("00112233445566778899aabbccddeeff", "hex");

const ring = (a = SECRET_A, prev?: string) => loadIntakeKeyring({ [INTAKE_ROOT_SECRET_ENV]: a, ...(prev ? { [INTAKE_ROOT_SECRET_PREVIOUS_ENV]: prev } : {}) });

describe("signing key handling", () => {
  it("reads the secret only from the named variable, and has no default", () => {
    expect(INTAKE_ROOT_SECRET_ENV).toBe("INTAKE_ROOT_SECRET");
    expect(() => loadIntakeKeyring({})).toThrow(IntakeSecretError);
    expect(() => loadIntakeKeyring({ [INTAKE_ROOT_SECRET_ENV]: "   " })).toThrow(IntakeSecretError);
  });
  it("accepts exactly 32 decoded bytes in hex, base64 or base64url, and nothing else", () => {
    const bytes = Buffer.from(SECRET_A, "hex");
    for (const form of [SECRET_A, SECRET_A.toUpperCase(), bytes.toString("base64"), bytes.toString("base64url")]) expect(decodeSecret(form)?.equals(bytes)).toBe(true);
    for (const bad of ["", "short-secret", SECRET_A.slice(0, 62), SECRET_A + "00", "z".repeat(64), "00".repeat(32), "ab".repeat(32), "A".repeat(43), Buffer.alloc(31, 7).toString("hex"), Buffer.alloc(33, 7).toString("base64"), "test-only-intake-secret-A-0123456789abcdef"]) expect(decodeSecret(bad)).toBeNull();
    expect(() => loadIntakeKeyring({ [INTAKE_ROOT_SECRET_ENV]: "test-only-intake-secret-A-0123456789abcdef" })).toThrow(IntakeSecretError);
  });
  it("refuses weak secrets and never echoes a secret in an error", () => {
    const weak = "short-secret";
    try {
      loadIntakeKeyring({ [INTAKE_ROOT_SECRET_ENV]: weak });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IntakeSecretError);
      expect(String((e as Error).message)).not.toContain(weak);
    }
    expect(() => loadIntakeKeyring({ [INTAKE_ROOT_SECRET_ENV]: SECRET_A, [INTAKE_ROOT_SECRET_PREVIOUS_ENV]: "weak" })).toThrow(IntakeSecretError);
  });
  it("derives a short key id that does not contain the secret and differs per key", () => {
    const a = ring();
    expect(a.current.kid).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(a.current.kid).not.toContain(SECRET_A.slice(0, 6));
    expect(keyIdOf(Buffer.from(SECRET_A, "hex"))).toBe(a.current.kid);
    expect(ring(SECRET_B).current.kid).not.toBe(a.current.kid);
  });
  it("rejects two identical keys", () => {
    expect(() => ring(SECRET_A, SECRET_A)).toThrow(IntakeSecretError);
  });
});

describe("invitation token", () => {
  const parts = { invitationId: ID, generation: 1, tokenSalt: SALT };
  it("is deterministic: a retry re-derives identical bytes", () => {
    expect(deriveInvitationToken(ring(), parts)).toBe(deriveInvitationToken(ring(), parts));
  });
  it("has the strict shape kid.mac, never contains the secret, id, or salt in clear", () => {
    const token = deriveInvitationToken(ring(), parts);
    expect(token).toMatch(/^[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(`${ring().current.kid}.`)).toBe(true);
    for (const leak of [SECRET_A, ID, ID.replace(/-/g, ""), SALT.toString("hex"), SALT.toString("base64url")]) expect(token).not.toContain(leak);
  });
  it("changes with the generation, the salt, the invitation id and the key", () => {
    const base = deriveInvitationToken(ring(), parts);
    expect(deriveInvitationToken(ring(), { ...parts, generation: 2 })).not.toBe(base);
    expect(deriveInvitationToken(ring(), { ...parts, tokenSalt: Buffer.alloc(16, 7) })).not.toBe(base);
    expect(deriveInvitationToken(ring(), { ...parts, invitationId: "a5200000-0000-0000-0000-000000000502" })).not.toBe(base);
    expect(deriveInvitationToken(ring(SECRET_B), parts)).not.toBe(base);
  });
  it("re-derives with a previous key during rotation and refuses an unknown key id", () => {
    const old = deriveInvitationToken(ring(SECRET_A), parts);
    const rotated = ring(SECRET_B, SECRET_A);
    expect(deriveInvitationToken(rotated, parts, keyIdOf(Buffer.from(SECRET_A, "hex")))).toBe(old);
    expect(deriveInvitationToken(rotated, parts)).not.toBe(old);
    expect(() => deriveInvitationToken(ring(SECRET_B), parts, keyIdOf(Buffer.from(SECRET_A, "hex")))).toThrow(IntakeSecretError);
  });
  it("validates its inputs", () => {
    expect(() => deriveInvitationToken(ring(), { ...parts, generation: 0 })).toThrow(RangeError);
    expect(() => deriveInvitationToken(ring(), { ...parts, generation: 1.5 })).toThrow(RangeError);
    expect(() => deriveInvitationToken(ring(), { ...parts, tokenSalt: Buffer.alloc(8) })).toThrow(RangeError);
    expect(() => deriveInvitationToken(ring(), { ...parts, invitationId: "not-a-uuid" })).toThrow(TypeError);
  });
  it("generates fresh, well-formed material for each invitation", () => {
    const a = newInvitationMaterial();
    const b = newInvitationMaterial();
    expect(a.invitationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.tokenSalt.length).toBe(16);
    expect(a.invitationId).not.toBe(b.invitationId);
    expect(a.tokenSalt.equals(b.tokenSalt)).toBe(false);
  });
});

describe("parsing and hashing", () => {
  const token = deriveInvitationToken(ring(), { invitationId: ID, generation: 3, tokenSalt: SALT });
  it("accepts only the exact token shape; everything else is just not a token", () => {
    expect(parseInvitationToken(token)).toEqual({ kid: ring().current.kid, mac: token.split(".")[1] });
    for (const bad of ["", "abc", `${token}x`, `x${token}`, token.replace(".", ":"), `${token} `, null, undefined, 5, {}, "a.b"]) expect(parseInvitationToken(bad)).toBeNull();
  });
  it("hashes to 32 bytes, deterministically, and formats as Postgres bytea hex", () => {
    const h = hashToken(token);
    expect(h.length).toBe(32);
    expect(hashToken(token).equals(h)).toBe(true);
    expect(hashToken(`${token}0`).equals(h)).toBe(false);
    expect(toPgBytea(h)).toBe(`\\x${h.toString("hex")}`);
    expect(toPgBytea(h)).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(h.toString("hex")).not.toContain(Buffer.from(token).toString("hex"));
  });
  it("extracts the token from a link fragment and rejects other fragments", () => {
    expect(tokenFromFragment(`#t=${token}`)).toBe(token);
    expect(tokenFromFragment(`t=${token}`)).toBe(token);
    for (const bad of ["", "#", "#t=", "#t=short", `#x=${token}`, `#t=${token}&y=1`, `#t=${token}/../`]) expect(tokenFromFragment(bad)).toBeNull();
  });
  it("compares bytes in constant time and refuses different lengths", () => {
    const h = hashToken(token);
    expect(safeEqualBytes(h, Buffer.from(h))).toBe(true);
    expect(safeEqualBytes(h, hashToken("other"))).toBe(false);
    expect(safeEqualBytes(h, h.subarray(0, 31))).toBe(false);
  });
});

describe("session token", () => {
  it("is 256 random bits, unique, and only its hash is meant to be stored", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(sessionHash(a).length).toBe(32);
    expect(sessionHash(a).equals(sessionHash(a))).toBe(true);
    expect(sessionHash(a).equals(sessionHash(b))).toBe(false);
  });
});

describe("guardian email code", () => {
  const C1 = "a5200000-0000-0000-0000-0000000000c1";
  const C2 = "a5200000-0000-0000-0000-0000000000c2";
  it("is six digits, derived from the challenge id, and identical on every retry", () => {
    const code = deriveEmailCode(ring(), C1);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(deriveEmailCode(ring(), C1)).toBe(code);
  });
  it("differs per challenge and per key, and re-derives with a previous key", () => {
    expect(deriveEmailCode(ring(), C1)).not.toBe(deriveEmailCode(ring(), C2));
    expect(deriveEmailCode(ring(SECRET_B), C1)).not.toBe(deriveEmailCode(ring(), C1));
    expect(deriveEmailCode(ring(SECRET_B, SECRET_A), C1, keyIdOf(Buffer.from(SECRET_A, "hex")))).toBe(deriveEmailCode(ring(SECRET_A), C1));
  });
  it("is roughly uniform over many challenges (no obvious digit bias) and never repeats a long run", () => {
    const counts = new Array(10).fill(0);
    const total = 600;
    for (let i = 0; i < total; i += 1) {
      const id = `a5200000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      for (const ch of deriveEmailCode(ring(), id)) counts[Number(ch)] += 1;
    }
    const expected = (total * 6) / 10;
    for (const c of counts) expect(Math.abs(c - expected)).toBeLessThan(expected * 0.25);
  });
});

describe("rate-limit keys", () => {
  it("is a keyed 32-byte value: no raw email, address or token, a different key gives different buckets, and the window length is part of the key", () => {
    const e = rateLimitBucket(ring(), "email", 600, "Parent@Example.com");
    expect(e.length).toBe(32);
    expect(e.toString("hex")).not.toContain(Buffer.from("parent@example.com").toString("hex"));
    expect(rateLimitBucket(ring(), "email", 600, "  parent@example.com ").equals(e)).toBe(true);
    expect(rateLimitBucket(ring(SECRET_B), "email", 600, "parent@example.com").equals(e)).toBe(false);
    expect(rateLimitBucket(ring(), "email", 900, "parent@example.com").equals(e)).toBe(false);
    expect(rateLimitBucket(ring(), "ip", 600, "203.0.113.9").equals(rateLimitBucket(ring(), "request", 600, "203.0.113.9"))).toBe(false);
    expect(rateLimitBucket(ring(), "ip", 600, "203.0.113.9").equals(rateLimitBucket(ring(), "ip", 600, "203.0.113.10"))).toBe(false);
  });
  it("is not the plain hash of its inputs (a database reader cannot test guesses without the secret)", () => {
    const plain = createHash("sha256").update("intake/rate/v1|email|parent@example.com", "utf8").digest();
    expect(rateLimitBucket(ring(), "email", 600, "parent@example.com").equals(plain)).toBe(false);
    expect(rateLimitBucket(ring(), "email", 600, "parent@example.com").equals(createHash("sha256").update("email0600parent@example.com").digest())).toBe(false);
  });
  it("refuses an empty value and an out-of-range window", () => {
    expect(() => rateLimitBucket(ring(), "ip", 600, "  ")).toThrow(RangeError);
    expect(() => rateLimitBucket(ring(), "ip", 5, "x")).toThrow(RangeError);
    expect(() => rateLimitBucket(ring(), "ip", 100000, "x")).toThrow(RangeError);
    expect(() => rateLimitBucket(ring(), "ip", 60.5, "x")).toThrow(RangeError);
  });
});
