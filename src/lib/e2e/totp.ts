import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 6238 time-based one-time password (HMAC-SHA1, 30 second step, 6 digits) for a base32 secret. Used only by the E2E harness to answer the
 * platform admin authenticator challenge against the LOCAL QA auth service; the app itself never computes codes.
 */
export function totp(secretBase32: string, at = Date.now()): string {
  const clean = secretBase32.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("not a base32 secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}
