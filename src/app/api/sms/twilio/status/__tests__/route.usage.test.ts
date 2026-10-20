import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";

/** TW-4F usage billing: the status callback's tw4_usage_record_callback step (attempt binding, signer account, legacy fall-through). */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

const SUB_TOKEN = "fake-subaccount-token";
const SUB = `AC${"b".repeat(32)}`;
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";

// A subaccount signer: one known subaccount of a legal business that owns STUDIO_A, verified with its own token.
vi.mock("@/lib/sms/twilioIsv/webhookRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/twilioIsv/webhookRuntime")>();
  return {
    ...actual,
    buildWebhookAccountDeps: () => ({
      parentAccountSid: `AC${"a".repeat(32)}`,
      lookupAccount: async (sid: string) =>
        sid === `AC${"b".repeat(32)}`
          ? { found: true, legalEntityId: "99999999-9999-4999-8999-999999999999", status: "active", studioIds: ["11111111-1111-4111-8111-111111111111"] }
          : { found: false },
      tokens: {
        tokenFor: async () => ({ reveal: () => "fake-subaccount-token" }),
        refresh: async (_sid: string, current: unknown) => ({ secret: current, changed: false }),
      },
    }),
  };
});

import { POST } from "@/app/api/sms/twilio/status/route";

const PARENT_TOKEN = "fake-test-auth-token";
const CALLBACK_SECRET = "fake-callback-secret";
const BASE_URL = "https://www.idanceflow.com/api/sms/twilio/status";
const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MG_A = `MG${"a1".repeat(16)}`;
const MG_BILLED = `MG${"c3".repeat(16)}`;
const SID = `SM${"1".repeat(32)}`;

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_STATUS_CALLBACK_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function statusRequest(params: Record<string, string>, query: Record<string, string> = {}, token = PARENT_TOKEN) {
  const q = new URLSearchParams({ secret: CALLBACK_SECRET, ...query });
  const url = `${BASE_URL}?${q.toString()}`;
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `192.0.2.${++ipCounter % 250}`,
      "x-twilio-signature": getExpectedTwilioSignature(token, url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

type RecordResult = { data: unknown; error: { code?: string } | null };

function seed(record: RecordResult | undefined) {
  fake.current = createFakeSupabase({
    sms_message_logs: [{ id: "log-a", studio_id: STUDIO_A, provider: "twilio", provider_message_id: SID, status: "queued" }],
    studio_sms_registrations: [{ id: "ra", studio_id: STUDIO_A, messaging_service_sid: MG_A }],
  });
  if (record) fake.current.overrideRpc("tw4_usage_record_callback", () => record);
  return fake.current;
}

const recordCalls = () => fake.current!.rpcCalls.filter((c) => c.name === "tw4_usage_record_callback");
const logStatus = () => String(fake.current!.rows("sms_message_logs")[0].status);

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = PARENT_TOKEN;
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
  process.env.TWILIO_STATUS_CALLBACK_SECRET = CALLBACK_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("tw4_usage_record_callback arguments", () => {
  it("passes the attempt from the query, the SID, status and code; parent signer -> null account", async () => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "failed", ErrorCode: "30003" }, { attempt: ATTEMPT }));
    expect(res.status).toBe(200);
    expect(recordCalls()).toEqual([
      {
        name: "tw4_usage_record_callback",
        args: { p_attempt_id: ATTEMPT, p_provider_sid: SID, p_signer_account: null, p_status: "failed", p_error_code: "30003" },
      },
    ]);
  });

  it("without an attempt param the attempt is null and an empty code is null", async () => {
    seed({ data: { billed: false }, error: null });
    await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }));
    expect(recordCalls()[0].args).toEqual({ p_attempt_id: null, p_provider_sid: SID, p_signer_account: null, p_status: "delivered", p_error_code: null });
  });

  it("a subaccount-signed callback passes the signer's subaccount SID", async () => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ AccountSid: SUB, MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }, SUB_TOKEN));
    expect(res.status).toBe(200);
    expect(recordCalls()[0].args).toMatchObject({ p_attempt_id: ATTEMPT, p_signer_account: SUB });
    expect(logStatus()).toBe("delivered");
  });

  it("an unsigned or wrongly signed request never reaches the usage function", async () => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }, "wrong-token"));
    expect(res.status).toBe(403);
    expect(recordCalls()).toHaveLength(0);
  });

  it("a wrong callback secret never reaches the usage function", async () => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { secret: "nope", attempt: ATTEMPT }));
    expect(res.status).toBe(401);
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("tw4_usage_record_callback errors", () => {
  it("42501 -> 403 and the log is not updated", async () => {
    seed({ data: null, error: { code: "42501" } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }));
    expect(res.status).toBe(403);
    expect(logStatus()).toBe("queued");
  });

  it("42501 is 403 even without an attempt id", async () => {
    seed({ data: null, error: { code: "42501" } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }));
    expect(res.status).toBe(403);
    expect(logStatus()).toBe("queued");
  });

  it.each(["abc", "not-a-uuid", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa", ""])("an invalid attempt param %j -> 400 without calling the function", async (attempt) => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { attempt }));
    expect(res.status).toBe(400);
    expect(recordCalls()).toHaveLength(0);
    expect(logStatus()).toBe("queued");
  });

  it.each(["XX000", "PGRST202", "42883"])("with an attempt id, error %s -> 500 and the log is not updated", async (code) => {
    seed({ data: null, error: { code } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }));
    expect(res.status).toBe(500);
    expect(logStatus()).toBe("queued");
  });

  it("with an attempt id, 22023 -> 400", async () => {
    seed({ data: null, error: { code: "22023" } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }));
    expect(res.status).toBe(400);
    expect(logStatus()).toBe("queued");
  });

  it.each(["XX000", "08006"])("without an attempt id, an unexpected error %s -> 500", async (code) => {
    seed({ data: null, error: { code } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_A }));
    expect(res.status).toBe(500);
    expect(logStatus()).toBe("queued");
  });

  it.each(["PGRST202", "42883", "22023"])("without an attempt id, %s falls through to the legacy behavior", async (code) => {
    seed({ data: null, error: { code } });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_A }));
    expect(res.status).toBe(200);
    expect(logStatus()).toBe("delivered");
  });

  it("the unseeded fake (function not installed) keeps a legacy callback working", async () => {
    seed(undefined);
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "sent", MessagingServiceSid: MG_A }));
    expect(res.status).toBe(200);
    expect(logStatus()).toBe("sent");
  });
});

