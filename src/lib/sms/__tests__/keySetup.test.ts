import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b64uToBytes, bootstrapStatement, counterNote, keyRefusal, parseAuthDataFlags, parseSignCount, spkiToXY, toHex } from "@/lib/sms/keySetup";

const authData = (flags: number) => {
  const b = new Uint8Array(37);
  b[32] = flags;
  return b;
};

describe("hardware key setup helpers", () => {
  it("extracts x and y from a real P-256 SubjectPublicKeyInfo (the same bytes the database stores)", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const { x, y } = spkiToXY(spki);
    expect(toHex(x)).toBe(Buffer.from(jwk.x, "base64url").toString("hex"));
    expect(toHex(y)).toBe(Buffer.from(jwk.y, "base64url").toString("hex"));
    expect(x).toHaveLength(32);
    expect(y).toHaveLength(32);
  });

  it("refuses a key that is not an uncompressed point or is too short", () => {
    expect(() => spkiToXY(new Uint8Array(10))).toThrow();
    const bad = new Uint8Array(91);
    bad[91 - 65] = 0x02;
    expect(() => spkiToXY(bad)).toThrow();
  });

  it("reads the authenticator flags and applies the database rule (UP and UV required; synced passkeys refused)", () => {
    expect(keyRefusal(parseAuthDataFlags(authData(0x01 | 0x04 | 0x40)))).toBeNull(); // device-bound security key with PIN
    expect(keyRefusal(parseAuthDataFlags(authData(0x01 | 0x40)))).toMatch(/verify you/); // no user verification
    expect(keyRefusal(parseAuthDataFlags(authData(0x04 | 0x40)))).toMatch(/presence/);
    expect(keyRefusal(parseAuthDataFlags(authData(0x01 | 0x04 | 0x08 | 0x40)))).toMatch(/synced passkey/); // backup eligible
    expect(keyRefusal(parseAuthDataFlags(authData(0x01 | 0x04 | 0x08 | 0x10 | 0x40)))).toMatch(/synced passkey/); // backed up
    expect(() => parseAuthDataFlags(new Uint8Array(10))).toThrow();
  });

  it("reads the signature counter (big endian) and explains zero versus counting authenticators", () => {
    const ad = new Uint8Array(37);
    ad.set([0x01, 0x02, 0x03, 0x04], 33);
    expect(parseSignCount(ad)).toBe(0x01020304);
    expect(parseSignCount(new Uint8Array(37))).toBe(0);
    ad.set([0xff, 0xff, 0xff, 0xff], 33);
    expect(parseSignCount(ad)).toBe(4294967295);
    expect(counterNote(0)).toMatch(/cannot be detected by the counter/);
    expect(counterNote(7)).toMatch(/clone detection stays on/);
    expect(() => parseSignCount(new Uint8Array(5))).toThrow();
  });

  it("round-trips base64url", () => {
    const b = randomBytes(40);
    expect(toHex(b64uToBytes(b.toString("base64url")))).toBe(b.toString("hex"));
  });

  it("builds the owner-level bootstrap statement with only public values, quoted safely", () => {
    const k = (n: number, label: string) => ({ label, credentialId: new Uint8Array(32).fill(n), x: new Uint8Array(32).fill(n + 1), y: new Uint8Array(32).fill(n + 2) });
    const sql = bootstrapStatement({ rpId: "www.idanceflow.com", origin: "https://www.idanceflow.com", primary: k(1, "owner's key"), recovery: k(10, "recovery key") });
    expect(sql).toMatch(/^select public\._tw4price_bootstrap_with_recovery\(/);
    expect(sql).toContain("'www.idanceflow.com', array['https://www.idanceflow.com']");
    expect(sql).toContain("'owner''s key'");
    expect(sql.match(/decode\('[0-9a-f]{64}', 'hex'\)/g)).toHaveLength(6);
    expect(sql).not.toMatch(/private/i);
  });
});
