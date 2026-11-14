import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * TW-4F compliance: a STOP whose consent change fails at the webhook cannot be permanently lost, even though Twilio never retries the response.
 * The webhook parks it (sms_pending_opt_out_*), and the scheduled notification sender applies it first on its next run. A later START supersedes it.
 * The database functions are emulated here with the semantics of migration 20270215100000.
 */

const h = vi.hoisted(() => ({ current: null as ReturnType<typeof makeDb> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.current!.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.current!.cronClient }));
vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => null }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchQueuedOutboundDeliveries: async () => ({ processed: 0 }) }));

import { POST as inboundPost } from "@/app/api/sms/twilio/inbound/route";
import { GET as cronGet } from "@/app/api/notifications/send/route";
import { NextRequest } from "next/server";

const TOKEN = "fake-test-auth-token";
const URL_ = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const SENDER = "+15550109999";
const SERVICE = `MG${"a1".repeat(16)}`;

type Pending = { studio: string; phone: string; applied: boolean; superseded: boolean };

function makeDb() {
  const db = createBaseFake({
    studios: [{ id: STUDIO, name: "Harbor Dance Studio" }],
    studio_sms_registrations: [
      { id: "reg", studio_id: STUDIO, messaging_service_sid: SERVICE, campaign_sid: `QE${"0f".repeat(16)}`, sender_e164: SENDER, registration_status: "approved" },
    ],
    sms_contact_permissions: [
      {
        id: "p1", studio_id: STUDIO, organizer_id: null, client_id: "33333333-3333-4333-8333-333333333333", organizer_contact_id: null, phone_e164: PHONE,
        consent_status: "opted_in", consent_source: "public_lead_form", consent_at: "2026-09-01T00:00:00.000Z", opted_out_at: null, opted_out_source: null,
        updated_at: "2026-09-01T00:00:00.000Z",
      } as FakeRow,
    ],
  });
  const state = { consentDown: true, pendingTableDown: false, pending: [] as Pending[] };
  const perm = () => db.rows("sms_contact_permissions")[0];
  const consent = (event: string) => {
    perm().consent_status = event === "stop" ? "opted_out" : "opted_in";
    return { data: { rows_changed: 1 }, error: null };
  };
  db.overrideRpc("tw4_inbound_reply_allowed", () => ({ data: true, error: null }));
  db.overrideRpc("record_sms_inbound_opt_event", (a) => (state.consentDown ? { data: null, error: { code: "57014" } } : consent(String(a.p_event))));
  db.overrideRpc("sms_pending_opt_out_record", (a) => {
    if (state.pendingTableDown) return { data: null, error: { code: "57014" } };
    if (!state.pending.some((p) => p.studio === a.p_studio_id && p.phone === a.p_phone_e164 && !p.applied && !p.superseded)) {
      state.pending.push({ studio: String(a.p_studio_id), phone: String(a.p_phone_e164), applied: false, superseded: false });
    }
    return { data: true, error: null };
  });
  db.overrideRpc("sms_pending_opt_out_supersede", (a) => {
    for (const p of state.pending) if (p.studio === a.p_studio_id && p.phone === a.p_phone_e164 && !p.applied && !p.superseded) p.superseded = true;
    return { data: 1, error: null };
  });
  db.overrideRpc("sms_pending_opt_out_apply", () => {
    let applied = 0;
    let failed = 0;
    for (const p of state.pending.filter((x) => !x.applied && !x.superseded)) {
      if (state.consentDown) { failed += 1; continue; }
      consent("stop");
      p.applied = true;
      applied += 1;
    }
    return { data: { applied, failed }, error: null };
  });
  // the notification sender reads nothing else in these tests
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, { get: (_t, prop) => (prop === "then" ? (r: (v: unknown) => unknown) => r({ data: [], error: null }) : () => self) });
  const order: string[] = [];
  const cronClient = {
    rpc: (name: string, args: Record<string, unknown>) => { order.push(`rpc:${name}`); return db.client.rpc(name, args); },
    from: () => { order.push("from"); return self; },
  };
  return { ...db, state, order, cronClient, perm };
}

const ENV = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let n = 0;
let sidCounter = 0;

function inbound(body: string) {
  const params = { From: PHONE, To: SENDER, Body: body, MessageSid: `SM${String(++sidCounter).padStart(32, "0")}` };
  return inboundPost(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${++n % 250}`, "x-twilio-signature": getExpectedTwilioSignature(TOKEN, URL_, params) },
    body: new URLSearchParams(params).toString(),
  }));
}
const cron = () => cronGet(new NextRequest("https://www.idanceflow.com/api/notifications/send"));

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.current = makeDb();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe("a failed STOP is eventually applied even if Twilio never retries", () => {
  it("consent down twice -> the STOP is parked and answered as handled; the next scheduled run applies it", async () => {
    const res = await inbound("STOP");
    expect(res.status).toBe(200); // handled: Twilio sees success and will NOT redeliver
    expect(h.current!.perm().consent_status).toBe("opted_in"); // not applied yet
    expect(h.current!.state.pending).toHaveLength(1);

    h.current!.state.consentDown = false; // the database recovers; no redelivery ever happens
    await cron();
    expect(h.current!.perm().consent_status).toBe("opted_out");
    expect(h.current!.state.pending[0].applied).toBe(true);
  });

  it("the sender cron applies pending opt-outs BEFORE it reads or sends anything", async () => {
    h.current!.state.consentDown = false;
    h.current!.state.pending.push({ studio: STUDIO, phone: PHONE, applied: false, superseded: false });
    await cron();
    expect(h.current!.order[0]).toBe("rpc:sms_pending_opt_out_apply");
    expect(h.current!.order.indexOf("from")).toBeGreaterThan(0);
  });

  it("while the database is still down the opt-out stays queued and is retried on the next run (not dropped)", async () => {
    await inbound("STOP");
    await cron();
    expect(h.current!.state.pending[0]).toMatchObject({ applied: false, superseded: false });
    h.current!.state.consentDown = false;
    await cron();
    expect(h.current!.perm().consent_status).toBe("opted_out");
  });

  it("a later START supersedes the waiting STOP: the recovery run never undoes it", async () => {
    await inbound("STOP");
    h.current!.state.consentDown = false;
    const start = await inbound("START");
    expect(start.status).toBe(200);
    expect(h.current!.state.pending[0].superseded).toBe(true);
    await cron();
    expect(h.current!.perm().consent_status).toBe("opted_in"); // the texter's newest intent stands
    expect(h.current!.state.pending[0].applied).toBe(false);
  });

  it("a STOP after a START (newer) is a new STOP: applied normally", async () => {
    await inbound("STOP");
    h.current!.state.consentDown = false;
    await inbound("START");
    await inbound("STOP");
    expect(h.current!.perm().consent_status).toBe("opted_out");
  });

  it("if even the park fails (whole database down) the webhook answers 503 and nothing is acknowledged", async () => {
    h.current!.state.pendingTableDown = true;
    expect((await inbound("STOP")).status).toBe(503);
  });

  it("a missing apply function (migration not applied) never breaks the sender cron", async () => {
    h.current!.overrideRpc("sms_pending_opt_out_apply", () => ({ data: null, error: { code: "PGRST202" } }));
    await expect(cron()).resolves.toBeDefined();
  });
});
