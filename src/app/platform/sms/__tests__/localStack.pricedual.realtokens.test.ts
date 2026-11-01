/**
 * D4-1: SMS price dual control with REAL tokens issued by a LOCAL GoTrue (TOTP MFA), sent through Kong -> PostgREST -> the database. Same harness as
 * localStack.aal2.realtokens (run-chain.mjs suites --auth). LOCAL / DISPOSABLE STACK ONLY; never touches DEV or PROD, Twilio, Stripe or any real account.
 * Synthetic users on the reserved domain example.test, a throwaway password generated at run time (never logged), a TOTP factor whose secret the local GoTrue returns.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { RP_ID, ORIGIN, SoftAuthenticator } from "../../../../lib/sms/twilioIsv/__tests__/webauthnFixture";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const AUTH = process.env.TW4_LOCAL_AUTH_URL ?? "";
const isLoopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
const enabled = Boolean(URL_ && SECRET && PG && AUTH) && isLoopback(URL_) && isLoopback(AUTH);

const RUN = randomBytes(4).toString("hex");

function psql(sql: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    throw new Error(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim());
  }
}

// ---------------------------------------------------------------------------------------------------------------- tokens
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signHs256(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const decode = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

function base32(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
/** RFC 6238 (HMAC-SHA1, 30 s step, 6 digits) */
function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

async function http(method: string, url: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", apikey: "local-no-key-auth", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json: json as Record<string, unknown> | unknown[] | null, text };
}
const rest = (method: string, p: string, token: string, body?: unknown, extra: Record<string, string> = {}) => http(method, `${URL_}/rest/v1/${p}`, token, body, extra);
const code = (r: { json: unknown }) => (r.json && !Array.isArray(r.json) ? String((r.json as { code?: unknown }).code ?? "") : "");
/** the database said "insufficient privilege": PostgREST answers 403 (401 only for the anon role) with SQLSTATE 42501 */
const refused = (r: { status: number; json: unknown }) => (r.status === 403 || r.status === 401) && code(r) === "42501";

type Session = { id: string; email: string; password: string; aal1: string; aal2: string };
async function makeUser(label: string, serviceToken: string): Promise<{ id: string; email: string; password: string }> {
  const email = `wpd2-${label}-${RUN}@example.test`;
  const password = `${randomBytes(18).toString("base64url")}Aa1!`;
  const r = await http("POST", `${AUTH}/admin/users`, serviceToken, { email, password, email_confirm: true });
  expect(r.status, `create ${label}: ${r.text.slice(0, 200)}`).toBe(200);
  return { id: String((r.json as { id: string }).id), email, password };
}
async function passwordLogin(email: string, password: string): Promise<string> {
  const r = await http("POST", `${AUTH}/token?grant_type=password`, null, { email, password });
  expect(r.status, `password grant: ${r.text.slice(0, 200)}`).toBe(200);
  return String((r.json as { access_token: string }).access_token);
}
async function stepUp(aal1: string): Promise<string> {
  const enrol = await http("POST", `${AUTH}/factors`, aal1, { factor_type: "totp", friendly_name: `wpd2-${RUN}-${randomBytes(2).toString("hex")}`, issuer: "wpd2.example.test" });
  expect(enrol.status, `enrol: ${enrol.text.slice(0, 200)}`).toBe(200);
  const f = enrol.json as { id: string; totp: { secret: string } };
  expect(f.totp.secret.length).toBeGreaterThan(10);
  // tolerate a small container/host clock offset: current step first, then the neighbours; each attempt opens its own challenge
  let last = "";
  for (const delta of [0, -30000, 30000]) {
    const ch = await http("POST", `${AUTH}/factors/${f.id}/challenge`, aal1, {});
    expect(ch.status, `challenge: ${ch.text.slice(0, 200)}`).toBe(200);
    const v = await http("POST", `${AUTH}/factors/${f.id}/verify`, aal1, { challenge_id: String((ch.json as { id: string }).id), code: totp(f.totp.secret, Date.now() + delta) });
    if (v.status === 200) return String((v.json as { access_token: string }).access_token);
    last = v.text.slice(0, 200);
  }
  throw new Error(`TOTP verify failed: ${last}`);
}


