/**
 * D4-2: single-owner high-assurance price authorization (migration 20270204100000) on a throwaway DEV-equivalent database. The WebAuthn assertions come from a SOFTWARE
 * authenticator (P-256 test keys, webauthnFixture.ts) and are verified INSIDE Postgres. Sessions are simulated with verified-claims JSON (role authenticated, aal2, TOTP,
 * session_id) exactly as PostgREST hands them to the database; the real-GoTrue variants live in localStack.pricedual.realtokens.
 * LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB and the tw4_local_qa_only marker.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, C, DB, PG, codeOf, enabled, num, psql, psqlError, rows, seedCast, seedPrices } from "./wpd4Helpers";
import { ownerAgeRequest, registerApproverSql } from "./priceFixture";
import { ORIGIN, RP_ID, SoftAuthenticator, b64u, type Assertion } from "./webauthnFixture";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const NL = String.fromCharCode(10);
const nowS = () => Math.floor(Date.now() / 1000);
const S1 = "d42-session-proposer";
const S2 = "d42-session-authorizer";
const claims = (sub: string, sid: string | null, over: Record<string, unknown> = {}) => ({
  sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], ...(sid ? { session_id: sid } : {}), ...over,
});
const asAuth = (c: Record<string, unknown> | null, sql: string) => `begin; set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(c ?? {}).replace(/'/g, "''")}', true); ${sql} commit;`;
const authErr = (c: Record<string, unknown> | null, sql: string) => psqlError(asAuth(c, sql));
const authOut = (c: Record<string, unknown> | null, sql: string) => JSON.parse(psql(asAuth(c, sql)).split(NL).pop()!) as Record<string, never>;

const K1 = new SoftAuthenticator(); // primary
const K2 = new SoftAuthenticator(); // spare
const K3 = new SoftAuthenticator(); // a later primary
const KX = new SoftAuthenticator(); // the attacker's key: never enrolled

const propose = (c: Record<string, unknown>, cents: number, prov = 115, kind = "number") =>
  authOut(c, `select public.tw4_price_propose('${kind}', ${cents}, ${prov}, 'owner mode price', 'a written reason for the owner mode test')::text;`);
const begin = (c: Record<string, unknown>, id: string) => authOut(c, `select public.tw4_price_authz_begin('${id}')::text;`);
const beginErr = (c: Record<string, unknown> | null, id: string) => authErr(c, `select public.tw4_price_authz_begin('${id}')::text;`);
const finishSql = (id: string, nonce: string, a: Assertion) => `select public.tw4_price_authz_finish('${id}', '${nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`;
const finish = (c: Record<string, unknown>, id: string, nonce: string, a: Assertion) => authOut(c, finishSql(id, nonce, a));
const finishErr = (c: Record<string, unknown> | null, id: string, nonce: string, a: Assertion) => authErr(c, finishSql(id, nonce, a));
const req = (id: string) => rows<{ status: string; approval_mode: string; decided_by: string | null; auth_credential_id: string | null; proposal_version: number; cooling_until: string | null; expires_at: string }>(
  `select status, approval_mode, decided_by, auth_credential_id::text, proposal_version, cooling_until::text, expires_at::text from public.studio_sms_price_change_requests where id = '${id}'`)[0];
const active = (kind = "number") => rows<{ id: string; customer_price_cents: number; created_by: string }>(`select id, customer_price_cents, created_by from public.studio_sms_price_list where kind = '${kind}' and active`);
const audit = (event: string) => num(`select count(*) from public.studio_sms_price_audit where event = '${event}'`);
const clear = () => {
  for (const r of rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where status = 'pending'`)) psql(`select public._tw4price_do_reject('${r.id}', '${r.requested_by}', 'withdrawn to start the next scenario clean')`);
};
/** owner-level, visible: change one protected configuration value (migration-only in production) */
const setConfig = (setSql: string) => psql(`begin; alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set ${setSql}; alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard; commit;`);
const ready = (id: string) => ownerAgeRequest(psql, id, 25); // the cooling-off is over (cooling_until, requested_at and expires_at move together)
const migration = (name: string) => readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", name), "utf8");
const strip = (s: string) => s.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
/** a full owner ceremony: propose in session S1, age, begin and finish from S2 with key `k` */
function authorize(cents: number, k: SoftAuthenticator = K1, kind = "number", prov = 115): { id: string; out: Record<string, never> } {
  clear();
  const p = propose(claims(A, S1), cents, prov, kind);
  ready(p.request_id);
  const b = begin(claims(A, S2), p.request_id);
  return { id: p.request_id, out: finish(claims(A, S2), p.request_id, b.nonce, k.assert(b.challenge)) };
}

