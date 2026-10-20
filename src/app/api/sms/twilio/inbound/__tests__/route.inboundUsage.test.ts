import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * TW-4F inbound usage: D3 (error replies at most one per sender per day, fail closed), D2 (HELP/START confirmations fail open, STOP always sent)
 * and the optional usage recording (SMS_INBOUND_RECORDING=on) that runs after a message's own effects.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";
import { SMS_UNROUTED_REPLY, buildSmsHelpReply, buildSmsStopReply } from "@/lib/sms/compliance";

const TEST_TOKEN = "fake-test-auth-token";
const WEBHOOK_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const SENDER_A = "+15550109999";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const GOOD_SID = `SM${"0a".repeat(16)}`;
const EMPTY_TWIML = "<Response></Response>";
const BODY_TEXT = "private words about my lesson";

function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const db = createBaseFake({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }],
    studio_sms_registrations: [
      {
        id: "reg-a",
        studio_id: STUDIO_A,
        messaging_service_sid: SERVICE_A,
        campaign_sid: `QE${"0f".repeat(16)}`,
        sender_e164: SENDER_A,
        registration_status: "approved",
      },
    ],
    sms_contact_permissions: [
      {
        id: "p1",
        studio_id: STUDIO_A,
        organizer_id: null,
        client_id: "33333333-3333-4333-8333-333333333333",
        organizer_contact_id: null,
        phone_e164: PHONE,
        consent_status: "opted_in",
        consent_source: "public_lead_form",
        consent_at: "2026-09-01T00:00:00.000Z",
        opted_out_at: null,
        opted_out_source: null,
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    ...seed,
  });
  db.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: true, error: null }));
  db.overrideRpc("tw4_inbound_record", () => ({
    data: { recorded: true, replayed: false, charged_cents: 3, uncollected_cents: 0 },
    error: null,
  }));
  return db;
}

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SMS_INBOUND_RECORDING"] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function inboundRequest(
  body: string,
  options: { sign?: "valid" | "invalid"; to?: string; sid?: string | null; segments?: string; media?: string; optOutType?: string } = {},
) {
  const params: Record<string, string> = { From: PHONE, To: options.to ?? SENDER_A, Body: body };
  if (options.sid !== null) params.MessageSid = options.sid ?? GOOD_SID;
  if (options.segments !== undefined) params.NumSegments = options.segments;
  if (options.media !== undefined) params.NumMedia = options.media;
  if (options.optOutType !== undefined) params.OptOutType = options.optOutType;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-for": `203.0.113.${++ipCounter % 250}`,
    "x-twilio-signature":
      options.sign === "invalid" ? "aW52YWxpZC1zaWduYXR1cmU=" : getExpectedTwilioSignature(TEST_TOKEN, WEBHOOK_URL, params),
  };
  return new Request(WEBHOOK_URL, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}

const calls = (name: string) => fake.current!.rpcCalls.filter((c) => c.name === name);
const xmlEscape = (v: string) => v.replace(/&/g, "&amp;").replace(/'/g, "&apos;");

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  delete process.env.SMS_INBOUND_RECORDING;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("error replies are rationed (D3, fail closed)", () => {
  // an unrouted message is the simplest error path that reaches the counter
  const unrouted = () => inboundRequest("hello", { to: "+15550107777" });

  it("is sent once when the counter allows it, with limit 1 and a hashed sender", async () => {
    fake.current = createFakeSupabase();
    const xml = await (await POST(unrouted())).text();
    expect(xml).toContain(xmlEscape(SMS_UNROUTED_REPLY));
    const [call] = calls("tw4_inbound_reply_allowed");
    expect(call.args).toMatchObject({ p_kind: "error_unrouted", p_limit: 1, p_account_sid: null });
    expect(String(call.args.p_sender_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call.args)).not.toContain("5550100123");
  });

  it.each([
    ["false", () => ({ data: false, error: null })],
    ["an rpc error", () => ({ data: null, error: { code: "XX001", message: "boom" } })],
    ["null", () => ({ data: null, error: null })],
    ["a truthy non-boolean string", () => ({ data: "true", error: null })],
    ["the number 1", () => ({ data: 1, error: null })],
  ])("is empty when the counter answers %s", async (_n, handler) => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", handler);
    expect(await (await POST(unrouted())).text()).toBe(EMPTY_TWIML);
  });

  it("is empty when the counter throws", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => {
      throw new Error("network");
    });
    expect(await (await POST(unrouted())).text()).toBe(EMPTY_TWIML);
  });

  it("the unavailable message is empty when there is no database client (cannot be counted)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    fake.current = createFakeSupabase();
    expect(await (await POST(inboundRequest("hello"))).text()).toBe(EMPTY_TWIML);
    expect(calls("tw4_inbound_reply_allowed")).toHaveLength(0);
  });

  it("a Twilio-handled keyword gets no error reply and does not consult the counter", async () => {
    fake.current = createFakeSupabase();
    const xml = await (await POST(inboundRequest("STOP", { to: "+15550107777", optOutType: "STOP" }))).text();
    expect(xml).toBe(EMPTY_TWIML);
    expect(calls("tw4_inbound_reply_allowed")).toHaveLength(0);
  });

  it("an invalid MessageSid reply is counted under its own kind", async () => {
    fake.current = createFakeSupabase();
    const response = await POST(inboundRequest("hello", { sid: "x".repeat(100) }));
    expect(await response.text()).toContain("could not process");
    expect(calls("tw4_inbound_reply_allowed")[0].args).toMatchObject({ p_kind: "error_invalid", p_limit: 1 });
  });
});