describe("billed vs legacy registration check", () => {
  it("billed:true skips the legacy registration MessagingServiceSid check", async () => {
    seed({ data: { billed: true }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_BILLED }, { attempt: ATTEMPT }));
    expect(res.status).toBe(200);
    expect(logStatus()).toBe("delivered");
  });

  it("billed:false keeps the check: a different Messaging Service is 403 and the log is untouched", async () => {
    seed({ data: { billed: false }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_BILLED }));
    expect(res.status).toBe(403);
    expect(logStatus()).toBe("queued");
  });

  it("billed:false with the registered Messaging Service updates the log", async () => {
    seed({ data: { billed: false }, error: null });
    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_A }));
    expect(res.status).toBe(200);
    expect(logStatus()).toBe("delivered");
  });

  it("an answer that is not exactly billed:true does not skip the check", async () => {
    for (const data of [null, {}, { billed: "true" }, "billed"]) {
      seed({ data, error: null });
      const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered", MessagingServiceSid: MG_BILLED }));
      expect(res.status).toBe(403);
      expect(logStatus()).toBe("queued");
    }
  });

  it("a subaccount signer still cannot update another business's log even when billed:true", async () => {
    seed({ data: { billed: true }, error: null });
    fake.current!.rows("sms_message_logs")[0].studio_id = STUDIO_B;
    const res = await POST(statusRequest({ AccountSid: SUB, MessageSid: SID, MessageStatus: "delivered" }, { attempt: ATTEMPT }, SUB_TOKEN));
    expect(res.status).toBe(403);
    expect(logStatus()).toBe("queued");
  });
});