describe.skipIf(!enabled)("D4-2 single-owner hardware-key price authorization (WebAuthn verified in Postgres, software authenticators)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_price_auth_config') is not null`)).toBe("t");
    seedCast();
    for (const u of [A, B, C]) psql(registerApproverSql(u));
    // the aged requests of this suite pre-date the registrations: move the registrations back so the verifier's 'registered at the time' check sees them
    psql(`begin; alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard; update public.studio_sms_price_approvers set added_at = added_at - interval '400 hours'; alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard; commit;`);
    seedPrices(); // team-mode fixtures through the internal functions
    // the owner-level bootstrap (a runbook step; no application path exists): relying party + the primary credential
    psql(`select public._tw4price_bootstrap('${RP_ID}', array['${ORIGIN}'], decode('${K1.hex.cred}', 'hex'), decode('${K1.hex.x}', 'hex'), decode('${K1.hex.y}', 'hex'), 'primary test key')`);
  });

  it("PA-01 the ECDSA P-256 verifier inside Postgres: valid signatures verify, and every tampering (message, key, r, s, off-curve key) fails", () => {
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      const msg = Buffer.from(`transaction ${i} ${Math.random()}`);
      const sig = K1.rawSign(msg).toString("hex");
      const e = createHash("sha256").update(msg).digest("hex");
      const call = (eHex: string, sigHex: string, x = K1.hex.x, y = K1.hex.y) => psql(`select public._tw4price_p256_verify(public._tw4price_bytes2num(decode('${eHex}', 'hex')), r, s, public._tw4price_bytes2num(decode('${x}', 'hex')), public._tw4price_bytes2num(decode('${y}', 'hex')))
        from public._tw4price_der_rs(decode('${sigHex}', 'hex'))`);
      expect(call(e, sig)).toBe("t");
      expect(call(createHash("sha256").update(msg).update("x").digest("hex"), sig)).toBe("f"); // other message
      expect(call(e, sig, K2.hex.x, K2.hex.y)).toBe("f"); // other key
      if (i === 0) {
        const flipped = Buffer.from(sig, "hex");
        flipped[flipped.length - 1] ^= 1;
        expect(call(e, flipped.toString("hex"))).toBe("f"); // altered s
        expect(call(e, "3006020100020100")).toBe("f"); // r = s = 0
      }
    }
    expect(psql(`select public._tw4price_p256_oncurve(1, 1)`)).toBe("f");
    expect(psql(`select public._tw4price_p256_oncurve(public._tw4price_bytes2num(decode('${K1.hex.x}', 'hex')), public._tw4price_bytes2num(decode('${K1.hex.y}', 'hex')))`)).toBe("t");
    console.info(`[priceauth] 14 ECDSA verifications in ${Date.now() - t0} ms`);
  });

  it("PA-02 the ceremony: propose (aal2 + fresh TOTP) starts a 24 h cooling-off; no auto-publish; a SEPARATE session with the hardware key publishes exactly the proposed price; every step is audited", () => {
    clear();
    const before = active();
    const p = propose(claims(A, S1), 250);
    expect(p).toMatchObject({ status: "pending", mode: "owner", version: 1 });
    const r = req(p.request_id);
    expect(r.approval_mode).toBe("owner");
    expect(new Date(r.cooling_until!).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(active()).toEqual(before);
    // inside the cooling-off nobody gets a challenge, not even the owner with a perfect session
    expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("TW045");
    ready(p.request_id);
    // the proposing session cannot authorize
    expect(codeOf(beginErr(claims(A, S1), p.request_id))).toBe("42501");
    const b = begin(claims(A, S2), p.request_id);
    expect(b.summary).toMatchObject({ scope: "studio_sms_price_list", kind: "number", new_customer_cents: 250, proposal_version: 1 });
    expect(b.allow_credentials).toEqual([K1.credIdB64u]);
    // nothing has changed yet
    expect(active()).toEqual(before);
    const out = finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge));
    expect(out.status).toBe("applied");
    expect(req(p.request_id)).toMatchObject({ status: "applied", decided_by: A });
    expect(active()[0]).toMatchObject({ id: out.price_id, customer_price_cents: 250, created_by: A });
    expect(audit("proposed")).toBeGreaterThanOrEqual(1);
    expect(audit("challenge_issued")).toBeGreaterThanOrEqual(1);
    expect(audit("authorized")).toBe(1);
    expect(audit("published")).toBe(1);
    expect(JSON.parse(psql(`select public.tw4_price_verify()::text`))).toMatchObject({ ok: true });
  });

  it("PA-03 a challenge is single use and the request is final: replaying the SAME valid assertion publishes nothing a second time", () => {
    const { id } = authorize(251);
    const row = rows<{ nonce: string }>(`select encode(auth_nonce, 'hex') as nonce from public.studio_sms_price_change_requests where id = '${id}'`)[0];
    expect(row.nonce).toHaveLength(64);
    const b64 = (hex: string) => b64u(Buffer.from(hex, "hex"));
    const stale = K1.assert("AAAA", { counter: K1.counter + 5 });
    expect(codeOf(finishErr(claims(A, S2), id, b64(row.nonce), stale))).toBe("TW041"); // request already applied
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 251`)).toBe(1);
  });

  it("PA-04 the assertion is bound to the exact proposal and the exact ceremony: wrong origin / relying party / flags / type / challenge / key / counter / signature are REJECTED (recorded, nothing published) and a valid assertion still works afterwards", () => {
    clear();
    const before = active();
    const p = propose(claims(A, S1), 260);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    const other = propose(claims(A, "d42-other-session"), 261, 115, "monthly");
    ready(other.request_id);
    const bo = begin(claims(A, S2), other.request_id);
    const bad: Array<[string, Assertion]> = [
      ["origin", K1.assert(b.challenge, { origin: "https://evil.example.test" })],
      ["relying party", K1.assert(b.challenge, { rpId: "evil.example.test" })],
      ["user verification missing", K1.assert(b.challenge, { flags: 0x01 })],
      ["user presence missing", K1.assert(b.challenge, { flags: 0x04 })],
      ["wrong ceremony type", K1.assert(b.challenge, { type: "webauthn.create" })],
      ["another proposal's challenge", K1.assert(bo.challenge)],
      ["a different challenge", K1.assert(b64u(Buffer.alloc(32, 7)))],
      ["attacker key, real credential id", { ...KX.assert(b.challenge), credId: K1.credIdB64u }],
      ["unknown credential", KX.assert(b.challenge)],
      ["cross origin", K1.assert(b.challenge, { crossOrigin: true })],
      ["counter went backwards", K1.assert(b.challenge, { counter: 1 })],
      ["garbage signature", { ...K1.assert(b.challenge), sig: b64u(Buffer.from("not a signature")) }],
      ["garbage everything", { credId: "!!", auth: "!!", client: "!!", sig: "!!" }],
    ];
    for (const [label, a] of bad) {
      const out = finish(claims(A, S2), p.request_id, b.nonce, a);
      expect(out.status, label).toBe("rejected");
      expect(out.reason, label).toBeTruthy();
    }
    expect(req(p.request_id).status).toBe("pending");
    expect(active()).toEqual(before);
    expect(audit("assertion_rejected")).toBeGreaterThanOrEqual(bad.length);
    // the challenge survived the failures; the genuine assertion publishes
    const ok = finish(claims(A, S2), p.request_id, b.nonce, K1.assert(b.challenge));
    expect(ok.status).toBe("applied");
    clear();
  });

  it("PA-05 proposal tampering / TOCTOU: a revision invalidates the old proposal and its challenge and RESTARTS the cooling-off; amounts of a pending proposal cannot be edited (also in replica mode); a signature over the old version never authorizes the new", () => {
    clear();
    const p = propose(claims(A, S1), 270);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    const sigOld = K1.assert(b.challenge);
    const rev = authOut(claims(A, S1), `select public.tw4_price_revise('${p.request_id}', 280, 115, 'revised owner price', 'a revised written reason for the test')::text;`);
    expect(rev).toMatchObject({ status: "pending", version: 2 });
    expect(req(p.request_id).status).toBe("invalidated");
    expect(req(rev.request_id).proposal_version).toBe(2);
    expect(new Date(req(rev.request_id).cooling_until!).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(audit("revised")).toBeGreaterThanOrEqual(1);
    // the old signature is useless on the old request (invalidated) ...
    expect(codeOf(finishErr(claims(A, S2), p.request_id, b.nonce, sigOld))).toBe("TW041");
    // ... and on the new one, even after its cooling-off (the hash is different, the nonce is not even issued)
    ready(rev.request_id);
    const b2 = begin(claims(A, S2), rev.request_id);
    expect(finish(claims(A, S2), rev.request_id, b.nonce, sigOld).status).toBe("rejected");
    expect(finish(claims(A, S2), rev.request_id, b2.nonce, sigOld).status).toBe("rejected");
    // direct tampering with the bound facts
    for (const col of ["customer_price_cents = 1", "kind = 'monthly'", "description = 'tampered'", "expires_at = expires_at + interval '1 day'", "cooling_until = requested_at + interval '30 hours'", "proposal_version = 9", "approval_mode = 'team'"]) {
      expect(psqlError(`update public.studio_sms_price_change_requests set ${col} where id = '${rev.request_id}'`), col).toMatch(/binding of a proposal is fixed/);
      expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_change_requests set ${col} where id = '${rev.request_id}'; rollback;`), col).toMatch(/binding of a proposal is fixed/);
    }
    // a valid ceremony on the new version works
    expect(finish(claims(A, S2), rev.request_id, b2.nonce, K1.assert(b2.challenge)).status).toBe("applied");
  });

  it("PA-06 the cooling-off cannot be bypassed: it is a ROW constraint (at least 24 hours), no function and no replica-mode owner can shorten it; expiry never publishes; an unauthorized window leaves the request pending and unauthorizable", () => {
    clear();
    const p = propose(claims(A, S1), 290);
    // owner-level, guard visibly off: a shorter cooling-off still violates the CHECK
    expect(psqlError(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      update public.studio_sms_price_change_requests set cooling_until = requested_at + interval '1 hour' where id = '${p.request_id}'; rollback;`)).toMatch(/owner_shape/);
    expect(psqlError(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, expires_at, approval_mode, cooling_until, proposer_session)
      values ('number', 999, 1, 'short cooling', 'a forged short cooling-off', '${A}', now() + interval '3 hours', 'owner', now() + interval '1 hour', 'x'); rollback;`)).toMatch(/owner_shape/);
    expect(psqlError(`update public.studio_sms_price_auth_config set cooling_off_hours = 1`)).toMatch(/owner-level migration/);
    expect(psqlError(`begin; alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard; update public.studio_sms_price_auth_config set cooling_off_hours = 1; rollback;`)).toMatch(/check constraint/);
    // the cooling-off ends; nothing is published by time alone
    const before = active();
    ready(p.request_id);
    expect(req(p.request_id).status).toBe("pending");
    expect(active()).toEqual(before);
    // the authorization window passes: the request stays pending forever and cannot be authorized
    ownerAgeRequest(psql, p.request_id, 80);
    expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("TW041");
    expect(req(p.request_id).status).toBe("pending");
    expect(active()).toEqual(before);
    clear();
  });

  it("PA-07 identity and session abuse: aal1, stale TOTP, no session id, a service-role or anon claim, an unregistered or non-owner subject, the team-mode approve path and a second session id that equals the proposer's are all refused; service_role has no EXECUTE at all", () => {
    clear();
    const p = propose(claims(A, S1), 300);
    ready(p.request_id);
    const refusals: Array<[string, Record<string, unknown> | null, string]> = [
      ["aal1", claims(A, S2, { aal: "aal1", amr: [{ method: "password", timestamp: nowS() }] }), "42501"],
      ["no totp", claims(A, S2, { amr: [{ method: "password", timestamp: nowS() }] }), "42501"],
      ["no session id", claims(A, null), "42501"],
      ["service_role claim", claims(A, S2, { role: "service_role" }), "42501"],
      ["anon", { role: "anon" }, "42501"],
      ["another registered admin (not the owner who proposed)", claims(B, S2), "42501"],
      ["a non-administrator", claims(C, S2, {}), "42501"],
      ["the proposing session", claims(A, S1), "42501"],
    ];
    for (const [label, c, code] of refusals) expect(codeOf(beginErr(c, p.request_id)), label).toBe(code);
    // the team-mode approval refuses an owner-mode proposal, whoever calls it
    expect(codeOf(authErr(claims(B, S2), `select public.tw4_price_approve('${p.request_id}', 'a long enough approval note')::text;`))).toBe("TW042");
    expect(codeOf(psqlError(`select public._tw4price_do_approve('${p.request_id}', '${B}', 'a long enough approval note')`))).toBe("TW042");
    // forged claims: a perfect session without the hardware key publishes nothing
    const b = begin(claims(A, S2), p.request_id);
    const forged = finish(claims(A, S2), p.request_id, b.nonce, KX.assert(b.challenge));
    expect(forged.status).toBe("rejected");
    for (const f of ["tw4_price_authz_begin(uuid)", "tw4_price_authz_finish(uuid,text,text,text,text,text)", "tw4_price_revise(uuid,integer,integer,text,text)", "tw4_price_freeze(text)",
      "tw4_price_thaw(text,text,text,text,text)", "tw4_price_cred_begin(text,text,text,text,text,text)", "tw4_price_cred_revoke(text,text,text,text,text,text)", "tw4_price_propose(text,integer,integer,text,text)",
      "_tw4price_check_assertion(text,bytea,bytea,bytea,bytea,bytea,bytea,boolean)", "_tw4price_bootstrap(text,text[],bytea,bytea,bytea,text)", "_tw4price_audit(text,uuid,text,uuid,bytea,jsonb)"]) {
      expect(psql(`select has_function_privilege('service_role', 'public.${f}', 'execute') or has_function_privilege('anon', 'public.${f}', 'execute')`), f).toBe("f");
    }
    for (const f of ["_tw4price_check_assertion(text,bytea,bytea,bytea,bytea,bytea,bytea,boolean)", "_tw4price_bootstrap(text,text[],bytea,bytea,bytea,text)", "_tw4price_audit(text,uuid,text,uuid,bytea,jsonb)"]) {
      expect(psql(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), f).toBe("f");
    }
    // no direct write to any protected table from any API role
    for (const t of ["studio_sms_price_credentials", "studio_sms_price_auth_challenges", "studio_sms_price_audit", "studio_sms_price_auth_config"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psqlError(`set role ${role}; select count(*) from public.${t};`), `${role} ${t}`).toMatch(/permission denied/);
        expect(psqlError(`set role ${role}; delete from public.${t};`), `${role} ${t}`).toMatch(/permission denied/);
      }
    }
    clear();
  });

  it("PA-08 mode and configuration protection: no function, no API role and no plain owner statement changes the mode, the cooling-off or the relying party; the freeze flag moves only through its functions", () => {
    for (const set of ["mode = 'team'", "cooling_off_hours = 48", "authz_window_hours = 72", "challenge_ttl_seconds = 900", "rp_id = 'evil.example.test'", "rp_origins = array['https://evil.example.test']", "frozen = true, frozen_at = now()"]) {
      expect(psqlError(`update public.studio_sms_price_auth_config set ${set}`), set).toMatch(/owner-level migration|freeze functions/);
      expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_auth_config set ${set}; rollback;`), set).toMatch(/owner-level migration|freeze functions/);
      for (const role of ["anon", "authenticated", "service_role"]) expect(psqlError(`set role ${role}; update public.studio_sms_price_auth_config set ${set};`), `${role} ${set}`).toMatch(/permission denied/);
    }
    expect(psqlError(`delete from public.studio_sms_price_auth_config`)).toMatch(/never deleted/);
    expect(psqlError(`insert into public.studio_sms_price_auth_config (singleton) values (false)`)).toMatch(/check constraint|single protected row/);
    expect(psqlError(`truncate public.studio_sms_price_auth_config`)).toMatch(/never truncated/);
    expect(psql(`select mode || ':' || cooling_off_hours from public.studio_sms_price_auth_config`)).toBe("single_owner:24");
    // the bootstrap works once only
    expect(psqlError(`select public._tw4price_bootstrap('evil.example.test', array['https://evil.example.test'], decode('${KX.hex.cred}', 'hex'), decode('${KX.hex.x}', 'hex'), decode('${KX.hex.y}', 'hex'), 'second bootstrap')`)).toMatch(/already bootstrapped/);
  });

  it("PA-09 credential replacement attacks: an attacker with a perfect session cannot add, replace or revoke a credential; the legitimate ceremony (existing credential signs, the new one proves possession) works; revocation cannot remove the last credential or be self-authorized", () => {
    const enrollBegin = (c: Record<string, unknown>, k: SoftAuthenticator, role: string, label: string) =>
      authOut(c, `select public.tw4_price_cred_begin('enroll', '${k.credIdB64u}', '${b64u(k.x)}', '${b64u(k.y)}', '${role}', '${label}')::text;`);
    const enroll = (c: Record<string, unknown>, k: SoftAuthenticator, role: string, label: string, nonce: string, by: Assertion, mine: Assertion) =>
      authOut(c, `select public.tw4_price_cred_enroll('${nonce}', '${k.credIdB64u}', '${b64u(k.x)}', '${b64u(k.y)}', '${role}', '${label}', '${by.credId}', '${by.auth}', '${by.client}', '${by.sig}', '${mine.auth}', '${mine.client}', '${mine.sig}')::text;`);
    const sess = claims(A, S2);
    // attacker signs with HIS OWN key only
    let b = enrollBegin(sess, KX, "spare", "attacker key");
    expect(enroll(sess, KX, "spare", "attacker key", b.nonce, KX.assert(b.challenge), KX.assert(b.challenge)).status).toBe("rejected");
    // the existing credential signed, but the new key cannot prove possession (it is signed by another key)
    b = enrollBegin(sess, KX, "spare", "attacker key");
    expect(enroll(sess, KX, "spare", "attacker key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge)).status).toBe("rejected");
    // tampered enrolment: signed for the spare K2, submitted for the attacker's key / another role / another label
    b = enrollBegin(sess, K2, "spare", "second test key");
    const byK1 = K1.assert(b.challenge);
    expect(enroll(sess, KX, "spare", "second test key", b.nonce, byK1, KX.assert(b.challenge)).status).toBe("rejected");
    expect(enroll(sess, K2, "primary", "second test key", b.nonce, byK1, K2.assert(b.challenge)).status).toBe("rejected");
    expect(enroll(sess, K2, "spare", "renamed key x", b.nonce, byK1, K2.assert(b.challenge)).status).toBe("rejected");
    expect(num(`select count(*) from public.studio_sms_price_credentials`)).toBe(1);
    // direct writes
    expect(psqlError(`insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${KX.hex.cred}', 'hex'), decode('${KX.hex.x}', 'hex'), decode('${KX.hex.y}', 'hex'), 'spare', 'direct insert', 'assertion')`))
      .toMatch(/written only by the price authorization functions/);
    expect(psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${KX.hex.cred}', 'hex'), decode('${KX.hex.x}', 'hex'), decode('${KX.hex.y}', 'hex'), 'spare', 'direct insert', 'assertion'); rollback;`))
      .toMatch(/written only by the price authorization functions/);
    // the legitimate ceremony
    expect(enroll(sess, K2, "spare", "second test key", b.nonce, byK1, K2.assert(b.challenge)).status).toBe("enrolled");
    expect(psql(`select count(*) filter (where status = 'active') || ':' || count(*) filter (where role = 'spare') from public.studio_sms_price_credentials`)).toBe("2:1");
    expect(audit("credential_enrolled")).toBe(1);
    // the spare authorizes a price
    expect(authorize(310, K2).out.status).toBe("applied");
    // revocation: a credential cannot revoke itself, the last one cannot be revoked, an outsider key cannot revoke
    const rv = (c: Record<string, unknown>, target: SoftAuthenticator, by: SoftAuthenticator, tamper = false) => {
      const bb = authOut(c, `select public.tw4_price_cred_begin('revoke', '${target.credIdB64u}', null, null, null, null)::text;`);
      const a = by.assert(bb.challenge);
      return authOut(c, `select public.tw4_price_cred_revoke('${bb.nonce}', '${(tamper ? K2 : target).credIdB64u}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
    };
    expect(rv(sess, K1, K1).status).toBe("rejected");
    expect(rv(sess, K1, KX).status).toBe("rejected");
    expect(rv(sess, K1, K2, true).status).toBe("rejected"); // signed for K1's revocation, submitted for K2's
    expect(rv(sess, K1, K2).status).toBe("revoked"); // the spare revokes the primary
    expect(audit("credential_revoked")).toBe(1);
    expect(authErr(sess, `select public.tw4_price_cred_begin('revoke', '${K2.credIdB64u}', null, null, null, null)::text;`)).toMatch(/at least one other active credential/);
    // the revoked primary can no longer sign anything
    clear();
    const p = propose(claims(A, S1), 311);
    ready(p.request_id);
    const b3 = begin(claims(A, S2), p.request_id);
    expect(b3.allow_credentials).toEqual([K2.credIdB64u]);
    expect(finish(claims(A, S2), p.request_id, b3.nonce, K1.assert(b3.challenge)).status).toBe("rejected");
    expect(finish(claims(A, S2), p.request_id, b3.nonce, K2.assert(b3.challenge)).status).toBe("applied");
    // a replacement primary after the old one is gone: enrolled by the spare
    const eb = enrollBegin(sess, K3, "primary", "new primary key");
    expect(enroll(sess, K3, "primary", "new primary key", eb.nonce, K2.assert(eb.challenge), K3.assert(eb.challenge)).status).toBe("enrolled");
    expect(num(`select count(*) from public.studio_sms_price_credentials where status = 'active'`)).toBe(2);
  });

  it("PA-10 emergency freeze: any registered administrator session can only SUSPEND publication; with it frozen nothing can be published by any path; lifting it needs the hardware-key ceremony", () => {
    clear();
    const p = propose(claims(A, S1), 320);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    // an unregistered/unauthenticated caller cannot freeze; a registered aal2 session can (suspension is the safe direction)
    expect(codeOf(authErr(claims(A, S2, { aal: "aal1" }), `select public.tw4_price_freeze('a written freeze reason for the test')::text;`))).toBe("42501");
    expect(authOut(claims(B, "d42-b"), `select public.tw4_price_freeze('a written freeze reason for the test')::text;`)).toMatchObject({ status: "frozen" });
    expect(audit("freeze_set")).toBe(1);
    const before = active();
    // frozen: the valid assertion, the team path and a direct price insert all fail
    expect(codeOf(finishErr(claims(A, S2), p.request_id, b.nonce, K2.assert(b.challenge)))).toBe("42501");
    expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("42501");
    expect(active()).toEqual(before);
    // the freeze is not a publication path: it cannot set a price, only suspend
    expect(psql(`select count(*) from public.studio_sms_price_list where created_by = '${B}' and customer_price_cents = 320`)).toBe("0");
    // lifting: garbage or a wrong key does nothing; the hardware key does
    const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
    const thaw = (a: Assertion) => authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
    expect(thaw(KX.assert(tb.challenge)).status).toBe("rejected");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("t");
    expect(thaw(K2.assert(tb.challenge)).status).toBe("thawed");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("f");
    expect(audit("freeze_lifted")).toBe(1);
    // publication works again, with a fresh challenge
    const b2 = begin(claims(A, S2), p.request_id);
    expect(finish(claims(A, S2), p.request_id, b2.nonce, K3.assert(b2.challenge)).status).toBe("applied");
  });

  it("PA-11 concurrency: two sessions submitting the SAME valid assertion at the same moment publish exactly one price; the second is refused", async () => {
    clear();
    const p = propose(claims(A, S1), 330);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    const a = K3.assert(b.challenge);
    const run = (sql: string): Promise<{ out: string; code: number | null }> =>
      new Promise((resolve) => {
        const pr = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        pr.stdout.on("data", (d) => (out += d));
        pr.stderr.on("data", (d) => (out += d));
        pr.on("close", (code) => resolve({ out, code }));
        pr.stdin.end(sql);
      });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const s1 = run(asAuth(claims(A, S2), finishSql(p.request_id, b.nonce, a)).replace("commit;", "select pg_sleep(3.37); commit;"));
    for (let i = 0; i < 80 && psql(`select count(*) from pg_stat_activity where datname = '${DB}' and query like '%pg_sleep(3.37)%' and wait_event = 'PgSleep'`) !== "1"; i++) await sleep(150);
    const s2 = run(asAuth(claims(A, S2), finishSql(p.request_id, b.nonce, a)));
    const [x, y] = await Promise.all([s1, s2]);
    expect(x.out).toContain('"status": "applied"');
    expect(y.code).not.toBe(0);
    expect(codeOf(y.out)).toBe("TW041");
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 330`)).toBe(1);
  });

  it("PA-12 audit is immutable evidence with a stable monitoring feed: no update, delete or truncate (also in replica mode); the feed is service_role/owner only and ordered", () => {
    expect(psqlError(`update public.studio_sms_price_audit set event = 'freeze_lifted'`)).toMatch(/written only by the price authorization functions|append-only/);
    expect(psqlError(`delete from public.studio_sms_price_audit`)).toMatch(/never deleted/);
    expect(psqlError(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_audit; rollback;`)).toMatch(/never deleted/);
    expect(psqlError(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_audit; rollback;`)).toMatch(/never truncated/);
    const feed = JSON.parse(psql(`select public.tw4_price_audit_feed(0, 1000)::text`)) as { id: number; event: string }[];
    expect(feed.length).toBeGreaterThan(10);
    expect(feed.map((f) => f.id)).toEqual([...feed.map((f) => f.id)].sort((m, n) => m - n));
    const seen = new Set(feed.map((f) => f.event));
    for (const e of ["proposed", "challenge_issued", "assertion_rejected", "authorized", "published", "revised", "credential_enrolled", "credential_revoked", "freeze_set", "freeze_lifted"]) expect(seen.has(e), e).toBe(true);
    expect(JSON.parse(psql(`select public.tw4_price_audit_feed(${feed[feed.length - 1].id}, 10)::text`))).toEqual([]);
    for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', 'public.tw4_price_audit_feed(bigint,integer)', 'execute')`)).toBe("f");
    expect(psql(`select has_function_privilege('service_role', 'public.tw4_price_audit_feed(bigint,integer)', 'execute')`)).toBe("t");
  });

  it("PA-13 the verifier covers owner-mode prices: clean after genuine ceremonies; an owner-mode price whose hardware-key evidence was tampered with is flagged; the limits stay unapproved and unenforced", () => {
    expect(JSON.parse(psql(`select public.tw4_price_verify()::text`))).toMatchObject({ ok: true });
    const forged = psql(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      update public.studio_sms_price_change_requests set auth_nonce = decode(repeat('ab', 32), 'hex') where id = (select id from public.studio_sms_price_change_requests where approval_mode = 'owner' and status = 'applied' limit 1);
      select public.tw4_price_verify()::text; rollback;`).split(NL).filter((l) => l.startsWith("{")).pop()!;
    expect(JSON.parse(forged).ok).toBe(false);
    expect(psql(`select count(*) || ':' || count(*) filter (where approved) from public.studio_sms_price_limits`)).toBe("8:0");
  });

  it("PA-14 team mode is kept: with the protected mode set to team by an owner-level migration step, two distinct registered administrators still work with no cooling-off and no hardware key; owner-mode rows stay unaffected", () => {
    clear();
    setConfig("mode = 'team'");
    try {
      const p = propose(claims(A, S1), 340);
      expect(p).toMatchObject({ mode: "team", cooling_until: null });
      expect(codeOf(authErr(claims(A, S2), `select public.tw4_price_approve('${p.request_id}', 'a long enough approval note')::text;`))).toBe("42501"); // own proposal
      expect(authOut(claims(B, "d42-b2"), `select public.tw4_price_approve('${p.request_id}', 'a long enough approval note')::text;`)).toMatchObject({ status: "applied" });
      expect(active()[0]).toMatchObject({ customer_price_cents: 340, created_by: B });
      expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("TW042"); // not an owner-mode proposal
    } finally {
      setConfig("mode = 'single_owner'");
    }
    expect(psql(`select mode from public.studio_sms_price_auth_config`)).toBe("single_owner");
  });

  it("PA-15 rollback of 20270204100000 is fail closed: it refuses while owner-mode evidence exists; with the evidence removed (visibly, by the owner) it returns the schema to the 20270204090000 bodies, and re-applying restores everything", () => {
    const rb = strip(migration("rollback/20270204100000_twilio_price_owner_authorization_rollback.sql"));
    const fwd = strip(migration("20270204100000_twilio_price_owner_authorization.sql"));
    expect(codeOf(psqlError(`begin; ${rb} rollback;`))).toBe("55000");
    const m1 = migration("20270204090000_twilio_price_dual_control.sql");
    const body = (name: string) => {
      const i = m1.indexOf(`create or replace function public.${name}(`);
      const a = m1.indexOf("as $$", i) + 5;
      return m1.slice(a, m1.indexOf("$$;", a));
    };
    const md5 = (s: string) => createHash("md5").update(s.replace(/\r/g, "")).digest("hex");
    const clearEvidence = `
      alter table public.studio_sms_price_audit disable trigger studio_sms_price_audit_guard; delete from public.studio_sms_price_audit;
      alter table public.studio_sms_price_auth_challenges disable trigger studio_sms_price_auth_challenges_guard; delete from public.studio_sms_price_auth_challenges;
      alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; delete from public.studio_sms_price_credentials;
      alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard; delete from public.studio_sms_price_change_requests where approval_mode = 'owner';`;
    const err = psqlError(`begin; ${clearEvidence} ${rb}
      do $t$ begin
        if to_regclass('public.studio_sms_price_auth_config') is not null then raise exception 'RB: config remains'; end if;
        if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public._tw4price_do_approve(uuid,uuid,text)'::regprocedure) <> '${md5(body("_tw4price_do_approve"))}' then raise exception 'RB: do_approve not restored'; end if;
        if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public._tw4price_activation_guard()'::regprocedure) <> '${md5(body("_tw4price_activation_guard"))}' then raise exception 'RB: activation guard not restored'; end if;
        if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.tw4_price_propose(text,integer,integer,text,text)'::regprocedure) <> '${md5(body("tw4_price_propose"))}' then raise exception 'RB: propose not restored'; end if;
        if to_regprocedure('public.tw4_price_authz_finish(uuid,text,text,text,text,text)') is not null then raise exception 'RB: authz remains'; end if;
      end $t$;
      ${fwd}
      do $t$ begin
        if to_regclass('public.studio_sms_price_auth_config') is null or to_regprocedure('public.tw4_price_authz_finish(uuid,text,text,text,text,text)') is null then raise exception 'RA: not re-applied'; end if;
        if (select mode from public.studio_sms_price_auth_config) <> 'single_owner' then raise exception 'RA: mode'; end if;
      end $t$;
      rollback;`);
    expect(err).toBe("");
    expect(psql(`select to_regclass('public.studio_sms_price_auth_config') is not null`)).toBe("t");
  });

  it("PA-16 monitoring interface: security events are emitted into studio_sms_price_security_events when that table exists (no secrets), and a LATEST pricing_suspended event suspends propose, approve and authorize until a pricing_resumed", () => {
    clear();
    // the table belongs to the monitoring migration (20270205090000); a minimal stand-in with the same columns proves the conditional emit
    psql(`create table public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb)`);
    try {
      const kinds = () => rows<{ kind: string }>("select kind from public.studio_sms_price_security_events order by seq").map((r) => r.kind);
      // registry changes
      const u = psql("select gen_random_uuid()");
      psql(registerApproverSql(u, "registered in the monitoring interface test"));
      psql(`update public.studio_sms_price_approvers set revoked_at = now(), revoked_note = 'revoked in the monitoring interface test' where user_id = '${u}'`);
      expect(kinds()).toEqual(["approver_added", "approver_registry_changed", "approver_removed", "approver_registry_changed"]);
      // freeze, compromise report, thaw (hardware key), credential changes
      expect(authOut(claims(B, "d42-b3"), `select public.tw4_price_report_compromise('a suspected compromise reported in the test')::text;`)).toMatchObject({ status: "frozen" });
      expect(kinds().slice(4)).toEqual(["pricing_suspended", "credential_compromise_reported"]);
      const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
      const a = K2.assert(tb.challenge);
      expect(authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`).status).toBe("thawed");
      expect(kinds().slice(-1)).toEqual(["pricing_resumed"]);
      // no secrets: details carry no credential ids, keys, challenges or tokens
      const text = JSON.stringify(rows("select detail from public.studio_sms_price_security_events"));
      for (const secret of [K1.credIdB64u, K2.credIdB64u, b64u(K2.x), tb.nonce, tb.challenge]) expect(text.includes(secret)).toBe(false);
      // a monitoring-side suspension (the latest event) suspends every publication path, whatever the local freeze flag says
      psql("insert into public.studio_sms_price_security_events (kind, detail) values ('pricing_suspended', '{\"by\": \"monitor\"}')");
      expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("f");
      expect(codeOf(authErr(claims(A, S1), `select public.tw4_price_propose('number', 411, 115, 'suspended proposal', 'a written reason while suspended')::text;`))).toBe("42501");
      expect(codeOf(psqlError("select public._tw4price_do_propose('number', 412, 115, 'suspended proposal', 'a written reason while suspended', '" + A + "')"))).toBe("42501");
      setConfig("mode = 'single_owner'");
      // an already open proposal cannot be authorized either
      psql("insert into public.studio_sms_price_security_events (kind) values ('pricing_resumed')");
      const p = propose(claims(A, S1), 413);
      ready(p.request_id);
      const b = begin(claims(A, S2), p.request_id);
      psql("insert into public.studio_sms_price_security_events (kind) values ('pricing_suspended')");
      expect(codeOf(finishErr(claims(A, S2), p.request_id, b.nonce, K3.assert(b.challenge)))).toBe("42501");
      expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("42501");
      psql("insert into public.studio_sms_price_security_events (kind) values ('pricing_resumed')");
      expect(finish(claims(A, S2), p.request_id, b.nonce, K3.assert(b.challenge)).status).toBe("applied");
      // the verifier interface is unchanged
      const v = JSON.parse(psql("select public.tw4_price_verify()::text")) as { ok: boolean; anomalies: unknown[]; checked_at: string };
      expect(Object.keys(v).sort()).toEqual(["anomalies", "checked_at", "ok"]);
    } finally {
      psql("drop table public.studio_sms_price_security_events");
    }
  });
});