describe("HELP / START confirmations (D2, fail open) and STOP (always)", () => {
  it.each(["HELP", "START"])("%s is sent when the counter allows it (limit 5)", async (word) => {
    fake.current = createFakeSupabase();
    const xml = await (await POST(inboundRequest(word))).text();
    expect(xml).toContain("<Message>");
    const [call] = calls("tw4_inbound_reply_allowed");
    expect(call.args).toMatchObject({ p_kind: word.toLowerCase(), p_limit: 5 });
    expect(String(call.args.p_sender_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["an rpc error", () => ({ data: null, error: { code: "XX001", message: "x" } })],
    ["null", () => ({ data: null, error: null })],
    ["a non-boolean", () => ({ data: "no", error: null })],
  ])("HELP and START are still sent when the counter answers %s", async (_n, handler) => {
    for (const word of ["HELP", "START"]) {
      fake.current = createFakeSupabase();
      fake.current.overrideRpc("tw4_inbound_reply_allowed", handler);
      expect(await (await POST(inboundRequest(word))).text(), word).toContain("<Message>");
    }
  });

  it("HELP and START are empty only when the counter answers exactly false, and consent still changes", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: false, error: null }));
    expect(await (await POST(inboundRequest("HELP"))).text()).toBe(EMPTY_TWIML);
    expect(await (await POST(inboundRequest("START"))).text()).toBe(EMPTY_TWIML);
    expect(calls("record_sms_inbound_opt_event").map((c) => c.args.p_event)).toEqual(["start"]);
  });

  it("STOP always replies and never calls the counter, even if the counter would say false", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: false, error: null }));
    const xml = await (await POST(inboundRequest("STOP"))).text();
    expect(xml).toContain(xmlEscape(buildSmsStopReply("Harbor Dance Studio")));
    expect(calls("tw4_inbound_reply_allowed")).toHaveLength(0);
    expect(calls("record_sms_inbound_opt_event")).toHaveLength(1);
  });
});

describe("usage recording is off by default", () => {
  it.each(["HELP", "STOP", "hello there"])("%s makes no tw4_inbound_record call", async (word) => {
    fake.current = createFakeSupabase();
    await POST(inboundRequest(word));
    expect(calls("tw4_inbound_record")).toHaveLength(0);
  });

  it.each(["off", "true", "1", ""])("SMS_INBOUND_RECORDING=%j does not enable it", async (value) => {
    process.env.SMS_INBOUND_RECORDING = value;
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello"));
    expect(calls("tw4_inbound_record")).toHaveLength(0);
  });
});

