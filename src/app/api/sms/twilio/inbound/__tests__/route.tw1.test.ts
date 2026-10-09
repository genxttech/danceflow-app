import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * TW-1: Twilio Advanced Opt-Out alignment for the inbound webhook.
 *
 * Every studio Messaging Service must have Advanced Opt-Out enabled, with keywords and
 * replies matching that studio's campaign submission. When Twilio handles a keyword it
 * sends `OptOutType` and has already replied, so the app records the event and returns
 * TwiML with no <Message>. Without `OptOutType`, exact-message fallback parsing applies.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";
import {
  SMS_UNROUTED_REPLY,
  buildSmsHelpReply,
  buildSmsStartNoPriorConsentReply,
  buildSmsStartReply,
  buildSmsStopReply,
} from "@/lib/sms/compliance";

const TEST_TOKEN = "fake-test-auth-token";
const WEBHOOK_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const SENDER_A = "+15550109999";
const SENDER_B = "+15550108888";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;
const EMPTY_TWIML = "<Response></Response>";
const ORDINARY_REPLY = "Thanks for your message. Please contact the studio directly if you need help.";

function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const registration = (studioId: string, sid: string, sender: string): FakeRow => ({
    id: `reg-${studioId}`,
    studio_id: studioId,
    messaging_service_sid: sid,
    campaign_sid: `QE${"0f".repeat(16)}`,
    sender_e164: sender,
    registration_status: "approved",
  });

  return createBaseFake({
    studios: [
      { id: STUDIO_A, name: "Harbor Dance Studio" },
      { id: STUDIO_B, name: "Lakeside Ballroom" },
    ],
    studio_sms_registrations: [
      registration(STUDIO_A, SERVICE_A, SENDER_A),
      registration(STUDIO_B, SERVICE_B, SENDER_B),
    ],
    ...seed,
  });
}

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function permission(overrides: FakeRow): FakeRow {
  return {
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
    ...overrides,
  };
}

function optedOut(overrides: FakeRow): FakeRow {
  return permission({
    consent_status: "opted_out",
    opted_out_at: "2026-09-10T00:00:00.000Z",
    opted_out_source: "twilio_inbound_stop",
    ...overrides,
  });
}

function inboundRequest(
  body: string,
  options: { optOutType?: string; to?: string; serviceSid?: string } = {},
) {
  const params: Record<string, string> = {
    From: PHONE,
    To: options.to ?? SENDER_A,
    Body: body,
    MessageSid: "SMinboundTw1",
  };
  if (options.serviceSid) params.MessagingServiceSid = options.serviceSid;
  if (options.optOutType !== undefined) params.OptOutType = options.optOutType;

  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `203.0.113.${++ipCounter % 250}`,
      "x-twilio-signature": getExpectedTwilioSignature(TEST_TOKEN, WEBHOOK_URL, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/'/g, "&apos;");
}

function byId() {
  return Object.fromEntries(
    fake.current!.rows("sms_contact_permissions").map((row) => [String(row.id), row]),
  );
}

function consentMutations() {
  return fake.current!.mutations.filter((mutation) => mutation.table === "sms_contact_permissions");
}

/** Asserts the webhook response would make Twilio send nothing further. */
async function expectNoSecondMessage(response: Response) {
  const xml = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/xml");
  expect(xml).toBe(EMPTY_TWIML);
  expect(xml).not.toContain("<Message");
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("OptOutType=STOP (Twilio already blocked and replied)", () => {
  it("opts out the receiving studio locally and sends no application reply", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "STOP" })));

    const rows = byId();
    expect(rows.a).toMatchObject({
      consent_status: "opted_out",
      opted_out_source: "twilio_inbound_stop",
      consent_source: "public_lead_form",
      consent_at: "2026-09-01T00:00:00.000Z",
    });
    expect(rows.a.opted_out_at).toBeTruthy();
    expect(rows.b).toMatchObject({ consent_status: "opted_in", opted_out_at: null });
    expect(consentMutations()[0].ids).toEqual(["a"]);
    expect(consentMutations().map((mutation) => mutation.op)).toEqual(["update", "insert"]);
    expect(fake.current.rpcCalls.map((call) => call.args)).toEqual([
      { p_studio_id: STUDIO_A, p_phone_e164: PHONE, p_event: "stop" },
    ]);
    expect(fake.current.rows("sms_message_logs")).toMatchObject([
      { studio_id: STUDIO_A, direction: "inbound", message_type: "stop", status: "received" },
    ]);
  });

  it("uses OptOutType over a conflicting body (OptOutType=STOP, Body=HELP behaves as STOP)", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await expectNoSecondMessage(await POST(inboundRequest("HELP", { optOutType: "STOP" })));

    expect(byId().a).toMatchObject({ consent_status: "opted_out" });
    expect(fake.current.rows("sms_message_logs")[0]).toMatchObject({ message_type: "stop" });
  });

  it("honors a Twilio-configured keyword the fallback list does not know", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await expectNoSecondMessage(await POST(inboundRequest("ARRET", { optOutType: "STOP" })));

    expect(byId().a).toMatchObject({ consent_status: "opted_out" });
  });

  it("matches OptOutType case-insensitively", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await expectNoSecondMessage(await POST(inboundRequest("Stop", { optOutType: "stop" })));

    expect(byId().a).toMatchObject({ consent_status: "opted_out" });
  });
});

