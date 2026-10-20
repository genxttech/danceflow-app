import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * TW-4F provider integration: the inbound and status webhooks for messages of a studio legal business's Twilio SUBACCOUNT (signed with the
 * subaccount's own token), end to end through the routes: forged callbacks, tenant isolation, token rotation, replay and retries.
 * Synthetic fixtures only: the "Twilio" here is the in-memory fake parent (local fake mode) or a stubbed fetch.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createBaseFake> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST as inbound } from "@/app/api/sms/twilio/inbound/route";
import { POST as status } from "@/app/api/sms/twilio/status/route";
import { FakeIsvParent } from "@/lib/sms/twilioIsv/fake";

const PARENT = `AC${"1".repeat(32)}`;
const PARENT_TOKEN = "fake-parent-token";
const SUB_A = `AC${"a".repeat(32)}`;
const SUB_B = `AC${"b".repeat(32)}`;
const ENTITY_A = "e0000000-0000-4000-8000-0000000000a1";
const ENTITY_B = "e0000000-0000-4000-8000-0000000000b1";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;
const SENDER_A = "+15550109999";
const SENDER_B = "+15550108888";
const PHONE = "+15550100123";
const CALLBACK_SECRET = "fake-callback-secret";
const STATUS_URL = `https://www.idanceflow.com/api/sms/twilio/status?secret=${CALLBACK_SECRET}`;
const INBOUND_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const MSG_A = `SM${"a".repeat(32)}`;
const MSG_B = `SM${"b".repeat(32)}`;
const IN_1 = `SM${"1".repeat(32)}`;

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_STATUS_CALLBACK_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "TW4_ISV_FAKE", "VERCEL_ENV", "NODE_ENV", "TW4_SUBACCOUNT_WEBHOOKS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
const g = globalThis as unknown as { __tw4FakeIsvParent?: FakeIsvParent; __tw4WebhookTokens?: unknown };
let parent: FakeIsvParent;
let receipts: Set<string>;
let ip = 0;

function seed() {
  fake.current = createBaseFake({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }, { id: STUDIO_B, name: "Lakeside Ballroom" }],
    studio_sms_registrations: [
      { id: "ra", studio_id: STUDIO_A, messaging_service_sid: SERVICE_A, campaign_sid: `QE${"0f".repeat(16)}`, sender_e164: SENDER_A, registration_status: "approved" },
      { id: "rb", studio_id: STUDIO_B, messaging_service_sid: SERVICE_B, campaign_sid: `QE${"0e".repeat(16)}`, sender_e164: SENDER_B, registration_status: "approved" },
    ],
    sms_message_logs: [
      { id: "log-a", studio_id: STUDIO_A, provider: "twilio", provider_message_id: MSG_A, status: "queued" },
      { id: "log-b", studio_id: STUDIO_B, provider: "twilio", provider_message_id: MSG_B, status: "queued" },
    ],
    sms_contact_permissions: [
      { studio_id: STUDIO_A, organizer_id: null, client_id: "33333333-3333-4333-8333-333333333333", organizer_contact_id: null, phone_e164: PHONE,
        consent_status: "opted_in", consent_source: "public_lead_form", consent_at: "2026-09-01T00:00:00.000Z", opted_out_at: null, opted_out_source: null, updated_at: "2026-09-01T00:00:00.000Z" },
    ],
  });
  const accounts: Record<string, unknown> = {
    [SUB_A]: { found: true, legal_entity_id: ENTITY_A, status: "active", studio_ids: [STUDIO_A] },
    [SUB_B]: { found: true, legal_entity_id: ENTITY_B, status: "active", studio_ids: [STUDIO_B] },
  };
  fake.current.overrideRpc("tw4_webhook_account", (args) => ({ data: accounts[String(args.p_account_sid)] ?? { found: false }, error: null }));
  receipts = new Set();
  fake.current.overrideRpc("sms_webhook_receipt_record", (args) => {
    const key = `${args.p_kind}|${args.p_event_key}`;
    if (receipts.has(key)) return { data: false, error: null };
    receipts.add(key);
    return { data: true, error: null };
  });
  return fake.current;
}

