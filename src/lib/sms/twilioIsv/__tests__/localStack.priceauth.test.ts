/**
 * D4-2: single-owner high-assurance price authorization (migration 20270204100000) on a throwaway DEV-equivalent database. The WebAuthn assertions come from a SOFTWARE
 * authenticator (P-256 test keys, webauthnFixture.ts) and are verified INSIDE Postgres. Sessions are simulated with verified-claims JSON (role authenticated, aal2, TOTP,
 * session_id) exactly as PostgREST hands them to the database; the real-GoTrue variants live in localStack.pricedual.realtokens.
 * LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB and the tw4_local_qa_only marker.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
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
/** run one statement as a session; a registered administrator's REFUSAL comes back as a recorded {status: 'refused'} answer and is rendered like an error text so that codeOf() reads its SQLSTATE */
function tryAuth(c: Record<string, unknown> | null, sql: string): { err: string; out: Record<string, never> | null } {
  try {
    const out = execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: `${String.fromCharCode(92)}set VERBOSITY verbose${NL}${asAuth(c, sql)}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { err: "", out: JSON.parse(out.trim().split(NL).pop()!) as Record<string, never> };
  } catch (e) {
    return { err: String((e as { stderr?: Buffer | string }).stderr ?? e), out: null };
  }
}
const refusalText = (r: { err: string; out: Record<string, never> | null }): string => ((r.out as Record<string, unknown> | null)?.status === "refused" ? `ERROR:  ${String((r.out as Record<string, unknown>).code)}: ${String((r.out as Record<string, unknown>).reason)}` : r.err);
const beginErr = (c: Record<string, unknown> | null, id: string) => refusalText(tryAuth(c, `select public.tw4_price_authz_begin('${id}')::text;`));
const finishSql = (id: string, nonce: string, a: Assertion) => `select public.tw4_price_authz_finish('${id}', '${nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`;
const finish = (c: Record<string, unknown>, id: string, nonce: string, a: Assertion) => authOut(c, finishSql(id, nonce, a));
const finishErr = (c: Record<string, unknown> | null, id: string, nonce: string, a: Assertion) => refusalText(tryAuth(c, finishSql(id, nonce, a)));
/** owner-level, visible: a pending credential change whose delay has passed */
const ageChange = (id: string) => psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; update public.studio_sms_price_credential_changes set requested_at = requested_at - interval '25 hours', effective_at = effective_at - interval '25 hours' where id = '${id}'; alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
const sessionRun = (sql: string): Promise<{ out: string; code: number | null }> =>
  new Promise((resolve) => {
    const pr = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    pr.stdout.on("data", (d) => (out += d));
    pr.stderr.on("data", (d) => (out += d));
    pr.on("close", (code) => resolve({ out, code }));
    pr.stdin.end(sql);
  });
/** cancel a pending credential change: a hardware-key act (begin the cancel ceremony, sign, submit) */
const cancelBegin = (c: Record<string, unknown>, changeId: string) => authOut(c, `select public.tw4_price_cred_begin('cancel', null, null, null, null, '${changeId}')::text;`);
const cancelSubmit = (c: Record<string, unknown>, changeId: string, nonce: string, a: Assertion) =>
  authOut(c, `select public.tw4_price_cred_cancel('${changeId}', '${nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
const cancelWith = (c: Record<string, unknown>, changeId: string, by: SoftAuthenticator) => {
  const cb = cancelBegin(c, changeId);
  return cancelSubmit(c, changeId, cb.nonce, by.assert(cb.challenge));
};
/** owner-level and visible: the credential registry becomes exactly these keys (the first primary, the rest spares), enrolled long ago, with no pending changes */
const resetCreds = (...items: (SoftAuthenticator | [SoftAuthenticator, string])[]) => {
  const ks = items.map((x) => (Array.isArray(x) ? x : ([x, null] as [SoftAuthenticator, string | null])));
  return resetCredsInner(ks);
};
const resetCredsInner = (ks: [SoftAuthenticator, string | null][]) =>
  psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard;
    delete from public.studio_sms_price_credential_changes; delete from public.studio_sms_price_credentials; set local tw4.priceauth_write = 'on';
    ${ks.map(([k, role], i) => `insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via, enrolled_at) values (decode('${k.hex.cred}', 'hex'), decode('${k.hex.x}', 'hex'), decode('${k.hex.y}', 'hex'), '${role ?? (i === 0 ? "primary" : "spare")}', 'reset key ${i + 1}', 'bootstrap', now() - interval '400 hours');`).join(" ")}
    alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
const enrollReq = (c: Record<string, unknown>, by: SoftAuthenticator, nw: SoftAuthenticator, label: string, role = "spare") => {
  const eb = authOut(c, `select public.tw4_price_cred_begin('enroll', '${nw.credIdB64u}', '${b64u(nw.x)}', '${b64u(nw.y)}', '${role}', '${label}')::text;`);
  const a = by.assert(eb.challenge);
  const m = nw.assert(eb.challenge);
  return authOut(c, `select public.tw4_price_cred_enroll('${eb.nonce}', '${nw.credIdB64u}', '${b64u(nw.x)}', '${b64u(nw.y)}', '${role}', '${label}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}', '${m.auth}', '${m.client}', '${m.sig}')::text;`);
};
const revokeReq = (c: Record<string, unknown>, by: SoftAuthenticator, target: SoftAuthenticator) => {
  const bb = authOut(c, `select public.tw4_price_cred_begin('revoke', '${target.credIdB64u}', null, null, null, null)::text;`);
  const a = by.assert(bb.challenge);
  return authOut(c, `select public.tw4_price_cred_revoke('${bb.nonce}', '${target.credIdB64u}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
};
const applyChange = (c: Record<string, unknown>, id: string) => authOut(c, `select public.tw4_price_cred_apply('${id}')::text;`);
const thawWith = (c: Record<string, unknown>, k: SoftAuthenticator) => {
  const tb = authOut(c, `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
  const a = k.assert(tb.challenge);
  return { tb, out: authOut(c, `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`) };
};
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
      ["backup-eligible (synced) credential", K1.assert(b.challenge, { flags: 0x0d })],
      ["backed-up credential", K1.assert(b.challenge, { flags: 0x1d })],
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
    expect(audit("assertion_rejected") + audit("integrity_failure")).toBeGreaterThanOrEqual(bad.length);
    expect(audit("integrity_failure")).toBeGreaterThanOrEqual(1);
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

  it("PA-09 credential changes are PENDING for a mandatory delay (visible, audited, cancellable) and never instant: an attacker with a perfect session cannot add, replace or revoke a credential; the legitimate ceremony works after the delay; aliasing, backup-eligible keys, foreign challenges and the last-credential rule are enforced", () => {
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
    expect(enroll(sess, KX, "spare", "second test key", b.nonce, K1.assert(b.challenge), KX.assert(b.challenge)).status).toBe("rejected");
    expect(enroll(sess, K2, "primary", "second test key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge)).status).toBe("rejected");
    expect(enroll(sess, K2, "spare", "renamed key x", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge)).status).toBe("rejected");
    // a challenge issued to ANOTHER session cannot be used (enrol, revoke and thaw check the issuing user and session, not only authorize)
    expect(enroll(claims(A, "d42-other-session"), K2, "spare", "second test key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge)).status).toBe("rejected");
    // a backup-eligible (synced) credential is not accepted as the existing signer nor as the new key
    expect(enroll(sess, K2, "spare", "second test key", b.nonce, K1.assert(b.challenge, { flags: 0x0d }), K2.assert(b.challenge)).status).toBe("rejected");
    expect(enroll(sess, K2, "spare", "second test key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge, { flags: 0x1d })).status).toBe("rejected");
    expect(num(`select count(*) from public.studio_sms_price_credentials`)).toBe(1);
    // direct writes
    expect(psqlError(`insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${KX.hex.cred}', 'hex'), decode('${KX.hex.x}', 'hex'), decode('${KX.hex.y}', 'hex'), 'spare', 'direct insert', 'assertion')`))
      .toMatch(/written only by the price authorization functions/);
    expect(psqlError(`begin; set local session_replication_role = replica; insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${KX.hex.cred}', 'hex'), decode('${KX.hex.x}', 'hex'), decode('${KX.hex.y}', 'hex'), 'spare', 'direct insert', 'assertion'); rollback;`))
      .toMatch(/written only by the price authorization functions/);
    // the legitimate request: PENDING, not active
    const req2 = enroll(sess, K2, "spare", "second test key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge));
    expect(req2).toMatchObject({ status: "pending", effective_in_hours: 24 });
    expect(num(`select count(*) from public.studio_sms_price_credentials`)).toBe(1);
    expect(audit("credential_change_pending")).toBe(1);
    // the pending change is visible; it cannot be applied early; replaying the same challenge does nothing
    const pend = authOut(sess, `select public.tw4_price_cred_pending()::text;`) as unknown as { pending: { change_id: string; kind: string }[] };
    expect(pend.pending.map((p) => p.kind)).toEqual(["enroll"]);
    expect(codeOf(authErr(sess, `select public.tw4_price_cred_apply('${req2.change_id}')::text;`))).toBe("TW045");
    expect(enroll(sess, K2, "spare", "second test key", b.nonce, K1.assert(b.challenge), K2.assert(b.challenge)).status).toBe("rejected");
    // the pending enrolment of a key that is ALREADY registered under another id (aliasing) is refused at the possession proof
    const alias = new SoftAuthenticator(K1);
    const ab = enrollBegin(sess, alias, "spare", "alias of the primary");
    expect(enroll(sess, alias, "spare", "alias of the primary", ab.nonce, K1.assert(ab.challenge), alias.assert(ab.challenge)).status).toBe("rejected");
    // a cancelled change never applies
    const cb = enrollBegin(sess, K3, "spare", "new cancelled key");
    const cp = enroll(sess, K3, "spare", "new cancelled key", cb.nonce, K1.assert(cb.challenge), K3.assert(cb.challenge));
    expect(cp.status).toBe("pending");
    // cancelling is a hardware-key act (a bare session cannot do it); a different registered session with the key can
    expect(cancelWith(claims(B, "d42-b-cancel"), cp.change_id, K1)).toMatchObject({ status: "cancelled" });
    ageChange(cp.change_id);
    expect(codeOf(authErr(sess, `select public.tw4_price_cred_apply('${cp.change_id}')::text;`))).toBe("TW041");
    expect(audit("credential_change_cancelled")).toBe(1);
    // the delay passes: the change applies (and only then the spare can sign)
    clear();
    const p0 = propose(claims(A, S1), 309);
    ready(p0.request_id);
    const b0 = begin(claims(A, S2), p0.request_id);
    expect(finish(claims(A, S2), p0.request_id, b0.nonce, K2.assert(b0.challenge)).status).toBe("rejected"); // K2 is only pending
    ageChange(req2.change_id);
    expect(authOut(sess, `select public.tw4_price_cred_apply('${req2.change_id}')::text;`)).toMatchObject({ status: "applied" });
    expect(psql(`select count(*) filter (where status = 'active') || ':' || count(*) filter (where role = 'spare') from public.studio_sms_price_credentials`)).toBe("2:1");
    expect(audit("credential_change_applied")).toBe(1);
    expect(authorize(310, K2).out.status).toBe("applied");
    // revocation: a credential cannot revoke itself, an outsider key cannot revoke, the last one is protected, and a revocation is IMMEDIATE
    const rv = (c: Record<string, unknown>, target: SoftAuthenticator, by: SoftAuthenticator, tamper = false) => {
      const bb = authOut(c, `select public.tw4_price_cred_begin('revoke', '${target.credIdB64u}', null, null, null, null)::text;`);
      const a = by.assert(bb.challenge);
      return authOut(c, `select public.tw4_price_cred_revoke('${bb.nonce}', '${(tamper ? K2 : target).credIdB64u}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
    };
    expect(rv(sess, K1, K1).status).toBe("rejected");
    expect(rv(sess, K1, KX).status).toBe("rejected");
    expect(rv(sess, K1, K2, true).status).toBe("rejected"); // signed for K1's revocation, submitted for K2's
    clear();
    const pk = propose(claims(A, S1), 311);
    ready(pk.request_id);
    const bk = begin(claims(A, S2), pk.request_id);
    expect([...bk.allow_credentials].sort()).toEqual([K1.credIdB64u, K2.credIdB64u].sort());
    // the revocation is IMMEDIATE: no pending state, no delay
    const rr = rv(sess, K1, K2);
    expect(rr).toMatchObject({ status: "revoked" });
    expect(psql(`select count(*) from public.studio_sms_price_credentials where status = 'active'`)).toBe("1");
    expect(audit("credential_revoked")).toBe(1);
    expect(authErr(sess, `select public.tw4_price_cred_begin('revoke', '${K2.credIdB64u}', null, null, null, null)::text;`)).toMatch(/other active signing credential/);
    // the revoked primary can no longer sign anything (its challenge, issued before the revocation, is useless)
    expect(finish(claims(A, S2), pk.request_id, bk.nonce, K1.assert(bk.challenge)).status).toBe("rejected");
    expect(finish(claims(A, S2), pk.request_id, bk.nonce, K2.assert(bk.challenge)).status).toBe("applied");
    // a replacement primary after the old one is gone: signed by the spare, pending, then applied
    const eb = enrollBegin(sess, K3, "primary", "new primary key");
    const ep = enroll(sess, K3, "primary", "new primary key", eb.nonce, K2.assert(eb.challenge), K3.assert(eb.challenge));
    expect(ep.status).toBe("pending");
    ageChange(ep.change_id);
    expect(authOut(sess, `select public.tw4_price_cred_apply('${ep.change_id}')::text;`)).toMatchObject({ status: "applied" });
    expect(num(`select count(*) from public.studio_sms_price_credentials where status = 'active'`)).toBe(2);
    // one record per key
    expect(psqlError(`begin; set local tw4.priceauth_write = 'on'; insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (decode('${alias.hex.cred}', 'hex'), decode('${alias.hex.x}', 'hex'), decode('${alias.hex.y}', 'hex'), 'spare', 'alias insert', 'assertion'); rollback;`)).toMatch(/studio_sms_price_credentials_key|duplicate key/);
  });

  it("PA-10 emergency freeze: any registered administrator session can only SUSPEND publication; with it frozen nothing can be published by any path and credential changes do not apply; lifting it needs the hardware key of a credential that PREDATES the freeze", () => {
    clear();
    const p = propose(claims(A, S1), 320);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    // an unauthenticated-grade caller cannot freeze; a registered aal2 session can (suspension is the safe direction)
    expect(codeOf(authErr(claims(A, S2, { aal: "aal1" }), `select public.tw4_price_freeze('a written freeze reason for the test')::text;`))).toBe("42501");
    expect(authOut(claims(B, "d42-b"), `select public.tw4_price_freeze('a written freeze reason for the test')::text;`)).toMatchObject({ status: "frozen" });
    expect(audit("freeze_set")).toBe(1);
    const before = active();
    // frozen: the valid assertion, a new challenge and a direct price insert all fail
    expect(codeOf(finishErr(claims(A, S2), p.request_id, b.nonce, K2.assert(b.challenge)))).toBe("42501");
    expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("42501");
    expect(active()).toEqual(before);
    expect(psql(`select count(*) from public.studio_sms_price_list where created_by = '${B}' and customer_price_cents = 320`)).toBe("0");
    // the freeze survives credential changes: a change can be requested but is NOT applied while frozen
    const eb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('enroll', '${KX.credIdB64u}', '${b64u(KX.x)}', '${b64u(KX.y)}', 'spare', 'a key added during the freeze')::text;`);
    const ea = K2.assert(eb.challenge);
    const ma = KX.assert(eb.challenge);
    const er = authOut(claims(A, S2), `select public.tw4_price_cred_enroll('${eb.nonce}', '${KX.credIdB64u}', '${b64u(KX.x)}', '${b64u(KX.y)}', 'spare', 'a key added during the freeze', '${ea.credId}', '${ea.auth}', '${ea.client}', '${ea.sig}', '${ma.auth}', '${ma.client}', '${ma.sig}')::text;`);
    expect(er.status).toBe("pending");
    ageChange(er.change_id);
    expect(codeOf(authErr(claims(A, S2), `select public.tw4_price_cred_apply('${er.change_id}')::text;`))).toBe("42501");
    expect(cancelWith(claims(A, S2), er.change_id, K2)).toMatchObject({ status: "cancelled" });
    // lifting: garbage or a wrong key does nothing; a credential enrolled AFTER the freeze cannot lift it; a predating one does
    const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
    const thaw = (a: Assertion) => authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`);
    expect(thaw(KX.assert(tb.challenge)).status).toBe("rejected");
    expect(psql(`select frozen from public.studio_sms_price_auth_config`)).toBe("t");
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set enrolled_at = now() + interval '1 second' where credential_id = decode('${K3.hex.cred}', 'hex'); alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
    expect(thaw(K3.assert(tb.challenge))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/BEFORE the suspension/) });
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set enrolled_at = now() - interval '30 hours' where credential_id = decode('${K3.hex.cred}', 'hex'); alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
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
    // the loser is a RECORDED refusal (an answer, committed to the audit), not a silent rollback
    expect(y.out).toContain('"status": "refused"');
    expect(y.out).toContain('"code": "TW041"');
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
    for (const e of ["proposed", "challenge_issued", "assertion_rejected", "authorized", "published", "revised", "credential_change_pending", "credential_change_applied", "freeze_set", "freeze_lifted"]) expect(seen.has(e), e).toBe(true);
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
      alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; delete from public.studio_sms_price_credential_changes;
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

  it("PA-16 monitoring interface: security events are emitted into studio_sms_price_security_events when that table exists (no secrets); a monitoring suspension is lifted ONLY by this schema's hardware-key thaw (a pricing_resumed row in the events table lifts nothing); the second channel carries the fingerprint; emit fails loudly once monitoring is expected", () => {
    clear();
    // the table belongs to the monitoring migration (20270205090000); a minimal stand-in with the same columns proves the conditional emit
    psql(`create table public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb, recorded_at timestamptz not null default clock_timestamp())`);
    try {
      const kinds = () => rows<{ kind: string }>("select kind from public.studio_sms_price_security_events order by seq").map((r) => r.kind);
      // registry changes
      const u = psql("select gen_random_uuid()");
      psql(registerApproverSql(u, "registered in the monitoring interface test"));
      psql(`update public.studio_sms_price_approvers set revoked_at = now(), revoked_note = 'revoked in the monitoring interface test' where user_id = '${u}'`);
      expect(kinds()).toEqual(["approver_added", "approver_registry_changed", "approver_removed", "approver_registry_changed"]);
      // compromise report -> suspension; thaw with a credential that predates it
      expect(authOut(claims(B, "d42-b3"), `select public.tw4_price_report_compromise('a suspected compromise reported in the test')::text;`)).toMatchObject({ status: "frozen" });
      expect(kinds().slice(4)).toEqual(["pricing_suspended", "credential_compromise_reported"]);
      const thawNow = (k: SoftAuthenticator) => {
        const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
        const a = k.assert(tb.challenge);
        return { out: authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`), tb };
      };
      const t1 = thawNow(K2);
      expect(t1.out.status).toBe("thawed");
      expect(kinds().slice(-1)).toEqual(["pricing_resumed"]);
      // no secrets: details carry no credential ids, keys, challenges or tokens
      const text = JSON.stringify(rows("select detail from public.studio_sms_price_security_events"));
      for (const secret of [K1.credIdB64u, K2.credIdB64u, b64u(K2.x), t1.tb.nonce, t1.tb.challenge]) expect(text.includes(secret)).toBe(false);
      // a monitoring-side suspension suspends every publication path although the local freeze flag is off
      psql("insert into public.studio_sms_price_security_events (kind, detail) values ('pricing_suspended', '{\"by\": \"monitor\"}')");
      expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("f");
      expect(codeOf(authErr(claims(A, S1), `select public.tw4_price_propose('number', 411, 115, 'suspended proposal', 'a written reason while suspended')::text;`))).toBe("42501");
      expect(codeOf(psqlError("select public._tw4price_do_propose('number', 412, 115, 'suspended proposal', 'a written reason while suspended', '" + A + "')"))).toBe("42501");
      // a pricing_resumed row in the monitoring table (written by anyone with insert there) lifts NOTHING
      psql("insert into public.studio_sms_price_security_events (kind) values ('pricing_resumed')");
      expect(codeOf(authErr(claims(A, S1), `select public.tw4_price_propose('number', 411, 115, 'suspended proposal', 'a written reason while suspended')::text;`))).toBe("42501");
      // the defined lift path: the hardware-key thaw (it works for a monitoring suspension too)
      expect(thawNow(K3).out.status).toBe("thawed");
      const pr = propose(claims(A, S1), 413);
      ready(pr.request_id);
      const b = begin(claims(A, S2), pr.request_id);
      // the second channel: the monitoring feed carries the fingerprint and values of what is about to be signed
      const started = rows<{ detail: { fingerprint: string; new_customer_cents: number; kind: string } }>("select detail from public.studio_sms_price_security_events where kind = 'price_authorization_started' order by seq desc limit 1")[0];
      expect(started.detail).toMatchObject({ fingerprint: String((b.summary as Record<string, unknown>).hash).slice(0, 16), new_customer_cents: 413, kind: "number" });
      // a suspension that arrives after the challenge blocks the finish
      psql("insert into public.studio_sms_price_security_events (kind) values ('pricing_suspended')");
      expect(codeOf(finishErr(claims(A, S2), pr.request_id, b.nonce, K3.assert(b.challenge)))).toBe("42501");
      expect(thawNow(K3).out.status).toBe("thawed");
      expect(finish(claims(A, S2), pr.request_id, b.nonce, K3.assert(b.challenge)).status).toBe("applied");
      // the verifier interface is unchanged
      const v = JSON.parse(psql("select public.tw4_price_verify()::text")) as { ok: boolean; anomalies: unknown[]; checked_at: string };
      expect(Object.keys(v).sort()).toEqual(["anomalies", "checked_at", "ok"]);
      // once monitoring is expected, a MISSING events table is a loud failure (no silent no-op)
      psql("drop table public.studio_sms_price_security_events");
      setConfig("monitoring_expected = true");
      try {
        // the safe-direction action is NOT blocked by the outage; the failed emit is itself recorded in the immutable audit
        expect(authOut(claims(B, "d42-b4"), `select public.tw4_price_freeze('a freeze while the monitoring table is missing')::text;`)).toMatchObject({ status: "frozen" });
        expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("t");
        expect(audit("emit_failed")).toBeGreaterThanOrEqual(1);
        expect(thawWith(claims(A, S2), K3).out.status).toBe("thawed");
      } finally {
        setConfig("monitoring_expected = false");
      }
    } finally {
      psql("drop table if exists public.studio_sms_price_security_events");
    }
  });

  it("PA-17 refusals are AUDITED independent of any other table: a refused gate (cooling-off, same session, wrong owner, frozen) and a rejected assertion are committed to the immutable audit; a sign counter that did not increase is an integrity failure", () => {
    clear();
    const gates = () => audit("gate_refused");
    const g0 = gates();
    const p = propose(claims(A, S1), 420);
    expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("TW045"); // cooling-off
    ready(p.request_id);
    expect(codeOf(beginErr(claims(A, S1), p.request_id))).toBe("42501"); // the proposing session
    expect(codeOf(beginErr(claims(B, S2), p.request_id))).toBe("42501"); // not the owner who proposed
    expect(gates() - g0).toBe(3);
    const last = rows<{ detail: { code: string; step: string } }>("select detail from public.studio_sms_price_audit where event = 'gate_refused' order by id desc limit 1")[0];
    expect(last.detail).toMatchObject({ code: "42501", step: "begin" });
    const b = begin(claims(A, S2), p.request_id);
    const bad = finish(claims(A, S2), p.request_id, b.nonce, KX.assert(b.challenge));
    expect(bad.status).toBe("rejected");
    const rej = audit("assertion_rejected");
    const dbCounter = num(`select sign_count from public.studio_sms_price_credentials where credential_id = decode('${K3.hex.cred}', 'hex')`);
    const replay = finish(claims(A, S2), p.request_id, b.nonce, K3.assert(b.challenge, { counter: Math.max(1, dbCounter) }));
    expect(replay.status).toBe("rejected");
    expect(audit("integrity_failure")).toBeGreaterThanOrEqual(1);
    expect(audit("assertion_rejected")).toBe(rej);
    // all of it is readable through the monitoring feed
    const feed = JSON.parse(psql(`select public.tw4_price_audit_feed(0, 1000)::text`)) as { event: string }[];
    for (const e of ["gate_refused", "assertion_rejected", "integrity_failure", "challenge_issued"]) expect(feed.some((f) => f.event === e), e).toBe(true);
    clear();
  });

  it("PA-18 a revocation is IMMEDIATE and FINAL: the target is unusable for pricing and credential management in the same transaction, what it signed is void, there is no cancel and no un-revoke (session, other key, service_role all fail), the last signing credential is protected, and a mistaken revocation is repaired only by a new enrolment", () => {
    clear();
    const Ka = new SoftAuthenticator();
    const Kb = new SoftAuthenticator();
    const Kn = new SoftAuthenticator();
    resetCreds(Ka, Kb);
    const sess = claims(A, S2);
    // Kb signs a pending enrolment; then Ka revokes Kb
    const pn = enrollReq(sess, Kb, Kn, "pending by kb");
    expect(pn.status).toBe("pending");
    const pc = propose(claims(A, S1), 461);
    ready(pc.request_id);
    const bc = begin(claims(A, S2), pc.request_id);
    expect([...bc.allow_credentials].sort()).toEqual([Ka.credIdB64u, Kb.credIdB64u].sort());
    const failedBefore = audit("assertion_rejected");
    const rv = revokeReq(sess, Ka, Kb);
    expect(rv).toMatchObject({ status: "revoked", voided_changes: 1 });
    expect(audit("credential_revoked")).toBe(1);
    expect(psql(`select status from public.studio_sms_price_credentials where credential_id = decode('${Kb.hex.cred}', 'hex')`)).toBe("revoked");
    expect(psql(`select status from public.studio_sms_price_credential_changes where id = '${pn.change_id}'`)).toBe("cancelled"); // what the revoked key signed is void
    // IMMEDIATELY unusable: it cannot sign an already issued challenge, a new ceremony, an enrolment, a revocation or a cancel
    expect(finish(claims(A, S2), pc.request_id, bc.nonce, Kb.assert(bc.challenge))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/revoked credential/) });
    const bn = begin(claims(A, S2), pc.request_id);
    expect(bn.allow_credentials).toEqual([Ka.credIdB64u]);
    expect(enrollReq(sess, Kb, new SoftAuthenticator(), "signed by the revoked")).toMatchObject({ status: "rejected" });
    expect(audit("assertion_rejected")).toBeGreaterThan(failedBefore);
    expect(codeOf(authErr(sess, `select public.tw4_price_cred_apply('${pn.change_id}')::text;`))).toBe("TW041");
    // the last signing credential cannot be revoked; a credential cannot revoke itself
    expect(codeOf(authErr(sess, `select public.tw4_price_cred_begin('revoke', '${Ka.credIdB64u}', null, null, null, null)::text;`))).toBe("22023");
    // NO cancel and NO un-revoke: a session alone, any other key, service_role and anon all fail
    expect(codeOf(authErr(sess, `select public.tw4_price_cred_cancel('${pn.change_id}')::text;`))).toBe("42883"); // the session-only form does not exist
    for (const role of ["service_role", "anon"]) {
      expect(codeOf(psqlError(`begin; set local role ${role}; select public.tw4_price_cred_revoke('AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA'); commit;`)), role).toBe("42501");
      expect(codeOf(psqlError(`begin; set local role ${role}; select public.tw4_price_cred_cancel(gen_random_uuid(), 'AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA'); commit;`)), role).toBe("42501");
    }
    expect(codeOf(psqlError(`begin; set local tw4.priceauth_write = 'on'; update public.studio_sms_price_credentials set status = 'active', revoked_at = null where credential_id = decode('${Kb.hex.cred}', 'hex'); commit;`))).toBe("42501");
    expect(codeOf(psqlError(`insert into public.studio_sms_price_credential_changes (kind, target_credential_id, authorized_by_credential_id, requested_by, effective_at) values ('revoke', decode('${Ka.hex.cred}', 'hex'), decode('${Kb.hex.cred}', 'hex'), '${A}', now() + interval '25 hours')`))).not.toBe("");
    // the mistaken revocation is repaired only by a NEW enrolment from a remaining key (the same public key can never come back)
    expect(enrollReq(sess, Ka, Kb, "same key again")).toMatchObject({ status: "rejected" });
    const kb2 = new SoftAuthenticator();
    const re = enrollReq(sess, Ka, kb2, "replacement spare");
    expect(re.status).toBe("pending");
    expect(num("select count(*) from public.studio_sms_price_credentials where status = 'active'")).toBe(1);
    ageChange(re.change_id);
    expect(applyChange(sess, re.change_id)).toMatchObject({ status: "applied" });
    expect(num("select count(*) from public.studio_sms_price_credentials where status = 'active'")).toBe(2);
  });

  it("PA-21 races with a revocation: an apply that waits behind a revocation is VOID, and a publication signed by the credential being revoked is refused (credential lock ordering, concurrent sessions)", async () => {
    clear();
    const Ka = new SoftAuthenticator();
    const Kb = new SoftAuthenticator();
    const Kn = new SoftAuthenticator();
    resetCreds(Ka, Kb);
    const sess = claims(A, S2);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const revokeSql = (by: SoftAuthenticator, target: SoftAuthenticator) => {
      const bb = authOut(sess, `select public.tw4_price_cred_begin('revoke', '${target.credIdB64u}', null, null, null, null)::text;`);
      const a = by.assert(bb.challenge);
      return `select public.tw4_price_cred_revoke('${bb.nonce}', '${target.credIdB64u}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`;
    };
    // (1) apply vs revoke: the revocation commits first (held open by a sleep), the apply waits for the credential lock and then finds its signer revoked
    const pn = enrollReq(sess, Kb, Kn, "pending by kb");
    ageChange(pn.change_id);
    const s1 = sessionRun(asAuth(sess, revokeSql(Ka, Kb)).replace("commit;", "select pg_sleep(3.43); commit;"));
    for (let i = 0; i < 80 && psql(`select count(*) from pg_stat_activity where datname = '${DB}' and query like '%pg_sleep(3.43)%' and wait_event = 'PgSleep'`) !== "1"; i++) await sleep(150);
    const s2 = sessionRun(asAuth(sess, `select public.tw4_price_cred_apply('${pn.change_id}')::text;`));
    const [x, y] = await Promise.all([s1, s2]);
    expect(x.out).toContain('"status": "revoked"');
    expect(y.out).toContain('"status": "voided"');
    expect(num(`select count(*) from public.studio_sms_price_credentials where credential_id = decode('${Kn.hex.cred}', 'hex')`)).toBe(0);
    // (2) publication signed by the credential being revoked: the finish waits on the credential row and is refused once the revocation commits
    resetCreds(Ka, Kb);
    clear();
    const p = propose(claims(A, S1), 462);
    ready(p.request_id);
    const b = begin(claims(A, S2), p.request_id);
    const ab = Kb.assert(b.challenge);
    const before = active();
    const s3 = sessionRun(asAuth(sess, revokeSql(Ka, Kb)).replace("commit;", "select pg_sleep(3.44); commit;"));
    for (let i = 0; i < 80 && psql(`select count(*) from pg_stat_activity where datname = '${DB}' and query like '%pg_sleep(3.44)%' and wait_event = 'PgSleep'`) !== "1"; i++) await sleep(150);
    const s4 = sessionRun(asAuth(sess, finishSql(p.request_id, b.nonce, ab)));
    const [x2, y2] = await Promise.all([s3, s4]);
    expect(x2.out).toContain('"status": "revoked"');
    expect(y2.out).toContain('"status": "rejected"');
    expect(y2.out).toMatch(/revoked credential/);
    expect(active()).toEqual(before);
  });

  it("PA-22 the OFFLINE RECOVERY credential can only freeze and start a delayed re-enrolment of a new primary: it cannot publish, authorize, enrol, revoke, cancel or thaw; the re-enrolment is loud, waits at least 72 h, can be cancelled by a primary or spare key, and on completion replaces the whole set (the recovery key is single use); it works under a freeze and with the monitoring table missing", () => {
    clear();
    const Ka = new SoftAuthenticator();
    const Kb = new SoftAuthenticator();
    const Kr = new SoftAuthenticator();
    const Kn = new SoftAuthenticator();
    resetCreds(Ka, [Kr, "recovery"]);
    const sess = claims(A, S2);
    psql("create table if not exists public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb, recorded_at timestamptz not null default clock_timestamp())");
    try {
      // the recovery key is not offered for, and cannot complete, any ordinary ceremony
      const p = propose(claims(A, S1), 471);
      ready(p.request_id);
      const b = begin(claims(A, S2), p.request_id);
      expect(b.allow_credentials).toEqual([Ka.credIdB64u]);
      expect(finish(claims(A, S2), p.request_id, b.nonce, Kr.assert(b.challenge))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/recovery credential can only/) });
      expect(enrollReq(sess, Kr, new SoftAuthenticator(), "enrolled by recovery")).toMatchObject({ status: "rejected", reason: expect.stringMatching(/recovery credential can only/) });
      const pe = enrollReq(sess, Ka, new SoftAuthenticator(), "an ordinary pending key");
      expect(pe.status).toBe("pending");
      expect(cancelWith(sess, pe.change_id, Kr)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/recovery credential can only/) });
      expect(cancelWith(sess, pe.change_id, Ka)).toMatchObject({ status: "cancelled" });
      // an ordinary spare key joins for the remaining checks (owner-level fixture); revoke is never offered to the recovery key
      resetCreds(Ka, Kb, [Kr, "recovery"]);
      expect(authOut(sess, `select public.tw4_price_cred_begin('revoke', '${Kb.credIdB64u}', null, null, null, null)::text;`).allow_credentials).toEqual([Ka.credIdB64u]);
      // an ordinary key cannot use the recovery operations
      const fb = authOut(sess, `select public.tw4_price_cred_begin('recover_freeze', null, null, null, null, null)::text;`);
      expect(fb.allow_credentials).toEqual([Kr.credIdB64u]);
      const bad = Ka.assert(fb.challenge);
      expect(authOut(sess, `select public.tw4_price_recovery_freeze('${fb.nonce}', '${bad.credId}', '${bad.auth}', '${bad.client}', '${bad.sig}')::text;`)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/only the recovery credential/) });
      // (a) FREEZE with the recovery key, with monitoring expected and the table gone (the freeze must not need monitoring)
      psql("drop table public.studio_sms_price_security_events");
      setConfig("monitoring_expected = true");
      try {
        const g = Kr.assert(fb.challenge);
        expect(authOut(sess, `select public.tw4_price_recovery_freeze('${fb.nonce}', '${g.credId}', '${g.auth}', '${g.client}', '${g.sig}')::text;`)).toMatchObject({ status: "frozen" });
        expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("t");
        expect(audit("recovery_used")).toBeGreaterThanOrEqual(1);
      } finally {
        setConfig("monitoring_expected = false");
      }
      psql("create table public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb, recorded_at timestamptz not null default clock_timestamp())");
      // (b) RE-ENROLMENT of a new primary: pending for the recovery delay (>= 72 h by CHECK), loud, never publishes
      const rb = authOut(sess, `select public.tw4_price_cred_begin('recover_enroll', '${Kn.credIdB64u}', '${b64u(Kn.x)}', '${b64u(Kn.y)}', null, 'recovered primary key')::text;`);
      expect(rb.allow_credentials).toEqual([Kr.credIdB64u]);
      const recSql = (rec: SoftAuthenticator, nw: SoftAuthenticator, ch: Record<string, never>) => {
        const a = rec.assert(ch.challenge);
        const m = nw.assert(ch.challenge);
        return authOut(sess, `select public.tw4_price_recovery_enroll('${ch.nonce}', '${nw.credIdB64u}', '${b64u(nw.x)}', '${b64u(nw.y)}', 'recovered primary key', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}', '${m.auth}', '${m.client}', '${m.sig}')::text;`);
      };
      expect(recSql(Ka, Kn, rb)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/only the recovery credential/) }); // an ordinary key cannot start it
      expect(recSql(Kr, new SoftAuthenticator(), rb)).toMatchObject({ status: "rejected" }); // the new key must sign the SAME challenge for ITS key
      const rb2 = authOut(sess, `select public.tw4_price_cred_begin('recover_enroll', '${Kn.credIdB64u}', '${b64u(Kn.x)}', '${b64u(Kn.y)}', null, 'recovered primary key')::text;`);
      const rq = recSql(Kr, Kn, rb2);
      expect(rq).toMatchObject({ status: "pending", effective_in_hours: 168 });
      expect(psql(`select (effective_at - requested_at) >= interval '72 hours' from public.studio_sms_price_credential_changes where id = '${rq.change_id}'`)).toBe("t");
      expect(codeOf(authErr(sess, `select public.tw4_price_cred_apply('${rq.change_id}')::text;`))).toBe("TW045");
      expect(codeOf(psqlError(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; update public.studio_sms_price_credential_changes set effective_at = requested_at + interval '30 hours' where id = '${rq.change_id}'; commit;`))).toBe("23514"); // never under 72 h
      const kinds = rows<{ kind: string; detail: { severity?: string } }>("select kind, detail from public.studio_sms_price_security_events");
      expect(kinds.some((k) => k.kind === "recovery_credential_used" && k.detail.severity === "high")).toBe(true);
      expect(audit("recovery_used")).toBeGreaterThanOrEqual(2);
      // the recovery key itself cannot thaw, publish or cancel; a primary or spare key CAN cancel the recovery enrolment (a stolen recovery key is not enough)
      const tb = authOut(sess, `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
      expect(tb.allow_credentials).not.toContain(Kr.credIdB64u);
      expect(cancelWith(sess, rq.change_id, Kr)).toMatchObject({ status: "rejected" });
      expect(cancelWith(sess, rq.change_id, Kb)).toMatchObject({ status: "cancelled" });
      // start again and let it complete under the freeze
      const rb3 = authOut(sess, `select public.tw4_price_cred_begin('recover_enroll', '${Kn.credIdB64u}', '${b64u(Kn.x)}', '${b64u(Kn.y)}', null, 'recovered primary key')::text;`);
      const rq2 = recSql(Kr, Kn, rb3);
      expect(rq2.status).toBe("pending");
      ageChange(rq2.change_id);
      psql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard; update public.studio_sms_price_credential_changes set requested_at = requested_at - interval '200 hours', effective_at = effective_at - interval '200 hours' where id = '${rq2.change_id}'; alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
      expect(applyChange(sess, rq2.change_id)).toMatchObject({ status: "applied" });
      expect(rows<{ role: string; enrolled_via: string }>("select role, enrolled_via from public.studio_sms_price_credentials where status = 'active'")).toEqual([{ role: "primary", enrolled_via: "recovery" }]);
      expect(rows<{ kind: string }>("select kind from public.studio_sms_price_security_events where kind = 'recovery_completed'").length).toBe(1);
      // the recovered primary lifts the freeze (enrolled through a completed recovery); the old keys are dead
      expect(thawWith(claims(A, S2), Ka).out).toMatchObject({ status: "rejected" });
      expect(thawWith(claims(A, S2), Kn).out.status).toBe("thawed");
      const r = authorize(472, Kn);
      expect(r.out.status).toBe("applied");
    } finally {
      psql("delete from public.studio_sms_price_security_events where false");
      psql("drop table if exists public.studio_sms_price_security_events");
    }
  });

  it("PA-25 emit failures are recoverable evidence: the failed emit is listed (service_role only), a replay appends an acknowledgement and re-emits the original event without altering the audit row, never acknowledges while the monitoring table is missing, and the routine prune never removes emit_failed rows", () => {
    clear();
    const Ka = new SoftAuthenticator();
    resetCreds(Ka);
    psql("drop table if exists public.studio_sms_price_security_events");
    setConfig("monitoring_expected = true");
    const asRole = (role: string, sql: string) => psql(`begin; set local role ${role}; ${sql} commit;`).split(NL).pop()!;
    try {
      const failed0 = audit("emit_failed");
      expect(authOut(claims(B, "d42-b25"), `select public.tw4_price_freeze('a freeze while monitoring is down, to be replayed')::text;`)).toMatchObject({ status: "frozen" });
      expect(thawWith(claims(A, S2), Ka).out.status).toBe("thawed");
      expect(audit("emit_failed")).toBe(failed0 + 2);
    } finally {
      setConfig("monitoring_expected = false");
    }
    const before = rows<{ id: string; detail: string }>("select id::text, detail::text from public.studio_sms_price_audit where event = 'emit_failed' order by id");
    const listed = JSON.parse(asRole("service_role", "select public.tw4_price_emit_failures(100)::text;")) as { audit_id: number; kind: string }[];
    expect(listed.map((l) => l.kind)).toEqual(expect.arrayContaining(["pricing_suspended", "pricing_resumed"]));
    for (const role of ["authenticated", "anon"]) expect(codeOf(psqlError(`begin; set local role ${role}; select public.tw4_price_emit_failures(5); commit;`)), role).toBe("42501");
    expect(codeOf(psqlError("begin; set local role authenticated; select public.tw4_price_emit_replay(5); commit;"))).toBe("42501");
    // the table is still missing: nothing is acknowledged
    expect(JSON.parse(asRole("service_role", "select public.tw4_price_emit_replay(50)::text;"))).toMatchObject({ replayed: 0 });
    expect(num("select count(*) from public.studio_sms_price_emit_acks")).toBe(0);
    psql("create table public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb, recorded_at timestamptz not null default clock_timestamp())");
    try {
      const rp = JSON.parse(asRole("service_role", "select public.tw4_price_emit_replay(50)::text;")) as { replayed: number; remaining: number };
      expect(rp.replayed).toBe(before.length);
      expect(rp.remaining).toBe(0);
      expect(num("select count(*) from public.studio_sms_price_emit_acks")).toBe(before.length);
      expect(rows<{ detail: { replayed_audit_id?: number } }>("select detail from public.studio_sms_price_security_events where kind in ('pricing_suspended', 'pricing_resumed')").every((e) => e.detail.replayed_audit_id !== undefined)).toBe(true);
      expect(rows<{ id: string; detail: string }>("select id::text, detail::text from public.studio_sms_price_audit where event = 'emit_failed' order by id")).toEqual(before); // evidence unchanged
      expect(JSON.parse(asRole("service_role", "select public.tw4_price_emit_failures(100)::text;"))).toEqual([]);
      expect(JSON.parse(asRole("service_role", "select public.tw4_price_emit_replay(50)::text;"))).toMatchObject({ replayed: 0 });
      expect(codeOf(psqlError("update public.studio_sms_price_emit_acks set note = 'x'"))).toBe("42501");
      // the routine prune keeps emit_failed (and its acknowledgements) however old they are
      psql("begin; alter table public.studio_sms_price_audit disable trigger studio_sms_price_audit_guard; update public.studio_sms_price_audit set at = now() - interval '100 days' where event = 'emit_failed'; alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_guard; commit;");
      psql("select public._tw4price_prune('90 days')");
      expect(num("select count(*) from public.studio_sms_price_audit where event = 'emit_failed'")).toBe(before.length);
    } finally {
      psql("drop table if exists public.studio_sms_price_security_events");
    }
  });

  it("PA-19 limits are re-checked at the decision: a limit the owner approves AFTER a proposal was made refuses its challenge and its signature; the shipped (unapproved) rows enforce nothing", () => {
    clear();
    const p = propose(claims(A, S1), 430);
    ready(p.request_id);
    const orig = psql(`select approved || ':' || max_customer_cents from public.studio_sms_price_limits where kind = 'number'`);
    expect(orig.startsWith("false")).toBe(true);
    expect(begin(claims(A, S2), p.request_id).nonce).toBeTruthy(); // unapproved rows enforce nothing
    psql(`update public.studio_sms_price_limits set max_customer_cents = 300, approved = true, approved_by_note = 'approved in the limits recheck test', approved_at = now() where kind = 'number'`);
    try {
      expect(codeOf(beginErr(claims(A, S2), p.request_id))).toBe("22023");
      const b = { nonce: "AAAA", challenge: "AAAA" };
      expect(codeOf(finishErr(claims(A, S2), p.request_id, b.nonce, K2.assert(b.challenge)))).toBe("22023");
      expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 430`)).toBe(0);
    } finally {
      psql(`update public.studio_sms_price_limits set approved = false, approved_by_note = null, approved_at = null, max_customer_cents = 500 where kind = 'number'`);
    }
    clear();
  });

  it("PA-20 safe-direction actions survive a monitoring outage: with monitoring expected but its table missing, freeze, compromise report, hardware-key cancel and thaw all succeed and commit their audit row (the failed emit is recorded as emit_failed); an integrity failure is still audited; risk-opening calls (begin) fail closed; the delay is not touched", () => {
    clear();
    const Ka = new SoftAuthenticator();
    const Kb = new SoftAuthenticator();
    const Katt = new SoftAuthenticator();
    resetCreds(Ka, Kb);
    const sess = claims(A, S2);
    const pend = enrollReq(sess, Kb, Katt, "hostile pending key");
    expect(pend.status).toBe("pending");
    const effectiveBefore = psql(`select effective_at::text from public.studio_sms_price_credential_changes where id = '${pend.change_id}'`);
    const p = propose(claims(A, S1), 441);
    ready(p.request_id);
    // a counter regression to be audited while monitoring is down: Kb's stored counter is far ahead of the assertion
    psql(`begin; alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard; update public.studio_sms_price_credentials set sign_count = 5000 where credential_id = decode('${Kb.hex.cred}', 'hex'); alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard; commit;`);
    const b = begin(claims(A, S2), p.request_id);
    setConfig("monitoring_expected = true");
    try {
      const failed0 = audit("emit_failed");
      const integrity0 = audit("integrity_failure");
      // R2-6: the integrity failure and its audit row survive the failed emit
      expect(finish(claims(A, S2), p.request_id, b.nonce, Kb.assert(b.challenge, { counter: 7 }))).toMatchObject({ status: "rejected" });
      expect(audit("integrity_failure")).toBe(integrity0 + 1);
      expect(audit("emit_failed")).toBe(failed0 + 1);
      // R2-1: freeze, compromise report, cancel and thaw are not blocked by the outage
      expect(authOut(claims(B, "d42-b20"), `select public.tw4_price_freeze('a freeze during the monitoring outage')::text;`)).toMatchObject({ status: "frozen" });
      expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("t");
      expect(authOut(claims(B, "d42-b20"), `select public.tw4_price_report_compromise('a compromise report during the outage')::text;`)).toMatchObject({ status: "frozen" });
      expect(audit("freeze_set")).toBeGreaterThanOrEqual(1);
      expect(audit("emit_failed")).toBeGreaterThanOrEqual(failed0 + 3);
      expect(cancelWith(claims(B, "d42-b20"), pend.change_id, Ka)).toMatchObject({ status: "cancelled" });
      expect(audit("credential_change_cancelled")).toBeGreaterThanOrEqual(1);
      expect(psql(`select effective_at::text from public.studio_sms_price_credential_changes where id = '${pend.change_id}'`)).toBe(effectiveBefore); // the outage did not move the delay
      expect(thawWith(claims(A, S2), Ka).out.status).toBe("thawed");
      expect(psql("select frozen from public.studio_sms_price_auth_config")).toBe("f");
      // risk-opening calls keep failing closed, and leave no challenge behind
      const challenges = num("select count(*) from public.studio_sms_price_auth_challenges");
      expect(codeOf(authErr(claims(A, S2), `select public.tw4_price_authz_begin('${p.request_id}')::text;`))).toBe("TW046");
      expect(num("select count(*) from public.studio_sms_price_auth_challenges")).toBe(challenges);
    } finally {
      setConfig("monitoring_expected = false");
      clear();
    }
  });

  it("PA-23 audit flooding: a non-administrator gets a refusal and NO audit row from begin or finish; a registered session's routine refusal rows are capped per hour; the owner-level prune removes housekeeping rows only and the guard never deletes integrity events", () => {
    clear();
    const p = propose(claims(A, S1), 451);
    ready(p.request_id);
    const rowsFor = (who: string) => num(`select count(*) from public.studio_sms_price_audit where actor = '${who}'`);
    const before = rowsFor(C);
    const nobody = claims(C, "d42-c-flood");
    for (let i = 0; i < 5; i++) {
      expect(codeOf(authErr(nobody, `select public.tw4_price_authz_begin('${p.request_id}')::text;`))).toBe("42501");
      expect(codeOf(authErr(nobody, `select public.tw4_price_authz_finish('${p.request_id}', 'AAAA', 'AAAA', 'AAAA', 'AAAA', 'AAAA')::text;`))).toBe("42501");
    }
    expect(rowsFor(C)).toBe(before);
    // a registered session that is not the owner: refused answers, rows capped at 100 per hour
    const flood = `select count(*) from generate_series(1, 120) g where (public.tw4_price_authz_begin('${p.request_id}')::jsonb ->> 'status') = 'refused';`;
    expect(psql(asAuth(claims(B, "d42-b-flood"), flood)).split(NL).pop()).toBe("120");
    expect(num(`select count(*) from public.studio_sms_price_audit where actor = '${B}' and event = 'gate_refused' and at > now() - interval '1 hour'`)).toBe(100);
    // retention: housekeeping rows age out, integrity events never do
    psql(`begin; alter table public.studio_sms_price_audit disable trigger studio_sms_price_audit_guard; update public.studio_sms_price_audit set at = now() - interval '100 days' where event in ('gate_refused', 'integrity_failure', 'published'); alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_guard; commit;`);
    const integrity = audit("integrity_failure");
    const published = audit("published");
    expect(integrity).toBeGreaterThan(0);
    expect(codeOf(authErr(claims(A, S2), `select public._tw4price_prune('90 days')::text;`))).toBe("42501"); // not executable by an API role
    expect(codeOf(psqlError(`select public._tw4price_prune('10 days')`))).toBe("22023");
    const pruned = JSON.parse(psql(`select public._tw4price_prune('90 days')::text`)) as { audit: number };
    expect(pruned.audit).toBeGreaterThanOrEqual(100);
    expect(audit("gate_refused")).toBeLessThan(5);
    expect(audit("integrity_failure")).toBe(integrity);
    expect(audit("published")).toBe(published);
    // the guard refuses to delete an integrity event even with the prune flag set
    expect(codeOf(psqlError(`begin; set local tw4.priceauth_prune = 'on'; delete from public.studio_sms_price_audit where event = 'integrity_failure'; commit;`))).toBe("42501");
    expect(begin(claims(B, "d42-b-after"), p.request_id)).toMatchObject({ status: "refused" }); // a fresh routine row exists
    expect(codeOf(psqlError(`delete from public.studio_sms_price_audit where event = 'gate_refused'`))).toBe("42501");
  });

  it("PA-24 thaw eligibility never reads the events table's timestamps: a monitoring suspension whose recorded_at is forged to the distant past (or future) still lets a registered key lift it, and the challenge lists every active key", () => {
    clear();
    const Ka = new SoftAuthenticator();
    const Kb = new SoftAuthenticator();
    resetCreds(Ka, Kb);
    setConfig("monitor_seq_lifted = 0"); // the stand-in table below restarts its sequence
    psql("create table public.studio_sms_price_security_events (seq bigint generated always as identity primary key, kind text not null, occurred_at timestamptz not null default clock_timestamp(), subject_user_id uuid null, detail jsonb not null default '{}'::jsonb, recorded_at timestamptz not null default clock_timestamp())");
    try {
      for (const stamp of ["1970-01-01", "2999-01-01"]) {
        psql(`insert into public.studio_sms_price_security_events (kind, recorded_at, occurred_at) values ('pricing_suspended', '${stamp}', '${stamp}')`);
        const tb = authOut(claims(A, S2), `select public.tw4_price_cred_begin('thaw', null, null, null, null, null)::text;`);
        expect([...tb.allow_credentials].sort()).toEqual([Ka.credIdB64u, Kb.credIdB64u].sort());
        const a = Kb.assert(tb.challenge);
        expect(authOut(claims(A, S2), `select public.tw4_price_thaw('${tb.nonce}', '${a.credId}', '${a.auth}', '${a.client}', '${a.sig}')::text;`)).toMatchObject({ status: "thawed" });
      }
      expect(psql("select public._tw4price_suspended()")).toBe("f");
    } finally {
      psql("drop table if exists public.studio_sms_price_security_events");
    }
  });
});
