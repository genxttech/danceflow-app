import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor, residualIdentifiers } from "../twilioFixtureRedaction";

/** The capture redactor (docs/twilio/TW-4F_Twilio_Fixture_Capture.md §4) on raw-looking Twilio payloads. No network. */

const REAL_ACCOUNT = `AC${"3f".repeat(16)}`;
const REAL_SID = `SM${"9c".repeat(16)}`;
const REAL_PHONE = "+14155552671";
const UK_PHONE = "+447911123456";
const key = Buffer.alloc(32, 7);

const raw = {
  sid: REAL_SID, account_sid: REAL_ACCOUNT, messaging_service_sid: `MG${"1a".repeat(16)}`, from: REAL_PHONE, to: "+15125550100", status: "undelivered",
  body: "Hi Jordan, your lesson moved to 6pm", num_segments: "1", price: "-0.00830", price_unit: "USD", error_code: 30034,
  error_message: "Message from an Unregistered Number", date_created: "Sat, 14 Nov 2026 15:00:00 +0000", date_sent: null,
  uri: `/2010-04-01/Accounts/${REAL_ACCOUNT}/Messages/${REAL_SID}.json`,
  subresource_uris: { media: `/2010-04-01/Accounts/${REAL_ACCOUNT}/Messages/${REAL_SID}/Media.json` },
};

describe("Twilio fixture redaction", () => {
  it("replaces identifiers consistently, keeping prefix, length, nulls, types and date formats", () => {
    const r = createRedactor(key);
    const out = r.redact(raw) as Record<string, unknown>;
    expect(out.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(out.sid).not.toBe(REAL_SID);
    expect(out.account_sid).toMatch(/^AC[0-9a-f]{32}$/);
    expect(out.uri).toBe(`/2010-04-01/Accounts/${out.account_sid}/Messages/${out.sid}.json`);   // the same SID maps to the same value everywhere
    expect(out.from).toMatch(/^\+1555010[0-9]{4}$/);
    expect(out.to).toMatch(/^\+1555010[0-9]{4}$/);
    expect(out.from).not.toBe(out.to);
    expect(out).toMatchObject({ status: "undelivered", num_segments: "1", price: "-0.00830", error_code: 30034, date_sent: null, date_created: raw.date_created });
    expect(Object.keys(out)).toEqual(Object.keys(raw));
    expect(JSON.stringify(out)).not.toMatch(/Jordan|4155552671|3f3f3f|9c9c9c/);
    expect(residualIdentifiers(out as never)).toEqual([]);
  });

  it("keeps a bare keyword's class (it is the evidence) and replaces any other body with same-length filler of the same encoding", () => {
    const r = createRedactor(key);
    expect(r.redact({ Body: "Stop" })).toEqual({ Body: "Stop" });
    expect(r.redact({ Body: "unstop" })).toEqual({ Body: "unstop" });
    expect(r.redact({ Body: "" })).toEqual({ Body: "" });
    const gsm = r.redact({ body: "See you Thursday!" }) as { body: string };
    expect(gsm.body).toBe("x".repeat(17));
    const ucs2 = r.redact({ body: "Merci 😀 à jeudi" }) as { body: string };
    expect(ucs2.body).toHaveLength("Merci 😀 à jeudi".length);
    expect(ucs2.body).not.toMatch(/Merci|jeudi/);
    expect(/^[\x20-\x7e]*$/.test(ucs2.body)).toBe(false);   // still UCS-2
  });

  it("webhook parameters: geo fields, media links, page tokens and non-US numbers are replaced", () => {
    const r = createRedactor(key);
    const out = r.redact({
      FromCity: "SAN FRANCISCO", FromZip: "94103", FromState: "CA", FromCountry: "US", From: UK_PHONE, To: REAL_PHONE,
      MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${REAL_ACCOUNT}/Messages/${REAL_SID}/Media/ME${"ab".repeat(16)}`,
      next_page_uri: `/2010-04-01/Accounts/${REAL_ACCOUNT}/Messages.json?To=%2B14155552671&PageSize=2&Page=1&PageToken=PASM${"9c".repeat(16)}`,
      ErrorMessage: `Delivery to ${REAL_PHONE} failed: see https://example.invalid/x?token=abc`,
    }) as Record<string, string>;
    expect(out).toMatchObject({ FromCity: "AUSTIN", FromZip: "78701", FromState: "TX", ErrorMessage: "redacted" });
    expect(out.From).toMatch(/^\+1555010[0-9]{4}$/);
    expect(out.MediaUrl0).not.toContain(REAL_ACCOUNT);
    expect(out.next_page_uri).toContain("PageToken=PAredacted0000");
    expect(out.next_page_uri).not.toContain("9c9c");
    expect(residualIdentifiers(out as never)).toEqual([]);
  });

  it("a different run key gives different synthetic values (nothing maps back)", () => {
    const a = createRedactor(Buffer.alloc(32, 1)).redact({ sid: REAL_SID }) as { sid: string };
    const b = createRedactor(Buffer.alloc(32, 2)).redact({ sid: REAL_SID }) as { sid: string };
    expect(a.sid).not.toBe(b.sid);
  });

  it("residualIdentifiers flags anything that slipped through", () => {
    expect(residualIdentifiers({ to: REAL_PHONE })).toEqual([REAL_PHONE]);
    expect(residualIdentifiers({ auth_token: "x" })).toEqual(["secret-bearing key"]);
  });

  it("the documented fixtures are already redaction-stable (fiction numbers only)", () => {
    const doc = JSON.parse(readFileSync(path.join(process.cwd(), "src/lib/sms/__tests__/fixtures/twilio/documentedShapes.json"), "utf8"));
    expect(residualIdentifiers(doc)).toEqual([]);
  });
});
