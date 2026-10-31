/**
 * D4-1: dual-controlled SMS price changes (migration 20270204090000), on a throwaway DEV-equivalent database with synthetic administrators.
 * Cast (wpd4Helpers): A, B platform administrators; C not an administrator; D administrator (session assurance is the action layer's job, see localStack.wpd4actions
 * and localStack.pricedualactions); E deactivated administrator; F a third administrator; G administrator whose auth user is banned.
 *
 * LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB and the tw4_local_qa_only marker. Nothing reaches Twilio, Stripe or any message channel.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { A, B, C, D, E, F, G, DB, NOTE, PG, call, callErr, codeOf, enabled, mkUser, money, num, psql, psqlError, replica, rows, seedCast, seedPrices, setRole, world } from "./wpd4Helpers";
import { ownerReactivate } from "./priceFixture";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const active = (kind: string) => rows<{ id: string; customer_price_cents: number; provider_cost_cents: number; created_by: string }>(
  `select id, customer_price_cents, provider_cost_cents, created_by from public.studio_sms_price_list where kind = '${kind}' and active`);
const priceRows = (kind: string, cents: number) => num(`select count(*) from public.studio_sms_price_list where kind = '${kind}' and customer_price_cents = ${cents}`);
const propose = (kind: string, cents: number, actor: string, provider = 150, description = "dual-control price change under test", reason = "a written reason for the price change under test") =>
  call<{ request_id: string; status: string; replayed: boolean }>("tw4_price_propose", kind, cents, provider, description, reason, actor);
const proposeErr = (kind: string, cents: number, actor: string, provider = 150, description = "dual-control price change under test", reason = "a written reason for the price change under test") =>
  callErr("tw4_price_propose", kind, cents, provider, description, reason, actor);
const approve = (id: string, actor: string, note = NOTE) => call<{ status: string; replayed?: boolean; price_id?: string }>("tw4_price_approve", id, actor, note);
const approveErr = (id: string, actor: string, note = NOTE) => callErr("tw4_price_approve", id, actor, note);
const reject = (id: string, actor: string, note = "rejected after review of the proposal") => call<{ status: string; replayed?: boolean; withdrawn?: boolean }>("tw4_price_reject", id, actor, note);
const rejectErr = (id: string, actor: string, note = "rejected after review of the proposal") => callErr("tw4_price_reject", id, actor, note);
const preq = (id: string) => rows<{ status: string; requested_by: string; decided_by: string | null; applied_price_id: string | null; decision_note: string | null; base_price_id: string | null }>(
  `select status, requested_by, decided_by, applied_price_id, decision_note, base_price_id from public.studio_sms_price_change_requests where id = '${id}'`)[0];
const ageRequest = (id: string) => replica(`update public.studio_sms_price_change_requests set requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours' where id = '${id}';`);
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
const rollbackSql = () => readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "rollback", "20270204090000_twilio_price_dual_control_rollback.sql"), "utf8");

describe.skipIf(!enabled)("D4-1 SMS price dual control (real schema, synthetic administrators)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null`)).toBe("t");
    seedCast();
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
    expect(psqlError(ins(true))).toMatch(/approved dual-control price change/);
    expect(psqlError(ins(false))).toMatch(/approved dual-control price change/);
    expect(psqlError(`begin; set local session_replication_role = replica; ${ins(true)} commit;`)).toMatch(/approved dual-control price change/); // the trigger is ENABLE ALWAYS
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
    const x = mkUser({ admin: true, label: "price-requester" });
    const q = propose("monthly", 1236, x);
    setRole(x, false);
    expect(approve(q.request_id, B)).toMatchObject({ status: "invalidated" });
    expect(preq(q.request_id)).toMatchObject({ status: "invalidated", decided_by: null });
    expect(preq(q.request_id).decision_note).toMatch(/no longer an active platform administrator/);
    // requester banned after proposing (the role is kept)
    const y = mkUser({ admin: true, label: "price-requester-banned" });
    const r = propose("monthly", 1237, y);
    psql(`update auth.users set banned_until = now() + interval '10 years' where id = '${y}';`);
    expect(approve(r.request_id, B)).toMatchObject({ status: "invalidated" });
    // approver demoted / banned
    const s = propose("monthly", 1238, A);
    const z = mkUser({ admin: true, label: "price-approver" });
    setRole(z, false);
    expect(codeOf(approveErr(s.request_id, z))).toBe("42501");
    const z2 = mkUser({ admin: true, label: "price-approver-banned" });
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
    expect(codeOf(callErr("tw4_price_propose", "monthly", null, 150, "dual-control price change under test", "a written reason for the price change", A))).toBe("22023");
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
      expect(psqlError(`truncate public.studio_sms_price_change_requests;`)).toMatch(/never truncated/);
      expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBeGreaterThan(0);
      // decided rows are final: approve, then every attempt to move it again fails, even with the write flag
      const out = approve(p.request_id, B);
      for (const st of ["pending", "rejected", "expired", "invalidated", "approved"]) {
        expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set status = '${st}' where id = '${p.request_id}'; commit;`), st).toMatch(/not a legal transition|shape|distinct/);
      }
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); update public.studio_sms_price_change_requests set decision_note = 'a rewritten decision note' where id = '${p.request_id}'; commit;`)).toMatch(/not a legal transition/);
      expect(preq(p.request_id)).toMatchObject({ status: "applied", decided_by: B, applied_price_id: out.price_id });
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
      expect(psqlError(`${pre} ${ins("number", 314, 150, d, B)} rollback;`)).toMatch(/approved dual-control price change/); // other amount
      expect(psqlError(`${pre} ${ins("number", 313, 151, d, B)} rollback;`)).toMatch(/approved dual-control price change/); // other provider cost
      expect(psqlError(`${pre} ${ins("number", 313, 150, "another description", B)} rollback;`)).toMatch(/approved dual-control price change/);
      expect(psqlError(`${pre} ${ins("monthly", 313, 150, d, B)} rollback;`)).toMatch(/approved dual-control price change/); // other kind
      expect(psqlError(`${pre} ${ins("number", 313, 150, d, A)} rollback;`)).toMatch(/approved dual-control price change/); // created_by is the requester, not the decider
      expect(psqlError(`${pre} ${ins("number", 313, 150, d, B)} rollback;`)).toBe(""); // exactly the approved row (nothing is kept: rolled back)
      // a request that is only PENDING (or rejected, expired, applied already) authorizes no insert
      expect(psqlError(`begin; update public.studio_sms_price_list set active = false where kind = 'number' and active; ${ins("number", 313, 150, d, B)} rollback;`)).toMatch(/approved dual-control price change/);
      expect(preq(p.request_id).status).toBe("pending");
      expect(priceRows("number", 313)).toBe(0);
      reject(p.request_id, A, "withdrawn to start the next scenario clean");
      expect(psqlError(`begin; select set_config('tw4.pricedual_write', 'on', true); ${ins("number", 313, 150, d, B)} rollback;`)).toMatch(/approved dual-control price change/);
    });

    it("PD-14 forged actor: the actor is a parameter the caller owns, but a forged requester id gets no further than the database checks (a non-administrator, a banned one or the requester themselves is refused; a fabricated unknown id is refused)", () => {
      clearOpen("number");
      const p = propose("number", 314, A);
      expect(codeOf(approveErr(p.request_id, "22222222-2222-4222-8222-222222222222"))).toBe("42501");
      expect(codeOf(callErr("tw4_price_approve", p.request_id, null, NOTE))).toBe("42501");
      expect(codeOf(proposeErr("number", 3141, "22222222-2222-4222-8222-222222222222"))).toBe("42501");
      expect(codeOf(callErr("tw4_price_approve", "33333333-3333-4333-8333-333333333333", B, NOTE))).toBe("22023"); // unknown request
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
    const appr = (id: string, who: string) => `select public.tw4_price_approve('${id}', '${who}', '${NOTE}')::text;`;

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
      const [ap, rj] = await race(appr(q.request_id, B), `select public.tw4_price_reject('${q.request_id}', '${F}', 'rejected while the approval was in flight')::text;`);
      expect(ap.out).toContain('"status": "applied"');
      expect(codeOf(rj.out)).toBe("TW041");
      expect(preq(q.request_id).status).toBe("applied");
      expect(priceRows("number", 3171)).toBe(1);
      // rejection holds, approval arrives second: the approval loses
      const s = propose("number", 3172, A);
      const [rj2, ap2] = await race(`select public.tw4_price_reject('${s.request_id}', '${F}', 'rejected before the approval arrived')::text;`, appr(s.request_id, B));
      expect(rj2.out).toContain('"status": "rejected"');
      expect(codeOf(ap2.out)).toBe("TW041");
      expect(priceRows("number", 3172)).toBe(0);
    });

    it("PD-18 two proposals for the same kind race: one pending request, the other TW041; an approver demoted while their approval waits for the lock is refused 42501 and nothing is published", async () => {
      clearOpen("number");
      const prop = (cents: number, who: string) => `select public.tw4_price_propose('number', ${cents}, 150, 'dual-control price change under test', 'a written reason for the race', '${who}')::text;`;
      const [a, b] = await race(prop(3181, A), prop(3182, B));
      expect(a.out).toContain('"status": "pending"');
      expect(codeOf(b.out)).toBe("TW041");
      expect(num(`select count(*) from public.studio_sms_price_change_requests where kind = 'number' and status in ('pending', 'approved')`)).toBe(1);
      const open = rows<{ id: string }>(`select id from public.studio_sms_price_change_requests where kind = 'number' and status = 'pending'`)[0].id;
      const ap = mkUser({ admin: true, label: "price-approver-race" });
      const [demote, approval] = await race(`update public.profiles set platform_role = null where id = '${ap}';`, appr(open, ap));
      expect(demote.code).toBe(0);
      expect(codeOf(approval.out)).toBe("42501");
      expect(preq(open).status).toBe("pending");
      expect(active("number")[0].customer_price_cents).not.toBe(3181);
      reject(open, A, "withdrawn to start the next scenario clean");
    });
  });

  describe("privileges, read model, rollback and money", () => {
    it("PD-19 service-role only: every new function is security definer with a pinned search_path and is executable by the service role alone; helpers by nobody; the table has no API-role privilege, no policy and RLS on; tw4_price_set keeps its grants", () => {
      const api = ["tw4_price_propose(text,int,int,text,text,uuid)", "tw4_price_approve(uuid,uuid,text)", "tw4_price_reject(uuid,uuid,text)", "tw4_price_requests_list(uuid)", "tw4_price_set(text,int,int,text,uuid)"];
      for (const f of api) {
        for (const role of ["anon", "authenticated", "public"]) expect(psql(`select has_function_privilege('${role}', 'public.${f}', 'execute')`), `${role} ${f}`).toBe("f");
        expect(psql(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), `service_role ${f}`).toBe("t");
        expect(psql(`select p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p where p.oid = 'public.${f}'::regprocedure`), f).toBe("true:search_path=pg_catalog, public, pg_temp");
      }
      for (const f of ["_tw4price_admin_active(uuid)", "_tw4price_kinds()", "_tw4pricedual_guard()", "_tw4price_activation_guard()"]) {
        for (const role of ["anon", "authenticated", "service_role", "public"]) expect(psql(`select has_function_privilege('${role}', 'public.${f}', 'execute')`), `${role} ${f}`).toBe("f");
      }
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'studio_sms_price_change_requests' and grantee = '${role}'`), role).toBe("0");
        expect(psqlError(`set role ${role}; select count(*) from public.studio_sms_price_change_requests;`), role).toMatch(/permission denied/);
      }
      expect(psql(`select relrowsecurity::text from pg_class where oid = 'public.studio_sms_price_change_requests'::regclass`)).toBe("true");
      expect(psql(`select count(*) from pg_policies where tablename = 'studio_sms_price_change_requests'`)).toBe("0");
      expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.studio_sms_price_change_requests'::regclass and not tgisinternal`)).toBe("2");
    });

    it("PD-20 the list is administrator-only and read-only: it returns the active prices and the latest requests, shows an overdue pending request as expired WITHOUT writing, and a non-administrator gets 42501", () => {
      clearOpen("number");
      const p = propose("number", 320, A);
      ageRequest(p.request_id);
      expect(codeOf(callErr("tw4_price_requests_list", C))).toBe("42501");
      expect(codeOf(callErr("tw4_price_requests_list", E))).toBe("42501");
      const list = call<{ active: { kind: string }[]; requests: { request_id: string; status: string; base_changed: boolean }[] }>("tw4_price_requests_list", B);
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

    it("PD-23 the rollback refuses (55000) while any request exists, and changes nothing (the audit rows are never destroyed); the forward objects are intact afterwards", () => {
      expect(num(`select count(*) from public.studio_sms_price_change_requests`)).toBeGreaterThan(0);
      const err = psqlError(rollbackSql());
      expect(codeOf(err)).toBe("55000");
      expect(psql(`select to_regclass('public.studio_sms_price_change_requests') is not null and to_regprocedure('public.tw4_price_approve(uuid,uuid,text)') is not null`)).toBe("t");
      expect(codeOf(callErr("tw4_price_set", "number", 1, 1, "still closed", A))).toBe("TW042");
    });
  });
});