describe("OptOutType=START (Twilio already unblocked and replied)", () => {
  it("re-enables only prior-consent rows for the receiving studio and sends no reply", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [
        optedOut({ id: "prior" }),
        optedOut({ id: "never", consent_at: null, opted_out_source: "studio_staff_manual" }),
        optedOut({ id: "otherStudio", studio_id: STUDIO_B }),
      ],
    });

    await expectNoSecondMessage(await POST(inboundRequest("START", { optOutType: "START" })));

    const rows = byId();
    expect(rows.prior).toMatchObject({
      consent_status: "opted_in",
      consent_source: "twilio_inbound_start",
      opted_out_at: null,
      opted_out_source: null,
    });
    expect(rows.never).toMatchObject({ consent_status: "opted_out", consent_at: null });
    expect(rows.otherStudio).toMatchObject({ consent_status: "opted_out" });
    expect(consentMutations().flatMap((mutation) => mutation.ids)).toEqual(["prior"]);
  });

  it("never creates consent without prior evidence, and still sends no reply", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "unknown", consent_status: "unknown", consent_at: null })],
    });

    await expectNoSecondMessage(await POST(inboundRequest("UNSTOP", { optOutType: "START" })));

    expect(byId().unknown).toMatchObject({ consent_status: "unknown", consent_at: null });
    expect(consentMutations()).toHaveLength(0);
  });

  it("uses OptOutType over a conflicting body (OptOutType=START, Body=STOP behaves as START)", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [optedOut({ id: "prior" })] });

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "START" })));

    expect(byId().prior).toMatchObject({ consent_status: "opted_in" });
  });
});

describe("OptOutType=HELP (Twilio already replied)", () => {
  it("logs the help event for the receiving studio, changes no consent, sends no reply", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    await expectNoSecondMessage(await POST(inboundRequest("HELP", { optOutType: "HELP" })));

    expect(consentMutations()).toHaveLength(0);
    expect(byId()).toMatchObject({ a: { consent_status: "opted_in" }, b: { consent_status: "opted_in" } });
    expect(fake.current.rows("sms_message_logs")).toMatchObject([
      { studio_id: STUDIO_A, direction: "inbound", message_type: "help", status: "received" },
    ]);
  });

  it("OptOutType=HELP with Body=STOP does not opt out", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "HELP" })));

    expect(byId().a).toMatchObject({ consent_status: "opted_in" });
    expect(consentMutations()).toHaveLength(0);
  });
});

describe("Twilio-handled keywords never produce a second message on any path", () => {
  it.each(["STOP", "START", "HELP"])(
    "OptOutType=%s to an unknown sender: fails closed, no mutation, no reply",
    async (optOutType) => {
      fake.current = createFakeSupabase({
        sms_contact_permissions: [permission({ id: "a" }), optedOut({ id: "b", studio_id: STUDIO_B })],
      });

      await expectNoSecondMessage(await POST(inboundRequest(optOutType, { optOutType, to: "+15550107777" })));

      expect(fake.current.mutations).toHaveLength(0);
    },
  );

  it("OptOutType=STOP with a Messaging Service and To that disagree fails closed silently", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    await expectNoSecondMessage(
      await POST(inboundRequest("STOP", { optOutType: "STOP", to: SENDER_A, serviceSid: SERVICE_B })),
    );

    expect(fake.current.mutations).toHaveLength(0);
    expect(byId()).toMatchObject({ a: { consent_status: "opted_in" }, b: { consent_status: "opted_in" } });
  });

  it("OptOutType=HELP with no service client configured still sends nothing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    fake.current = createFakeSupabase({});

    await expectNoSecondMessage(await POST(inboundRequest("HELP", { optOutType: "HELP" })));
  });

  it("an unrecognized OptOutType falls back to body parsing", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    const response = await POST(inboundRequest("hello", { optOutType: "SOMETHING_NEW" }));

    expect(await response.text()).toContain(ORDINARY_REPLY);
    expect(consentMutations()).toHaveLength(0);
  });
});

