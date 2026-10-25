/**
 * TW-4F platform-admin AAL2: the SQL side (migration 20261231090000) exercised on a REAL database with real role switching and JWT claims.
 * LOCAL / ISOLATED QA STACK ONLY: skipped unless TW4A_LOCAL_URL (loopback), TW4A_LOCAL_JWT_SECRET and TW4A_LOCAL_DB_CONTAINER are set, and the stack has
 * 20261231090000 applied. Fixtures are synthetic and removed afterwards. Never touches DEV or PROD.
 *
 * Claims are set the way PostgREST sets them (request.jwt.claims) inside a transaction that is rolled back, so no test row survives.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname);
  } catch {
    return false;
  }
})();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const ADMIN = "a1a10000-0000-4000-8000-000000000401";
const PLAIN = "a1a10000-0000-4000-8000-000000000402";
const STUDIO = "a1a10000-0000-4000-8000-00000000000a";
const STUDIO_NEW = "a1a10000-0000-4000-8000-00000000000b";

function psqlRaw(sql: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    return { ok: false, out: `${e.stderr ?? ""}${e.stdout ?? ""}`.trim() };
  }
}
const admin = (sql: string) => {
  const r = psqlRaw(sql);
  if (!r.ok) throw new Error(r.out);
  return r.out;
};

type Claims = Record<string, unknown> | null;
/** Run `sql` as the authenticated role with the given claims inside a transaction that is always rolled back; returns the last output line or the error. */
function asClaims(claims: Claims, sql: string): { ok: boolean; out: string } {
  const json = claims === null ? "" : JSON.stringify({ role: "authenticated", ...claims });
  const r = psqlRaw(`begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', '${json.replace(/'/g, "''")}', true);\n${sql};\nrollback;`);
  // -At -q prints the set_config result first, then the statement result: the last line is the answer
  return { ok: r.ok, out: r.ok ? (r.out.split("\n").pop() ?? "") : r.out };
}
const AAL2 = { sub: ADMIN, aal: "aal2" };
const AAL1 = { sub: ADMIN, aal: "aal1" };
const denied = (r: { ok: boolean; out: string }) => !r.ok && /42501/.test(r.out);

