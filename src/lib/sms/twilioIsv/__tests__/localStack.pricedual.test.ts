/**
 * D4-1: dual-controlled SMS price changes (migration 20270204090000), on a throwaway DEV-equivalent database with synthetic administrators.
 * Cast (wpd4Helpers): A, B platform administrators; C not an administrator; D administrator (session assurance is the action layer's job, see localStack.wpd4actions
 * and localStack.pricedualactions); E deactivated administrator; F a third administrator; G administrator whose auth user is banned.
 *
 * LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB and the tw4_local_qa_only marker. Nothing reaches Twilio, Stripe or any message channel.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, C, D, E, F, G, DB, NOTE, PG, call, callErr, codeOf, enabled, mkUser, money, num, psql, psqlError, rows, seedCast, seedPrices, setRole, world } from "./wpd4Helpers";
import { PRICE_KINDS } from "@/lib/sms/priceChange";
import { ownerAgeRequest, ownerReactivate, registerApproverSql, setPriceMode } from "./priceFixture";

vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const active = (kind: string) => rows<{ id: string; customer_price_cents: number; provider_cost_cents: number; created_by: string }>(
  `select id, customer_price_cents, provider_cost_cents, created_by from public.studio_sms_price_list where kind = '${kind}' and active`);
const priceRows = (kind: string, cents: number) => num(`select count(*) from public.studio_sms_price_list where kind = '${kind}' and customer_price_cents = ${cents}`);
const propose = (kind: string, cents: number, actor: string, provider = 150, description = "dual-control price change under test", reason = "a written reason for the price change under test") =>
  call<{ request_id: string; status: string; replayed: boolean }>("_tw4price_do_propose", kind, cents, provider, description, reason, actor);
const proposeErr = (kind: string, cents: number, actor: string, provider = 150, description = "dual-control price change under test", reason = "a written reason for the price change under test") =>
  callErr("_tw4price_do_propose", kind, cents, provider, description, reason, actor);
const approve = (id: string, actor: string, note = NOTE) => call<{ status: string; replayed?: boolean; price_id?: string }>("_tw4price_do_approve", id, actor, note);
const approveErr = (id: string, actor: string, note = NOTE) => callErr("_tw4price_do_approve", id, actor, note);
const reject = (id: string, actor: string, note = "rejected after review of the proposal") => call<{ status: string; replayed?: boolean; withdrawn?: boolean }>("_tw4price_do_reject", id, actor, note);
const rejectErr = (id: string, actor: string, note = "rejected after review of the proposal") => callErr("_tw4price_do_reject", id, actor, note);
const preq = (id: string) => rows<{ status: string; requested_by: string; decided_by: string | null; applied_price_id: string | null; decision_note: string | null; base_price_id: string | null }>(
  `select status, requested_by, decided_by, applied_price_id, decision_note, base_price_id from public.studio_sms_price_change_requests where id = '${id}'`)[0];
const ageRequest = (id: string) => ownerAgeRequest(psql, id);
/** Withdraw whatever is open for a kind so the next scenario starts clean. */
const clearOpen = (kind: string) => {
  for (const r of rows<{ id: string; requested_by: string }>(`select id, requested_by from public.studio_sms_price_change_requests where kind = '${kind}' and status in ('pending', 'approved')`)) reject(r.id, r.requested_by, "withdrawn to start the next scenario clean");
};
/** An isolated psql session: runs a script on its own connection, resolves with the combined output and exit status (used for the two-connection concurrency scenarios). */
const sessionPsql = (sql: string): Promise<{ out: string; code: number | null }> =>
  new Promise((resolve) => {
    const p = spawn("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ out, code }));
    p.stdin.end(sql);
  });
/** a platform administrator who is also in the protected approver registry (owner-level insert) */
const mkAdmin = (label: string): string => {
  const u = mkUser({ admin: true, label });
  psql(registerApproverSql(u));
  return u;
};
const mig = (name: string) => readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", name), "utf8");
const noTx = (s: string) => s.replace(/^begin;\s*$/gm, "").replace(/^commit;\s*$/gm, "");
/** the audit rows and owner-mode evidence of 20270204100000 are immutable in production; this suite is a throwaway database and clears them visibly before it exercises the rollbacks */
const clearAuthEvidence = `
  alter table public.studio_sms_price_audit disable trigger studio_sms_price_audit_guard; delete from public.studio_sms_price_audit; alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_guard;
  alter table public.studio_sms_price_auth_challenges disable trigger studio_sms_price_auth_challenges_guard; delete from public.studio_sms_price_auth_challenges; alter table public.studio_sms_price_auth_challenges enable always trigger studio_sms_price_auth_challenges_guard;`;
const rollbackSql = () => clearAuthEvidence + noTx(mig("rollback/20270204100000_twilio_price_owner_authorization_rollback.sql")) + noTx(mig("rollback/20270204090000_twilio_price_dual_control_rollback.sql"));

describe.skipIf(!enabled)("D4-1 SMS price dual control (real schema, synthetic administrators)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null`)).toBe("t");
    seedCast();
    // the cast is in the protected registry (C never held the role and E lost it, which the role check must still catch)
    for (const u of [A, B, C, D, E, F, G]) psql(registerApproverSql(u));
    setPriceMode(psql, "team"); // this suite proves the TEAM-mode workflow (two distinct registered administrators); the single-owner mode is localStack.priceauth
    seedPrices();
    expect(new Set([A, B, C, D, E, F, G]).size).toBe(7);
  });

  it("PD-01 tw4_price_set fails closed for EVERY caller (administrator, second administrator, non-administrator, deactivated, unknown, null): TW042, no price and no request changes", () => {
    const before = [active("number"), active("monthly"), psql("select count(*) from public.studio_sms_price_list"), psql("select count(*) from public.studio_sms_price_change_requests")];
    for (const who of [A, B, C, E, G, "11111111-1111-4111-8111-111111111111", null]) {
      expect(codeOf(callErr("tw4_price_set", "number", 777, 115, "direct single-admin attempt", who)), String(who)).toBe("TW042");
    }
    expect(codeOf(callErr("tw4_price_set", null, null, null, null, null))).toBe("TW042");
    expect([active("number"), active("monthly"), psql("select count(*) from public.studio_sms_price_list"), psql("select count(*) from public.studio_sms_price_change_requests")]).toEqual(before);
  });

  it("PD-02 no other writer can activate, re-activate or edit a price: INSERT (even as the owner, even with ordinary triggers off), reactivation and in-place edits are refused; retiring still works", () => {
    const cur = active("number")[0];
    const ins = (active_: boolean, by = A) => `insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, active, created_by) values ('number', 999, 100, 'bypass attempt', ${active_}, '${by}');`;
    expect(psqlError(ins(true))).toMatch(/approved price change/);
    expect(psqlError(ins(false))).toMatch(/approved price change/);
    expect(psqlError(`begin; set local session_replication_role = replica; ${ins(true)} commit;`)).toMatch(/approved price change/); // the trigger is ENABLE ALWAYS
    expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_list set customer_price_cents = 1 where id = '${cur.id}'; commit;`)).toMatch(/never edited/);
    expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_list set description = 'edited' where id = '${cur.id}'; commit;`)).toMatch(/never edited/);
    expect(psqlError(`begin; update public.studio_sms_price_list set active = false where id = '${cur.id}'; update public.studio_sms_price_list set active = true where id = '${cur.id}'; commit;`)).toMatch(/never re-activated/);
    expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_list set active = false where id = '${cur.id}'; update public.studio_sms_price_list set active = true where id = '${cur.id}'; commit;`)).toMatch(/never re-activated/);
    expect(psql(`select tgenabled from pg_trigger where tgname = 'studio_sms_price_list_00_activation' and tgrelid = 'public.studio_sms_price_list'::regclass`)).toBe("A");
    // retiring (active -> false) stays possible for the owner, as before (inside a rolled-back transaction)
    expect(psqlError(`begin; update public.studio_sms_price_list set active = false where id = '${cur.id}'; rollback;`)).toBe("");
    expect(active("number")).toEqual([cur]);
    // the API roles cannot reach the table at all
    for (const role of ["anon", "authenticated", "service_role"]) expect(psqlError(`set role ${role}; ${ins(true)}`), role).toMatch(/permission denied/);
  });

  it("PD-03 a proposal alone changes nothing; requester == approver is refused 42501; the price is unchanged until a DIFFERENT administrator approves", () => {
    const before = active("number");
    const r = propose("number", 301, A);
    expect(r).toMatchObject({ status: "pending", replayed: false });
    expect(active("number")).toEqual(before);
    expect(codeOf(approveErr(r.request_id, A))).toBe("42501");
    expect(preq(r.request_id)).toMatchObject({ status: "pending", decided_by: null });
    for (const who of [C, E, G]) expect(codeOf(approveErr(r.request_id, who)), who).toBe("42501");
    expect(active("number")).toEqual(before);
    expect(priceRows("number", 301)).toBe(0);
    reject(r.request_id, A, "withdrawn by the requester without any approval");
  });

  it("PD-04 B approves: one new price is published exactly once (old retired, one active row, created_by = B), decided_by = B, applied_price_id recorded; B's replay is idempotent, a third administrator gets TW041", () => {
    const old = active("number")[0];
    const r = propose("number", 302, A);
    const out = approve(r.request_id, B);
    expect(out).toMatchObject({ status: "applied", replayed: false });
    const now = active("number");
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ customer_price_cents: 302, id: out.price_id, created_by: B });
    expect(psql(`select active from public.studio_sms_price_list where id = '${old.id}'`)).toBe("f");
    expect(preq(r.request_id)).toMatchObject({ status: "applied", requested_by: A, decided_by: B, applied_price_id: out.price_id, decision_note: NOTE, base_price_id: old.id });
    expect(approve(r.request_id, B)).toMatchObject({ status: "applied", replayed: true, price_id: out.price_id });
    expect(codeOf(approveErr(r.request_id, F))).toBe("TW041");
    expect(codeOf(approveErr(r.request_id, A))).toBe("42501");
    expect(priceRows("number", 302)).toBe(1);
    expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and active`)).toBe(1);
  });

  it("PD-05 stale price: the active price moved after the proposal => the approval returns invalidated (persisted, noted) and publishes nothing; a replay stays invalidated", () => {
    const p = propose("number", 305, A);
    const base = active("number")[0];
    psql(`update public.studio_sms_price_list set active = false where id = '${base.id}';`); // the base price is retired underneath the proposal (owner-level)
    expect(approve(p.request_id, B)).toMatchObject({ status: "invalidated", replayed: false });
    expect(preq(p.request_id)).toMatchObject({ status: "invalidated", decided_by: null });
    expect(preq(p.request_id).decision_note).toMatch(/active price changed/);
    expect(approve(p.request_id, B)).toMatchObject({ status: "invalidated", replayed: true });
    expect(priceRows("number", 305)).toBe(0);
    expect(active("number")).toHaveLength(0);
    ownerReactivate(psql, `id = '${base.id}'`);
    expect(active("number")[0].id).toBe(base.id);
  });

  it("PD-06 expiry (24 h): an unapproved proposal comes back expired and never applies, a replay stays expired, and a new proposal for the kind is then possible", () => {
    const before = active("number");
    const p = propose("number", 306, A);
    ageRequest(p.request_id);
    expect(approve(p.request_id, B)).toMatchObject({ status: "expired", replayed: false });
    expect(preq(p.request_id).status).toBe("expired");
    expect(approve(p.request_id, B)).toMatchObject({ status: "expired", replayed: true });
    expect(active("number")).toEqual(before);
    // an expired-but-still-pending request does not block a new proposal: propose closes it first
    const q = propose("number", 3061, A);
    ageRequest(q.request_id);
    const r = propose("number", 3062, B);
    expect(r.status).toBe("pending");
    expect(preq(q.request_id).status).toBe("expired");
    reject(r.request_id, B, "withdrawn to start the next scenario clean");
  });

  it("PD-07 rejection and withdrawal: B rejects (approve then TW041); the requester may withdraw only as a rejection; an applied request cannot be rejected; replays are idempotent", () => {
    const before = active("number");
    const p = propose("number", 307, A);
    expect(reject(p.request_id, B, "rejected: the price is not approved by the owner")).toMatchObject({ status: "rejected", replayed: false, withdrawn: false });
    expect(preq(p.request_id)).toMatchObject({ status: "rejected", decided_by: B });
    expect(reject(p.request_id, B, "rejected: the price is not approved by the owner")).toMatchObject({ status: "rejected", replayed: true });
    expect(codeOf(approveErr(p.request_id, F))).toBe("TW041");
    const w = propose("number", 3071, A);
    expect(reject(w.request_id, A, "withdrawn by the requester after review")).toMatchObject({ status: "rejected", withdrawn: true });
    expect(preq(w.request_id)).toMatchObject({ status: "rejected", decided_by: A, requested_by: A });
    expect(codeOf(approveErr(w.request_id, B))).toBe("TW041");
    const x = propose("number", 3072, A);
    approve(x.request_id, B);
    expect(codeOf(rejectErr(x.request_id, F))).toBe("TW041");
    expect(codeOf(rejectErr(x.request_id, C))).toBe("42501");
    expect(active("number")[0].customer_price_cents).toBe(3072);
    expect(active("number")).not.toEqual(before);
  });

  it("PD-08 inactive administrators: C (never one), E (deactivated), G (banned) can neither propose, approve nor reject; a requester or approver who lost the role (or is banned) voids / blocks the approval", () => {
    const before = active("monthly");
    for (const who of [C, E, G]) expect(codeOf(proposeErr("monthly", 1234, who)), who).toBe("42501");
    const p = propose("monthly", 1235, A);
    for (const who of [C, E, G]) {
      expect(codeOf(approveErr(p.request_id, who)), who).toBe("42501");
      expect(codeOf(rejectErr(p.request_id, who)), who).toBe("42501");
    }
    reject(p.request_id, A, "withdrawn to start the next scenario clean");
    // requester demoted after proposing
    const x = mkAdmin("price-requester");
    const q = propose("monthly", 1236, x);
    setRole(x, false);
    expect(approve(q.request_id, B)).toMatchObject({ status: "invalidated" });
    expect(preq(q.request_id)).toMatchObject({ status: "invalidated", decided_by: null });
    expect(preq(q.request_id).decision_note).toMatch(/no longer an active platform administrator/);
    // requester banned after proposing (the role is kept)
    const y = mkAdmin("price-requester-banned");
    const r = propose("monthly", 1237, y);
    psql(`update auth.users set banned_until = now() + interval '10 years' where id = '${y}';`);
    expect(approve(r.request_id, B)).toMatchObject({ status: "invalidated" });
    // requester soft-deleted after proposing (deleted_at set, role kept)
    const w = mkAdmin("price-requester-deleted");
    const dq = propose("monthly", 1239, w);
    psql(`update auth.users set deleted_at = now() where id = '${w}';`);
    expect(approve(dq.request_id, B)).toMatchObject({ status: "invalidated" });
    const w2 = mkAdmin("price-approver-deleted");
    psql(`update auth.users set deleted_at = now() where id = '${w2}';`);
    expect(codeOf(proposeErr("monthly", 1240, w2))).toBe("42501");
    // approver demoted / banned
    const s = propose("monthly", 1238, A);
    const z = mkAdmin("price-approver");
    setRole(z, false);
    expect(codeOf(approveErr(s.request_id, z))).toBe("42501");
    const z2 = mkAdmin("price-approver-banned");
    psql(`update auth.users set banned_until = now() + interval '10 years' where id = '${z2}';`);
    expect(codeOf(approveErr(s.request_id, z2))).toBe("42501");
    expect(preq(s.request_id).status).toBe("pending");
    expect(active("monthly")).toEqual(before);
    reject(s.request_id, A, "withdrawn to start the next scenario clean");
  });

  it("PD-09 input validation: unknown kind 22023, non-positive / null amounts, short description or reason, a no-op proposal; a second open proposal for the kind TW041; an identical replay by the requester is idempotent; every price kind of the price list is accepted", () => {
    clearOpen("monthly");
    const cur = active("monthly")[0];
    expect(codeOf(proposeErr("bogus", 1234, A))).toBe("22023");
    expect(codeOf(proposeErr("MONTHLY", 1234, A))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 0, A))).toBe("22023");
    expect(codeOf(proposeErr("monthly", -5, A))).toBe("22023");
    expect(codeOf(callErr("_tw4price_do_propose", "monthly", null, 150, "dual-control price change under test", "a written reason for the price change", A))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 1234, A, -1))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 1234, A, 150, "ab"))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 1234, A, 150, "dual-control price change under test", "short"))).toBe("22023");
    expect(codeOf(proposeErr("monthly", cur.customer_price_cents, A, cur.provider_cost_cents))).toBe("22023");
    expect(num(`select count(*) from public.studio_sms_price_change_requests where kind = 'monthly' and status = 'pending'`)).toBe(0);
    const p = propose("monthly", 1239, A);
    expect(propose("monthly", 1239, A)).toMatchObject({ request_id: p.request_id, replayed: true });
    expect(codeOf(proposeErr("monthly", 1240, A))).toBe("TW041"); // someone else's, and the same requester's different one: both refused while one is open
    expect(codeOf(proposeErr("monthly", 1239, B))).toBe("TW041");
    reject(p.request_id, A, "withdrawn to start the next scenario clean");
    for (const kind of psql(`select string_agg(k, ',') from unnest(public._tw4price_kinds()) k`).split(",")) {
      const r = propose(kind, 4321, A);
      expect(r.status, kind).toBe("pending");
      reject(r.request_id, A, "withdrawn: only the validation was under test");
    }
    expect(psql(`select array_to_string(public._tw4price_kinds(), ',')`)).toBe('brand,brand_low_volume,campaign_vetting,monthly,monthly_low_volume,number,sms_inbound,sms_usage');
  });

  it("PD-09c the UI list of price kinds (PRICE_KIND_TEXT) equals the database list: a new price kind must be added to both", () => {
    expect([...PRICE_KINDS].sort().join(",")).toBe(psql(`select array_to_string(public._tw4price_kinds(), ',')`));
  });

  it("PD-09b amount ceilings: a customer price or provider cost above 10,000,000 cents (the UI maximum) is refused 22023 by the function and by the table; the ceiling itself is accepted; a provider cost above the customer price is allowed (negative-margin cases are modelled, not forbidden)", () => {
    clearOpen("monthly");
    expect(codeOf(proposeErr("monthly", 10_000_001, A))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 2147483647, A))).toBe("22023");
    expect(codeOf(proposeErr("monthly", 1245, A, 10_000_001))).toBe("22023");
    expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, expires_at) values ('sms_usage', 10000001, 1, 'too big', 'a ceiling test row', '${A}', now() + interval '1 hour'); commit;`)).toMatch(/check constraint/);
    const hi = propose("monthly", 10_000_000, A, 10_000_000);
    expect(hi.status).toBe("pending");
    reject(hi.request_id, A, "withdrawn to start the next scenario clean");
    const neg = propose("monthly", 1246, A, 5000);
    expect(neg.status).toBe("pending");
    reject(neg.request_id, A, "withdrawn to start the next scenario clean");
  });

  it("PD-10 first publication: a kind with no active price (base null) is published through the same two-administrator workflow, created_by = the approver", () => {
    clearOpen("brand_low_volume");
    expect(active("brand_low_volume")).toHaveLength(0);
    const p = propose("brand_low_volume", 1500, A, 450);
    expect(preq(p.request_id).base_price_id).toBeNull();
    expect(codeOf(approveErr(p.request_id, A))).toBe("42501");
    const out = approve(p.request_id, F);
    expect(active("brand_low_volume")[0]).toMatchObject({ id: out.price_id, customer_price_cents: 1500, created_by: F });
  });

  describe("tampering with the request table and the price list", () => {
    it("PD-11 the binding of a request is fixed and its status moves only through the functions: modified amounts / base / requester / expiry, forged status or decider, resurrected decided rows, deletes and truncates are all refused", () => {
      clearOpen("number");
      const p = propose("number", 311, A);
      const set = (col: string, val: string, guc = false) => psqlError(`begin; ${guc ? "select set_config('tw4.pricedual_write', 'on', true);" : ""} update public.studio_sms_price_change_requests set ${col} = ${val} where id = '${p.request_id}'; commit;`);
      for (const [col, val] of [["customer_price_cents", "1"], ["provider_cost_cents", "1"], ["description", "'tampered description'"], ["reason", "'tampered reason for it'"], ["kind", "'monthly'"], ["requested_by", `'${B}'`],
        ["base_price_id", "null"], ["base_customer_price_cents", "1"], ["expires_at", "expires_at + interval '1 day'"], ["requested_at", "requested_at - interval '1 hour'"], ["id", "gen_random_uuid()"]] as const) {
        expect(set(col, val), `${col} without the function`).toMatch(/binding of a proposal is fixed/);
        expect(set(col, val, true), `${col} with the write flag`).toMatch(/binding of a proposal is fixed/);
      }
      expect(set("status", "'applied'")).toMatch(/only through the dual-control functions/);
      expect(set("decided_by", `'${B}'`)).toMatch(/only through the dual-control functions/);
      // even with the write flag: a forged approval by the requester, an applied row without a published price, an applied row naming a different price
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set status = 'approved', decided_by = requested_by, decided_at = now(), decision_note = '${NOTE}' where id = '${p.request_id}'; commit;`)).toMatch(/studio_sms_price_change_requests_distinct/);
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set status = 'applied', decided_by = '${B}', decided_at = now(), decision_note = '${NOTE}', applied_price_id = '${active("number")[0].id}', applied_at = now() where id = '${p.request_id}'; commit;`)).toMatch(/not a legal transition/);
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set status = 'approved', decided_by = '${B}', decided_at = now() where id = '${p.request_id}'; commit;`)).toMatch(/studio_sms_price_change_requests_shape/);
      expect(psqlError(`delete from public.studio_sms_price_change_requests where id = '${p.request_id}';`)).toMatch(/never deleted/);
      expect(psqlError(`truncate public.studio_sms_price_change_requests;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBeGreaterThan(0);
      // decided rows are final: approve, then every attempt to move it again fails, even with the write flag
      const out = approve(p.request_id, B);
      for (const st of ["pending", "rejected", "expired", "invalidated", "approved"]) {
        expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set status = '${st}' where id = '${p.request_id}'; commit;`), st).toMatch(/not a legal transition|shape|distinct/);
      }
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set decision_note = 'a rewritten decision note' where id = '${p.request_id}'; commit;`)).toMatch(/not a legal transition/);
      expect(preq(p.request_id)).toMatchObject({ status: "applied", decided_by: B, applied_price_id: out.price_id });
    });

    it("PD-11b forging under session_replication_role = replica no longer works: the request guards are ENABLE ALWAYS, so inserting a pre-approved request, updating a decided one, deleting and truncating are all refused; only visible DDL (disable trigger) could change that", () => {
      const forged = `insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, expires_at, status, decided_by, decided_at, decision_note)
        values ('sms_usage', 7, 1, 'forged price row', 'forged reason text', '${A}', now() + interval '1 hour', 'approved', '${B}', now(), 'forged note text');`;
      const price = `insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by) values ('sms_usage', 7, 1, 'forged price row', '${B}');`;
      expect(psqlError(`begin; set local session_replication_role = replica; ${forged} ${price} rollback;`)).toMatch(/created only by tw4_price_propose/);
      const done = rows<{ id: string }>(`select id from public.studio_sms_price_change_requests where status = 'applied' limit 1`)[0];
      expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_change_requests set decision_note = 'rewritten decision note' where id = '${done.id}'; rollback;`)).toMatch(/binding of a proposal is fixed|not a legal transition|only through/);
      expect(psqlError(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_change_requests where id = '${done.id}'; rollback;`)).toMatch(/never deleted/);
      expect(psqlError(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_change_requests; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.studio_sms_price_change_requests'::regclass and not tgisinternal and tgenabled = 'A'`)).toBe("2");
    });

    it("PD-12 a request row cannot be inserted: not directly, not pre-decided, not for another requester; the function is the only creator", () => {
      const ins = () => `insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, expires_at)
        values ('sms_usage', 5, 1, 'forged request', 'a forged request row', '${A}', now() + interval '1 hour');`;
      expect(psqlError(ins())).toMatch(/created only by tw4_price_propose/);
      // with the write flag the row is BORN pending whatever the insert supplies
      const id = psql(`begin; select set_config('tw4.pricedual_write', 'on', true); insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, requested_by, expires_at, status, decided_by, decided_at, decision_note)
        values ('sms_usage', 5, 1, 'forged request', 'a forged request row', '${A}', now() + interval '1 hour', 'approved', '${B}', now(), '${NOTE}') returning id; commit;`).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l))!;
      expect(preq(id)).toMatchObject({ status: "pending", decided_by: null });
      reject(id, A, "withdrawn: the forged-insert scenario is over");
    });

    it("PD-13 an approval of one price cannot publish another: inside the approval's own transaction, an insert with different amounts, description, kind or created_by is refused; only the exactly approved row is accepted (owner-level proof of the trigger, rolled back)", () => {
      clearOpen("number");
      const p = propose("number", 313, A);
      const pre = `begin; select set_config('tw4.pricedual_write', 'on', true);
        update public.studio_sms_price_change_requests set status = 'approved', decided_by = '${B}', decided_at = now(), decision_note = '${NOTE}' where id = '${p.request_id}';
        update public.studio_sms_price_list set active = false where kind = 'number' and active;`;
      const ins = (kind: string, cents: number, provider: number, desc: string, by: string) =>
        `insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by) values ('${kind}', ${cents}, ${provider}, '${desc}', '${by}');`;
      const d = "dual-control price change under test";
      expect(psqlError(`${pre} ${ins("number", 314, 150, d, B)} rollback;`)).toMatch(/approved price change/); // other amount
      expect(psqlError(`${pre} ${ins("number", 313, 151, d, B)} rollback;`)).toMatch(/approved price change/); // other provider cost
      expect(psqlError(`${pre} ${ins("number", 313, 150, "another description", B)} rollback;`)).toMatch(/approved price change/);
      expect(psqlError(`${pre} ${ins("monthly", 313, 150, d, B)} rollback;`)).toMatch(/approved price change/); // other kind
      expect(psqlError(`${pre} ${ins("number", 313, 150, d, A)} rollback;`)).toMatch(/approved price change/); // created_by is the requester, not the decider
      expect(psqlError(`${pre} ${ins("number", 313, 150, d, B)} rollback;`)).toBe(""); // exactly the approved row (nothing is kept: rolled back)
      // a request that is only PENDING (or rejected, expired, applied already) authorizes no insert
      expect(psqlError(`begin; update public.studio_sms_price_list set active = false where kind = 'number' and active; ${ins("number", 313, 150, d, B)} rollback;`)).toMatch(/approved price change/);
      expect(preq(p.request_id).status).toBe("pending");
      expect(priceRows("number", 313)).toBe(0);
      reject(p.request_id, A, "withdrawn to start the next scenario clean");
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); ${ins("number", 313, 150, d, B)} rollback;`)).toMatch(/approved price change/);
    });

    it("PD-14 forged actor: the actor is a parameter the caller owns, but a forged requester id gets no further than the database checks (a non-administrator, a banned one or the requester themselves is refused; a fabricated unknown id is refused)", () => {
      clearOpen("number");
      const p = propose("number", 314, A);
      expect(codeOf(approveErr(p.request_id, "22222222-2222-4222-8222-222222222222"))).toBe("42501");
      expect(codeOf(callErr("_tw4price_do_approve", p.request_id, null, NOTE))).toBe("42501");
      expect(codeOf(proposeErr("number", 3141, "22222222-2222-4222-8222-222222222222"))).toBe("42501");
      expect(codeOf(callErr("_tw4price_do_approve", "33333333-3333-4333-8333-333333333333", B, NOTE))).toBe("22023"); // unknown request
      expect(codeOf(approveErr(p.request_id, B, "short"))).toBe("22023"); // a written note is mandatory
      expect(preq(p.request_id).status).toBe("pending");
      reject(p.request_id, A, "withdrawn to start the next scenario clean");
    });

    it("PD-15 replay of a decided request: an applied request is not re-applied for its approver (replayed), nor by anyone else (TW041); rejected / expired / invalidated ones stay final; exactly one price row ever", () => {
      clearOpen("number");
      const p = propose("number", 315, A);
      const out = approve(p.request_id, B);
      for (let i = 0; i < 3; i++) expect(approve(p.request_id, B)).toMatchObject({ status: "applied", replayed: true, price_id: out.price_id });
      expect(codeOf(approveErr(p.request_id, F))).toBe("TW041");
      expect(priceRows("number", 315)).toBe(1);
      expect(num(`select count(*) from public.studio_sms_price_list where created_by = '${B}' and customer_price_cents = 315`)).toBe(1);
    });
  });

  describe("concurrency (two real database connections)", () => {
    type Res = { out: string; code: number | null };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond: string, ms = 15_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (psql(`select (${cond})::text`) === "true") return;
        await sleep(150);
      }
      throw new Error(`timed out waiting for: ${cond}`);
    };
    let marker = 3_000;
    /** Session 1 runs its statements and then sleeps while still holding its locks (a unique sleep length identifies it); session 2 starts only once session 1 is sleeping, and
     *  is released to finish only after session 2 is provably BLOCKED on a lock. Returns both results. Deterministic: no timing guess. */
    async function race(first: string, second: string): Promise<[Res, Res]> {
      marker += 1;
      const hold = `${(marker / 1000).toFixed(3)}`;
      const s1 = sessionPsql(`begin; ${first} select pg_sleep(${Number(hold) + 3}); commit;`);
      await until(`exists (select 1 from pg_stat_activity where datname = '${DB}' and query like '%pg_sleep(${Number(hold) + 3})%' and wait_event = 'PgSleep')`);
      const s2 = sessionPsql(second);
      await until(`exists (select 1 from pg_stat_activity where datname = '${DB}' and wait_event_type = 'Lock')`);
      return Promise.all([s1, s2]);
    }
    const appr = (id: string, who: string) => `select public._tw4price_do_approve('${id}', '${who}', '${NOTE}')::text;`;

    it("PD-16 two administrators approve the SAME request at the same moment: exactly one publishes, the other is refused TW041, one active price, one price row, the request is decided by the winner", async () => {
      clearOpen("number");
      const p = propose("number", 316, A);
      const [x, y] = await race(appr(p.request_id, B), appr(p.request_id, F));
      expect(x.out).toContain('"status": "applied"');
      expect(x.code).toBe(0);
      expect(y.code).not.toBe(0);
      expect(codeOf(y.out)).toBe("TW041");
      expect(priceRows("number", 316)).toBe(1);
      expect(num(`select count(*) from public.studio_sms_price_list where kind = 'number' and active`)).toBe(1);
      expect(preq(p.request_id)).toMatchObject({ status: "applied", decided_by: B });
    });

    it("PD-17 the same administrator approves twice concurrently: one publish, one replay; an approval racing a rejection has exactly one winner in either order", async () => {
      clearOpen("number");
      const p = propose("number", 317, A);
      const [a, b] = await race(appr(p.request_id, B), appr(p.request_id, B));
      expect(a.out).toContain('"replayed": false');
      expect(b.out).toContain('"replayed": true');
      expect(priceRows("number", 317)).toBe(1);
      // approval holds, rejection arrives second: the rejection loses
      const q = propose("number", 3171, A);
      const [ap, rj] = await race(appr(q.request_id, B), `select public._tw4price_do_reject('${q.request_id}', '${F}', 'rejected while the approval was in flight')::text;`);
      expect(ap.out).toContain('"status": "applied"');
      expect(codeOf(rj.out)).toBe("TW041");
      expect(preq(q.request_id).status).toBe("applied");
      expect(priceRows("number", 3171)).toBe(1);
      // rejection holds, approval arrives second: the approval loses
      const s = propose("number", 3172, A);
      const [rj2, ap2] = await race(`select public._tw4price_do_reject('${s.request_id}', '${F}', 'rejected before the approval arrived')::text;`, appr(s.request_id, B));
      expect(rj2.out).toContain('"status": "rejected"');
      expect(codeOf(ap2.out)).toBe("TW041");
      expect(priceRows("number", 3172)).toBe(0);
    });

    it("PD-18 two proposals for the same kind race: one pending request, the other TW041; an approver demoted while their approval waits for the lock is refused 42501 and nothing is published", async () => {
      clearOpen("number");
      const prop = (cents: number, who: string) => `select public._tw4price_do_propose('number', ${cents}, 150, 'dual-control price change under test', 'a written reason for the race', '${who}')::text;`;
      const [a, b] = await race(prop(3181, A), prop(3182, B));
      expect(a.out).toContain('"status": "pending"');
      expect(codeOf(b.out)).toBe("TW041");
      expect(num(`select count(*) from public.studio_sms_price_change_requests where kind = 'number' and status in ('pending', 'approved')`)).toBe(1);
      const open = rows<{ id: string }>(`select id from public.studio_sms_price_change_requests where kind = 'number' and status = 'pending'`)[0].id;
      const ap = mkAdmin("price-approver-race");
      const [demote, approval] = await race(`update public.profiles set platform_role = null where id = '${ap}';`, appr(open, ap));
      expect(demote.code).toBe(0);
      expect(codeOf(approval.out)).toBe("42501");
      expect(preq(open).status).toBe("pending");
      expect(active("number")[0].customer_price_cents).not.toBe(3181);
      reject(open, A, "withdrawn to start the next scenario clean");
    });
  });

  describe("F1: published prices are undeletable, untruncatable and unrepeatable, also under session_replication_role = replica", () => {
    const superuser = (sql: string): string => {
      try {
        return execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "supabase_admin", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) && "";
      } catch (error) {
        return String((error as { stderr?: Buffer | string }).stderr ?? error);
      }
    };
    const ins = `insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by) values ('number', 999, 100, 'bypass attempt', '${A}');`;
    it("PD-02b the owner (postgres) in replica mode cannot DELETE, TRUNCATE (direct or CASCADE) or retire-then-insert a published price", () => {
      const before = [num(`select count(*) from public.studio_sms_price_list`), active("number")];
      expect(psqlError(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_list where active; rollback;`)).toMatch(/never deleted/);
      expect(psqlError(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_list; rollback;`)).toMatch(/never deleted/);
      expect(psqlError(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_list; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(psqlError(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_list cascade; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(psqlError(`begin; truncate public.studio_sms_price_list cascade; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(psqlError(`begin; set local session_replication_role = replica; update public.studio_sms_price_list set active = false where kind = 'number' and active; ${ins} rollback;`)).toMatch(/approved price change/);
      expect([num(`select count(*) from public.studio_sms_price_list`), active("number")]).toEqual(before);
    });
    it("PD-02c the same as a superuser (supabase_admin) when the harness has that role: delete, truncate and insert are refused in replica mode", () => {
      if (psql(`select count(*) from pg_roles where rolname = 'supabase_admin' and rolsuper`) !== "1") return;
      expect(superuser(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_list; rollback;`)).toMatch(/never deleted/);
      expect(superuser(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_list cascade; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(superuser(`begin; set local session_replication_role = replica; ${ins} rollback;`)).toMatch(/approved price change/);
    });
  });

  describe("protected approver registry and session-bound entry points", () => {
    const claims = (sub: string, over: Record<string, unknown> = {}) => ({ sub, role: "authenticated", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 60 }], ...over });
    const asAuth = (c: Record<string, unknown> | null, sql: string, role = "authenticated") =>
      `begin; set local role ${role}; select set_config('request.jwt.claims', '${JSON.stringify(c ?? {})}', true); ${sql} commit;`;
    const authErr = (c: Record<string, unknown> | null, sql: string, role = "authenticated") => psqlError(asAuth(c, sql, role));
    const authOut = (c: Record<string, unknown> | null, sql: string) => JSON.parse(psql(asAuth(c, sql)).split("\n").pop()!) as Record<string, unknown>;
    const wrapPropose = (cents: number) => `select public.tw4_price_propose('number', ${cents}, 115, 'session bound proposal', 'a written reason for the session test')::text;`;
    const wrapApprove = (id: string) => `select public.tw4_price_approve('${id}', '${NOTE}')::text;`;

    it("PD-24 the registry: a platform administrator who is NOT registered (or whose registration was revoked) can neither propose, approve, reject nor list; the registry cannot be changed by API roles, revived or deleted; profile forgery alone gains nothing", () => {
      clearOpen("number");
      const u = mkUser({ admin: true, label: "unregistered-admin" });
      expect(codeOf(proposeErr("number", 401, u))).toBe("42501");
      const p = propose("number", 402, A);
      expect(codeOf(approveErr(p.request_id, u))).toBe("42501");
      expect(codeOf(rejectErr(p.request_id, u))).toBe("42501");
      expect(codeOf(callErr("_tw4price_do_list", u))).toBe("42501");
      // role forged on the profile (what a service-role holder can do) still does not make a registered approver
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psqlError(`set role ${role}; insert into public.studio_sms_price_approvers (user_id, added_note) values ('${u}', 'a forged registration attempt');`), role).toMatch(/permission denied/);
        expect(psqlError(`set role ${role}; select count(*) from public.studio_sms_price_approvers;`), role).toMatch(/permission denied/);
      }
      // registered, then revoked
      const v = mkAdmin("revoked-admin");
      psql(`update public.studio_sms_price_approvers set revoked_at = now(), revoked_note = 'revoked in the registry test' where user_id = '${v}';`);
      expect(codeOf(approveErr(p.request_id, v))).toBe("42501");
      expect(codeOf(proposeErr("monthly", 1999, v))).toBe("42501");
      expect(psqlError(`update public.studio_sms_price_approvers set revoked_at = null, revoked_note = null where user_id = '${v}';`)).toMatch(/can only be revoked, once/);
      expect(psqlError(`delete from public.studio_sms_price_approvers where user_id = '${v}';`)).toMatch(/never deleted/);
      expect(psqlError(`begin; set local session_replication_role = replica; delete from public.studio_sms_price_approvers where user_id = '${v}'; rollback;`)).toMatch(/never deleted/);
      expect(psqlError(`begin; set local session_replication_role = replica; truncate public.studio_sms_price_approvers; rollback;`)).toMatch(/never truncated|cannot truncate a table referenced in a foreign key/);
      expect(preq(p.request_id).status).toBe("pending");
      reject(p.request_id, A, "withdrawn to start the next scenario clean");
    });

    it("PD-25 the public entry points take the identity from the caller's own JWT: aal1, a stale or absent TOTP, a service-role or anon token, and a swapped claim set are refused; a fresh aal2 registered administrator is accepted; there is no actor argument", () => {
      clearOpen("number");
      const base = active("number")[0];
      const before = active("number");
      const bad: Array<[string, Record<string, unknown> | null]> = [
        ["aal1", claims(A, { aal: "aal1", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] })],
        ["stale totp", claims(A, { amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 1000 }] })],
        ["no totp", claims(A, { amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] })],
        ["totp without a timestamp (string amr)", claims(A, { amr: ["totp"] })],
        ["service_role claim", claims(A, { role: "service_role" })],
        ["anon claim", { role: "anon" }],
        ["no claims", null],
      ];
      for (const [label, c] of bad) {
        expect(codeOf(authErr(c, wrapPropose(501))), `propose ${label}`).toBe("42501");
      }
      expect(num(`select count(*) from public.studio_sms_price_change_requests where kind = 'number' and status = 'pending'`)).toBe(0);
      // fresh aal2 + recent TOTP, registered: accepted; the requester recorded is the JWT subject
      const r = authOut(claims(A), wrapPropose(502)) as { request_id: string };
      expect(preq(r.request_id)).toMatchObject({ status: "pending", requested_by: A });
      // a stale-TOTP / aal1 approver is refused; the requester cannot approve their own; an unregistered subject cannot
      expect(codeOf(authErr(claims(B, { amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 1000 }] }), wrapApprove(r.request_id)))).toBe("42501");
      expect(codeOf(authErr(claims(B, { aal: "aal1" }), wrapApprove(r.request_id)))).toBe("42501");
      expect(codeOf(authErr(claims(A), wrapApprove(r.request_id)))).toBe("42501"); // the requester
      expect(codeOf(authErr(claims(C), wrapApprove(r.request_id)))).toBe("42501"); // not an administrator
      expect(active("number")).toEqual(before);
      // reject needs aal2 with a TOTP, not recency
      expect(codeOf(authErr(claims(F, { aal: "aal1" }), `select public.tw4_price_reject('${r.request_id}', 'rejected with an aal1 session attempt')::text;`))).toBe("42501");
      // the approval by B (fresh aal2) publishes exactly this request's price
      const out = authOut(claims(B), wrapApprove(r.request_id));
      expect(out).toMatchObject({ status: "applied" });
      expect(preq(r.request_id)).toMatchObject({ status: "applied", requested_by: A, decided_by: B });
      expect(active("number")[0].id).not.toBe(base.id);
      // list: aal2 registered only
      expect(codeOf(authErr(claims(A, { aal: "aal1" }), `select public.tw4_price_requests_list()::text;`))).toBe("42501");
      expect(Array.isArray((authOut(claims(A, { amr: [{ method: "totp", timestamp: 1 }] }), `select public.tw4_price_requests_list()::text;`) as { requests: unknown[] }).requests)).toBe(true);
      // the old actor-taking shape does not exist any more on the public names
      expect(psqlError(`select public.tw4_price_approve('${r.request_id}'::uuid, '${B}'::uuid, '${NOTE}');`)).toMatch(/does not exist|function public\.tw4_price_approve/);
      expect(psqlError(`select public.tw4_price_propose('number', 1, 1, 'a description', 'a written reason text', '${A}'::uuid);`)).toMatch(/does not exist|function public\.tw4_price_propose/);
    });

    it("PD-26 service_role cannot reach any price entry point: no EXECUTE on the public functions, the internal functions or the helpers; the only function it keeps is the refusing tw4_price_set and the read-only verifier", () => {
      for (const f of ["tw4_price_propose(text,int,int,text,text)", "tw4_price_approve(uuid,text)", "tw4_price_reject(uuid,text)", "tw4_price_requests_list()", "_tw4price_do_propose(text,int,int,text,text,uuid)",
        "_tw4price_do_approve(uuid,uuid,text)", "_tw4price_do_reject(uuid,uuid,text)", "_tw4price_do_list(uuid)", "_tw4price_session_actor(text)", "_tw4price_admin_active(uuid)"]) {
        expect(psql(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), `service_role ${f}`).toBe("f");
      }
      for (const f of ["tw4_price_propose(text,int,int,text,text)", "tw4_price_approve(uuid,text)", "tw4_price_reject(uuid,text)", "tw4_price_requests_list()"]) {
        expect(psql(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), `authenticated ${f}`).toBe("t");
        expect(psql(`select has_function_privilege('anon', 'public.${f}', 'execute')`), `anon ${f}`).toBe("f");
        expect(psql(`select has_function_privilege('public', 'public.${f}', 'execute')`), `public ${f}`).toBe("f");
      }
      expect(psql(`select has_function_privilege('authenticated', 'public.tw4_price_verify(timestamptz)', 'execute') or has_function_privilege('anon', 'public.tw4_price_verify(timestamptz)', 'execute')`)).toBe("f");
      expect(psql(`select has_function_privilege('service_role', 'public.tw4_price_verify(timestamptz)', 'execute')`)).toBe("t");
      // the end to end impersonation attempt: a service-role session proposes as A and approves as B in two calls
      const e1 = psqlError(`set role service_role; select public._tw4price_do_propose('number', 777, 115, 'impersonation attempt', 'service role impersonation test', '${A}'::uuid);`);
      expect(e1).toMatch(/permission denied/);
      const e2 = psqlError(`set role service_role; select public.tw4_price_propose('number', 777, 115, 'impersonation attempt', 'service role impersonation test');`);
      expect(e2).toMatch(/permission denied/);
      expect(num(`select count(*) from public.studio_sms_price_change_requests where description = 'impersonation attempt'`)).toBe(0);
    });
  });

  describe("verifier", () => {
    it("PD-27 tw4_price_verify: clean on this database (every published price is attested by two distinct registered administrators); flags a forged price row, a forged applied request and an unregistered approver (owner-level forgeries, rolled back)", () => {
      const clean = JSON.parse(psql(`select public.tw4_price_verify()::text`)) as { ok: boolean; anomalies: unknown[] };
      expect(clean.anomalies).toEqual([]);
      expect(clean.ok).toBe(true);
      // forged price: the owner switches the guard off and inserts a retired row nobody approved
      const forged = psql(`begin; alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
        insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, active, created_by) values ('number', 5, 1, 'forged price row', false, '${A}');
        select public.tw4_price_verify()::text; rollback;`).split("\n").filter((l) => l.startsWith("{")).pop()!;
      const f = JSON.parse(forged) as { ok: boolean; anomalies: { code: string; kind: string }[] };
      expect(f.ok).toBe(false);
      expect(f.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({ code: "price_unattested", kind: "number" })]));
      // forged state: an applied request rewritten to an 'approved' row that never moved on (and so no longer attests its price)
      const forged2 = psql(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
        update public.studio_sms_price_change_requests set status = 'approved', applied_price_id = null, applied_at = null where id = (select id from public.studio_sms_price_change_requests where status = 'applied' limit 1);
        select public.tw4_price_verify()::text; rollback;`).split("\n").filter((l) => l.startsWith("{")).pop()!;
      expect((JSON.parse(forged2) as { anomalies: { code: string }[] }).anomalies.map((a) => a.code)).toEqual(expect.arrayContaining(["request_anomaly", "price_unattested"]));
      // an approver who was not registered when he approved
      const forged3 = psql(`begin; alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard;
        update public.studio_sms_price_approvers set added_at = now() + interval '1 day' where user_id = '${B}';
        select public.tw4_price_verify()::text; rollback;`).split("\n").filter((l) => l.startsWith("{")).pop()!;
      expect((JSON.parse(forged3) as { ok: boolean }).ok).toBe(false);
      // p_since narrows the look to newer prices
      expect((JSON.parse(psql(`select public.tw4_price_verify(now() + interval '1 hour')::text`)) as { ok: boolean }).ok).toBe(true);
    });
  });

  describe("limits as data (F2): shipped values are proposals and enforce nothing until the owner approves", () => {
    it("PD-28 an unapproved limit row enforces nothing; an owner-approved row bounds the customer price, the provider cost, the provider/customer ratio and the step change; removing it lifts the bound", () => {
      clearOpen("brand_low_volume");
      const base = active("brand_low_volume")[0];
      expect(base).toBeTruthy();
      const lim = (approved: boolean) => `insert into public.studio_sms_price_limits (kind, max_customer_cents, max_provider_cents, max_provider_pct_of_customer, max_step_pct, approved, approved_by_note, approved_at)
        values ('brand_low_volume', 2000, 1000, 80, 20, ${approved}, ${approved ? "'owner approved in the limits test'" : "null"}, ${approved ? "now()" : "null"})`;
      // the shipped rows are proposals only: eight kinds, none approved, none enforced
      expect(psql(`select count(*) || ':' || count(*) filter (where approved) from public.studio_sms_price_limits`)).toBe("8:0");
      expect(psql(`select string_agg(kind, ',' order by kind) from public.studio_sms_price_limits`)).toBe(psql(`select array_to_string(public._tw4price_kinds(), ',')`));
      psql(`delete from public.studio_sms_price_limits where kind = 'brand_low_volume';`);
      psql(`${lim(false)};`);
      const free = propose("brand_low_volume", 9000, A, 8000);
      expect(free.status).toBe("pending"); // not enforced
      reject(free.request_id, A, "withdrawn: the unapproved limit enforced nothing");
      psql(`delete from public.studio_sms_price_limits where kind = 'brand_low_volume';`);
      psql(`${lim(true)};`);
      expect(codeOf(proposeErr("brand_low_volume", 2100, A, 400))).toBe("22023"); // customer ceiling
      expect(codeOf(proposeErr("brand_low_volume", 1600, A, 1100))).toBe("22023"); // provider ceiling
      expect(codeOf(proposeErr("brand_low_volume", 1600, A, 1400))).toBe("22023"); // provider above 80 percent of the customer price
      expect(codeOf(proposeErr("brand_low_volume", 1900, A, 400))).toBe("22023"); // step change above 20 percent (1500 -> 1900 is 26.7 percent)
      const ok = propose("brand_low_volume", 1700, A, 450); // 13.3 percent step, ratio 26 percent
      expect(ok.status).toBe("pending");
      reject(ok.request_id, A, "withdrawn: the approved limit accepted a value inside it");
      expect(psqlError(`insert into public.studio_sms_price_limits (kind, max_customer_cents, max_provider_cents, approved) values ('x', 1, 1, true);`)).toMatch(/check constraint/); // approval needs a note and a time
      psql(`delete from public.studio_sms_price_limits where kind = 'brand_low_volume';`);
      const lifted = propose("brand_low_volume", 9000, A, 8000);
      expect(lifted.status).toBe("pending");
      reject(lifted.request_id, A, "withdrawn: the removed limit lifted the bound");
      for (const role of ["anon", "authenticated", "service_role"]) expect(psqlError(`set role ${role}; insert into public.studio_sms_price_limits (kind, max_customer_cents, max_provider_cents) values ('number', 1, 1);`), role).toMatch(/permission denied/);
    });
  });

  describe("fail-closed rollback and recovery (executed inside transactions that are rolled back)", () => {
    const strip = (s: string) => s.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
    const forwardSql = () => noTx(mig("20270204090000_twilio_price_dual_control.sql")) + noTx(mig("20270204100000_twilio_price_owner_authorization.sql"));
    const noSingleAdmin = `
      if has_function_privilege('service_role', 'public.tw4_price_set(text,integer,integer,text,uuid)', 'execute') then raise exception 'RB: service_role can still execute tw4_price_set'; end if;
      begin perform public.tw4_price_set('number', 1, 1, 'single admin attempt', '${A}'); raise exception 'RB: tw4_price_set published'; exception when sqlstate 'TW042' then null; end;
      begin insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by) values ('number', 1, 1, 'direct insert after rollback', '${A}'); raise exception 'RB: a direct insert was accepted'; exception when sqlstate '42501' then null; end;
      begin delete from public.studio_sms_price_list; raise exception 'RB: a delete was accepted'; exception when sqlstate '42501' then null; end;
      if to_regprocedure('public.tw4_price_approve(uuid,text)') is not null or to_regprocedure('public._tw4price_do_approve(uuid,uuid,text)') is not null then raise exception 'RB: approve functions remain'; end if;
      if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.tw4_price_set(text,integer,integer,text,uuid)'::regprocedure) = '36b3548cfa94cce34e7df10c2a74981f' then raise exception 'RB: the old executable body was restored'; end if;`;
    const reapplied = (kindsExpected: number) => `
      if to_regprocedure('public.tw4_price_approve(uuid,text)') is null or to_regprocedure('public._tw4price_do_approve(uuid,uuid,text)') is null then raise exception 'RA: functions missing after re-apply'; end if;
      if has_function_privilege('service_role', 'public.tw4_price_approve(uuid,text)', 'execute') or not has_function_privilege('authenticated', 'public.tw4_price_approve(uuid,text)', 'execute') then raise exception 'RA: grants wrong after re-apply'; end if;
      if not has_function_privilege('service_role', 'public.tw4_price_set(text,integer,integer,text,uuid)', 'execute') then raise exception 'RA: tw4_price_set grant not restored'; end if;
      if (select count(*) from pg_trigger where tgname in ('studio_sms_price_list_00_activation', 'studio_sms_price_list_00_truncate', 'studio_sms_price_change_requests_guard', 'studio_sms_price_change_requests_truncate', 'studio_sms_price_approvers_guard', 'studio_sms_price_approvers_truncate') and tgenabled = 'A') <> 6 then raise exception 'RA: triggers not always-on'; end if;
      if ${kindsExpected} >= 0 and (select count(*) from public.studio_sms_price_change_requests) <> ${kindsExpected} then raise exception 'RA: request rows not retained'; end if;`;

    it("PD-23 rollback WITH evidence: the tables and every request row are retained, no function can publish, the single-admin path stays closed (tw4_price_set refuses, EXECUTE revoked, direct insert/delete refused), then the forward migration re-applies over the retained tables with the rows intact", () => {
      expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBeGreaterThan(0);
      const n = num(`select count(*) from public.studio_sms_price_change_requests`);
      const err = psqlError(`begin; ${strip(rollbackSql())}
        do $t$ begin
          if to_regclass('public.studio_sms_price_change_requests') is null or to_regclass('public.studio_sms_price_approvers') is null or to_regclass('public.studio_sms_price_limits') is null then raise exception 'RB: evidence tables dropped'; end if;
          if (select count(*) from public.studio_sms_price_change_requests) <> ${n} then raise exception 'RB: request rows changed'; end if;
          ${noSingleAdmin}
        end $t$;
        ${strip(forwardSql())}
        do $t$ begin ${reapplied(n)}
          -- the workflow works again after recovery
          perform public._tw4price_do_reject((public._tw4price_do_propose('monthly', 1777, 150, 'recovery check price', 'a written reason for the recovery check', '${A}')->>'request_id')::uuid, '${A}', 'withdrawn after the recovery check');
        end $t$;
        rollback;`);
      expect(err).toBe("");
      expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBe(n);
      expect(codeOf(callErr("tw4_price_set", "number", 1, 1, "still closed", A))).toBe("TW042");
    });

    it("PD-23b rollback with NO evidence: the three tables are dropped, nothing can publish a price (tw4_price_set refuses and has no EXECUTE for anyone, the price-list insert guard refuses every insert), and the forward migration re-applies cleanly and works", () => {
      const err = psqlError(`begin;
        alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
        delete from public.studio_sms_price_change_requests;
        alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
        alter table public.studio_sms_price_approvers disable trigger studio_sms_price_approvers_guard;
        delete from public.studio_sms_price_approvers;
        alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_guard;
        ${strip(rollbackSql())}
        do $t$ begin
          if to_regclass('public.studio_sms_price_change_requests') is not null or to_regclass('public.studio_sms_price_approvers') is not null or to_regclass('public.studio_sms_price_limits') is not null then raise exception 'RB: tables remain'; end if;
          ${noSingleAdmin}
        end $t$;
        ${strip(forwardSql())}
        do $t$ begin ${reapplied(0)}
          insert into public.studio_sms_price_approvers (user_id, added_note) values ('${A}', 'registered after the recovery'), ('${B}', 'registered after the recovery');
          perform public._tw4price_do_approve((public._tw4price_do_propose('monthly', 1778, 150, 'recovery check price', 'a written reason for the recovery check', '${A}')->>'request_id')::uuid, '${B}', '${NOTE}');
          if (select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active) <> 1778 then raise exception 'RA: the workflow did not publish'; end if;
        end $t$;
        rollback;`);
      expect(err).toBe("");
      expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null`)).toBe("t");
    });

    it("PD-23c the rollback refuses (55000) when a later slice replaced tw4_price_set or a guarded function, and changes nothing", () => {
      const err = psqlError(`begin; create or replace function public.tw4_price_set(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
        returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $f$ begin return null; end $f$;
        ${strip(rollbackSql())} rollback;`);
      expect(codeOf(err)).toBe("55000");
      expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null and to_regprocedure('public._tw4price_do_approve(uuid,uuid,text)') is not null`)).toBe("t");
    });
  });

  describe("privileges, read model, rollback and money", () => {
    it("PD-19 grants and shape: the public functions are security definer with a pinned search_path and executable by authenticated only; tw4_price_set keeps its service-role grant; internal functions and helpers by nobody; no API-role privilege, no policy and RLS on for the three tables", () => {
      for (const f of ["tw4_price_propose(text,int,int,text,text)", "tw4_price_approve(uuid,text)", "tw4_price_reject(uuid,text)", "tw4_price_requests_list()", "tw4_price_verify(timestamptz)", "tw4_price_set(text,int,int,text,uuid)",
        "_tw4price_do_propose(text,int,int,text,text,uuid)", "_tw4price_do_approve(uuid,uuid,text)", "_tw4price_do_reject(uuid,uuid,text)", "_tw4price_do_list(uuid)"]) {
        expect(psql(`select p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p where p.oid = 'public.${f}'::regprocedure`), f).toBe("true:search_path=pg_catalog, public, pg_temp");
      }
      for (const f of ["_tw4price_admin_active(uuid)", "_tw4price_registered_at(uuid,timestamptz)", "_tw4price_session_actor(text)", "_tw4price_kinds()", "_tw4pricedual_guard()", "_tw4price_activation_guard()", "_tw4price_truncate_guard()", "_tw4price_registry_guard()",
        "_tw4price_do_propose(text,int,int,text,text,uuid)", "_tw4price_do_approve(uuid,uuid,text)", "_tw4price_do_reject(uuid,uuid,text)", "_tw4price_do_list(uuid)"]) {
        for (const role of ["anon", "authenticated", "service_role", "public"]) expect(psql(`select has_function_privilege('${role}', 'public.${f}', 'execute')`), `${role} ${f}`).toBe("f");
      }
      for (const table of ["studio_sms_price_change_requests", "studio_sms_price_approvers", "studio_sms_price_limits"]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(psql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = '${table}' and grantee = '${role}'`), `${role} ${table}`).toBe("0");
          expect(psqlError(`set role ${role}; select count(*) from public.${table};`), `${role} ${table}`).toMatch(/permission denied/);
        }
        expect(psql(`select relrowsecurity::text from pg_class where oid = 'public.${table}'::regclass`)).toBe("true");
        expect(psql(`select count(*) from pg_policies where tablename = '${table}'`)).toBe("0");
      }
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.studio_sms_price_change_requests'::regclass and not tgisinternal and tgenabled = 'A'`)).toBe("2");
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.studio_sms_price_approvers'::regclass and not tgisinternal and tgenabled = 'A'`)).toBe("3");
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.studio_sms_price_list'::regclass and tgname like 'studio_sms_price_list_00_%' and tgenabled = 'A'`)).toBe("2");
    });

    it("PD-20 the list is administrator-only and read-only: it returns the active prices and the latest requests, shows an overdue pending request as expired WITHOUT writing, and a non-administrator gets 42501", () => {
      clearOpen("number");
      const p = propose("number", 320, A);
      ageRequest(p.request_id);
      expect(codeOf(callErr("_tw4price_do_list", C))).toBe("42501");
      expect(codeOf(callErr("_tw4price_do_list", E))).toBe("42501");
      const list = call<{ active: { kind: string }[]; requests: { request_id: string; status: string; base_changed: boolean }[] }>("_tw4price_do_list", B);
      expect(list.active.map((a) => a.kind)).toEqual(expect.arrayContaining(["number", "monthly"]));
      expect(list.requests.find((r) => r.request_id === p.request_id)).toMatchObject({ status: "expired", base_changed: false });
      expect(preq(p.request_id).status).toBe("pending"); // reading did not write
      expect(approve(p.request_id, B)).toMatchObject({ status: "expired" });
    });

    it("PD-21 the audit trail: requester, decider, note, decided_at, applied price and applied_at are recorded for an applied request; the base amounts are a snapshot", () => {
      clearOpen("number");
      const base = active("number")[0];
      const p = propose("number", 321, A, 119, "audit trail price", "a written reason for the audit trail");
      const out = approve(p.request_id, B);
      const row = rows<Record<string, string | number | null>>(`select requested_by, decided_by, decision_note, decided_at is not null as decided, applied_price_id, applied_at is not null as applied, base_price_id, base_customer_price_cents,
        base_provider_cost_cents, reason, description, customer_price_cents, provider_cost_cents from public.studio_sms_price_change_requests where id = '${p.request_id}'`)[0];
      expect(row).toMatchObject({ requested_by: A, decided_by: B, decision_note: NOTE, decided: true, applied_price_id: out.price_id, applied: true, base_price_id: base.id, base_customer_price_cents: base.customer_price_cents,
        base_provider_cost_cents: base.provider_cost_cents, reason: "a written reason for the audit trail", description: "audit trail price", customer_price_cents: 321, provider_cost_cents: 119 });
    });

    it("PD-22 a price change moves no money: balances, reservations and the credit ledger of a funded business are identical before and after a proposal, an approval and a rejection", () => {
      clearOpen("number");
      const w = world();
      const before = money(w);
      const ledger = psql(`select count(*) from public.studio_sms_credit_ledger`);
      const p = propose("number", 322, A);
      approve(p.request_id, B);
      const q = propose("number", 3221, A);
      reject(q.request_id, B);
      expect(money(w)).toBe(before);
      expect(psql(`select count(*) from public.studio_sms_credit_ledger`)).toBe(ledger);
    });
  });
});