function post(url: string, token: string, params: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `198.51.100.${++ip % 250}`,
      "x-twilio-signature": getExpectedTwilioSignature(token, url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}
const statusParams = (account: string, sid: string, s: string, service: string) => ({ AccountSid: account, MessageSid: sid, MessageStatus: s, MessagingServiceSid: service });
const inboundParams = (account: string, body: string, to = SENDER_A, sid = IN_1) => ({ AccountSid: account, From: PHONE, To: to, Body: body, MessageSid: sid });
const logs = () => Object.fromEntries(fake.current!.rows("sms_message_logs").filter((r) => r.id).map((r) => [String(r.id), r]));
const consent = () => fake.current!.rows("sms_contact_permissions").find((r) => r.studio_id === STUDIO_A)?.consent_status;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: PARENT, TWILIO_AUTH_TOKEN: PARENT_TOKEN, TWILIO_STATUS_CALLBACK_SECRET: CALLBACK_SECRET,
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fake-service-role", TW4_ISV_FAKE: "on",
  });
  delete process.env.VERCEL_ENV;
  delete process.env.TW4_SUBACCOUNT_WEBHOOKS;
  parent = new FakeIsvParent(`BU${"e".repeat(32)}`);
  parent.seedAccount(SUB_A, "df:test:a");
  parent.seedAccount(SUB_B, "df:test:b");
  g.__tw4FakeIsvParent = parent;
  delete g.__tw4WebhookTokens;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete env[key];
    else env[key] = savedEnv[key];
  }
  delete g.__tw4FakeIsvParent;
  delete g.__tw4WebhookTokens;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tokenA = () => parent.currentToken(SUB_A)!;
const tokenB = () => parent.currentToken(SUB_B)!;

describe("status callbacks from a subaccount", () => {
  it("a callback signed with the subaccount's own token updates its own studio's log", async () => {
    seed();
    const response = await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)));
    expect(response.status).toBe(200);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
    expect(logs()["log-b"]).toMatchObject({ status: "queued" });
  });

  it("forged: signed with the parent token, another subaccount's token or junk, nothing changes", async () => {
    seed();
    for (const token of [PARENT_TOKEN, tokenB(), "junk"]) {
      const response = await status(post(STATUS_URL, token, statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)));
      expect(response.status).toBe(403);
    }
    expect(fake.current!.mutations).toHaveLength(0);
  });

  it("tenant isolation: subaccount B, correctly signed, cannot update studio A's message", async () => {
    seed();
    const response = await status(post(STATUS_URL, tokenB(), statusParams(SUB_B, MSG_A, "failed", SERVICE_A)));
    expect(response.status).toBe(403);
    expect(logs()["log-a"]).toMatchObject({ status: "queued" });
    expect(fake.current!.mutations).toHaveLength(0);
    expect(receipts.size).toBe(0);
  });

  it("an unknown AccountSid is refused without any token read", async () => {
    seed();
    const unknown = `AC${"d".repeat(32)}`;
    const response = await status(post(STATUS_URL, "anything", statusParams(unknown, MSG_A, "delivered", SERVICE_A)));
    expect(response.status).toBe(403);
    expect(parent.count("getSubaccountToken")).toBe(0);
  });

  it("replay: the same (message, status) is applied once; a replayed older status cannot overwrite a newer one", async () => {
    seed();
    const sent = statusParams(SUB_A, MSG_A, "sent", SERVICE_A);
    expect((await status(post(STATUS_URL, tokenA(), sent))).status).toBe(200);
    expect((await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)))).status).toBe(200);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
    const replay = await status(post(STATUS_URL, tokenA(), sent));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, duplicate: true });
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
  });

  it("a retry after a failed update is deduplicated only once recorded; an unreachable replay ledger still applies the callback", async () => {
    seed();
    fake.current!.overrideRpc("sms_webhook_receipt_record", () => ({ data: null, error: { code: "42883" } }));
    const response = await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)));
    expect(response.status).toBe(200);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
  });

  it("rotation: right after the subaccount token is rotated, a callback signed with the new token verifies; the old token no longer does", async () => {
    seed();
    expect((await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "sent", SERVICE_A)))).status).toBe(200);
    const old = tokenA();
    parent.rotateToken(SUB_A);
    expect((await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)))).status).toBe(200);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
    expect((await status(post(STATUS_URL, old, statusParams(SUB_A, MSG_A, "failed", SERVICE_A)))).status).toBe(403);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
  });

  it("parent-account callbacks are unchanged", async () => {
    seed();
    const response = await status(post(STATUS_URL, PARENT_TOKEN, statusParams(PARENT, MSG_B, "delivered", SERVICE_B)));
    expect(response.status).toBe(200);
    expect(logs()["log-b"]).toMatchObject({ status: "delivered" });
  });

  it("outside fake mode and without the production switch a subaccount callback is 503, never accepted", async () => {
    seed();
    delete process.env.TW4_ISV_FAKE;
    const response = await status(post(STATUS_URL, tokenA(), statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)));
    expect(response.status).toBe(503);
    expect(fake.current!.mutations).toHaveLength(0);
  });

  it("production wiring: the token is read on demand through the parent credentials (stubbed fetch) and never logged", async () => {
    seed();
    delete process.env.TW4_ISV_FAKE;
    Object.assign(env, { VERCEL_ENV: "production", NODE_ENV: "production", TW4_SUBACCOUNT_WEBHOOKS: "on" });
    const subToken = "s".repeat(32);
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization });
      return { status: 200, text: async () => JSON.stringify({ sid: SUB_A, auth_token: subToken }) };
    });
    const logged: string[] = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    const response = await status(post(STATUS_URL, subToken, statusParams(SUB_A, MSG_A, "delivered", SERVICE_A)));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: `https://api.twilio.com/2010-04-01/Accounts/${SUB_A}.json`, auth: `Basic ${Buffer.from(`${PARENT}:${PARENT_TOKEN}`).toString("base64")}` }]);
    await status(post(STATUS_URL, "forged", statusParams(SUB_A, MSG_A, "failed", SERVICE_A)));
    expect(logged.join("\n")).not.toContain(subToken);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
  });
});