describe.skipIf(!enabled)("TW-4F platform-admin AAL2 (SQL, real role switching)", () => {
  beforeAll(() => {
    expect(admin("select to_regprocedure('public._sms_onb_is_platform_admin()') is not null")).toBe("t");
    admin(`
      delete from public.studio_sms_registrations where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
      delete from public.studios where id in ('${STUDIO}', '${STUDIO_NEW}');
      delete from public.profiles where id in ('${ADMIN}', '${PLAIN}');
      delete from auth.users where email like '%@tw4aal2-e2e.test';
      insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
        values ('${ADMIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin@tw4aal2-e2e.test', now(), now()),
               ('${PLAIN}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'plain@tw4aal2-e2e.test', now(), now());
      insert into public.profiles (id, platform_role) values ('${ADMIN}', 'platform_admin'), ('${PLAIN}', null) on conflict (id) do update set platform_role = excluded.platform_role;
      insert into public.studios (id, name, slug, public_name) values ('${STUDIO}', 'TW4 AAL2 Studio A', 'tw4aal2-a', null), ('${STUDIO_NEW}', 'TW4 AAL2 Studio B', 'tw4aal2-b', null);
      insert into public.studio_sms_registrations (studio_id) values ('${STUDIO}');`);
  });
  afterAll(() => {
    try {
      admin(`
        delete from public.studio_sms_onboarding_access where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studio_sms_onboarding_audit where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studio_sms_registrations where studio_id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.studios where id in ('${STUDIO}', '${STUDIO_NEW}');
        delete from public.profiles where id in ('${ADMIN}', '${PLAIN}');
        delete from auth.users where email like '%@tw4aal2-e2e.test';`);
    } catch {
      /* best effort */
    }
  });

  it("the helper is true only for a platform admin whose verified token says aal2", () => {
    const h = "select public._sms_onb_is_platform_admin()";
    expect(asClaims(AAL2, h).out).toBe("t");
    for (const claims of [AAL1, { sub: ADMIN }, { sub: ADMIN, aal: "" }, { sub: ADMIN, aal: null }, { sub: ADMIN, aal: "AAL2" }, { sub: ADMIN, aal: " aal2" }, { sub: ADMIN, aal: 2 }, { sub: ADMIN, aal: ["aal2"] }, { sub: PLAIN, aal: "aal2" }, { aal: "aal2" }]) {
      expect(asClaims(claims as Claims, h).out, JSON.stringify(claims)).toBe("f");
    }
    expect(asClaims(null, h).out).toBe("f");
  });

  it("studio_sms_registrations RLS: aal2 admin reads, creates and updates; an aal1 admin is refused on all three", () => {
    const count = "select count(*) from public.studio_sms_registrations";
    expect(asClaims(AAL2, count).out).toBe("1");
    expect(asClaims(AAL1, count).out).toBe("0");
    expect(asClaims({ sub: ADMIN }, count).out).toBe("0");
    expect(asClaims({ sub: PLAIN, aal: "aal2" }, count).out).toBe("0");

    const ins = `insert into public.studio_sms_registrations (studio_id) values ('${STUDIO_NEW}')`;
    expect(asClaims(AAL2, ins).ok).toBe(true);
    expect(denied(asClaims(AAL1, ins))).toBe(true);
    expect(denied(asClaims({ sub: ADMIN }, ins))).toBe(true);

    const upd = (who: Claims) => asClaims(who, `with u as (update public.studio_sms_registrations set registration_status = registration_status where studio_id = '${STUDIO}' returning 1) select count(*) from u`);
    expect(upd(AAL2).out).toBe("1");
    expect(upd(AAL1).out).toBe("0");
    expect(upd({ sub: ADMIN }).out).toBe("0");
    // an aal1 admin cannot move a row it could not see either: the new-row check also needs aal2
    expect(asClaims(AAL1, `with u as (update public.studio_sms_registrations set studio_id = '${STUDIO_NEW}' where studio_id = '${STUDIO}' returning 1) select count(*) from u`).out).toBe("0");
    expect(admin(`select count(*) from public.studio_sms_registrations where studio_id = '${STUDIO}'`)).toBe("1");
  });

  it("the four admin RPCs refuse an aal1 platform admin (42501) and answer an aal2 one", () => {
    const calls = [
      `select public.set_sms_onboarding_access('${STUDIO}'::uuid, true, 'ConfiDance pilot (local e2e)')`,
      "select public.list_sms_onboardings()",
      "select public.sms_credit_admin_overview()",
      "select public.sms_recurring_admin_overview()",
    ];
    for (const call of calls) {
      expect(denied(asClaims(AAL1, call)), `aal1 ${call}`).toBe(true);
      expect(denied(asClaims({ sub: ADMIN }, call)), `no aal ${call}`).toBe(true);
      expect(denied(asClaims({ sub: PLAIN, aal: "aal2" }, call)), `non-admin ${call}`).toBe(true);
      expect(asClaims(AAL2, call).ok, `aal2 ${call}`).toBe(true);
    }
    // the effect is visible inside the same transaction: aal2 writes the access row, the refused aal1 call does not get that far
    const writes = (who: Claims) => asClaims(who, `select public.set_sms_onboarding_access('${STUDIO}'::uuid, true, 'ConfiDance pilot (local e2e)'); select count(*) from public.studio_sms_onboarding_access where studio_id = '${STUDIO}'`);
    expect(writes(AAL2).out).toBe("1");
    expect(denied(writes(AAL1))).toBe(true);
    expect(admin(`select count(*) from public.studio_sms_onboarding_access where studio_id = '${STUDIO}'`)).toBe("0");
  });

  it("the replaced helper kept its definition shape: security definer, pinned search_path, no new API-role grants", () => {
    expect(admin("select prosecdef from pg_proc where oid = 'public._sms_onb_is_platform_admin()'::regprocedure")).toBe("t");
    expect(admin("select array_to_string(proconfig, ',') from pg_proc where oid = 'public._sms_onb_is_platform_admin()'::regprocedure")).toBe("search_path=pg_catalog, public, pg_temp");
    expect(admin("select count(*) from pg_policies where schemaname = 'public' and tablename = 'studio_sms_registrations'")).toBe("3");
    expect(admin("select count(*) from pg_policies where schemaname = 'public' and tablename = 'studio_sms_registrations' and coalesce(qual,'') || coalesce(with_check,'') not like '%aal2%'")).toBe("0");
  });
});
