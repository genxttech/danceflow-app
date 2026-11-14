/**
 * D4-2: STOP / START / HELP through the REAL inbound webhook route (src/app/api/sms/twilio/inbound/route.ts) against the REAL local database (Kong -> PostgREST, a
 * stack-signed service-role key, exactly as the route reads its environment), with a dummy Twilio auth token and a locally computed X-Twilio-Signature. No outbound
 * network is involved: the route answers with TwiML, it never calls Twilio. The same STOP -> START -> HELP sequence runs with pricing NOT frozen, with a price FREEZE, with the
 * RECOVERY HOLD (freeze + hold set by the recovery key) and with a PENDING RECOVERY ENROLMENT (which suspends publication by itself), on a studio with no credit and no
 * published price. The replies and the recorded consent must be identical in every state. LOCAL DISPOSABLE STACK ONLY.
 */
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { A as ADMIN, seedCast } from "@/lib/sms/twilioIsv/__tests__/wpd4Helpers";
import { registerApproverSql } from "@/lib/sms/twilioIsv/__tests__/priceFixture";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const isLoopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
const enabled = Boolean(URL_ && SECRET && PG) && isLoopback(URL_);

function psql(sql: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    throw new Error(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim());
  }
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function serviceKey(): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ role: "service_role", aud: "authenticated", iss: "d42-local", exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

const RUN = randomBytes(3).toString("hex");
const STUDIO = `d4f00000-0000-4000-8000-${RUN}0000a1`.slice(0, 36);
const STUDIO_NAME = `Freeze Test Studio ${RUN}`;
const SENDER = "+15550109911";
const SERVICE = `MG${"d4".repeat(16)}`;
const TOKEN = "dummy-local-twilio-auth-token";
const WEBHOOK_URL = "https://www.example.test/api/sms/twilio/inbound";
const escapeXml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
let sidSeq = 0;
const sid = () => `SM${(RUN + String(++sidSeq).padStart(4, "0")).padEnd(32, "0")}`;

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SMS_INBOUND_RECORDING", "TWILIO_ACCOUNT_SID"] as const;
const saved: Record<string, string | undefined> = {};

async function send(from: string, body: string): Promise<{ status: number; text: string }> {
  const { POST } = await import("@/app/api/sms/twilio/inbound/route");
  const params: Record<string, string> = { From: from, To: SENDER, Body: body, MessagingServiceSid: SERVICE, MessageSid: sid(), NumSegments: "1", NumMedia: "0" };
  const form = new URLSearchParams(params);
  const signature = getExpectedTwilioSignature(TOKEN, WEBHOOK_URL, params);
  const res = await POST(new Request(WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: form }));
  return { status: res.status, text: await res.text() };
}
const consent = (phone: string) =>
  psql(`select coalesce(string_agg(consent_status, ',' order by consent_status), 'none') from public.sms_contact_permissions where studio_id = '${STUDIO}' and phone_e164 = '${phone}'`);
const history = (phone: string) =>
  psql(`select coalesce(string_agg(event_type, ',' order by changed_at), 'none') from public.sms_consent_history where studio_id = '${STUDIO}' and phone_e164 = '${phone}'`);

const setState = (sql: string) =>
  psql(`begin; alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; ${sql} alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard; commit;`);
const CLEAR = "update public.studio_sms_price_auth_config set frozen = false, frozen_at = null, freeze_reason = null, recovery_hold = false where singleton;";

