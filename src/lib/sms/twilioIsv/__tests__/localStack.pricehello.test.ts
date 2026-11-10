/**
 * TW-4F single-owner design (device-bound passkey such as Windows Hello): the cells the design depends on that the earlier price authorization suites do not cover.
 *   HC: signature-counter compatibility. An authenticator that always reports counter 0 is accepted; clone detection is NOT weakened for an authenticator that counts
 *       (once a counter has moved, equal or lower values are refused, including 0).
 *   HR: the documented lost-device reset (scripts/hosted/tw4f/lost_device_reset.sql): refused unless frozen 72 hours, verified reference, valid key; revokes everything, installs the
 *       new primary, audits it, and the new key can prove itself, lift the freeze and publish while the lost key is dead.
 * LOCAL QA DATABASE ONLY (TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB, the tw4_local_qa_only marker). Software authenticators; the real-device check is the owner-run harness, not this suite.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, DB, PG, enabled, psql, psqlError, rows, seedCast } from "./wpd4Helpers";
import { ownerAgeRequest, registerApproverSql } from "./priceFixture";
import { ORIGIN, RP_ID, SoftAuthenticator } from "./webauthnFixture";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const NL = String.fromCharCode(10);
const nowS = () => Math.floor(Date.now() / 1000);
const claims = (sub: string, sid: string) => ({ sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], session_id: sid });
const asAuth = (c: Record<string, unknown>, sql: string) => `begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(c).replace(/'/g, "''")}', true); ${sql} commit;`;
const authOut = (c: Record<string, unknown>, sql: string) => JSON.parse(psql(asAuth(c, sql)).split(NL).pop()!) as Record<string, never>;
const S1 = "hello-session-1";
const S2 = "hello-session-2";

const ownerSql = (sql: string) => psql(`begin; do $q$ begin if to_regclass('public.tw4_local_qa_only') is null then raise exception 'not a local QA database'; end if; end $q$; ${sql} commit;`);
const unguard = (table: string, trigger: string, stmt: string) => `alter table public.${table} disable trigger ${trigger}; ${stmt} alter table public.${table} enable always trigger ${trigger};`;
const attest = (k: SoftAuthenticator, counter?: number): string | null => {
  const b = JSON.parse(psql(`select public._tw4price_attest_begin(decode('${k.hex.cred}', 'hex'))::text`).split(NL).filter(Boolean).pop()!) as { nonce: string; challenge: string };
  const a = k.assert(b.challenge, counter === undefined ? {} : { counter });
  const r = psql(`select coalesce(public._tw4price_attest_finish(decode('${k.hex.cred}', 'hex'), public._tw4price_unb64u('${b.nonce}'), public._tw4price_unb64u('${a.auth}'), public._tw4price_unb64u('${a.client}'), public._tw4price_unb64u('${a.sig}')), 'UNEXPECTED_NULL')`).split(NL).filter(Boolean).pop()!;
  return r === "attested" ? null : r;
};
const bootstrap = (k: SoftAuthenticator) =>
  psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${k.hex.cred}', 'hex'), decode('${k.hex.x}', 'hex'), decode('${k.hex.y}', 'hex'), 'owner device key')`);
const storedCounter = (k: SoftAuthenticator) => Number(psql(`select sign_count from public.studio_sms_price_credentials where credential_id = decode('${k.hex.cred}', 'hex')`));
const clear = () => {
  for (const r of rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where status = 'pending'`)) psql(`select public._tw4price_do_reject('${r.id}', '${r.requested_by}', 'withdrawn to start the next test')`);
};
const setFrozenHoursAgo = (h: number) =>
  ownerSql(unguard("studio_sms_price_auth_config", "studio_sms_price_auth_config_guard", `set local tw4.priceauth_write = 'on'; update public.studio_sms_price_auth_config set frozen = true, frozen_at = clock_timestamp() - interval '${h} hours', freeze_reason = 'lost device verified by call and email 2026-11-10' where singleton;`));
const resetSql = (k: SoftAuthenticator, over: Record<string, string> = {}) => {
  let s = readFileSync(join(process.cwd(), "scripts", "hosted", "tw4f", "lost_device_reset.sql"), "utf8");
  const v: Record<string, string> = { TICKET: "verified by call and email 2026-11-10", OWNER_UID: A, INCIDENT_START: new Date(Date.now() - 100 * 3600 * 1000).toISOString(), CRED_HEX: k.hex.cred, X_HEX: k.hex.x, Y_HEX: k.hex.y, LABEL: "replacement device key", ...over };
  for (const [name, value] of Object.entries(v)) s = s.split(`@@${name}@@`).join(value);
  return s;
};
const superRun = (sql: string): string => {
  try {
    execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "supabase_admin", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (e) {
    return String((e as { stderr?: Buffer | string }).stderr ?? e);
  }
};

describe.skipIf(!enabled)("single-owner device-bound passkey: counter compatibility and lost-device reset", () => {
  const Kzero = new SoftAuthenticator(); // reports counter 0 forever (as some platform authenticators do)
  const Kcount = new SoftAuthenticator(); // counts
  const Knew = new SoftAuthenticator();

  beforeAll(() => {
    seedCast();
    psql(registerApproverSql(A));
    ownerSql(unguard("studio_sms_price_approvers", "studio_sms_price_approvers_guard", "update public.studio_sms_price_approvers set added_at = added_at - interval '400 hours';"));
    bootstrap(Kzero);
  });

  it("HC-1 an authenticator that always reports counter 0 is accepted repeatedly (attest twice) and its stored counter stays 0", () => {
    expect(attest(Kzero, 0)).toBeNull();
    expect(attest(Kzero, 0)).toBeNull();
    expect(storedCounter(Kzero)).toBe(0);
  });

  it("HC-2 a zero-counter authenticator can authorize a price (cooling-off, separate session, signature over the exact proposal)", () => {
    clear();
    const p = authOut(claims(A, S1), `select public.tw4_price_propose('number', 165, 115, 'zero counter owner price', 'a written reason for the zero counter test')::text;`);
    ownerAgeRequest(psql, p.request_id, 25);
    const b = authOut(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`);
    const a = Kzero.assert(b.challenge, { counter: 0 });
    const f = authOut(claims(A, S2), `select public.tw4_price_authz_finish('${p.request_id}', '${b.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
    expect(f.status).toBe("applied");
  });

  it("HC-3 clone detection is NOT weakened for an authenticator that counts: once the counter has moved, an equal, lower or zero value is refused", () => {
    // enrol a second, counting credential through the owner-level path used for tests, then prove it
    ownerSql(unguard("studio_sms_price_credentials", "studio_sms_price_credentials_guard", `set local tw4.priceauth_write = 'on'; insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${Kcount.hex.cred}', 'hex'), decode('${Kcount.hex.x}', 'hex'), decode('${Kcount.hex.y}', 'hex'), 'spare', 'counting test key', 'bootstrap');`));
    expect(attest(Kcount, 3)).toBeNull();
    expect(storedCounter(Kcount)).toBe(3);
    expect(attest(Kcount, 3)).toMatch(/sign counter did not increase/);
    expect(attest(Kcount, 2)).toMatch(/sign counter did not increase/);
    expect(attest(Kcount, 0)).toMatch(/sign counter did not increase/);
    expect(attest(Kcount, 4)).toBeNull();
    expect(storedCounter(Kcount)).toBe(4);
  });

  it("HR-1 the lost-device reset refuses unless pricing has been frozen for 72 hours, the reference is real and the key is a valid new key", () => {
    ownerSql(unguard("studio_sms_price_credentials", "studio_sms_price_credentials_guard", `update public.studio_sms_price_credentials set status = 'revoked', revoked_at = clock_timestamp() where credential_id = decode('${Kcount.hex.cred}', 'hex');`));
    // not frozen at all
    expect(superRun(resetSql(Knew))).toMatch(/frozen for at least 72 hours/);
    setFrozenHoursAgo(10);
    expect(superRun(resetSql(Knew))).toMatch(/frozen for at least 72 hours/);
    setFrozenHoursAgo(73);
    expect(superRun(resetSql(Knew, { TICKET: "short" }))).toMatch(/written verification reference/);
    // the freeze must have been set for THIS incident: the reference has to be in the freeze reason
    // the freeze must belong to this incident: neither the reference in its reason nor set after the incident start
    expect(superRun(resetSql(Knew, { TICKET: "a different reference 99", INCIDENT_START: new Date(Date.now() + 3600 * 1000).toISOString() }))).toMatch(/freeze must belong to this incident/);
    // unsubstituted placeholders are refused
    expect(superRun(readFileSync(join(process.cwd(), "scripts", "hosted", "tw4f", "lost_device_reset.sql"), "utf8"))).toMatch(/written verification reference|invalid input|decode|hex/i);
    expect(superRun(resetSql(Knew, { OWNER_UID: "00000000-0000-4000-8000-000000000001" }))).toMatch(/not an active registered platform administrator/);
    expect(superRun(resetSql(Knew, { X_HEX: "00".repeat(32), Y_HEX: "00".repeat(32) }))).toMatch(/not a valid P-256 public key/);
    expect(superRun(resetSql(Kzero))).toMatch(/already registered/);
    // nothing changed by any refusal
    expect(psql(`select count(*) from public.studio_sms_price_credentials where status = 'active'`)).toBe("1");
  });

  it("HR-2 the reset revokes every active credential, installs the new primary, audits both with the reference, and leaves pricing frozen with published prices intact", () => {
    const before = rows<{ n: number }>(`select count(*)::int n from public.studio_sms_price_list where active`)[0].n;
    expect(superRun(resetSql(Knew))).toBe("");
    expect(rows<{ s: string; r: string }>(`select status s, role r from public.studio_sms_price_credentials order by enrolled_at`).filter((x) => x.s === "active")).toEqual([{ s: "active", r: "primary" }]);
    expect(psql(`select count(*) from public.studio_sms_price_credentials where credential_id = decode('${Knew.hex.cred}', 'hex') and status = 'active' and role = 'primary' and enrolled_via = 'bootstrap' and proof_verified_at is null and enrolled_at < (select frozen_at from public.studio_sms_price_auth_config)`)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_price_credentials where credential_id = decode('${Kzero.hex.cred}', 'hex') and status = 'revoked'`)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_price_audit where detail ->> 'via' = 'owner_level_reset' and detail ->> 'ticket' = 'verified by call and email 2026-11-10'`)).toBe("2");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("t");
    expect(rows<{ n: number }>(`select count(*)::int n from public.studio_sms_price_list where active`)[0].n).toBe(before);
    // the lost key is dead
    expect(psqlError(`select public._tw4price_attest_begin(decode('${Kzero.hex.cred}', 'hex'))`)).toMatch(/attest needs an active credential/);
  });

  it("HR-3 the new key proves itself, lifts the freeze with its own ceremony, and publishes; the lost key cannot", () => {
    expect(attest(Knew)).toBeNull();
    expect(psql(`select proof_verified_at is not null from public.studio_sms_price_credentials where credential_id = decode('${Knew.hex.cred}', 'hex')`)).toBe("t");
    const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
    const ta = Knew.assert(tb.challenge);
    const thaw = authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${ta.credId}', '${ta.auth}', '${ta.client}', '${ta.sig}')::text;`);
    expect(thaw.status).not.toBe("rejected");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("f");
    clear();
    const p = authOut(claims(A, S1), `select public.tw4_price_propose('number', 175, 115, 'price after the reset', 'a written reason for the reset test')::text;`);
    ownerAgeRequest(psql, p.request_id, 25);
    const b = authOut(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`);
    const f = authOut(claims(A, S2), `select public.tw4_price_authz_finish('${p.request_id}', '${b.nonce}', '${Knew.assert(b.challenge).credId}', 'AA', 'AA', 'AA')::text;`);
    expect(f.status).toBe("rejected"); // malformed assertion is refused
    const b2 = authOut(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`);
    const a2 = Knew.assert(b2.challenge);
    expect(authOut(claims(A, S2), `select public.tw4_price_authz_finish('${p.request_id}', '${b2.nonce}', '${a2.credId}', '${a2.auth}', '${a2.client}', '${a2.sig}')::text;`).status).toBe("applied");
  });

  it("HR-4 a recovery hold (set by a recovery key's freeze, whose reason is fixed text without the reference) does not strand the reset: it is cleared, the freeze clock restarts, and the new key lifts the freeze", () => {
    const Krec = new SoftAuthenticator();
    const Knew2 = new SoftAuthenticator();
    // owner-level, visible test setup: an installed recovery key whose freeze left recovery_hold set, long enough ago
    psql(`select public._tw4price_install_recovery(decode('${Krec.hex.cred}', 'hex'), decode('${Krec.hex.x}', 'hex'), decode('${Krec.hex.y}', 'hex'), 'recovery test key')`);
    ownerSql(unguard("studio_sms_price_auth_config", "studio_sms_price_auth_config_guard", `set local tw4.priceauth_write = 'on'; update public.studio_sms_price_auth_config set recovery_hold = true, frozen = true, frozen_at = clock_timestamp() - interval '80 hours', freeze_reason = 'frozen with the recovery credential' where singleton;`));
    expect(psql(`select recovery_hold from public.studio_sms_price_auth_config`)).toBe("t");
    expect(superRun(resetSql(Knew2))).toBe("");
    expect(psql(`select recovery_hold from public.studio_sms_price_auth_config`)).toBe("f");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("t");
    expect(psql(`select count(*) from public.studio_sms_price_credentials where status = 'active'`)).toBe("1");
    expect(psql(`select count(*) from public.studio_sms_price_credentials where credential_id = decode('${Krec.hex.cred}', 'hex') and status = 'revoked'`)).toBe("1");
    expect(attest(Knew2)).toBeNull();
    const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
    const ta = Knew2.assert(tb.challenge);
    authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${ta.credId}', '${ta.auth}', '${ta.client}', '${ta.sig}')::text;`);
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("f");
    // the audit names the previous recovery hold
    expect(psql(`select count(*) from public.studio_sms_price_audit where event = 'credential_revoked' and (detail ->> 'previous_recovery_hold') = 'true'`)).toBe("2");
  });
});
