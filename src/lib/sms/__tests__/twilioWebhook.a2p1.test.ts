import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

vi.mock("server-only", () => ({}));

import {
  resolveTwilioSignedUrl,
  twilioFormParams,
  verifyTwilioWebhook,
} from "@/lib/sms/twilioWebhook";

/** A2P-1A: Twilio webhook signature verification (fake test token only). */

const TEST_TOKEN = "fake-test-auth-token";
const URL_WITH_QUERY = "https://www.idanceflow.com/api/sms/twilio/status?secret=fake-callback-secret";
const PARAMS = { MessageSid: "SMtest123", MessageStatus: "delivered", From: "+15550100123" };

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = savedToken;
  vi.restoreAllMocks();
});

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers });
}

describe("verifyTwilioWebhook", () => {
  it("accepts a correctly signed request (full URL including query string)", () => {
    const signature = getExpectedTwilioSignature(TEST_TOKEN, URL_WITH_QUERY, PARAMS);

    expect(verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": signature }), PARAMS)).toEqual({
      ok: true,
    });
  });

  it("rejects an invalid signature with 403", () => {
    const result = verifyTwilioWebhook(
      request(URL_WITH_QUERY, { "x-twilio-signature": "bm90LWEtdmFsaWQtc2lnbmF0dXJl" }),
      PARAMS,
    );

    expect(result).toEqual({ ok: false, status: 403, reason: "twilio_signature_invalid" });
  });

  it("rejects a signature computed over tampered parameters", () => {
    const signature = getExpectedTwilioSignature(TEST_TOKEN, URL_WITH_QUERY, PARAMS);
    const result = verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": signature }), {
      ...PARAMS,
      MessageStatus: "failed",
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a signature signed with a different token", () => {
    const signature = getExpectedTwilioSignature("some-other-token", URL_WITH_QUERY, PARAMS);
    const result = verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": signature }), PARAMS);

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a missing signature with 403", () => {
    expect(verifyTwilioWebhook(request(URL_WITH_QUERY), PARAMS)).toEqual({
      ok: false,
      status: 403,
      reason: "twilio_signature_missing",
    });
  });

  it("fails closed with 503 when the auth token is not configured", () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const signature = getExpectedTwilioSignature(TEST_TOKEN, URL_WITH_QUERY, PARAMS);

    expect(verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": signature }), PARAMS)).toEqual({
      ok: false,
      status: 503,
      reason: "twilio_auth_token_missing",
    });
  });

  it("validates against the forwarded public URL when behind a proxy", () => {
    const internalUrl = "http://internal-host:3000/api/sms/twilio/status?secret=fake-callback-secret";
    const signature = getExpectedTwilioSignature(TEST_TOKEN, URL_WITH_QUERY, PARAMS);
    const proxied = request(internalUrl, {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "www.idanceflow.com",
      "x-twilio-signature": signature,
    });

    expect(resolveTwilioSignedUrl(proxied)).toBe(URL_WITH_QUERY);
    expect(verifyTwilioWebhook(proxied, PARAMS)).toEqual({ ok: true });
  });

  it("never logs the token or signatures", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const signature = getExpectedTwilioSignature(TEST_TOKEN, URL_WITH_QUERY, PARAMS);

    verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": signature }), PARAMS);
    verifyTwilioWebhook(request(URL_WITH_QUERY, { "x-twilio-signature": "invalid" }), PARAMS);
    verifyTwilioWebhook(request(URL_WITH_QUERY), PARAMS);

    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain(TEST_TOKEN);
    expect(logged).not.toContain(signature);
  });
});

describe("twilioFormParams", () => {
  it("keeps string fields only", () => {
    const formData = new FormData();
    formData.set("Body", "STOP");
    formData.set("From", "+15550100123");
    formData.set("Media", new Blob(["x"]), "file.txt");

    expect(twilioFormParams(formData)).toEqual({ Body: "STOP", From: "+15550100123" });
  });
});
