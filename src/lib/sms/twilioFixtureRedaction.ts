import { createHmac, randomBytes } from "node:crypto";
import { classifyInboundKeywordBody } from "./inboundKeywords";

/**
 * TW-4F fixture capture (docs/twilio/TW-4F_Twilio_Fixture_Capture.md §4): turns raw Twilio Message JSON, list pages and webhook parameter sets into
 * repo-safe fixtures. Field names, nulls, types, date formats and value SHAPES are kept; every identifier, number, body, place and media link is replaced.
 *
 *   - every SID-shaped value (two letters + 32 hex) becomes a synthetic one with the SAME prefix, consistently (identity checks still hold);
 *   - every phone number becomes a 555-01xx fiction number, consistently;
 *   - PageToken values, media URLs and geo fields (city / state / zip / country) are replaced with fixed values;
 *   - a body that is exactly an opt-out / opt-in / help keyword keeps its keyword class and case pattern; any other body becomes filler of the same length
 *     and encoding class (GSM-7 stays GSM-7, anything else stays UCS-2);
 *   - error_message / ErrorMessage text is kept only when it is a short fixed Twilio phrase, else dropped.
 * The mapping key is random per run and never written, so a synthetic value cannot be mapped back.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const SID = /\b([A-Z]{2})([0-9a-fA-F]{32})\b/g;
const PHONE = /\+[1-9][0-9]{7,14}\b/g;   // any E.164 number, not only US
const PAGE_TOKEN = /(PageToken(?:=|%3D))([A-Za-z0-9_-]+)/g;
const GEO_KEYS: Record<string, string> = {
  FromCity: "AUSTIN", ToCity: "AUSTIN", FromState: "TX", ToState: "TX", FromZip: "78701", ToZip: "78701", FromCountry: "US", ToCountry: "US",
};
const BODY_KEYS = new Set(["body", "Body"]);
const MEDIA_KEY = /^MediaUrl[0-9]+$/;
const ERROR_TEXT_KEYS = new Set(["error_message", "ErrorMessage"]);
const SAFE_ERROR_TEXT = /^[A-Za-z][A-Za-z ,.'-]{0,60}$/;
// GSM-7 basic set plus the extension table (a body made only of these is GSM-7)
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

export type Redactor = { redact: (value: unknown) => Json; phones: () => number; sids: () => number };

export function createRedactor(key: Buffer = randomBytes(32)): Redactor {
  const phoneMap = new Map<string, string>();
  const sidMap = new Map<string, string>();
  const synthSid = (prefix: string, hex: string) => {
    const original = `${prefix}${hex.toLowerCase()}`;
    let mapped = sidMap.get(original);
    if (!mapped) {
      mapped = prefix + createHmac("sha256", key).update(original).digest("hex").slice(0, 32);
      sidMap.set(original, mapped);
    }
    return mapped;
  };
  const synthPhone = (phone: string) => {
    let mapped = phoneMap.get(phone);
    if (!mapped) {
      mapped = `+1555010${String(100 + phoneMap.size).padStart(4, "0")}`;
      phoneMap.set(phone, mapped);
    }
    return mapped;
  };
  const scrubText = (text: string) =>
    text.replace(SID, (_m, p: string, h: string) => synthSid(p, h)).replace(PHONE, (p) => synthPhone(p)).replace(PAGE_TOKEN, (_m, k: string) => `${k}PAredacted0000`);

  const redactBody = (body: string) => {
    if (body === "") return "";
    if (classifyInboundKeywordBody(body) !== "message") return body;   // a bare keyword (STOP, unstop, Help): its class is the evidence
    return GSM7.test(body) ? "x".repeat(body.length) : "é中".repeat(Math.ceil(body.length / 2)).slice(0, body.length);
  };

  const walk = (value: unknown, key?: string): Json => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value as Json;
    if (typeof value === "string") {
      if (key && BODY_KEYS.has(key)) return redactBody(value);
      if (key && key in GEO_KEYS) return GEO_KEYS[key];
      if (key && MEDIA_KEY.test(key)) return "https://api.twilio.com/2010-04-01/Accounts/ACredacted/Messages/MMredacted/Media/MEredacted";
      if (key && ERROR_TEXT_KEYS.has(key)) return SAFE_ERROR_TEXT.test(value) ? value : "redacted";
      return scrubText(value);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (typeof value === "object") {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    return null;
  };
  return { redact: (value) => walk(value), phones: () => phoneMap.size, sids: () => sidMap.size };
}

/** Anything still looking like a real identifier after redaction (a non-fiction phone number or a known secret-bearing key): must be empty. */
export function residualIdentifiers(value: Json): string[] {
  const text = JSON.stringify(value);
  const left: string[] = [];
  for (const phone of text.match(PHONE) ?? []) if (!/^\+1555010[0-9]{4}$/.test(phone)) left.push(phone);
  if (/auth_?token|"password"|x-twilio-signature|authorization/i.test(text)) left.push("secret-bearing key");
  return left;
}
