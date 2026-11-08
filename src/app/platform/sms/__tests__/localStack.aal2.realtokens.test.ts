/**
 * WP-D2 layer (b): platform-admin AAL2 with REAL tokens issued by a LOCAL GoTrue (TOTP MFA), sent through Kong -> PostgREST -> the database.
 * LOCAL / DISPOSABLE STACK ONLY. Skipped unless TW4A_LOCAL_URL (loopback), TW4A_LOCAL_JWT_SECRET, TW4A_LOCAL_DB_CONTAINER and TW4_LOCAL_AUTH_URL (loopback) are set;
 * the runner provides them with `run-chain.mjs suites --auth`. Never touches DEV or PROD, Twilio, Stripe or any real account.
 *
 * Fixtures: synthetic users on the reserved domain example.test, a throwaway password generated at run time (never logged or written), a TOTP factor whose
 * secret is the one the local GoTrue returns at enrolment (GoTrue chooses it; it exists only in this process and in the throwaway database).
 * The service-role token used to create the users is signed here with the stack's random JWT secret.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const STUDIO = "a1a10000-0000-4000-8000-0000000000d2";
const STUDIO_NEW = "a1a10000-0000-4000-8000-0000000000d3";
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

function sampleFor(type: string): unknown {
  if (type.endsWith("[]")) return [];
  if (type === "uuid") return randomUUID();
  if (["text", "character varying", "citext", "name"].includes(type) || type.startsWith("character")) return "wpd2";
  if (type === "boolean") return true;
  if (["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(type)) return 1;
  if (type === "jsonb" || type === "json") return {};
  if (type === "date") return "2026-01-01";
  if (type.startsWith("timestamp")) return "2026-01-01T00:00:00Z";
  return null;
}

type Fn = { name: string; sig: string; names: string[] | null; types: string[] | null; authExec: boolean; anonExec: boolean };
let fns: Fn[] = [];
let admin: Session;
let plain: Session;

describe.skipIf(!enabled)("WP-D2 layer b: platform-admin AAL2 with real GoTrue tokens (local, disposable)", () => {
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
    expect(psql("select to_regprocedure('public._sms_onb_is_platform_admin()') is not null")).toBe("t");
    const service = signHs256({ role: "service_role", aud: "authenticated", iss: "wpd2-local", exp: Math.floor(Date.now() / 1000) + 3600 });
    const a = await makeUser("admin", service);
    const p = await makeUser("plain", service);
    // profiles may be created by a trigger on auth.users; make the roles explicit either way
    psql(`insert into public.profiles (id, platform_role) values ('${a.id}', 'platform_admin'), ('${p.id}', null) on conflict (id) do update set platform_role = excluded.platform_role;
      delete from public.studio_sms_registrations where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
      delete from public.studios where id in ('${STUDIO}', '${STUDIO_NEW}');
      insert into public.studios (id, name, slug, public_name) values ('${STUDIO}', 'WPD2 Studio A', 'wpd2-a', null), ('${STUDIO_NEW}', 'WPD2 Studio B', 'wpd2-b', null);
      insert into public.studio_sms_registrations (studio_id) values ('${STUDIO}');`);
    const a1 = await passwordLogin(a.email, a.password);
    const p1 = await passwordLogin(p.email, p.password);
    admin = { ...a, aal1: a1, aal2: await stepUp(a1) };
    plain = { ...p, aal1: p1, aal2: await stepUp(p1) };
    fns = JSON.parse(
      psql(`select coalesce(json_agg(json_build_object('name', p.proname, 'sig', p.oid::regprocedure::text, 'names', p.proargnames[1:p.pronargs], 'types',
              (select json_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality u(t, o)),
              'authExec', has_function_privilege('authenticated', p.oid, 'execute'), 'anonExec', has_function_privilege('anon', p.oid, 'execute')) order by p.oid::regprocedure::text), '[]'::json)
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosrc like '%_sms_onb_is_platform_admin%' and p.proname <> '_sms_onb_is_platform_admin'`),
    ) as Fn[];
  }, 240_000);

  afterAll(() => {
    try {
      psql(`delete from public.studio_sms_onboarding_access where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studio_sms_onboarding_audit where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studio_sms_registrations where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studios where id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.profiles where id in ('${admin?.id}', '${plain?.id}');`);
    } catch {
      /* best effort: the database is disposable */
    }
  });

  it("the tokens are what GoTrue issued: password-only is aal1, after the TOTP code is aal2 with the totp method", () => {
    const c1 = decode(admin.aal1);
    const c2 = decode(admin.aal2);
    expect(c1.aal).toBe("aal1");
    expect(c2.aal).toBe("aal2");
    expect(c1.sub).toBe(admin.id);
    expect(c2.sub).toBe(admin.id);
    expect(c1.role).toBe("authenticated");
    expect(c2.role).toBe("authenticated");
    expect(JSON.stringify(c2.amr)).toContain("totp");
    expect(JSON.stringify(c1.amr)).not.toContain("totp");
    expect(c1.email).toMatch(/@example\.test$/);
    expect(decode(plain.aal2).aal).toBe("aal2");
  });

  it("the stable admin RPC list_sms_onboardings over PostgREST: aal1 admin refused, aal2 admin answered, non-admin aal2 refused", async () => {
    // _sms_onb_is_platform_admin is revoked from the API roles; the stable admin RPC is the observable surface
    const r1 = await rest("POST", "rpc/list_sms_onboardings", admin.aal1, {});
    const r2 = await rest("POST", "rpc/list_sms_onboardings", admin.aal2, {});
    const r3 = await rest("POST", "rpc/list_sms_onboardings", plain.aal2, {});
    expect(refused(r1), `aal1 ${r1.status} ${r1.text.slice(0, 160)}`).toBe(true);
    expect(r2.status, `aal2 ${r2.text.slice(0, 160)}`).toBe(200);
    expect(refused(r3), `non-admin aal2 ${r3.status} ${r3.text.slice(0, 160)}`).toBe(true);
  });

  it("an aal1 token with its payload edited to say aal2 is rejected by PostgREST (signature), and an aal2 token tampered to another subject too", async () => {
    const [h, , s] = admin.aal1.split(".");
    const forged = `${h}.${b64u(JSON.stringify({ ...decode(admin.aal1), aal: "aal2" }))}.${s}`;
    const r = await rest("POST", "rpc/list_sms_onboardings", forged, {});
    expect([401, 403]).toContain(r.status);
    expect(r.status).toBe(401);
    const [h2, , s2] = admin.aal2.split(".");
    const other = `${h2}.${b64u(JSON.stringify({ ...decode(admin.aal2), sub: plain.id }))}.${s2}`;
    expect((await rest("POST", "rpc/list_sms_onboardings", other, {})).status).toBe(401);
  });

  it("studio_sms_registrations over PostgREST: aal2 admin reads, creates and updates; the same admin at aal1 is refused or sees nothing on all three; a non-admin aal2 sees nothing", async () => {
    const sel = (t: string) => rest("GET", "studio_sms_registrations?select=studio_id", t);
    const s2 = await sel(admin.aal2);
    expect(s2.status).toBe(200);
    expect((s2.json as { studio_id: string }[]).map((x) => x.studio_id)).toEqual([STUDIO]);
    const s1 = await sel(admin.aal1);
    expect(s1.status).toBe(200);
    expect(s1.json).toEqual([]);
    const sp = await sel(plain.aal2);
    expect(sp.status).toBe(200);
    expect(sp.json).toEqual([]);

    const ins = (t: string) => rest("POST", "studio_sms_registrations", t, { studio_id: STUDIO_NEW }, { Prefer: "return=representation" });
    const i1 = await ins(admin.aal1);
    expect(refused(i1), `aal1 insert ${i1.status} ${i1.text.slice(0, 160)}`).toBe(true);
    const ip = await ins(plain.aal2);
    expect(refused(ip), `non-admin insert ${ip.status} ${ip.text.slice(0, 160)}`).toBe(true);
    expect(psql(`select count(*) from public.studio_sms_registrations where studio_id = '${STUDIO_NEW}'`)).toBe("0");
    const i2 = await ins(admin.aal2);
    expect(i2.status, i2.text.slice(0, 200)).toBe(201);
    expect(psql(`select count(*) from public.studio_sms_registrations where studio_id = '${STUDIO_NEW}'`)).toBe("1");

    const current = (await rest("GET", `studio_sms_registrations?select=registration_status&studio_id=eq.${STUDIO}`, admin.aal2)).json as { registration_status: string }[];
    const status = current[0].registration_status;
    const upd = (t: string) => rest("PATCH", `studio_sms_registrations?studio_id=eq.${STUDIO}`, t, { registration_status: status }, { Prefer: "return=representation" });
    const u1 = await upd(admin.aal1);
    expect([200, 204]).toContain(u1.status);
    expect(Array.isArray(u1.json) ? u1.json.length : 0).toBe(0);
    const up = await upd(plain.aal2);
    expect(Array.isArray(up.json) ? up.json.length : 0).toBe(0);
    const u2 = await upd(admin.aal2);
    expect(u2.status, u2.text.slice(0, 200)).toBe(200);
    expect(Array.isArray(u2.json) ? u2.json.length : 0).toBe(1);
    // moving a row to another studio id is also an aal2-only write
    const mv = await rest("PATCH", `studio_sms_registrations?studio_id=eq.${STUDIO}`, admin.aal1, { studio_id: STUDIO_NEW }, { Prefer: "return=representation" });
    expect(Array.isArray(mv.json) ? mv.json.length : 0).toBe(0);
  });

  it("every function that calls _sms_onb_is_platform_admin() (listed from the catalog): aal1 refused (42501 over HTTP 403), non-admin aal2 not admitted, aal2 admin not refused as non-admin", async () => {
    // the catalog list is the enumeration; it must contain the four RPCs the SQL suite names, and nothing may be silently skipped
    const names = fns.map((f) => f.name);
    for (const required of ["set_sms_onboarding_access", "list_sms_onboardings", "sms_credit_admin_overview", "sms_recurring_admin_overview"]) expect(names, `catalog list ${names.join(",")}`).toContain(required);
    const report: string[] = [];
    const failures: string[] = [];
    for (const f of fns) {
      if (!f.authExec) {
        // not reachable by any end-user token at all: the ACL is the refusal (not called: avoids the known permission-denied crash of the local image)
        report.push(`${f.sig}: authenticated has no EXECUTE (ACL refusal, no token can reach it)`);
        continue;
      }
      const body: Record<string, unknown> = {};
      (f.names ?? []).forEach((n, i) => {
        const type = (f.types ?? [])[i] ?? "text";
        // a real studio id where the function takes one, so the aal2 call gets past argument validation when it can
        body[n] = type === "uuid" && /studio/.test(n) ? STUDIO : /reason|note/.test(n) && type === "text" ? "WP-D2 local aal2 check, throwaway database" : sampleFor(type);
      });
      const call = (t: string) => rest("POST", `rpc/${f.name}`, t, body);
      const a1 = await call(admin.aal1);
      const a2 = await call(admin.aal2);
      const pl = await call(plain.aal2);
      const tag = `${f.sig} aal1=${a1.status}/${code(a1)} aal2=${a2.status}/${code(a2)} nonadmin-aal2=${pl.status}/${code(pl)}`;
      report.push(tag);
      if (!refused(a1)) failures.push(`AAL1 NOT REFUSED: ${tag} :: ${a1.text.slice(0, 200)}`);
      if (a2.status === 404 || a2.status === 300) failures.push(`aal2 could not be exercised (request shape): ${tag} :: ${a2.text.slice(0, 200)}`);
      if (refused(a2)) failures.push(`aal2 admin refused with 42501: ${tag} :: ${a2.text.slice(0, 200)}`);
    }
    console.log(`[wpd2] functions calling the helper: ${fns.length}\n${report.join("\n")}`);
    expect(failures, failures.join("\n")).toEqual([]);
  }, 240_000);

  it("catalog sanity: the helper is security definer with a pinned search_path and is not executable by the API roles; every enumerated function is a public function in the migrated schema", () => {
    expect(psql("select prosecdef from pg_proc where oid = 'public._sms_onb_is_platform_admin()'::regprocedure")).toBe("t");
    expect(psql("select has_function_privilege('authenticated', 'public._sms_onb_is_platform_admin()', 'execute') or has_function_privilege('anon', 'public._sms_onb_is_platform_admin()', 'execute')")).toBe("f");
    expect(fns.length).toBeGreaterThan(0);
    // policies that name the helper: none other than function bodies (the registration policies inline the aal check)
    expect(psql("select count(*) from pg_policies where schemaname = 'public' and (coalesce(qual,'') || coalesce(with_check,'')) like '%_sms_onb_is_platform_admin%'")).toBe("0");
  });
});