describe("fallback parsing without OptOutType (Advanced Opt-Out absent or misconfigured)", () => {
  const OPT_OUT_WORDS = ["STOP", "UNSUBSCRIBE", "END", "QUIT", "STOPALL", "REVOKE", "OPTOUT", "CANCEL"];
  const variants = OPT_OUT_WORDS.flatMap((word) => [
    word,
    word.toLowerCase(),
    `${word[0]}${word.slice(1).toLowerCase()}`,
    `  ${word.toLowerCase()} \n`,
  ]);

  it.each(variants)("%j opts out the receiving studio", async (body) => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    const response = await POST(inboundRequest(body));

    expect(await response.text()).toContain(xmlEscape(buildSmsStopReply("Harbor Dance Studio")));
    expect(byId()).toMatchObject({ a: { consent_status: "opted_out" }, b: { consent_status: "opted_in" } });
  });

  it.each(["please stop", "STOP NOW", "stop texting me", "I want to cancel my lesson", "end of class?"])(
    "%j is an ordinary message (exact-message semantics)",
    async (body) => {
      fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

      const response = await POST(inboundRequest(body));

      expect(await response.text()).toBe(`<Response><Message>${ORDINARY_REPLY}</Message></Response>`);
      expect(consentMutations()).toHaveLength(0);
    },
  );

  it.each(["START", "start", "Yes", "unstop"])("%j re-enables prior consent with the app reply", async (body) => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [optedOut({ id: "prior" })] });

    const response = await POST(inboundRequest(body));

    expect(await response.text()).toContain(xmlEscape(buildSmsStartReply("Harbor Dance Studio")));
    expect(byId().prior).toMatchObject({ consent_status: "opted_in" });
  });

  it.each(["HELP", "help", "Info"])("%j returns the studio HELP reply and changes nothing", async (body) => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    const response = await POST(inboundRequest(body));

    expect(await response.text()).toContain(xmlEscape(buildSmsHelpReply("Harbor Dance Studio")));
    expect(consentMutations()).toHaveLength(0);
  });

  it("an unrouted fallback keyword keeps the truthful unrouted reply", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    const response = await POST(inboundRequest("STOP", { to: "+15550107777" }));

    expect(await response.text()).toContain(xmlEscape(SMS_UNROUTED_REPLY));
    expect(fake.current.mutations).toHaveLength(0);
  });
});

describe("ordinary inbound messages are not silenced", () => {
  it("a non-keyword reply still gets the truthful contact-the-studio response", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    const response = await POST(inboundRequest("Can I move my lesson to Friday?"));
    const xml = await response.text();

    expect(xml).toBe(`<Response><Message>${ORDINARY_REPLY}</Message></Response>`);
    expect(consentMutations()).toHaveLength(0);
    expect(fake.current.rows("sms_message_logs")).toMatchObject([
      { studio_id: STUDIO_A, direction: "inbound", message_type: "message" },
    ]);
  });
});

describe("studio isolation for Twilio-handled keywords", () => {
  it("Studio A STOP does not alter Studio B consent", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    await POST(inboundRequest("STOP", { optOutType: "STOP", to: SENDER_A, serviceSid: SERVICE_A }));

    expect(byId()).toMatchObject({ a: { consent_status: "opted_out" }, b: { consent_status: "opted_in" } });
  });

  it("Studio B STOP does not alter Studio A consent", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), permission({ id: "b", studio_id: STUDIO_B })],
    });

    await POST(inboundRequest("STOP", { optOutType: "STOP", to: SENDER_B, serviceSid: SERVICE_B }));

    expect(byId()).toMatchObject({ a: { consent_status: "opted_in" }, b: { consent_status: "opted_out" } });
  });

  it("Studio A START does not alter Studio B consent", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [optedOut({ id: "a" }), optedOut({ id: "b", studio_id: STUDIO_B })],
    });

    await POST(inboundRequest("START", { optOutType: "START", serviceSid: SERVICE_A }));

    expect(byId()).toMatchObject({ a: { consent_status: "opted_in" }, b: { consent_status: "opted_out" } });
  });

  it("Studio A HELP does not alter Studio B state or logs", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "a" }), optedOut({ id: "b", studio_id: STUDIO_B })],
    });

    await POST(inboundRequest("HELP", { optOutType: "HELP", serviceSid: SERVICE_A }));

    expect(consentMutations()).toHaveLength(0);
    expect(byId()).toMatchObject({ a: { consent_status: "opted_in" }, b: { consent_status: "opted_out" } });
    expect(fake.current.rows("sms_message_logs").every((row) => row.studio_id === STUDIO_A)).toBe(true);
  });
});

