import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * TW-4F compliance hardening of the inbound webhook: opt-outs are durable and independent of billing,
 * and request authentication is fail-closed (URL/host reconstruction, body tampering).
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.current!.client }));

import { POST } from "@/app/api/sms/twilio/inbound/route";

const TEST_TOKEN = "fake-test-auth-token";
const WEBHOOK_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const SENDER_A = "+15550109999";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SID = `SM${"0a".repeat(16)}`;
const EMPTY_TWIML = "<Response></Response>";

function createFakeSupabase() {
  const db = createBaseFake({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }],
    studio_sms_registrations: [
      { id: "reg-a", studio_id: STUDIO_A, messaging_service_sid: SERVICE_A, campaign_sid: `QE${"0f".repeat(16)}`, sender_e164: SENDER_A, registration_status: "approved" },
    ],
    sms_contact_permissions: [
      {
        id: "p1", studio_id: STUDIO_A, organizer_id: null, client_id: "33333333-3333-4333-8333-333333333333", organizer_contact_id: null,
        phone_e164: PHONE, consent_status: "opted_in", consent_source: "public_lead_form", consent_at: "2026-09-01T00:00:00.000Z",
        opted_out_at: null, opted_out_source: null, updated_at: "2026-09-01T00:00:00.000Z",
      } as FakeRow,
    ],
  });
  db.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: true, error: null }));
  return db;
}

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SMS_INBOUND_RECORDING"] as const;
const saved: Record<string, string | undefined> = {};
let ip = 0;

function req(body: string, opts: { headers?: Record<string, string>; signedUrl?: string; signedBody?: string; extra?: Record<string, string> } = {}) {
  const params: Record<string, string> = { From: PHONE, To: SENDER_A, Body: body, MessageSid: SID, ...opts.extra };
  const signed = { ...params, Body: opts.signedBody ?? body };
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `203.0.113.${++ip % 250}`,
      "x-twilio-signature": getExpectedTwilioSignature(TEST_TOKEN, opts.signedUrl ?? WEBHOOK_URL, signed),
      ...opts.headers,
    },
    body: new URLSearchParams(params).toString(),
  });
}