describe("usage recording when SMS_INBOUND_RECORDING=on", () => {
  beforeEach(() => {
    process.env.SMS_INBOUND_RECORDING = "on";
  });

  it("STOP records once, after the consent change, as compliance with the reply text", async () => {
    fake.current = createFakeSupabase();
    const xml = await (await POST(inboundRequest("STOP"))).text();
    const stopReply = buildSmsStopReply("Harbor Dance Studio");
    expect(xml).toContain(xmlEscape(stopReply));
    const names = fake.current.rpcCalls.map((c) => c.name);
    expect(names.indexOf("record_sms_inbound_opt_event")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("tw4_inbound_record")).toBeGreaterThan(names.indexOf("record_sms_inbound_opt_event"));
    expect(calls("tw4_inbound_record")).toHaveLength(1);
    expect(calls("tw4_inbound_record")[0].args).toEqual({
      p_studio_id: STUDIO_A,
      p_signer_account: null,
      p_provider_sid: GOOD_SID,
      p_segments: 1,
      p_media: 0,
      p_classification: "compliance",
      p_reply_body: stopReply,
      p_received_at: null,
      p_source: "webhook",
    });
  });

  it("HELP records as compliance with the help reply", async () => {
    fake.current = createFakeSupabase();
    await POST(inboundRequest("HELP"));
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({
      p_classification: "compliance",
      p_reply_body: buildSmsHelpReply("Harbor Dance Studio"),
    });
  });

  it("HELP suppressed by the counter records compliance with no reply body", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: false, error: null }));
    await POST(inboundRequest("HELP"));
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({ p_classification: "compliance", p_reply_body: null });
  });

  it("a Twilio-handled STOP records with a null reply body", async () => {
    fake.current = createFakeSupabase();
    await POST(inboundRequest("STOP", { optOutType: "STOP" }));
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({ p_classification: "compliance", p_reply_body: null });
  });

  it("an ordinary message records as ordinary with no reply body and an empty response", async () => {
    fake.current = createFakeSupabase();
    const xml = await (await POST(inboundRequest("hello there"))).text();
    expect(xml).toBe(EMPTY_TWIML);
    expect(calls("tw4_inbound_record")).toHaveLength(1);
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({ p_classification: "ordinary", p_reply_body: null });
  });

  it("passes NumSegments and NumMedia, defaulting to 1 and 0", async () => {
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello", { segments: "3", media: "1" }));
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({ p_segments: 3, p_media: 1 });
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello"));
    expect(calls("tw4_inbound_record")[0].args).toMatchObject({ p_segments: 1, p_media: 0 });
  });

  it("an MM sid is recorded; a non-SM/MM sid is not", async () => {
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello", { sid: `MM${"b1".repeat(16)}` }));
    expect(calls("tw4_inbound_record")).toHaveLength(1);
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello", { sid: "SMinboundShort" }));
    expect(calls("tw4_inbound_record")).toHaveLength(0);
  });

  it("a parent-signed message records a null signer account", async () => {
    // the subaccount-signed path is covered by subaccountWebhooks.tw4f.test.ts
    fake.current = createFakeSupabase();
    await POST(inboundRequest("hello"));
    expect(calls("tw4_inbound_record")[0].args.p_signer_account).toBeNull();
  });

  it.each([
    ["an rpc error", () => ({ data: null, error: { code: "XX001", message: `boom ${PHONE} ${BODY_TEXT}` } }), "sms_inbound_record_failed:XX001"],
    ["an unreadable answer", () => ({ data: "garbage", error: null }), "sms_inbound_record_failed:unreadable"],
    [
      "a thrown exception",
      () => {
        throw new Error(`secret ${PHONE} ${BODY_TEXT}`);
      },
      "sms_inbound_record_failed:exception",
    ],
  ])("%s never changes the response and logs only a code", async (_n, handler, expectedLog) => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_record", handler);
    const stop = await POST(inboundRequest("STOP"));
    expect(stop.status).toBe(200);
    expect(await stop.text()).toContain(xmlEscape(buildSmsStopReply("Harbor Dance Studio")));
    const ordinary = await POST(inboundRequest(BODY_TEXT));
    expect(await ordinary.text()).toBe(EMPTY_TWIML);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(expectedLog);
    expect(logged).not.toContain("5550100123");
    expect(logged).not.toContain("private words");
  });
});

describe("recording never happens on rejected or replayed deliveries", () => {
  beforeEach(() => {
    process.env.SMS_INBOUND_RECORDING = "on";
  });

  it("a duplicate delivery returns empty TwiML and records nothing, with no consent change", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("sms_webhook_receipt_record", () => ({ data: false, error: null }));
    const xml = await (await POST(inboundRequest("STOP"))).text();
    expect(xml).toBe(EMPTY_TWIML);
    expect(calls("tw4_inbound_record")).toHaveLength(0);
    expect(calls("record_sms_inbound_opt_event")).toHaveLength(0);
  });

  it("a first delivery is recorded after the receipt", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("sms_webhook_receipt_record", () => ({ data: true, error: null }));
    await POST(inboundRequest("hello"));
    const names = fake.current.rpcCalls.map((c) => c.name);
    expect(names.indexOf("tw4_inbound_record")).toBeGreaterThan(names.indexOf("sms_webhook_receipt_record"));
  });

  it("a signature failure returns 403 and calls neither the counter nor the recorder", async () => {
    fake.current = createFakeSupabase();
    const response = await POST(inboundRequest("STOP", { sign: "invalid" }));
    expect(response.status).toBe(403);
    expect(calls("tw4_inbound_record")).toHaveLength(0);
    expect(calls("tw4_inbound_reply_allowed")).toHaveLength(0);
    expect(calls("record_sms_inbound_opt_event")).toHaveLength(0);
  });
});

describe("a fallback STOP / START / HELP on an error path gets a compliance reply, never silence (review P2-4)", () => {
  const unroutedKeyword = (body: string) => inboundRequest(body, { to: "+15550107777" });
  it("an unrouted STOP is always answered, without asking the counter, even when the counter would refuse", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: false, error: null }));
    expect(await (await POST(unroutedKeyword("STOP"))).text()).toContain(xmlEscape(SMS_UNROUTED_REPLY));
    expect(calls("tw4_inbound_reply_allowed")).toHaveLength(0);
  });
  it("an unrouted HELP / START follows the confirmation limit (5, fail open), not the error limit", async () => {
    for (const body of ["HELP", "START"]) {
      fake.current = createFakeSupabase();
      fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: null, error: { code: "XX001", message: "boom" } }));
      expect(await (await POST(unroutedKeyword(body))).text(), body).toContain(xmlEscape(SMS_UNROUTED_REPLY)); // fail open
      expect(calls("tw4_inbound_reply_allowed")[0].args).toMatchObject({ p_kind: body.toLowerCase(), p_limit: 5 });
    }
  });
  it("an ordinary unrouted message still follows the error limit (fail closed)", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: null, error: { code: "XX001", message: "boom" } }));
    expect(await (await POST(unroutedKeyword("hello there"))).text()).toBe(EMPTY_TWIML);
  });
});