/** a token minted with the stack's own secret (what a holder of the service-role / JWT secret could sign): used only to prove what the database does with such claims */
const signClaims = (sub: string, over: Record<string, unknown> = {}) =>
  signHs256({ sub, role: "authenticated", aud: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 30 }], ...over });
const rpcCall = (fn: string, token: string, body: Record<string, unknown>) => rest("POST", `rpc/${fn}`, token, body);
const sqlOne = (q: string) => psql(q);
const priceRows = (kind: string, cents: number) => Number(sqlOne(`select count(*) from public.studio_sms_price_list where kind = '${kind}' and customer_price_cents = ${cents}`));

const setMode = (mode: string) => psql(`begin; alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set mode = '${mode}'; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard; commit;`);
let A: Session;
let B: Session;
let plainUser: Session;
let unreg: Session;

describe.skipIf(!enabled)("D4-1: price dual control with REAL GoTrue tokens through Kong and PostgREST (local, disposable)", () => {
  beforeAll(async () => {
    const t0 = Date.now();
    for (;;) {
      try {
        const h = await fetch(`${AUTH}/health`, { signal: AbortSignal.timeout(5000) });
        if (h.status === 200 && psql("select to_regclass('auth.mfa_factors') is not null") === "t") break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 120_000) throw new Error("local GoTrue did not become healthy");
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(psql("select to_regprocedure('public.tw4_price_approve(uuid,text)') is not null")).toBe("t");
    setMode("team"); // RT-01..08 are the team-mode flow; RT-09 is the single-owner ceremony with a software authenticator
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d41-local", exp: Math.floor(Date.now() / 1000) + 3600 });
    const mk = async (label: string, admin: boolean, registered: boolean): Promise<Session> => {
      const u = await makeUser(label, service);
      psql(`insert into public.profiles (id, platform_role) values ('${u.id}', ${admin ? "'platform_admin'" : "null"}) on conflict (id) do update set platform_role = excluded.platform_role;
        ${registered ? `insert into public.studio_sms_price_approvers (user_id, added_note) values ('${u.id}', 'real token test approver') on conflict (user_id) do nothing;` : ""}`);
      const a1 = await passwordLogin(u.email, u.password);
      return { ...u, aal1: a1, aal2: await stepUp(a1) };
    };
    A = await mk("price-a", true, true);
    B = await mk("price-b", true, true);
    plainUser = await mk("price-plain", false, true);
    unreg = await mk("price-unreg", true, false);
    // a baseline price through the owner-level workflow (fixture requester + approver), so the real tokens have something to change
    psql(`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values ('d41f1c70-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fixture-req@d41.test', now(), now(), now()) on conflict (id) do nothing;
      insert into public.profiles (id, platform_role) values ('d41f1c70-0000-4000-8000-0000000000aa', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
      insert into public.studio_sms_price_approvers (user_id, added_note) values ('d41f1c70-0000-4000-8000-0000000000aa', 'real token test fixture') on conflict (user_id) do nothing;
      select public._tw4price_do_approve((public._tw4price_do_propose('number', 200, 115, 'baseline number price', 'baseline for the real token test', 'd41f1c70-0000-4000-8000-0000000000aa')->>'request_id')::uuid, '${A.id}', 'baseline approved by the first admin');
      update public.profiles set platform_role = null where id = 'd41f1c70-0000-4000-8000-0000000000aa';`);
  }, 300_000);

  const propose = (token: string, cents: number) => rpcCall("tw4_price_propose", token, { p_kind: "number", p_customer_cents: cents, p_provider_cents: 115, p_description: "real token price", p_reason: "a written reason for the real token test" });
  const approve = (token: string, id: string) => rpcCall("tw4_price_approve", token, { p_request_id: id, p_note: "approved with a real aal2 session after reading it" });
  const open = () => sqlOne(`select id from public.studio_sms_price_change_requests where kind = 'number' and status = 'pending'`);
  const clear = () => {
    const id = open();
    if (id) sqlOne(`select public._tw4price_do_reject('${id}', requested_by, 'withdrawn to start the next real token scenario') from public.studio_sms_price_change_requests where id = '${id}'`);
  };

  it("RT-01 the tokens are what GoTrue issued: password-only is aal1, after the TOTP code aal2 with the totp method", () => {
    expect(decode(A.aal1).aal).toBe("aal1");
    expect(decode(A.aal2).aal).toBe("aal2");
    expect(JSON.stringify(decode(A.aal2).amr)).toContain("totp");
    expect(decode(A.aal2).role).toBe("authenticated");
  });

  it("RT-02 aal1 (password only) is refused on propose, approve, reject and list; nothing is created or changed", async () => {
    clear();
    const before = sqlOne(`select count(*) from public.studio_sms_price_change_requests`);
    expect(refused(await propose(A.aal1, 301))).toBe(true);
    expect(refused(await rpcCall("tw4_price_requests_list", A.aal1, {}))).toBe(true);
    expect(refused(await rpcCall("tw4_price_reject", A.aal1, { p_request_id: randomUUID(), p_note: "an aal1 rejection attempt" }))).toBe(true);
    expect(sqlOne(`select count(*) from public.studio_sms_price_change_requests`)).toBe(before);
  });

  it("RT-03 fresh aal2 + TOTP: A proposes, B approves with his OWN aal2 session; the price is published once; the decider is B, the requester A", async () => {
    clear();
    const p = await propose(A.aal2, 302);
    expect(p.status, p.text).toBe(200);
    const id = String((p.json as { request_id: string }).request_id);
    expect(sqlOne(`select requested_by from public.studio_sms_price_change_requests where id = '${id}'`)).toBe(A.id);
    expect(priceRows("number", 302)).toBe(0);
    // the requester cannot approve their own proposal even with a perfect session
    expect(refused(await approve(A.aal2, id))).toBe(true);
    const ok = await approve(B.aal2, id);
    expect(ok.status, ok.text).toBe(200);
    expect((ok.json as { status: string }).status).toBe("applied");
    expect(sqlOne(`select decided_by from public.studio_sms_price_change_requests where id = '${id}'`)).toBe(B.id);
    expect(priceRows("number", 302)).toBe(1);
    expect(sqlOne(`select created_by from public.studio_sms_price_list where kind = 'number' and active`)).toBe(B.id);
    // a replay by the same approver is idempotent, by anyone else refused
    const again = await approve(B.aal2, id);
    expect(again.status).toBe(200);
    expect((again.json as { replayed: boolean }).replayed).toBe(true);
    expect(priceRows("number", 302)).toBe(1);
  });

  it("RT-04 an aal2 session whose TOTP is older than 15 minutes (claims signed with the stack secret) is refused for propose and approve, but accepted for reject (aal2 tier)", async () => {
    clear();
    const p = await propose(A.aal2, 303);
    const id = String((p.json as { request_id: string }).request_id);
    const stale = signClaims(B.id, { amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 20 * 60 }] });
    expect(refused(await approve(stale, id))).toBe(true);
    expect(refused(await propose(signClaims(A.id, { amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 20 * 60 }] }), 304))).toBe(true);
    expect(sqlOne(`select status from public.studio_sms_price_change_requests where id = '${id}'`)).toBe("pending");
    const rej = await rpcCall("tw4_price_reject", stale, { p_request_id: id, p_note: "rejected with an old but aal2 code, allowed at the aal2 tier" });
    expect(rej.status, rej.text).toBe(200);
    expect(sqlOne(`select status from public.studio_sms_price_change_requests where id = '${id}'`)).toBe("rejected");
  });

  it("RT-05 forged and swapped tokens are refused before the database: a token signed with another secret, a token whose subject was edited after signing, an expired token", async () => {
    clear();
    const p = await propose(A.aal2, 305);
    const id = String((p.json as { request_id: string }).request_id);
    // signed with another secret
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: B.id, role: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] })).toString("base64url");
    const wrongSecret = `${head}.${body}.${createHmac("sha256", "not-the-stack-secret").update(`${head}.${body}`).digest("base64url")}`;
    const r1 = await approve(wrongSecret, id);
    expect([401, 403]).toContain(r1.status);
    expect(r1.status === 200).toBe(false);
    // B's genuine token with the subject swapped to A's id but the old signature
    const [h, , s] = B.aal2.split(".");
    const swapped = `${h}.${Buffer.from(JSON.stringify({ ...decode(B.aal2), sub: A.id })).toString("base64url")}.${s}`;
    const r2 = await approve(swapped, id);
    expect([401, 403]).toContain(r2.status);
    // expired
    const expired = signClaims(B.id, { exp: Math.floor(Date.now() / 1000) - 60 });
    const r3 = await approve(expired, id);
    expect([401, 403]).toContain(r3.status);
    expect(sqlOne(`select status from public.studio_sms_price_change_requests where id = '${id}'`)).toBe("pending");
    expect(priceRows("number", 305)).toBe(0);
  });

  it("RT-06 service_role cannot approve, propose or reject: a service-role token gets permission denied on the public functions, and the old actor-taking shape (p_actor) does not exist; nothing is published", async () => {
    clear();
    const p = await propose(A.aal2, 306);
    const id = String((p.json as { request_id: string }).request_id);
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d41-local", exp: Math.floor(Date.now() / 1000) + 3600 });
    const r1 = await rpcCall("tw4_price_approve", service, { p_request_id: id, p_note: "service role approval attempt, no actor" });
    expect(refused(r1)).toBe(true);
    const r2 = await rpcCall("tw4_price_approve", service, { p_request_id: id, p_actor: B.id, p_note: "service role approval with a chosen actor" });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status === 200).toBe(false);
    const r3 = await rpcCall("_tw4price_do_approve", service, { p_request_id: id, p_actor: B.id, p_note: "service role call of the internal function" });
    expect(r3.status).toBeGreaterThanOrEqual(400);
    expect(refused(await propose(service, 307))).toBe(true);
    // the authenticated B token with the old shape (an extra p_actor) finds no such function either
    const r4 = await rpcCall("tw4_price_approve", B.aal2, { p_request_id: id, p_actor: A.id, p_note: "chosen actor with a genuine session" });
    expect(r4.status).toBeGreaterThanOrEqual(400);
    expect(sqlOne(`select status from public.studio_sms_price_change_requests where id = '${id}'`)).toBe("pending");
    expect(priceRows("number", 306)).toBe(0);
    clear();
  });

  it("RT-07 a genuine aal2 session that is not a registered administrator (or not an administrator at all) is refused; registering a user whose profile role is forged changes nothing without the registry", async () => {
    clear();
    expect(refused(await propose(unreg.aal2, 308))).toBe(true); // administrator by role, not registered
    expect(refused(await propose(plainUser.aal2, 309))).toBe(true); // registered, but no platform role
    const p = await propose(A.aal2, 310);
    const id = String((p.json as { request_id: string }).request_id);
    expect(refused(await approve(unreg.aal2, id))).toBe(true);
    expect(refused(await approve(plainUser.aal2, id))).toBe(true);
    expect(sqlOne(`select status from public.studio_sms_price_change_requests where id = '${id}'`)).toBe("pending");
    // the registry is not reachable from any API role
    const ins = await rest("POST", "studio_sms_price_approvers", unreg.aal2, { user_id: unreg.id, added_note: "self registration attempt" });
    expect(ins.status).toBeGreaterThanOrEqual(400);
    expect(sqlOne(`select count(*) from public.studio_sms_price_approvers where user_id = '${unreg.id}'`)).toBe("0");
    clear();
  });

  it("RT-08 the list works for a registered aal2 administrator and for no one else", async () => {
    const ok = await rpcCall("tw4_price_requests_list", A.aal2, {});
    expect(ok.status, ok.text).toBe(200);
    expect(Array.isArray((ok.json as { requests: unknown[] }).requests)).toBe(true);
    expect(refused(await rpcCall("tw4_price_requests_list", unreg.aal2, {}))).toBe(true);
    expect(refused(await rpcCall("tw4_price_requests_list", plainUser.aal2, {}))).toBe(true);
  });

  it("RT-09 single-owner ceremony with REAL GoTrue sessions: propose in one session, cooling-off, then a SEPARATE real session (a different session_id) plus a hardware-style assertion publishes; the proposing session and a service-role token cannot", async () => {
    clear();
    setMode("single_owner");
    try {
      const K = new SoftAuthenticator();
      psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${K.hex.cred}', 'hex'), decode('${K.hex.x}', 'hex'), decode('${K.hex.y}', 'hex'), 'real token test key')`);
      const p = await propose(A.aal2, 401);
      expect(p.status, p.text).toBe(200);
      const id = String((p.json as { request_id: string }).request_id);
      expect((p.json as { mode: string }).mode).toBe("owner");
      // inside the cooling-off: no challenge for anyone
      const early = await rpcCall("tw4_price_authz_begin", A.aal2, { p_request_id: id });
      expect(early.status).toBeGreaterThanOrEqual(400);
      // the cooling-off ends (owner-level ageing; the row constraints move together)
      psql(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard; update public.studio_sms_price_change_requests set requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours', cooling_until = cooling_until - interval '25 hours' where id = '${id}'; alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard; commit;`);
      // the proposing session cannot authorize
      expect(refused(await rpcCall("tw4_price_authz_begin", A.aal2, { p_request_id: id }))).toBe(true);
      // a service-role token cannot
      const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d41-local", exp: Math.floor(Date.now() / 1000) + 3600 });
      expect(refused(await rpcCall("tw4_price_authz_begin", service, { p_request_id: id }))).toBe(true);
      // a NEW real session of the same user (password login + TOTP): a different session_id
      const a1 = await passwordLogin(A.email, A.password);
      const second = await stepUp(a1);
      expect(decode(second).session_id).toBeTruthy();
      expect(decode(second).session_id).not.toBe(decode(A.aal2).session_id);
      const b = await rpcCall("tw4_price_authz_begin", second, { p_request_id: id });
      expect(b.status, b.text).toBe(200);
      const ch = b.json as { nonce: string; challenge: string };
      // a wrong key's assertion is rejected; the right key's publishes
      const bad = new SoftAuthenticator().assert(ch.challenge);
      const fin = (a: { credId: string; auth: string; client: string; sig: string }, token = second) =>
        rpcCall("tw4_price_authz_finish", token, { p_request_id: id, p_nonce: ch.nonce, p_credential_id: a.credId, p_auth_data: a.auth, p_client_data: a.client, p_signature: a.sig });
      expect((await fin(bad)).json).toMatchObject({ status: "rejected" });
      expect(priceRows("number", 401)).toBe(0);
      // the proposing session with the right assertion is still refused
      expect(refused(await fin(K.assert(ch.challenge), A.aal2))).toBe(true);
      const ok = await fin(K.assert(ch.challenge));
      expect(ok.status, ok.text).toBe(200);
      expect((ok.json as { status: string }).status).toBe("applied");
      expect(priceRows("number", 401)).toBe(1);
      expect(sqlOne(`select decided_by from public.studio_sms_price_change_requests where id = '${id}'`)).toBe(A.id);
    } finally {
      setMode("team");
    }
  });
});
