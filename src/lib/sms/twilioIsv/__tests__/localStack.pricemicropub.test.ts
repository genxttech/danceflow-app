/**
 * TW-4F: sub-cent per-segment prices through the EXISTING single-owner price authorization (migration 20270212090000) on a throwaway DEV-equivalent database.
 * The WebAuthn assertions come from a SOFTWARE authenticator and are verified INSIDE Postgres; sessions are simulated with verified-claims JSON exactly as PostgREST hands
 * them to the database. LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB and the tw4_local_qa_only marker.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, DB, PG, codeOf, enabled, num, psql, psqlError, rows, seedCast } from "./wpd4Helpers";
import { ownerAgeRequest, registerApproverSql } from "./priceFixture";
import { ORIGIN, RP_ID, SoftAuthenticator, type Assertion } from "./webauthnFixture";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const NL = String.fromCharCode(10);
const nowS = () => Math.floor(Date.now() / 1000);
const S1 = "mp-session-proposer";
const S2 = "mp-session-authorizer";
const claims = (sub: string, sid: string) => ({ sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], session_id: sid });
const asAuth = (c: Record<string, unknown>, sql: string) => `begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(c).replace(/'/g, "''")}', true); ${sql} commit;`;
const authOut = (c: Record<string, unknown>, sql: string) => JSON.parse(psql(asAuth(c, sql)).split(NL).pop()!) as Record<string, never>;
const authErr = (c: Record<string, unknown>, sql: string) => psqlError(asAuth(c, sql));
/** a registered administrator's refusal is RECORDED and returned as an answer (status refused); an unregistered one raises */
function tryAuth(c: Record<string, unknown>, sql: string): { err: string; out: Record<string, never> | null } {
  try {
    const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: String.fromCharCode(92) + "set VERBOSITY verbose" + NL + asAuth(c, sql), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { err: "", out: JSON.parse(out.trim().split(NL).pop()!) as Record<string, never> };
  } catch (e) {
    return { err: String((e as { stderr?: Buffer | string }).stderr ?? e), out: null };
  }
}

const K1 = new SoftAuthenticator();
const proposeMicros = (c: Record<string, unknown>, kind: string, price: number, cost: number) =>
  authOut(c, `select public.tw4_price_propose_micros('${kind}', ${price}, ${cost}, 'owner micro price ${kind}', 'a written reason for the micro price test')::text;`);