describe("TW-2: inbound consent goes through the canonical consent function", () => {
  it("fallback STOP from a number with no consent record stores a studio+phone opt-out for that studio only", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [] });

    const response = await POST(inboundRequest("STOP", { to: SENDER_A, serviceSid: SERVICE_A }));

    expect(await response.text()).toContain(xmlEscape(buildSmsStopReply("Harbor Dance Studio")));
    expect(fake.current.rpcCalls).toEqual([
      { name: "record_sms_inbound_opt_event", args: { p_studio_id: STUDIO_A, p_phone_e164: PHONE, p_event: "stop" } },
    ]);
    expect(fake.current.rows("sms_contact_permissions")).toMatchObject([
      { studio_id: STUDIO_A, client_id: null, phone_e164: PHONE, consent_status: "opted_out", opted_out_source: "twilio_inbound_stop" },
    ]);
    // No identity -> no inbound log row is attributed to a client.
    expect(fake.current.rows("sms_message_logs")).toHaveLength(0);
  });

  it("OptOutType=STOP from an unknown number is stored without a second reply", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [] });

    await expectNoSecondMessage(await POST(inboundRequest("REVOKE", { optOutType: "STOP" })));

    expect(fake.current.rows("sms_contact_permissions")).toMatchObject([
      { studio_id: STUDIO_A, client_id: null, consent_status: "opted_out" },
    ]);
  });

  it("STOP to Studio B's sender is recorded for Studio B only", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "STOP", to: SENDER_B, serviceSid: SERVICE_B })));

    expect(fake.current.rpcCalls.map((call) => call.args.p_studio_id)).toEqual([STUDIO_B]);
    expect(byId().a).toMatchObject({ consent_status: "opted_in" });
  });

  it("STOP then START: block lifted only by the consumer, no consent created for an unknown number", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [] });

    await POST(inboundRequest("STOP"));
    const response = await POST(inboundRequest("START"));

    expect(await response.text()).toContain(xmlEscape(buildSmsStartNoPriorConsentReply("Harbor Dance Studio")));
    expect(fake.current.rpcCalls.map((call) => call.args.p_event)).toEqual(["stop", "start"]);
    expect(fake.current.rows("sms_contact_permissions")).toMatchObject([
      { client_id: null, consent_status: "unknown", opted_out_at: null },
    ]);
  });

  it("START reply reflects the database outcome (restored vs no prior consent)", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [optedOut({ id: "prior" })] });

    const restored = await POST(inboundRequest("START"));
    expect(await restored.text()).toContain(xmlEscape(buildSmsStartReply("Harbor Dance Studio")));

    fake.current.overrideRpc("record_sms_inbound_opt_event", () => ({ data: { rows_changed: 0 }, error: null }));
    const none = await POST(inboundRequest("START"));
    expect(await none.text()).toContain(xmlEscape(buildSmsStartNoPriorConsentReply("Harbor Dance Studio")));
  });

  it.each([
    ["HELP", { optOutType: "HELP" }],
    ["HELP", {}],
    ["Can I move my lesson?", {}],
  ])("%s does not touch consent (no consent function call)", async (body, options) => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });

    await POST(inboundRequest(body, options));

    expect(fake.current.rpcCalls).toHaveLength(0);
    expect(consentMutations()).toHaveLength(0);
  });

  it("inbound logs are written per known client only, never for the studio+phone opt-out row", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [
        permission({ id: "a" }),
        permission({ id: "phone-level", client_id: null, consent_status: "opted_out", consent_at: null }),
      ],
    });

    await POST(inboundRequest("Running late, sorry!"));

    expect(fake.current.rows("sms_message_logs")).toMatchObject([
      { studio_id: STUDIO_A, client_id: "33333333-3333-4333-8333-333333333333", message_type: "message" },
    ]);
    expect(fake.current.rows("sms_message_logs")).toHaveLength(1);
  });

  it("an unrouted STOP never reaches the consent function", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [] });

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "STOP", to: "+15550107777" })));

    expect(fake.current.rpcCalls).toHaveLength(0);
    expect(fake.current.mutations).toHaveLength(0);
  });

  it("a consent-function failure still sends no second reply and logs only a code", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "a" })] });
    fake.current.overrideRpc("record_sms_inbound_opt_event", () => ({
      data: null,
      error: { code: "XX001", message: `boom ${PHONE}` },
    }));

    await expectNoSecondMessage(await POST(inboundRequest("STOP", { optOutType: "STOP" })));

    const logged = errorLog.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("sms_inbound_consent_update_failed");
    expect(logged).not.toContain("555");
  });
});