const rpc = (name: string) => fake.current!.rpcCalls.filter((c) => c.name === name);
const status = () => String(fake.current!.rows("sms_contact_permissions")[0].consent_status);
const optOutNow = () => {
  fake.current!.rows("sms_contact_permissions")[0].consent_status = "opted_out";
  return { data: { rows_changed: 1 }, error: null };
};
const dbError = () => ({ data: null, error: { code: "57014" } });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  delete process.env.SMS_INBOUND_RECORDING;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("opt-out is durable and independent of billing", () => {
  it.each(["STOP.", "stop!", " Stop "])("fallback %j opts out", async (body) => {
    fake.current = createFakeSupabase();
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(status()).toBe("opted_out");
  });

  it.each([
    ["an rpc error", () => ({ data: null, error: { code: "P0001", message: "insufficient balance" } })],
    ["an exhausted-balance answer", () => ({ data: { recorded: false, reason: "no_credit" }, error: null })],
    ["a thrown exception", () => { throw new Error("billing down"); }],
  ])("a STOP is recorded and confirmed when usage recording fails with %s", async (_n, handler) => {
    process.env.SMS_INBOUND_RECORDING = "on";
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("tw4_inbound_record", handler as never);
    const res = await POST(req("STOP"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Message>");
    expect(status()).toBe("opted_out");
  });

  it("a failing read or log write before the consent change cannot stop the opt-out", async () => {
    fake.current = createFakeSupabase();
    const client = fake.current.client as unknown as { from: (t: string) => unknown };
    const original = client.from.bind(client);
    client.from = (table: string) => {
      if (table === "studios" || table === "sms_message_logs") throw new Error(`${table} unavailable`);
      return original(table);
    };
    const res = await POST(req("STOP"));
    expect(res.status).toBe(200);
    expect(status()).toBe("opted_out");
  });

  it("a transient consent-function failure is retried once inline; the STOP is applied and confirmed", async () => {
    fake.current = createFakeSupabase();
    let n = 0;
    fake.current.overrideRpc("record_sms_inbound_opt_event", () => (++n === 1 ? dbError() : optOutNow()));
    const res = await POST(req("STOP"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Message>");
    expect(status()).toBe("opted_out");
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(2);
  });

  it("a persistent consent-function failure on a STOP is not acknowledged with 2xx", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("record_sms_inbound_opt_event", dbError);
    expect((await POST(req("STOP"))).status).toBe(503);
  });

  it("a persistent failure on a Twilio-handled STOP is also non-2xx", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("record_sms_inbound_opt_event", dbError);
    expect((await POST(req("anything", { extra: { OptOutType: "STOP" } }))).status).toBe(503);
  });

  it("a failed START stays fail-safe: 200, consent untouched (the texter remains opted out)", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("record_sms_inbound_opt_event", dbError);
    fake.current.rows("sms_contact_permissions")[0].consent_status = "opted_out";
    const res = await POST(req("START"));
    expect(res.status).toBe(200);
    // exactly one consent call, and it failed: nothing was restored, created or written
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(1);
    expect(fake.current.mutations.filter((m) => m.table === "sms_contact_permissions")).toHaveLength(0);
    expect(status()).toBe("opted_out");
  });

  /** a replay ledger with the real semantics: seen() reads it, record() claims it (first caller wins) */
  function ledger() {
    const claimed = new Set<string>();
    fake.current!.overrideRpc("sms_webhook_receipt_seen", (a) => ({ data: claimed.has(String(a.p_event_key)), error: null }));
    fake.current!.overrideRpc("sms_webhook_receipt_record", (a) => {
      const first = !claimed.has(String(a.p_event_key));
      claimed.add(String(a.p_event_key));
      return { data: first, error: null };
    });
    return claimed;
  }
  const STOP_SID = "SM" + "1".repeat(32);
  const START_SID = "SM" + "2".repeat(32);

  it("consent AND park both failed (503): no claim is recorded, so the redelivery is processed afresh and applies the STOP", async () => {
    fake.current = createFakeSupabase();
    const claimed = ledger();
    let fail = true;
    fake.current.overrideRpc("record_sms_inbound_opt_event", () => (fail ? dbError() : optOutNow()));
    expect((await POST(req("STOP", { extra: { MessageSid: STOP_SID } }))).status).toBe(503);
    expect(claimed.size).toBe(0); // nothing claimed: the failure is not remembered as handled
    expect(status()).toBe("opted_in");
    fail = false;
    const retry = await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    expect(retry.status).toBe(200);
    expect(status()).toBe("opted_out");
    expect(claimed.has(STOP_SID)).toBe(true);
  });

  it("a STOP that was applied is claimed; its redelivery never re-applies (no consent RPC, no reply)", async () => {
    fake.current = createFakeSupabase();
    ledger();
    await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    const before = rpc("record_sms_inbound_opt_event").length;
    const dup = await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    expect(await dup.text()).toBe(EMPTY_TWIML);
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(before);
  });

  it("out of order, with NO identity/log rows to order them: STOP (applied) -> START -> late redelivery of the STOP leaves the texter opted IN, no consent RPC", async () => {
    fake.current = createFakeSupabase();
    fake.current.rows("sms_contact_permissions").length = 0; // an unknown number: no client row, so no inbound log is ever written
    ledger();
    await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    await POST(req("START", { extra: { MessageSid: START_SID } }));
    const before = rpc("record_sms_inbound_opt_event").length;
    const late = await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    expect(late.status).toBe(200);
    expect(await late.text()).toBe(EMPTY_TWIML);
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(before);
    expect(fake.current.rows("sms_message_logs")).toHaveLength(0);
    // the START's effect stands: no phone-level opt-out is left behind
    expect(fake.current.rows("sms_contact_permissions").filter((r) => r.consent_status === "opted_out")).toHaveLength(0);
  });

  it("a parked STOP is claimed too (consent failed, park succeeded): the redelivery does nothing", async () => {
    fake.current = createFakeSupabase();
    const claimed = ledger();
    fake.current.overrideRpc("record_sms_inbound_opt_event", dbError);
    fake.current.overrideRpc("sms_pending_opt_out_record", () => ({ data: true, error: null }));
    expect((await POST(req("STOP", { extra: { MessageSid: STOP_SID } }))).status).toBe(200);
    expect(claimed.has(STOP_SID)).toBe(true);
    const before = rpc("record_sms_inbound_opt_event").length;
    await POST(req("STOP", { extra: { MessageSid: STOP_SID } }));
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(before);
  });

  it("a replayed START never changes consent (an old START must not undo a later STOP)", async () => {
    fake.current = createFakeSupabase();
    fake.current.overrideRpc("sms_webhook_receipt_record", () => ({ data: false, error: null }));
    expect(await (await POST(req("START"))).text()).toBe(EMPTY_TWIML);
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(0);
  });

  it("a START whose first supersede call fails is retried once", async () => {
    fake.current = createFakeSupabase();
    let n = 0;
    fake.current.overrideRpc("sms_pending_opt_out_supersede", () => (++n === 1 ? dbError() : { data: 1, error: null }));
    expect((await POST(req("START"))).status).toBe(200);
    expect(n).toBe(2);
  });
});

describe("webhook authentication fails closed", () => {
  const untouched = () => {
    expect(rpc("record_sms_inbound_opt_event")).toHaveLength(0);
    expect(rpc("sms_webhook_receipt_record")).toHaveLength(0);
    expect(status()).toBe("opted_in");
  };

  it("a signature computed for a different host is refused", async () => {
    fake.current = createFakeSupabase();
    expect((await POST(req("STOP", { signedUrl: "https://evil.example.com/api/sms/twilio/inbound" }))).status).toBe(403);
    untouched();
  });

  it("a signature computed for http (wrong scheme) or another path is refused", async () => {
    fake.current = createFakeSupabase();
    expect((await POST(req("STOP", { signedUrl: "http://www.idanceflow.com/api/sms/twilio/inbound" }))).status).toBe(403);
    expect((await POST(req("STOP", { signedUrl: "https://www.idanceflow.com/api/sms/twilio/status" }))).status).toBe(403);
    untouched();
  });

  it("a forged x-forwarded-host cannot make a wrong-host signature verify", async () => {
    fake.current = createFakeSupabase();
    const res = await POST(req("STOP", { signedUrl: "https://evil.example.com/api/sms/twilio/inbound", headers: { "x-forwarded-host": "www.idanceflow.com" } }));
    expect(res.status).toBe(403);
    untouched();
  });

  it("a signed benign message whose Body was swapped for STOP is refused (body tampering)", async () => {
    fake.current = createFakeSupabase();
    expect((await POST(req("STOP", { signedBody: "hello" }))).status).toBe(403);
    untouched();
  });

  it("a request with no signature header is refused before any database access", async () => {
    fake.current = createFakeSupabase();
    const r = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.250" },
      body: new URLSearchParams({ From: PHONE, To: SENDER_A, Body: "STOP", MessageSid: SID }).toString(),
    });
    expect((await POST(r)).status).toBe(403);
    expect(fake.current.rpcCalls).toHaveLength(0);
  });
});
