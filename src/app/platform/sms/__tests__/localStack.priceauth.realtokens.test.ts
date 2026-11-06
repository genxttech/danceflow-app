/**
 * D4-2: the pricing AUTHORIZATION surface (migration 20270208100000) with REAL tokens issued by a LOCAL GoTrue (TOTP MFA), sent through Kong -> PostgREST -> the database.
 * Same harness as localStack.pricedual.realtokens (run-chain.mjs suites --auth). LOCAL / DISPOSABLE STACK ONLY; synthetic users on example.test, throwaway passwords generated at
 * run time, a TOTP factor whose secret the local GoTrue returns, WebAuthn assertions from the software authenticator (verified inside Postgres). Nothing touches a hosted service.
 * Where a token is edited or re-signed (expired, impersonation) it is built FROM a real one and said so.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { RP_ID, ORIGIN, SoftAuthenticator, b64u } from "../../../../lib/sms/twilioIsv/__tests__/webauthnFixture";

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
const num = (q: string) => Number(psql(q));

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
function signHs256(payload: Record<string, unknown>): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const decode = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
/** a token carrying the claims of a REAL one with some overrides, re-signed with the stack secret (what only a secret holder could do) */
const resign = (real: string, over: Record<string, unknown>) => signHs256({ ...decode(real), ...over });

function base32(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, "0");
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
const rpc = (fn: string, token: string, body: Record<string, unknown> = {}) => http("POST", `${URL_}/rest/v1/rpc/${fn}`, token, body);
const code = (r: { json: unknown }) => (r.json && !Array.isArray(r.json) ? String((r.json as { code?: unknown }).code ?? "") : "");
/** the database said "insufficient privilege" (42501) */
const denied = (r: { status: number; json: unknown }) => (r.status === 403 || r.status === 401) && code(r) === "42501";
/** a registered administrator's session reached the function: the answer is a result, a recorded refusal or a domain error, never the identity gate */
const reached = (r: { status: number; json: unknown }) => !denied(r) && r.status !== 401;

type Login = { access: string; refresh: string };
async function login(email: string, password: string): Promise<Login> {
  const r = await http("POST", `${AUTH}/token?grant_type=password`, null, { email, password });
  expect(r.status, `password grant: ${r.text.slice(0, 200)}`).toBe(200);
  const j = r.json as { access_token: string; refresh_token: string };
  return { access: j.access_token, refresh: j.refresh_token };
}
type Factor = { id: string; secret: string };
async function verifyFactor(aal1: string, f: Factor): Promise<Login> {
  let last = "";
  for (const delta of [0, -30000, 30000]) {
    const ch = await http("POST", `${AUTH}/factors/${f.id}/challenge`, aal1, {});
    expect(ch.status, `challenge: ${ch.text.slice(0, 200)}`).toBe(200);
    const v = await http("POST", `${AUTH}/factors/${f.id}/verify`, aal1, { challenge_id: String((ch.json as { id: string }).id), code: totp(f.secret, Date.now() + delta) });
    if (v.status === 200) {
      const j = v.json as { access_token: string; refresh_token: string };
      return { access: j.access_token, refresh: j.refresh_token };
    }
    last = v.text.slice(0, 200);
  }
  throw new Error(`TOTP verify failed: ${last}`);
}
async function enrolFactor(aal1: string): Promise<Factor> {
  const enrol = await http("POST", `${AUTH}/factors`, aal1, { factor_type: "totp", friendly_name: `d42-${RUN}-${randomBytes(2).toString("hex")}`, issuer: "d42.example.test" });
  expect(enrol.status, `enrol: ${enrol.text.slice(0, 200)}`).toBe(200);
  const f = enrol.json as { id: string; totp: { secret: string } };
  return { id: f.id, secret: f.totp.secret };
}

type User = { id: string; email: string; password: string; factor: Factor; aal1: string; aal2: string };
let A: User;
let B: User;
let plain: User;
let unreg: User;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a NEW real session of a user (password login + the existing factor) */
const newSession = async (u: User): Promise<string> => (await verifyFactor((await login(u.email, u.password)).access, u.factor)).access;