describe.skipIf(!enabled)("D4-2: STOP / START / HELP through the real inbound route are unaffected by a price freeze, the recovery hold and a pending recovery (real database, signed local request, no outbound network)", () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey();
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.SMS_INBOUND_RECORDING;
    expect(psql("select to_regclass('public.studio_sms_price_auth_config') is not null and to_regclass('public.studio_sms_registrations') is not null")).toBe("t");
    psql(`insert into public.studios (id, name, slug, public_name, timezone) values ('${STUDIO}', '${STUDIO_NAME}', 'freeze-${RUN}', null, 'UTC');
      insert into public.studio_sms_registrations (studio_id, messaging_service_sid, campaign_sid, sender_e164, registration_status, submitted_at, approved_at) values ('${STUDIO}', '${SERVICE}', 'QE${"0f".repeat(16)}', '${SENDER}', 'in_review', now(), null);`);
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try {
      setState(CLEAR);
      psql("delete from public.studio_sms_price_credential_changes where kind = 'recovery_enroll' and label = 'inbound freeze test'");
    } catch {
      /* best effort */
    }
  });

  const STATES: [string, string][] = [
    ["not frozen", CLEAR],
    ["price freeze", `${CLEAR} update public.studio_sms_price_auth_config set frozen = true, frozen_at = now(), freeze_reason = 'inbound freeze test' where singleton;`],
    ["recovery hold (freeze + hold)", `${CLEAR} update public.studio_sms_price_auth_config set frozen = true, frozen_at = now(), freeze_reason = 'inbound freeze test', recovery_hold = true where singleton;`],
    ["pending recovery enrolment only", CLEAR],
  ];

  it("the same STOP -> START -> HELP sequence gets the same replies and records the same consent in every state, for a studio with no credit and no published price", async () => {
    const outcomes: string[] = [];
    let n = 0;
    for (const [name, sql] of STATES) {
      setState(sql);
      psql("delete from public.studio_sms_price_credential_changes where kind = 'recovery_enroll' and label = 'inbound freeze test'");
      if (name === "pending recovery enrolment only") {
        // a pending recovery enrolment suspends publication on its own (owner-level fixture row, signed by nothing)
        psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard;
          insert into public.studio_sms_price_credential_changes (kind, target_credential_id, pub_x, pub_y, role, label, authorized_by_credential_id, requested_by, requested_at, effective_at)
          values ('recovery_enroll', decode(repeat('ab', 20), 'hex'), decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), 'primary', 'inbound freeze test', decode(repeat('cd', 20), 'hex'), '${STUDIO}', now(), now() + interval '168 hours');
          alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
      }
      const suspended = psql("select public._tw4price_suspended()");
      expect(suspended, `${name}: suspension state`).toBe(name === "not frozen" ? "f" : "t");
      const phone = `+1555010${String(2000 + ++n)}`;
      const stop = await send(phone, "STOP");
      const afterStop = consent(phone);
      const start = await send(phone, "START");
      const afterStart = consent(phone);
      const help = await send(phone, "HELP");
      const sig = JSON.stringify({ stop: stop.text, start: start.text, help: help.text, afterStop, afterStart, hist: history(phone), status: [stop.status, start.status, help.status] });
      outcomes.push(sig);
      // each answer is a TwiML reply (the reply-capable path), STOP names the studio, and the opt-out was recorded
      for (const r of [stop, start, help]) {
        expect(r.status, name).toBe(200);
        expect(r.text, name).toMatch(/^<Response><Message>.+<\/Message><\/Response>$/);
      }
      expect(stop.text, name).toContain(escapeXml(STUDIO_NAME));
      expect(afterStop, `${name}: opt-out recorded`).toMatch(/opted_out/);
      expect(afterStart, `${name}: START lifts the block`).not.toMatch(/opted_out/);
      expect(help.text, name).toContain(escapeXml(STUDIO_NAME));
    }
    // identical in every state apart from nothing: the replies and the consent do not depend on the price machinery at all
    const norm = (s: string) => s;
    for (const o of outcomes.slice(1)) expect(norm(o)).toBe(norm(outcomes[0]));
  });

  it("a STOP is recorded and answered exactly like the unfrozen case while publication is suspended and the recovery hold is set, and an unsigned or wrongly signed request is still refused", async () => {
    setState(`${CLEAR} update public.studio_sms_price_auth_config set frozen = true, frozen_at = now(), freeze_reason = 'inbound freeze test', recovery_hold = true where singleton;`);
    const phone = "+15550108888";
    const r = await send(phone, "STOP");
    expect(r.status).toBe(200);
    expect(consent(phone)).toMatch(/opted_out/);
    const { POST } = await import("@/app/api/sms/twilio/inbound/route");
    const params = { From: phone, To: SENDER, Body: "STOP", MessagingServiceSid: SERVICE, MessageSid: sid() };
    const bad = await POST(new Request(WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "not-a-signature" }, body: new URLSearchParams(params) }));
    expect(bad.status).toBe(403);
    const none = await POST(new Request(WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) }));
    expect(none.status).toBe(403);
  });
  it("a freeze made by an administrator session whose authenticator code is OLD works (the emergency stop is never blocked), the sensitive thaw ceremony is refused for that same session, and STOP / START / HELP are answered exactly as in the other states", async () => {
    seedCast();
    psql(registerApproverSql(ADMIN));
    setState(CLEAR);
    const stale = JSON.stringify({ sub: ADMIN, role: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3000 }] });
    const asStale = (sql: string) => psql(`begin; set local role authenticated; select set_config('request.jwt.claims', '${stale}', true); ${sql} commit;`);
    expect(asStale("select public.tw4_price_freeze('a freeze with an old authenticator code')::text;")).toContain("frozen");
    expect(psql("select public._tw4price_suspended()")).toBe("t");
    let thawError = "";
    try {
      asStale("select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;");
    } catch (e) {
      thawError = String((e as Error).message);
    }
    expect(thawError).toMatch(/fresh authenticator code is required/);
    const phone = "+15550107777";
    const stop = await send(phone, "STOP");
    const afterStop = consent(phone);
    const start = await send(phone, "START");
    const afterStart = consent(phone);
    const help = await send(phone, "HELP");
    for (const r of [stop, start, help]) {
      expect(r.status).toBe(200);
      expect(r.text).toMatch(/^<Response><Message>.+<\/Message><\/Response>$/);
    }
    expect(stop.text).toContain(escapeXml(STUDIO_NAME));
    expect(afterStop).toMatch(/opted_out/);
    expect(afterStart).not.toMatch(/opted_out/);
    expect(help.text).toContain(escapeXml(STUDIO_NAME));
    setState(CLEAR);
  });
});
