import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import {
  appendSmsOptOutFooter,
  buildSmsHelpReply,
  buildSmsStopReply,
  isAutomatedSmsTemplatePermitted,
} from "@/lib/sms/compliance";
import { resolveStudioFromInboundSender, resolveStudioSmsSender } from "@/lib/sms/studioSender";
import { sendTwilioSms } from "@/lib/sms/twilio";

/** SMS-A2P-2: per-studio sender resolution, approval gating and studio identity in the body. */

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;
const CAMPAIGN = `QE${"0f".repeat(16)}`;

function registration(studioId: string, overrides: FakeRow = {}): FakeRow {
  return {
    id: `reg-${studioId}`,
    studio_id: studioId,
    messaging_service_sid: studioId === STUDIO_A ? SERVICE_A : SERVICE_B,
    campaign_sid: CAMPAIGN,
    sender_e164: studioId === STUDIO_A ? "+15550109999" : "+15550108888",
    registration_status: "approved",
    ...overrides,
  };
}

function client(rows: FakeRow[]) {
  return createFakeSupabase({ studio_sms_registrations: rows }).client as unknown as SupabaseClient;
}

const ENV_KEYS = ["DANCEFLOW_SMS_STATUS", "SMS_PLATFORM_STATUS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveStudioSmsSender", () => {
  it("approved studio resolves its own Messaging Service, sender and campaign", async () => {
    const result = await resolveStudioSmsSender(client([registration(STUDIO_A), registration(STUDIO_B)]), STUDIO_A);

    expect(result).toEqual({
      ok: true,
      sender: {
        studioId: STUDIO_A,
        messagingServiceSid: SERVICE_A,
        senderE164: "+15550109999",
        campaignSid: CAMPAIGN,
      },
    });
  });

  it("Studio A can never resolve Studio B's sender", async () => {
    const result = await resolveStudioSmsSender(client([registration(STUDIO_B)]), STUDIO_A);

    expect(result).toEqual({ ok: false, reason: "sms_studio_not_approved" });
  });

  it("no registration row fails closed", async () => {
    expect(await resolveStudioSmsSender(client([]), STUDIO_A)).toEqual({
      ok: false,
      reason: "sms_studio_not_approved",
    });
  });

  it.each(["not_registered", "in_review", "rejected", "suspended"])("%s fails closed", async (status) => {
    const result = await resolveStudioSmsSender(
      client([registration(STUDIO_A, { registration_status: status })]),
      STUDIO_A,
    );

    expect(result).toEqual({ ok: false, reason: "sms_studio_not_approved" });
  });

  it.each([
    ["messaging_service_sid", null],
    ["campaign_sid", null],
    ["sender_e164", null],
    ["messaging_service_sid", "not-a-sid"],
  ])("approved but %s=%s fails closed", async (column, value) => {
    const result = await resolveStudioSmsSender(
      client([registration(STUDIO_A, { [column]: value })]),
      STUDIO_A,
    );

    expect(result).toEqual({ ok: false, reason: "sms_studio_not_approved" });
  });

  it.each(["rejected", "disabled", "pending_review"])(
    "global kill switch (%s) blocks even an approved studio",
    async (status) => {
      process.env.DANCEFLOW_SMS_STATUS = status;

      const result = await resolveStudioSmsSender(client([registration(STUDIO_A)]), STUDIO_A);

      expect(result).toEqual({ ok: false, reason: "sms_not_approved" });
    },
  );

  it("a lookup error fails closed with a distinct reason", async () => {
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }),
        }),
      }),
    } as unknown as SupabaseClient;

    expect(await resolveStudioSmsSender(failing, STUDIO_A)).toEqual({
      ok: false,
      reason: "sms_registration_lookup_failed",
    });
  });
});

describe("resolveStudioFromInboundSender", () => {
  const rows = [registration(STUDIO_A), registration(STUDIO_B)];

  it("routes by To and by MessagingServiceSid, ignoring registration status", async () => {
    const suspended = [registration(STUDIO_A, { registration_status: "suspended" }), registration(STUDIO_B)];

    expect(await resolveStudioFromInboundSender(client(suspended), { to: "+15550109999" })).toEqual({
      ok: true,
      studioId: STUDIO_A,
    });
    expect(await resolveStudioFromInboundSender(client(rows), { messagingServiceSid: SERVICE_B })).toEqual({
      ok: true,
      studioId: STUDIO_B,
    });
  });

  it("requires every present field to agree", async () => {
    expect(
      await resolveStudioFromInboundSender(client(rows), { to: "+15550109999", messagingServiceSid: SERVICE_B }),
    ).toEqual({ ok: false, reason: "ambiguous_sender" });
  });

  it("fails closed for unknown or missing sender context", async () => {
    expect(await resolveStudioFromInboundSender(client(rows), { to: "+15550107777" })).toEqual({
      ok: false,
      reason: "unknown_sender",
    });
    expect(await resolveStudioFromInboundSender(client(rows), {})).toEqual({ ok: false, reason: "no_sender" });
  });
});

describe("no global messaging service fallback", () => {
  it("sendTwilioSms refuses to call Twilio without a valid studio Messaging Service SID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.TWILIO_MESSAGING_SERVICE_SID = SERVICE_A;

    for (const messagingServiceSid of ["", "not-a-sid", `QE${"0f".repeat(16)}`]) {
      const result = await sendTwilioSms({ to: "+15550100123", body: "Hi", messagingServiceSid });
      expect(result).toMatchObject({ ok: false, errorCode: "sms_studio_not_approved" });
    }

    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses exactly the supplied studio SID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: "SM1", status: "queued" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTwilioSms({ to: "+15550100123", body: "Hi", messagingServiceSid: SERVICE_B });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1].body)).get("MessagingServiceSid")).toBe(SERVICE_B);
  });
});

describe("studio identity and STOP/HELP in every message", () => {
  it("always appends the studio footer, even when the body says 'reply stop'", () => {
    const body = appendSmsOptOutFooter("Please reply stop if you want to opt out of reminders.", "Harbor Dance Studio");

    expect(body.endsWith("Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.")).toBe(true);
  });

  it("does not duplicate the footer", () => {
    const once = appendSmsOptOutFooter("Hi Alex", "Harbor Dance Studio");

    expect(appendSmsOptOutFooter(once, "Harbor Dance Studio")).toBe(once);
    expect(once.match(/Reply STOP/g)).toHaveLength(1);
  });

  it("falls back to a generic studio label rather than omitting identity", () => {
    expect(appendSmsOptOutFooter("Hi", "")).toContain("Your dance studio: Reply STOP to opt out. Reply HELP for help.");
    expect(appendSmsOptOutFooter("Hi", null)).toContain("Reply STOP");
  });

  it("adds no event or marketing wording", () => {
    const text = [
      appendSmsOptOutFooter("Hi", "Harbor Dance Studio"),
      buildSmsHelpReply("Harbor Dance Studio"),
      buildSmsStopReply("Harbor Dance Studio"),
    ].join(" ");

    expect(text).not.toMatch(/event|promo|offer|sale|discount|marketing/i);
  });

  it("appointment templates stay permitted and event templates stay blocked", () => {
    for (const key of ["appointment_confirmed", "appointment_rescheduled", "appointment_cancelled"]) {
      expect(isAutomatedSmsTemplatePermitted(key)).toBe(true);
    }
    for (const key of ["event_registration_confirmed", "event_registration_reminder_24h", "event_cart_order_confirmed"]) {
      expect(isAutomatedSmsTemplatePermitted(key)).toBe(false);
    }
  });
});