const begin = (c: Record<string, unknown>, id: string) => authOut(c, `select public.tw4_price_authz_begin('${id}')::text;`);
const finishSql = (id: string, nonce: string, a: Assertion) => `select public.tw4_price_authz_finish('${id}', '${nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`;
const finish = (c: Record<string, unknown>, id: string, nonce: string, a: Assertion) => authOut(c, finishSql(id, nonce, a));
const ready = (id: string) => ownerAgeRequest(psql, id, 25);
const clear = () => {
  for (const r of rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where status = 'pending'`)) {
    psql(`select public._tw4price_do_reject('${r.id}', '${r.requested_by}', 'withdrawn to start the next test')`);
  }
};
const active = (kind: string) =>
  rows<{ cents: number; prov: number; pm: number | null; cm: number | null }>(
    `select customer_price_cents cents, provider_cost_cents prov, unit_price_micros pm, unit_cost_micros cm from public.studio_sms_price_list where kind = '${kind}' and active`);
const ownerSql = (sql: string) => psql(`begin; do $q$ begin if to_regclass('public.tw4_local_qa_only') is null then raise exception 'not a local QA database'; end if; end $q$; ${sql} commit;`);

describe.skipIf(!enabled)("TW-4F micro-dollar price publication through the single-owner authorization", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null and exists (select 1 from information_schema.columns where table_name = 'studio_sms_price_change_requests' and column_name = 'price_micros')`)).toBe("t");
    seedCast();
    for (const u of [A, B]) psql(registerApproverSql(u));
    psql(`begin; alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard; update public.studio_sms_price_approvers set added_at = added_at - interval '400 hours'; alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard; commit;`);
    if (psql(`select rp_id is null from public.studio_sms_price_auth_config`) === "t") psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${K1.hex.cred}', 'hex'), decode('${K1.hex.x}', 'hex'), decode('${K1.hex.y}', 'hex'), 'primary test key')`);
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set proof_verified_at = now(), enrolled_at = now() - interval '48 hours'; alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
  });

  it("MP-01 outbound $0.017: proposed in micro-dollars, signed with the key, published with the exact micro amounts", () => {
    clear();
    const p = proposeMicros(claims(A, S1), "sms_usage", 17000, 12700);
    expect(p.status).toBe("pending");
    const row = rows<{ pm: number; cm: number; c: number; p: number; mode: string }>(`select price_micros pm, cost_micros cm, customer_price_cents c, provider_cost_cents p, approval_mode mode from public.studio_sms_price_change_requests where id = '${p.request_id}'`)[0];
    expect(row).toMatchObject({ pm: 17000, cm: 12700, c: 2, p: 2, mode: "owner" });
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id) as unknown as { nonce: string; challenge: string; summary: Record<string, unknown> };
    expect(b.summary).toMatchObject({ new_price_micros: 17000, new_cost_micros: 12700, new_customer_cents: 2, old_price_micros: null });
    const f = finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge));
    expect(f.status).toBe("applied");
    expect(active("sms_usage")).toEqual([{ cents: 2, prov: 2, pm: 17000, cm: 12700 }]);
    // the usage reader (what billing reads) carries the micro price
    expect(psql(`select count(*) from public.studio_sms_price_list where kind = 'sms_usage' and active and unit_price_micros = 17000`)).toBe("1");
    expect(psql(`select (public.tw4_price_verify() ->> 'ok')`)).toBe("true");
  });

  it("MP-02 inbound $0.013 with the same ceremony", () => {
    clear();
    const p = proposeMicros(claims(A, S1), "sms_inbound", 13000, 10200);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id) as unknown as { nonce: string; challenge: string };
    expect(finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge)).status).toBe("applied");
    expect(active("sms_inbound")).toEqual([{ cents: 2, prov: 2, pm: 13000, cm: 10200 }]);
    expect(psql(`select (public.tw4_price_verify() ->> 'ok')`)).toBe("true");
  });

  it("MP-03 the signature binds the micro amounts: changing them after the challenge is issued makes the assertion fail", () => {
    clear();
    const p = proposeMicros(claims(A, S1), "sms_usage", 18000, 12700);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id) as unknown as { nonce: string; challenge: string };
    const a = K1.assert(b.challenge);
    // owner-level, visible tampering (production has no such path): 18,000 becomes 19,000 (cents stay 2)
    ownerSql(`alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard; update public.studio_sms_price_change_requests set price_micros = 19000 where id = '${p.request_id}'; alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;`);
    const f = finish(claims(A, S2), p.request_id, b.nonce, a) as unknown as { status: string; reason?: string };
    expect(f.status).toBe("rejected");
    expect(active("sms_usage")[0].pm).toBe(17000); // unchanged
  });

  it("MP-04 the binding of a micro proposal is frozen (a direct update of the amounts is refused)", () => {
    clear();
    const p = proposeMicros(claims(A, S1), "sms_usage", 18000, 12700);
    expect(psqlError(`update public.studio_sms_price_change_requests set price_micros = 19000 where id = '${p.request_id}'`)).toMatch(/binding of a proposal is fixed|status moves only/);
  });

  it("MP-05 only the per-segment kinds take micro-dollar amounts, and the amounts are bounded", () => {
    clear();
    const err = (kind: string, price: number, cost: number) => authErr(claims(A, S1), `select public.tw4_price_propose_micros('${kind}', ${price}, ${cost}, 'bad micro price', 'a written reason for the micro price test');`);
    expect(codeOf(err("number", 17000, 12700))).toBe("22023");
    expect(codeOf(err("sms_usage", 0, 100))).toBe("22023");
    expect(codeOf(err("sms_usage", 10000001, 100))).toBe("22023");
    expect(codeOf(err("sms_usage", 17000, -1))).toBe("22023");
    expect(codeOf(authErr(claims(A, S1), `select public.tw4_price_propose_micros('sms_usage', null, 100, 'bad micro price', 'a written reason for the micro price test');`))).toBe("22023");
  });

  it("MP-06 an identical open micro proposal replays; the active micro price cannot be re-proposed", () => {
    clear();
    const a = proposeMicros(claims(A, S1), "sms_usage", 18000, 12700);
    const again = proposeMicros(claims(A, S1), "sms_usage", 18000, 12700);
    expect(again.request_id).toBe(a.request_id);
    expect(again.replayed).toBe(true);
    clear();
    expect(codeOf(authErr(claims(A, S1), `select public.tw4_price_propose_micros('sms_usage', 17000, 12700, 'same as active', 'a written reason for the micro price test');`))).toBe("22023");
  });

  it("MP-07 a micro proposal is not revised through the whole-cent revise path", () => {
    clear();
    const p = proposeMicros(claims(A, S1), "sms_usage", 18000, 12700);
    const r = tryAuth(claims(A, S1), `select public.tw4_price_revise('${p.request_id}', 2, 2, 'revised', 'a written reason for the revise test')::text;`);
    expect(codeOf(r.err)).toBe("TW041");
    expect(rows<{ status: string }>(`select status from public.studio_sms_price_change_requests where id = '${p.request_id}'`)[0].status).toBe("pending");
  });

  it("MP-08 a price row with micro amounts cannot be inserted outside an approved request; published micro prices are immutable", () => {
    clear();
    expect(psqlError(`insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, unit_price_micros, unit_cost_micros, description, created_by) values ('sms_usage', 3, 2, 21000, 12700, 'forged', '${A}')`)).toMatch(/approved price change|42501/);
    expect(psqlError(`update public.studio_sms_price_list set unit_price_micros = 1000 where kind = 'sms_usage' and active`)).toMatch(/never edited|42501/);
    // the ungranted setter stays ungranted
    expect(psql(`select has_function_privilege('authenticated', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute') or has_function_privilege('service_role', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute') or has_function_privilege('anon', 'public.tw4_price_propose_micros(text,integer,integer,text,text)', 'execute')`)).toBe("f");
  });

  it("MP-09 team mode: a second administrator's approval of a micro request fails closed (no whole-cent price is published)", () => {
    clear();
    ownerSql(`alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set mode = 'team'; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;`);
    try {
      const p = proposeMicros(claims(A, S1), "sms_usage", 20000, 12700);
      expect(codeOf(authErr(claims(B, "mp-session-b"), `select public.tw4_price_approve('${p.request_id}', 'approval note for the micro request')::text;`))).toBe("42501");
      expect(active("sms_usage")[0].pm).toBe(17000);
      expect(num(`select count(*) from public.studio_sms_price_change_requests where id = '${p.request_id}' and status = 'pending'`)).toBe(1);
    } finally {
      ownerSql(`alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set mode = 'single_owner'; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;`);
      clear();
    }
  });

  it("MP-10 the whole-cent path is unchanged: a fee-kind price publishes with null micros and the verifier attests it", () => {
    clear();
    const p = authOut(claims(A, S1), `select public.tw4_price_propose('number', 165, 115, 'owner whole-cent number price', 'a written reason for the whole-cent test')::text;`);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id) as unknown as { nonce: string; challenge: string; summary: Record<string, unknown> };
    expect(b.summary).toMatchObject({ new_price_micros: null, new_customer_cents: 165 });
    expect(finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge)).status).toBe("applied");
    expect(active("number")).toEqual([{ cents: 165, prov: 115, pm: null, cm: null }]);
    expect(psql(`select (public.tw4_price_verify() ->> 'ok')`)).toBe("true");
  });

  it("MP-12 production setting: with monitoring expected, the micro proposal, the challenge and the publication all emit their monitoring events (with the micro amounts) and succeed", () => {
    clear();
    ownerSql(`alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set monitoring_expected = true; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;`);
    try {
      const head = num(`select coalesce(max(seq), 0) from public.studio_sms_price_security_events`);
      const p = proposeMicros(claims(A, S1), "sms_usage", 21000, 12695);
      ready(p.request_id);
      const b = begin(claims(A, S2), p.request_id) as unknown as { nonce: string; challenge: string };
      expect(finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge)).status).toBe("applied");
      const ev = rows<{ kind: string; micros: string | null }>(`select kind, detail ->> 'new_price_micros' micros from public.studio_sms_price_security_events where seq > ${head} order by seq`);
      const kinds = ev.map((e) => e.kind);
      expect(kinds).toContain("price_proposed");
      expect(kinds).toContain("price_authorization_started");
      expect(ev.filter((e) => e.kind === "price_proposed" || e.kind === "price_authorization_started").every((e) => e.micros === "21000")).toBe(true);
      expect(active("sms_usage")[0].pm).toBe(21000);
    } finally {
      ownerSql(`alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set monitoring_expected = false; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;`);
    }
  });

  it("MP-11 a published micro price is what the usage engine reads (sms_price_list carries unit_price_micros)", () => {
    const j = psql(`select pg_get_functiondef('public.sms_price_list()'::regprocedure)`);
    expect(j).toContain("unit_price_micros");
  });
});
