/**
 * D4-2 x #391 integration: the owner-authorization migration (20270204100000) on the COMBINED chain with the monitoring migration (20270205090000) and its REAL
 * studio_sms_price_security_events table, gapless trigger-assigned seq and owner-level emitter. Every event this schema emits must be accepted by the monitor's validation,
 * nothing may insert into the events table directly, the freeze must not need monitoring, an impaired monitoring table must make every risk-opening call fail closed, and
 * suspension decisions come only from seq and kind. Software authenticator, simulated verified claims. LOCAL QA DATABASE ONLY.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, codeOf, enabled, num, psql, psqlError, rows, seedCast, seedPrices } from "./wpd4Helpers";
import { ownerAgeRequest, registerApproverSql } from "./priceFixture";
import { ORIGIN, RP_ID, SoftAuthenticator, b64u, type Assertion } from "./webauthnFixture";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const NL = String.fromCharCode(10);
const nowS = () => Math.floor(Date.now() / 1000);
const S1 = "d42m-session-proposer";
const S2 = "d42m-session-authorizer";
const claims = (sub: string, sid: string | null) => ({ sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], ...(sid ? { session_id: sid } : {}) });
const asAuth = (c: Record<string, unknown>, sql: string) => `begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(c).replace(/'/g, "''")}', true); ${sql} commit;`;
const authOut = (c: Record<string, unknown>, sql: string) => JSON.parse(psql(asAuth(c, sql)).split(NL).pop()!) as Record<string, never>;
const authErr = (c: Record<string, unknown>, sql: string) => psqlError(asAuth(c, sql));
const asRole = (role: string, sql: string) => psql(`begin; set local role ${role}; ${sql} commit;`).split(NL).pop()!;
const setConfig = (setSql: string) => psql(`begin; alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set ${setSql}; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard; commit;`);
const resetCreds = (...items: (SoftAuthenticator | [SoftAuthenticator, string])[]) => {
  const ks = items.map((x) => (Array.isArray(x) ? x : ([x, null] as [SoftAuthenticator, string | null])));
  psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard;
    delete from public.studio_sms_price_credential_changes; delete from public.studio_sms_price_credentials; set local tw4.priceauth_write = 'on';
    ${ks.map(([k, role], i) => `insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via, enrolled_at) values (decode('${k.hex.cred}', 'hex'), decode('${k.hex.x}', 'hex'), decode('${k.hex.y}', 'hex'), '${role ?? (i === 0 ? "primary" : "spare")}', 'reset key ${i + 1}', 'bootstrap', now() - interval '400 hours');`).join(" ")}
    alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
};
const clear = () => {
  for (const r of rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where status = 'pending'`)) psql(`select public._tw4price_do_reject('${r.id}', '${r.requested_by}', 'withdrawn to start the next monitor test')`);
};
const propose = (cents: number) => authOut(claims(A, S1), `select public.tw4_price_propose('number', ${cents}, 115, 'monitor test price', 'a written reason for the monitor integration test')::text;`);
const begin = (id: string) => authOut(claims(A, S2), `select public.tw4_price_authz_begin('${id}')::text;`);
const finish = (id: string, nonce: string, a: Assertion) => authOut(claims(A, S2), `select public.tw4_price_authz_finish('${id}', '${nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
const thawWith = (k: SoftAuthenticator) => {
  const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
  const a = k.assert(tb.challenge);
  return authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
};
const enrollReq = (by: SoftAuthenticator, nw: SoftAuthenticator, label: string, role = "spare") => {
  const c = claims(A, S2);
  const eb = authOut(c, `select public.tw4_price_cred_begin('enroll', '${nw.credIdB64u}', '${b64u(nw.x)}', '${b64u(nw.y)}', '${role}', '${label}')::text;`);
  const a = by.assert(eb.challenge);
  const m = nw.assert(eb.challenge);
  return authOut(c, `select public.tw4_price_cred_enroll('${eb.nonce}', '${nw.credIdB64u}', '${b64u(nw.x)}', '${b64u(nw.y)}', '${role}', '${label}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}', '${m.auth}', '${m.client}', '${m.sig}')::text;`);
};
const events = (afterSeq = 0) => rows<{ seq: number; kind: string; detail: Record<string, unknown> }>(`select seq, kind, detail from public.studio_sms_price_security_events where seq > ${afterSeq} order by seq`);
const headSeq = () => num("select coalesce(max(seq), 0) from public.studio_sms_price_security_events");

describe.skipIf(!enabled)("D4-2 owner authorization on the combined chain with the monitoring migration (#391 events table, gapless seq, owner-level emitter)", () => {
  const K1 = new SoftAuthenticator();
  const K2 = new SoftAuthenticator();
  const KR = new SoftAuthenticator();
  beforeAll(() => {
    expect(psql(`select to_regprocedure('public._tw4pricemon_emit_event(text,uuid,jsonb)') is not null and to_regclass('public.studio_sms_price_security_events') is not null`)).toBe("t");
    seedCast();
    for (const u of [A, B]) psql(registerApproverSql(u));
    psql(`begin; alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard; update public.studio_sms_price_approvers set added_at = added_at - interval '400 hours'; alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard; commit;`);
    seedPrices();
    psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${K1.hex.cred}', 'hex'), decode('${K1.hex.x}', 'hex'), decode('${K1.hex.y}', 'hex'), 'primary test key')`);
  });

  it("MON-01 every event this schema emits is accepted by the monitor's emitter (kind pattern, size, gapless trigger-assigned seq) and no API role can insert into the table", () => {
    clear();
    resetCreds(K1, [KR, "recovery"]);
    const h0 = headSeq();
    // propose -> begin (price_authorization_started) -> a counter regression (price_integrity_failure)
    const p = propose(481);
    ownerAgeRequest(psql, p.request_id, 25);
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set sign_count = 9000 where credential_id = decode('${K1.hex.cred}', 'hex'); alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
    const b = begin(p.request_id);
    expect(finish(p.request_id, b.nonce, K1.assert(b.challenge, { counter: 3 })).status).toBe("rejected");
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set sign_count = 0; alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
    // an ordinary pending enrolment, a freeze, a recovery freeze (credential_recovery_used), a thaw, a revocation
    const K3 = new SoftAuthenticator();
    expect(enrollReq(K1, K3, "a pending spare key").status).toBe("pending");
    expect(authOut(claims(B, "d42m-b"), `select public.tw4_price_freeze('a freeze for the monitor integration test')::text;`)).toMatchObject({ status: "frozen" });
    const fb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('recover_freeze', null, null, null, null, null)::text;`);
    const g = KR.assert(fb.challenge);
    expect(authOut(claims(A, S2), `select public.tw4_price_recovery_freeze('${fb.nonce}', '${g.credId}', '${g.auth}', '${g.client}', '${g.sig}')::text;`)).toMatchObject({ status: "frozen" });
    expect(thawWith(K1)).toMatchObject({ status: "thawed" });
    const got = events(h0);
    const kinds = got.map((e) => e.kind);
    for (const k of ["price_authorization_started", "price_integrity_failure", "credential_replaced", "pricing_suspended", "credential_recovery_used", "pricing_resumed"]) expect(kinds, k).toContain(k);
    // gapless, commit-ordered seq assigned by the monitor's trigger
    expect(got.map((e) => e.seq)).toEqual(got.map((_, i) => h0 + i + 1));
    // details carry no key material, challenge, nonce or credential id
    const text = JSON.stringify(got);
    for (const s of [K1.credIdB64u, b64u(K1.x), b.nonce, b.challenge]) expect(text.includes(s)).toBe(false);
    // no API role can write the events table or call the emitter
    for (const role of ["authenticated", "service_role", "anon"]) {
      expect(codeOf(psqlError(`begin; set local role ${role}; insert into public.studio_sms_price_security_events (seq, kind) values (0, 'forged_event'); commit;`)), role).toBe("42501");
      expect(codeOf(psqlError(`begin; set local role ${role}; select public._tw4pricemon_emit_event('forged_event', null, '{}'); commit;`)), role).toBe("42501");
    }
  });

  it("MON-02 suspension decisions come from seq and kind only: the monitor-side suspension blocks begin, a forged pricing_resumed lifts nothing, and only the hardware-key thaw lifts it", () => {
    clear();
    resetCreds(K1, K2);
    const p = propose(482);
    ownerAgeRequest(psql, p.request_id, 25);
    psql("select public._tw4pricemon_emit_event('pricing_suspended', null, '{\"by\": \"monitor\"}')");
    expect(psql("select public._tw4price_suspended()")).toBe("t");
    expect(codeOf(authErr(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`))).toBe("42501");
    psql("select public._tw4pricemon_emit_event('pricing_resumed', null, '{}')");
    expect(psql("select public._tw4price_suspended()")).toBe("t");
    expect(thawWith(K2)).toMatchObject({ status: "thawed" });
    expect(psql("select public._tw4price_suspended()")).toBe("f");
    const b = begin(p.request_id);
    expect(finish(p.request_id, b.nonce, K1.assert(b.challenge)).status).toBe("applied");
    // the monitor's read function and its digest see the same state
    const mon = JSON.parse(asRole("service_role", "select public.tw4_price_monitor_events(0)::text;")) as { events: { kind: string }[] };
    expect(mon.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["pricing_suspended", "pricing_resumed"]));
    const dig = JSON.parse(asRole("service_role", "select public.tw4_price_monitor_digest()::text;")) as { guards_bad: string[] };
    expect(dig.guards_bad).toEqual([]);
  });

  it("MON-03 a monitoring outage never authorizes a financial change: with the events table unavailable, propose-side begin / enrol / revoke fail closed, the freeze and the recovery freeze still work, failed emits are audited, and the replay delivers them in order once the table is back", () => {
    clear();
    resetCreds(K1, K2, [KR, "recovery"]);
    const p = propose(483);
    ownerAgeRequest(psql, p.request_id, 25);
    const failed0 = num("select count(*) from public.studio_sms_price_audit where event = 'emit_failed'");
    psql("alter table public.studio_sms_price_security_events rename to studio_sms_price_security_events_off");
    try {
      // risk-opening calls fail closed (the emit cannot be delivered)
      const challenges = num("select count(*) from public.studio_sms_price_auth_challenges where purpose = 'authorize'");
      expect(authErr(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`)).toMatch(/ERROR/);
      expect(num("select count(*) from public.studio_sms_price_auth_challenges where purpose = 'authorize'")).toBe(challenges);
      const K9 = new SoftAuthenticator();
      expect(() => enrollReq(K1, K9, "enrol during an outage")).toThrow();
      expect(num("select count(*) from public.studio_sms_price_credential_changes")).toBe(0);
      // the emergency freeze does not depend on monitoring
      expect(authOut(claims(B, "d42m-b3"), `select public.tw4_price_freeze('a freeze while the monitoring table is unavailable')::text;`)).toMatchObject({ status: "frozen" });
      expect(num("select count(*) from public.studio_sms_price_audit where event = 'emit_failed'")).toBeGreaterThan(failed0);
    } finally {
      psql("alter table public.studio_sms_price_security_events_off rename to studio_sms_price_security_events");
    }
    const h = headSeq();
    const rp = JSON.parse(asRole("service_role", "select public.tw4_price_emit_replay(50)::text;")) as { replayed: number; remaining: number };
    expect(rp.remaining).toBe(0);
    expect(rp.replayed).toBeGreaterThan(0);
    expect(events(h).map((e) => e.kind)).toContain("pricing_suspended");
    expect(thawWith(K2)).toMatchObject({ status: "thawed" });
  });
});