const K1 = new SoftAuthenticator();
const K2 = new SoftAuthenticator();
const KR = new SoftAuthenticator();
const asm = (a: { credId: string; auth: string; client: string; sig: string }) => ({ p_credential_id: a.credId, p_auth_data: a.auth, p_client_data: a.client, p_signature: a.sig });
const ageRequest = (id: string) =>
  psql(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard; update public.studio_sms_price_change_requests set requested_at = requested_at - interval '25 hours', cooling_until = cooling_until - interval '25 hours', expires_at = expires_at - interval '25 hours' where id = '${id}'; alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard; commit;`);
const resetCreds = () =>
  psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard;
    delete from public.studio_sms_price_credential_changes; delete from public.studio_sms_price_credentials; set local tw4.priceauth_write = 'on';
    ${[[K1, "primary"], [K2, "spare"], [KR, "recovery"]].map(([k, role]) => `insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via, enrolled_at) values (decode('${(k as SoftAuthenticator).hex.cred}', 'hex'), decode('${(k as SoftAuthenticator).hex.x}', 'hex'), decode('${(k as SoftAuthenticator).hex.y}', 'hex'), '${role}', 'real token ${role}', 'bootstrap', now() - interval '400 hours');`).join(" ")}
    update public.studio_sms_price_auth_config set frozen = false, frozen_at = null, freeze_reason = null, recovery_hold = false;
    do $$ begin if to_regclass('public.studio_sms_price_security_events') is not null then execute 'update public.studio_sms_price_auth_config set monitor_seq_lifted = (select coalesce(max(seq), 0) from public.studio_sms_price_security_events)'; end if; end $$;
    alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
const clearRequests = () => {
  for (const r of psql(`select id || '|' || requested_by from public.studio_sms_price_change_requests where status = 'pending'`).split("\n").filter(Boolean)) {
    const [id, by] = r.split("|");
    psql(`select public._tw4price_do_reject('${id}', '${by}', 'withdrawn to start the next real token scenario')`);
  }
};
const propose = (token: string, cents: number) => rpc("tw4_price_propose", token, { p_kind: "number", p_customer_cents: cents, p_provider_cents: 115, p_description: "real token owner price", p_reason: "a written reason for the real token owner test" });
const counts = () => psql(`select (select count(*) from public.studio_sms_price_audit) || ':' || (select count(*) from public.studio_sms_price_credential_changes) || ':' || (select count(*) from public.studio_sms_price_change_requests) || ':' || (select count(*) from public.studio_sms_price_credentials) || ':' || (select frozen from public.studio_sms_price_auth_config)`);

const DUMMY = "AAAAAAAAAAAAAAAAAAAAAA";
const U = () => randomUUID();
/** every public entry point of the pricing authorization surface with harmless arguments (so an aal1 call can only be stopped by the identity gate) */
const ENTRY_POINTS: [string, () => Record<string, unknown>][] = [
  ["tw4_price_propose", () => ({ p_kind: "number", p_customer_cents: 501, p_provider_cents: 115, p_description: "aal1 attempt", p_reason: "an attempt that must never create anything" })],
  ["tw4_price_approve", () => ({ p_request_id: U(), p_note: "an aal1 approval attempt" })],
  ["tw4_price_reject", () => ({ p_request_id: U(), p_note: "an aal1 rejection attempt" })],
  ["tw4_price_requests_list", () => ({})],
  ["tw4_price_authz_begin", () => ({ p_request_id: U() })],
  ["tw4_price_authz_finish", () => ({ p_request_id: U(), p_nonce: DUMMY, p_credential_id: DUMMY, p_auth_data: DUMMY, p_client_data: DUMMY, p_signature: DUMMY })],
  ["tw4_price_revise", () => ({ p_request_id: U(), p_customer_cents: 502, p_provider_cents: 115, p_description: "aal1 revise", p_reason: "an aal1 revision attempt" })],
  ["tw4_price_cred_begin", () => ({ p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null })],
  ["tw4_price_cred_enroll", () => ({ p_nonce: DUMMY, p_new_cred_id: DUMMY, p_x: DUMMY, p_y: DUMMY, p_role: "spare", p_label: "aal1 enrol", p_by_cred: DUMMY, p_by_auth: DUMMY, p_by_client: DUMMY, p_by_sig: DUMMY, p_new_auth: DUMMY, p_new_client: DUMMY, p_new_sig: DUMMY })],
  ["tw4_price_cred_revoke", () => ({ p_nonce: DUMMY, p_target: DUMMY, p_by_cred: DUMMY, p_by_auth: DUMMY, p_by_client: DUMMY, p_by_sig: DUMMY })],
  ["tw4_price_cred_apply", () => ({ p_change_id: U() })],
  ["tw4_price_cred_cancel", () => ({ p_change_id: U(), p_nonce: DUMMY, p_cred: DUMMY, p_auth: DUMMY, p_client: DUMMY, p_sig: DUMMY })],
  ["tw4_price_cred_pending", () => ({})],
  ["tw4_price_freeze", () => ({ p_reason: "an aal1 freeze attempt, must be refused" })],
  ["tw4_price_thaw", () => ({ p_nonce: DUMMY, p_cred: DUMMY, p_auth: DUMMY, p_client: DUMMY, p_sig: DUMMY })],
  ["tw4_price_report_compromise", () => ({ p_note: "an aal1 compromise report, must be refused" })],
  ["tw4_price_recovery_enroll", () => ({ p_nonce: DUMMY, p_new_cred_id: DUMMY, p_x: DUMMY, p_y: DUMMY, p_label: "aal1 recovery", p_rec_cred: DUMMY, p_rec_auth: DUMMY, p_rec_client: DUMMY, p_rec_sig: DUMMY, p_new_auth: DUMMY, p_new_client: DUMMY, p_new_sig: DUMMY })],
  ["tw4_price_recovery_freeze", () => ({ p_nonce: DUMMY, p_cred: DUMMY, p_auth: DUMMY, p_client: DUMMY, p_sig: DUMMY })],
];

describe.skipIf(!enabled)("D4-2: pricing authorization with REAL GoTrue tokens through Kong and PostgREST (local, disposable)", () => {
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
      await sleep(2000);
    }
    expect(psql("select to_regprocedure('public.tw4_price_authz_begin(uuid)') is not null")).toBe("t");
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d42-local", exp: nowS() + 3600 });
    const mk = async (label: string, admin: boolean, registered: boolean): Promise<User> => {
      const email = `d42-${label}-${RUN}@example.test`;
      const password = `${randomBytes(18).toString("base64url")}Aa1!`;
      const c = await http("POST", `${AUTH}/admin/users`, service, { email, password, email_confirm: true });
      expect(c.status, `create ${label}: ${c.text.slice(0, 200)}`).toBe(200);
      const id = String((c.json as { id: string }).id);
      psql(`insert into public.profiles (id, platform_role) values ('${id}', ${admin ? "'platform_admin'" : "null"}) on conflict (id) do update set platform_role = excluded.platform_role;
        ${registered ? `insert into public.studio_sms_price_approvers (user_id, added_note) values ('${id}', 'real token owner test') on conflict (user_id) do nothing;` : ""}`);
      const a1 = (await login(email, password)).access;
      const factor = await enrolFactor(a1);
      const a2 = (await verifyFactor(a1, factor)).access;
      return { id, email, password, factor, aal1: a1, aal2: a2 };
    };
    A = await mk("own-a", true, true);
    B = await mk("own-b", true, true);
    plain = await mk("own-plain", false, true);
    unreg = await mk("own-unreg", true, false);
    psql(`begin; alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard; update public.studio_sms_price_approvers set added_at = added_at - interval '400 hours'; alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard; commit;`);
    psql(`alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set mode = 'single_owner', monitoring_expected = false; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;`);
    psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${K1.hex.cred}', 'hex'), decode('${K1.hex.x}', 'hex'), decode('${K1.hex.y}', 'hex'), 'real token primary')`);
    resetCreds();
  }, 400_000);

  it("RTA-01 the tokens are what GoTrue issued, and EVERY pricing authorization entry point refuses an aal1 (password only) session of a registered administrator, creating or changing nothing", async () => {
    expect(decode(A.aal1).aal).toBe("aal1");
    expect(decode(A.aal2).aal).toBe("aal2");
    expect(JSON.stringify(decode(A.aal2).amr)).toContain("totp");
    expect(decode(A.aal2).session_id).toBeTruthy();
    clearRequests();
    resetCreds();
    const before = counts();
    for (const [fn, args] of ENTRY_POINTS) {
      const r = await rpc(fn, A.aal1, args());
      expect(denied(r), `${fn} with aal1: ${r.status} ${r.text.slice(0, 160)}`).toBe(true);
    }
    expect(counts()).toBe(before);
  });

  it("RTA-02 a genuine aal2 session of a registered administrator REACHES every entry point (the identity gate passes; the call then answers on its merits), and a freeze / hardware thaw / compromise report round-trip works with real tokens", async () => {
    clearRequests();
    resetCreds();
    for (const [fn, args] of ENTRY_POINTS) {
      if (["tw4_price_freeze", "tw4_price_report_compromise", "tw4_price_propose", "tw4_price_approve", "tw4_price_reject"].includes(fn)) continue; // exercised below with their own state
      const r = await rpc(fn, A.aal2, args());
      expect(reached(r), `${fn} with aal2: ${r.status} ${r.text.slice(0, 160)}`).toBe(true);
    }
    const p = await propose(A.aal2, 511);
    expect(p.status, p.text).toBe(200);
    clearRequests();
    // freeze (a safe-direction act needs only the session), then lift it with the hardware key of a SECOND real session
    const fz = await rpc("tw4_price_freeze", A.aal2, { p_reason: "a real token freeze to be lifted with the hardware key" });
    expect(fz.status, fz.text).toBe(200);
    expect(fz.json).toMatchObject({ status: "frozen" });
    const second = await newSession(A);
    const tb = await rpc("tw4_price_cred_begin", second, { p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null });
    expect(tb.status, tb.text).toBe(200);
    const ch = tb.json as { nonce: string; challenge: string };
    const a = K1.assert(ch.challenge);
    const th = await rpc("tw4_price_thaw", second, { p_nonce: ch.nonce, p_cred: a.credId, p_auth: a.auth, p_client: a.client, p_sig: a.sig });
    expect(th.json).toMatchObject({ status: "thawed" });
    const rc = await rpc("tw4_price_report_compromise", B.aal2, { p_note: "a real token compromise report, lifted again by the test" });
    expect(rc.json).toMatchObject({ status: "frozen" });
    const tb2 = await rpc("tw4_price_cred_begin", second, { p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null });
    const c2 = tb2.json as { nonce: string; challenge: string };
    const a2 = K1.assert(c2.challenge);
    expect((await rpc("tw4_price_thaw", second, { p_nonce: c2.nonce, p_cred: a2.credId, p_auth: a2.auth, p_client: a2.client, p_sig: a2.sig })).json).toMatchObject({ status: "thawed" });
  });

  it("RTA-03 expired tokens (the claims of a real token, expiry in the past, re-signed with the stack secret) and tokens not signed by the stack are refused before the database; nothing changes", async () => {
    clearRequests();
    const before = counts();
    const expired = resign(A.aal2, { exp: nowS() - 120 });
    const foreign = (() => {
      const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64(JSON.stringify({ ...decode(A.aal2), exp: nowS() + 3600 }));
      return `${head}.${body}.${createHmac("sha256", "not-the-stack-secret").update(`${head}.${body}`).digest("base64url")}`;
    })();
    const [h, , s] = B.aal2.split(".");
    const swapped = `${h}.${b64(JSON.stringify({ ...decode(B.aal2), sub: A.id }))}.${s}`;
    for (const t of [expired, foreign, swapped]) {
      for (const [fn, args] of ENTRY_POINTS) {
        const r = await rpc(fn, t, args());
        expect([401, 403], `${fn}: ${r.status}`).toContain(r.status);
        expect(r.status === 200).toBe(false);
      }
    }
    expect(counts()).toBe(before);
  });

  it("RTA-04 signed-out sessions and revoked refresh tokens: after a global sign-out the refresh token cannot mint a new session; the already issued access token is a stateless JWT and is checked against the live session table by the database", async () => {
    resetCreds();
    clearRequests();
    const lg = await login(A.email, A.password);
    const sess = await verifyFactor(lg.access, A.factor);
    // while the session lives it works
    expect(reached(await rpc("tw4_price_cred_pending", sess.access))).toBe(true);
    const out = await http("POST", `${AUTH}/logout?scope=global`, sess.access);
    expect([200, 204]).toContain(out.status);
    // the refresh token is dead
    const rf = await http("POST", `${AUTH}/token?grant_type=refresh_token`, null, { refresh_token: sess.refresh });
    expect(rf.status, rf.text.slice(0, 200)).not.toBe(200);
    // the access token is still a validly signed JWT until it expires, but its session no longer exists: the database refuses it
    const r = await rpc("tw4_price_cred_pending", sess.access);
    expect(denied(r), `signed-out session still accepted: ${r.status} ${r.text.slice(0, 160)}`).toBe(true);
    expect(denied(await propose(sess.access, 512))).toBe(true);
    // a global sign-out ended every session of A: the shared fixture sessions are renewed for the following tests
    A.aal1 = (await login(A.email, A.password)).access;
    A.aal2 = (await verifyFactor(A.aal1, A.factor)).access;
  });

  it("RTA-05 a TOTP factor removed mid-flight: the session that already has aal2 keeps its token until it expires (documented), but a refresh after the removal is aal1 and is refused everywhere; re-adding a factor and verifying restores aal2", async () => {
    resetCreds();
    clearRequests();
    // a user with no verified factor yet (a user who already has one cannot enrol another at aal1: GoTrue answers insufficient_aal)
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d42-local", exp: nowS() + 3600 });
    const email = `d42-mfa-${RUN}@example.test`;
    const password = `${randomBytes(18).toString("base64url")}Aa1!`;
    const created = await http("POST", `${AUTH}/admin/users`, service, { email, password, email_confirm: true });
    expect(created.status, created.text.slice(0, 200)).toBe(200);
    const uid = String((created.json as { id: string }).id);
    psql(`insert into public.profiles (id, platform_role) values ('${uid}', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role; insert into public.studio_sms_price_approvers (user_id, added_note) values ('${uid}', 'mfa removal test') on conflict (user_id) do nothing;`);
    const u = { email, password };
    const lg = await login(u.email, u.password);
    const f2 = await enrolFactor(lg.access);
    const sess = await verifyFactor(lg.access, f2);
    expect(decode(sess.access).aal).toBe("aal2");
    expect(reached(await rpc("tw4_price_cred_pending", sess.access))).toBe(true);
    // remove the factor with that very session
    const del = await http("DELETE", `${AUTH}/factors/${f2.id}`, sess.access);
    expect([200, 204], `unenrol: ${del.text.slice(0, 200)}`).toContain(del.status);
    const rf = await http("POST", `${AUTH}/token?grant_type=refresh_token`, null, { refresh_token: sess.refresh });
    if (rf.status === 200) {
      const fresh = String((rf.json as { access_token: string }).access_token);
      expect(decode(fresh).aal, "a refresh after the factor was removed must not be aal2").toBe("aal1");
      expect(denied(await rpc("tw4_price_cred_pending", fresh))).toBe(true);
      expect(denied(await rpc("tw4_price_freeze", fresh, { p_reason: "a freeze with a refreshed aal1 token, must be refused" }))).toBe(true);
    }
    // a password-only login now has no aal2 path until a factor exists again
    const again = await login(u.email, u.password);
    expect(decode(again.access).aal).toBe("aal1");
    expect(denied(await rpc("tw4_price_cred_pending", again.access))).toBe(true);
    // re-add a factor and verify it: aal2 again, and a fresh TOTP satisfies the recent-MFA tier
    const f3 = await enrolFactor(again.access);
    const ok = await verifyFactor(again.access, f3);
    expect(decode(ok.access).aal).toBe("aal2");
    expect(reached(await rpc("tw4_price_cred_pending", ok.access))).toBe(true);
    expect((await propose(ok.access, 513)).status).toBe(200);
    clearRequests();
  });

  it("RTA-06 a genuine aal2 token of a user who is not a registered platform administrator (an unregistered administrator, a registered user without the platform role) is refused at every entry point and writes no audit row", async () => {
    resetCreds();
    clearRequests();
    const audit0 = num("select count(*) from public.studio_sms_price_audit");
    const before = counts();
    for (const who of [unreg, plain]) {
      for (const [fn, args] of ENTRY_POINTS) {
        const r = await rpc(fn, who.aal2, args());
        expect(denied(r), `${fn} as ${who === unreg ? "unregistered admin" : "plain user"}: ${r.status} ${r.text.slice(0, 120)}`).toBe(true);
      }
    }
    expect(num("select count(*) from public.studio_sms_price_audit")).toBe(audit0);
    expect(counts()).toBe(before);
  });

  it("RTA-07 impersonation: no entry point takes an actor, the internal functions and the tables are unreachable, service_role (a stack-signed token) is denied everywhere, and a challenge issued to one real session cannot be used by another user", async () => {
    resetCreds();
    clearRequests();
    // an extra actor argument matches no function
    const x1 = await rpc("tw4_price_freeze", A.aal2, { p_reason: "an impersonation attempt with a chosen actor", p_actor: B.id });
    expect(x1.status).toBeGreaterThanOrEqual(400);
    expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("f");
    // the internal and owner-level functions are not executable by authenticated or service_role
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d42-local", exp: nowS() + 3600 });
    for (const t of [A.aal2, service]) {
      for (const [fn, body] of [
        ["_tw4price_bootstrap", { p_rp_id: "evil.example", p_origins: ["https://evil.example"], p_cred_id: "\\x00", p_x: "\\x00", p_y: "\\x00", p_label: "evil" }],
        ["_tw4price_prune", { p_keep: "30 days" }],
        ["_tw4price_emit", { p_kind: "forged_event", p_subject: null, p_detail: {} }],
        ["_tw4price_audit", { p_event: "published", p_actor: null, p_session: null, p_request: null, p_credential: null, p_detail: {} }],
        ["_tw4price_do_propose", { p_kind: "number", p_customer_cents: 1, p_provider_cents: 1, p_description: "forged", p_reason: "forged", p_actor: B.id }],
      ] as [string, Record<string, unknown>][]) {
        const r = await rpc(fn, t, body);
        expect(r.status, `${fn}: ${r.text.slice(0, 100)}`).toBeGreaterThanOrEqual(400);
      }
    }
    // service_role is denied on every public entry point (the monitoring read functions are the only exceptions and are not listed here)
    for (const [fn, args] of ENTRY_POINTS) {
      const r = await rpc(fn, service, args());
      expect(denied(r), `${fn} as service_role: ${r.status} ${r.text.slice(0, 100)}`).toBe(true);
    }
    // the tables are not reachable through the REST API by any real session
    for (const t of ["studio_sms_price_credentials", "studio_sms_price_credential_changes", "studio_sms_price_auth_challenges", "studio_sms_price_audit", "studio_sms_price_auth_config", "studio_sms_price_emit_acks"]) {
      expect((await http("GET", `${URL_}/rest/v1/${t}?select=*`, A.aal2)).status, `${t} read`).toBeGreaterThanOrEqual(400);
      expect((await http("POST", `${URL_}/rest/v1/${t}`, A.aal2, {})).status, `${t} write`).toBeGreaterThanOrEqual(400);
    }
    // a challenge issued to A's session is useless to B (another real user) and to A's other session
    clearRequests();
    const p = await propose(A.aal2, 514);
    const id = String((p.json as { request_id: string }).request_id);
    ageRequest(id);
    const sessA2 = await newSession(A);
    const b = await rpc("tw4_price_authz_begin", sessA2, { p_request_id: id });
    expect(b.status, b.text).toBe(200);
    const ch = b.json as { nonce: string; challenge: string };
    const sig = K1.assert(ch.challenge);
    const sessA3 = await newSession(A);
    const fin = (token: string) => rpc("tw4_price_authz_finish", token, { p_request_id: id, p_nonce: ch.nonce, ...asm(sig) });
    expect((await fin(B.aal2)).json).toMatchObject({ status: "refused" }); // another user: not the owner of this proposal
    expect((await fin(sessA3)).json).toMatchObject({ status: "rejected" }); // the owner's other session: the challenge was issued to a different session
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 514`)).toBe(0);
  });

  it("RTA-08 replay across sessions and proposals: one assertion publishes once; it cannot be replayed in any session, nor reused on another proposal or another nonce", async () => {
    resetCreds();
    clearRequests();
    const sessOwner = await newSession(A);
    const mk = async (cents: number) => {
      clearRequests();
      const p = await propose(A.aal2, cents);
      const id = String((p.json as { request_id: string }).request_id);
      ageRequest(id);
      const b = await rpc("tw4_price_authz_begin", sessOwner, { p_request_id: id });
      expect(b.status, b.text).toBe(200);
      return { id, ...(b.json as { nonce: string; challenge: string }) };
    };
    const p1 = await mk(521);
    const sig1 = K1.assert(p1.challenge);
    const fin = (token: string, c: { id: string; nonce: string }, a: typeof sig1) => rpc("tw4_price_authz_finish", token, { p_request_id: c.id, p_nonce: c.nonce, ...asm(a) });
    const ok = await fin(sessOwner, p1, sig1);
    expect(ok.json).toMatchObject({ status: "applied" });
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 521`)).toBe(1);
    // replay: same session, a brand new session, the other administrator
    for (const t of [sessOwner, await newSession(A), B.aal2]) {
      const r = await fin(t, p1, sig1);
      expect((r.json as { status: string }).status === "applied", "a replay must never publish again").toBe(false);
    }
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 521`)).toBe(1);
    // a second proposal: the first proposal's assertion does not authorize it, and neither does an assertion over another nonce
    const p2 = await mk(522);
    expect(((await fin(sessOwner, p2, sig1)).json as { status: string }).status).toBe("rejected");
    const p2again = await rpc("tw4_price_authz_begin", sessOwner, { p_request_id: p2.id }); // a second challenge for the same proposal
    const c2 = p2again.json as { nonce: string; challenge: string };
    const sigOld = K1.assert(p2.challenge);
    expect(((await fin(sessOwner, { id: p2.id, nonce: c2.nonce }, sigOld)).json as { status: string }).status).toBe("rejected"); // the old challenge's signature over the new nonce
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 522`)).toBe(0);
    const good = await fin(sessOwner, { id: p2.id, nonce: c2.nonce }, K1.assert(c2.challenge));
    expect(good.json).toMatchObject({ status: "applied" });
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 522`)).toBe(1);
    // the used nonce is dead even for the right key and a new counter
    expect(((await fin(sessOwner, { id: p2.id, nonce: c2.nonce }, K1.assert(c2.challenge))).json as { status: string }).status === "applied").toBe(false);
  });

  it("RTA-09 out-of-database account takeover surface (observed against the local GoTrue, its default configuration): what a stolen password-only (aal1) session and a stolen aal2 session can do to the owner's MFA and password", async () => {
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "d42-local", exp: nowS() + 3600 });
    const email = `d42-takeover-${RUN}@example.test`;
    const password = `${randomBytes(18).toString("base64url")}Aa1!`;
    const created = await http("POST", `${AUTH}/admin/users`, service, { email, password, email_confirm: true });
    expect(created.status).toBe(200);
    const first = await login(email, password);
    const factor = await enrolFactor(first.access);
    const aal2 = await verifyFactor(first.access, factor);
    const aal1only = await login(email, password); // a stolen password: a NEW password-only session of a user with a verified factor
    expect(decode(aal1only.access).aal).toBe("aal1");
    const observed: Record<string, number> = {};
    // (1) a second factor cannot be enrolled at aal1 once one is verified
    observed.aal1_enrol_factor = (await http("POST", `${AUTH}/factors`, aal1only.access, { factor_type: "totp", friendly_name: `x-${RUN}`, issuer: "d42.example.test" })).status;
    // (2) the verified factor cannot be removed at aal1
    observed.aal1_unenrol_factor = (await http("DELETE", `${AUTH}/factors/${factor.id}`, aal1only.access)).status;
    // (3) password change from the stolen password-only session, and from an aal2 session, without any reauthentication nonce
    observed.aal1_password_change = (await http("PUT", `${AUTH}/user`, aal1only.access, { password: `${randomBytes(18).toString("base64url")}Bb2!` })).status;
    observed.aal2_password_change = (await http("PUT", `${AUTH}/user`, aal2.access, { password: `${randomBytes(18).toString("base64url")}Cc3!` })).status;
    console.warn(`RTA-09 observed GoTrue statuses: ${JSON.stringify(observed)}`);
    // the two protections this design relies on at aal1 hold: no new factor, no factor removal
    expect(observed.aal1_enrol_factor).toBeGreaterThanOrEqual(400);
    expect(observed.aal1_unenrol_factor).toBeGreaterThanOrEqual(400);
    // whatever the password statuses are, the stolen password-only session never reaches the pricing surface
    expect(denied(await rpc("tw4_price_cred_pending", aal1only.access))).toBe(true);
  });

  it("RTA-10 fresh MFA with real tokens: a freshly verified TOTP session passes the sensitive entry points, the claims of that token with an old, missing or malformed amr timestamp (re-signed with the stack secret) are refused, a refresh-token refresh keeps the OLD timestamp (documented), re-verifying a code on the session renews it, and freeze / report_compromise / the recovery freeze work with a stale session", async () => {
    resetCreds();
    clearRequests();
    const sens: [string, Record<string, unknown>][] = [
      ["tw4_price_cred_begin", { p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null }],
      ["tw4_price_authz_begin", { p_request_id: U() }],
      ["tw4_price_cred_apply", { p_change_id: U() }],
      ["tw4_price_propose", { p_kind: "number", p_customer_cents: 513, p_provider_cents: 115, p_description: "fresh test", p_reason: "a written reason for the fresh MFA test" }],
    ];
    const staleMsg = (r: { text: string }) => /fresh authenticator code is required|authenticator \(TOTP\) sign-in is required/.test(r.text);
    const fresh = await newSession(A);
    const amr0 = decode(fresh).amr as { method: string; timestamp: number }[];
    expect(amr0.find((e) => e.method === "totp")?.timestamp, "GoTrue writes the TOTP timestamp in seconds").toBeGreaterThan(nowS() - 60);
    for (const [fn, args] of sens) {
      const r = await rpc(fn, fresh, args);
      expect(staleMsg(r), `${fn} fresh: ${r.text.slice(0, 200)}`).toBe(false);
    }
    clearRequests();
    // the same real token with the TOTP timestamp moved back 11 minutes, removed, or turned into a string-form amr: refused by the database, whatever the signature says
    const variants: [string, unknown][] = [
      ["11 minutes old", [{ ...amr0[0], timestamp: nowS() - 660 }]],
      ["no timestamp", [{ method: "totp" }]],
      ["string amr", ["totp"]],
      ["amr removed", undefined],
    ];
    for (const [label, amr] of variants) {
      const stale = resign(fresh, { amr });
      for (const [fn, args] of sens) {
        const r = await rpc(fn, stale, args);
        expect(denied(r), `${fn} ${label}: ${r.status} ${r.text.slice(0, 160)}`).toBe(true);
        expect(r.text, `${fn} ${label}`).toMatch(/fresh authenticator code is required|authenticator \(TOTP\) sign-in is required/);
      }
    }
    // a refresh-token refresh does NOT make the code fresh: GoTrue keeps the original amr timestamp
    const lg = await login(A.email, A.password);
    const s1 = await verifyFactor(lg.access, A.factor);
    const t1 = (decode(s1.access).amr as { method: string; timestamp: number }[]).find((e) => e.method === "totp")!.timestamp;
    await sleep(3000);
    const rf = await http("POST", `${AUTH}/token?grant_type=refresh_token`, null, { refresh_token: s1.refresh });
    expect(rf.status, rf.text.slice(0, 200)).toBe(200);
    const refreshed = (rf.json as { access_token: string }).access_token;
    const t2 = (decode(refreshed).amr as { method: string; timestamp: number }[]).find((e) => e.method === "totp")!.timestamp;
    expect(t2, "the refreshed token carries the original TOTP timestamp").toBe(t1);
    expect(decode(refreshed).session_id).toBe(decode(s1.access).session_id);
    // re-verifying a code on the SAME session (the step-up the panel performs: mfa challenge + verify) renews the timestamp
    const again = await verifyFactor(refreshed, A.factor);
    const t3 = (decode(again.access).amr as { method: string; timestamp: number }[]).filter((e) => e.method === "totp").map((e) => e.timestamp);
    expect(Math.max(...t3), "the step-up produced a newer TOTP timestamp").toBeGreaterThan(t1);
    expect(decode(again.access).session_id).toBe(decode(s1.access).session_id);
    // EMERGENCY actions with a stale session: freeze, report_compromise and the recovery-freeze ceremony; the sensitive thaw is refused with the same stale token
    const stale = resign(fresh, { amr: [{ ...amr0[0], timestamp: nowS() - 3000 }] });
    expect(reached(await rpc("tw4_price_cred_pending", stale))).toBe(true);
    const fz = await rpc("tw4_price_freeze", stale, { p_reason: "a freeze with a stale authenticator code, which must still work" });
    expect(fz.json).toMatchObject({ status: "frozen" });
    const rc = await rpc("tw4_price_report_compromise", stale, { p_note: "a compromise report with a stale authenticator code" });
    expect(rc.json).toMatchObject({ status: "frozen" });
    const rb = await rpc("tw4_price_cred_begin", stale, { p_purpose: "recover_freeze", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null });
    expect(rb.status, rb.text).toBe(200);
    const ra = KR.assert((rb.json as { challenge: string }).challenge);
    const rfz = await rpc("tw4_price_recovery_freeze", stale, { p_nonce: (rb.json as { nonce: string }).nonce, p_cred: ra.credId, p_auth: ra.auth, p_client: ra.client, p_sig: ra.sig });
    expect(rfz.json).toMatchObject({ status: "frozen" });
    const thawStale = await rpc("tw4_price_cred_begin", stale, { p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null });
    expect(denied(thawStale)).toBe(true);
    expect(thawStale.text).toMatch(/fresh authenticator code is required/);
    resetCreds();   // owner-level: clears the suspension and the recovery hold for the following tests
  });

  it("RTA-11 ordinary-key eviction restriction with real tokens: through PostgREST the primary cannot revoke the spare (direct or by a crafted recovery-type ceremony), the recovery credential can, once, and the spare then cannot sign", async () => {
    resetCreds();
    clearRequests();
    const s = await newSession(A);
    const status = (k: SoftAuthenticator) => psql(`select status from public.studio_sms_price_credentials where credential_id = decode('${k.hex.cred}', 'hex')`);
    const rev = (c: { nonce: string }, target: SoftAuthenticator, a: { credId: string; auth: string; client: string; sig: string }) =>
      rpc("tw4_price_cred_revoke", s, { p_nonce: c.nonce, p_target: target.credIdB64u, p_by_cred: a.credId, p_by_auth: a.auth, p_by_client: a.client, p_by_sig: a.sig });
    const begin = (purpose: string, target: SoftAuthenticator) => rpc("tw4_price_cred_begin", s, { p_purpose: purpose, p_cred_id: target.credIdB64u, p_x: null, p_y: null, p_role: null, p_label: null });
    // direct: the ceremony names the TARGET as the only signer; the primary's assertion is refused
    const rb = await begin("revoke", K2);
    expect((rb.json as { allow_credentials: string[] }).allow_credentials).toEqual([K2.credIdB64u]);
    expect((await rev(rb.json as { nonce: string }, K2, K1.assert((rb.json as { challenge: string }).challenge))).json).toMatchObject({ status: "rejected" });
    // crafted: the eviction ceremony (recovery only) signed by the primary
    const eb = await begin("revoke_other", K2);
    expect((eb.json as { allow_credentials: string[] }).allow_credentials).toEqual([KR.credIdB64u]);
    expect((await rev(eb.json as { nonce: string }, K2, K1.assert((eb.json as { challenge: string }).challenge))).json).toMatchObject({ status: "rejected" });
    expect(status(K2)).toBe("active");
    // the recovery credential evicts the spare; the primary's own ceremony still cannot reach the recovery key
    const eb2 = await begin("revoke_other", K2);
    const done = await rev(eb2.json as { nonce: string }, K2, KR.assert((eb2.json as { challenge: string }).challenge));
    expect(done.json).toMatchObject({ status: "revoked" });
    expect(status(K2)).toBe("revoked");
    expect(status(KR)).toBe("active");
    expect(num("select count(*) from public.studio_sms_price_audit where event = 'recovery_used' and detail ->> 'action' = 'revoke_ordinary_key'")).toBeGreaterThanOrEqual(1);
    // the spare cannot sign any more; the primary is the last ordinary credential and is protected
    const p = await propose(s, 514);
    expect(p.status, p.text).toBe(200);
    const lastBegin = await begin("revoke_other", K1);
    expect(lastBegin.status).toBe(400);
    expect(lastBegin.text).toMatch(/other active signing credential/);
    clearRequests();
    resetCreds();
  });

});