describe("inbound messages to a subaccount", () => {
  it("STOP to studio A's subaccount opts out in studio A only", async () => {
    seed();
    const response = await inbound(post(INBOUND_URL, tokenA(), inboundParams(SUB_A, "STOP")));
    expect(response.status).toBe(200);
    expect(fake.current!.rpcCalls.some((c) => c.name === "record_sms_inbound_opt_event" && c.args.p_studio_id === STUDIO_A)).toBe(true);
  });

  it("forged STOP/START (wrong token) changes no consent and records nothing", async () => {
    seed();
    for (const token of [PARENT_TOKEN, tokenB()]) {
      const response = await inbound(post(INBOUND_URL, token, inboundParams(SUB_A, "STOP")));
      expect(response.status).toBe(403);
    }
    expect(fake.current!.rpcCalls.filter((c) => c.name === "record_sms_inbound_opt_event")).toHaveLength(0);
    expect(consent()).toBe("opted_in");
  });

  it("tenant isolation: subaccount B, correctly signed, cannot act on studio A's sender", async () => {
    seed();
    const response = await inbound(post(INBOUND_URL, tokenB(), inboundParams(SUB_B, "STOP", SENDER_A)));
    expect(response.status).toBe(403);
    expect(fake.current!.rpcCalls.filter((c) => c.name === "record_sms_inbound_opt_event")).toHaveLength(0);
    expect(fake.current!.mutations).toHaveLength(0);
  });

  it("replay: a re-delivered inbound MessageSid produces no second reply and no second consent change", async () => {
    seed();
    const first = await inbound(post(INBOUND_URL, tokenA(), inboundParams(SUB_A, "START")));
    expect(await first.text()).toContain("<Message>");
    const calls = fake.current!.rpcCalls.filter((c) => c.name === "record_sms_inbound_opt_event").length;
    const replay = await inbound(post(INBOUND_URL, tokenA(), inboundParams(SUB_A, "START")));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe("<Response></Response>");
    expect(fake.current!.rpcCalls.filter((c) => c.name === "record_sms_inbound_opt_event")).toHaveLength(calls);
    // a different message is processed normally
    const other = await inbound(post(INBOUND_URL, tokenA(), inboundParams(SUB_A, "HELP", SENDER_A, `SM${"2".repeat(32)}`)));
    expect(await other.text()).toContain("<Message>");
  });

  it("an unreachable replay ledger never drops a STOP", async () => {
    seed();
    fake.current!.overrideRpc("sms_webhook_receipt_record", () => { throw new Error("network"); });
    const response = await inbound(post(INBOUND_URL, tokenA(), inboundParams(SUB_A, "STOP")));
    expect(response.status).toBe(200);
    expect(fake.current!.rpcCalls.some((c) => c.name === "record_sms_inbound_opt_event")).toBe(true);
  });
});
