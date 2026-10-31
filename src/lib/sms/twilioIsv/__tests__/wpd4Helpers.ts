/**
 * WP-D4 shared fixtures for the dual-control matrix (localStack.wpd4dual / localStack.wpd4actions). LOCAL QA DATABASE ONLY.
 * Needs TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB (the isolated suite database) and the local-QA marker table. Every id is synthetic; nothing leaves the container.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

export const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
export const DB = process.env.TW4RFL_DB ?? "";
export const enabled = Boolean(PG && DB);

export const RUN = randomBytes(3).toString("hex");
/** Synthetic administrators and users (distinct ids). A, B: platform administrators whose sessions are aal2. C: not an administrator. D: administrator whose session is aal1.
 *  E: deactivated (was an administrator, demoted). F: a third administrator (aal2). G: administrator whose auth user is banned. */
export const A = `d4${RUN}00-0000-4000-8000-0000000000a1`;
export const B = `d4${RUN}00-0000-4000-8000-0000000000b2`;
export const C = `d4${RUN}00-0000-4000-8000-0000000000c3`;
export const D = `d4${RUN}00-0000-4000-8000-0000000000d4`;
export const E = `d4${RUN}00-0000-4000-8000-0000000000e5`;
export const F = `d4${RUN}00-0000-4000-8000-0000000000f6`;
export const G = `d4${RUN}00-0000-4000-8000-000000000097`;

const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
export const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
export const psqlError = (sql: string): string => {
  try {
    execFileSync("docker", sqlArgs, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer | string }).stderr ?? error);
  }
};
export const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
export const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
export const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
export const callErr = (fn: string, ...args: unknown[]) => psqlError(callSql(fn, ...args));
export const hasCode = (err: string, code: string) => new RegExp(`ERROR:\\s+${code}:`).test(err);
/** The SQLSTATE of a refusal ("" when the call succeeded). */
export const codeOf = (err: string): string => /ERROR:\s+([0-9A-Za-z]{5}):/.exec(err)?.[1] ?? "";
export const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);
export const rows = <T = Record<string, unknown>>(sql: string): T[] => JSON.parse(psql(`select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t;`)) as T[];
export const num = (sql: string): number => Number(psql(sql));

export const sid = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;
export const digest = () => randomBytes(32).toString("hex");
export const ref = (label: string) => `Written approval ${RUN} ${label} ${randomBytes(3).toString("hex")}`;
export const NOTE = "a second administrator reviewed and approves this request";
export const REASON = "DanceFlow accepts the cost of this lapsed period";
export const CR = "The owner asked us in writing to release this number";

export type World = { entity: string; studio: string; owner: string; account: string; n: number };
let worldSeq = 0;
export const PRICE = { number: 0, monthly: 0 };
const cur = () => psql("select to_char(now() at time zone 'UTC', 'YYYY-MM')");
const keyAdd = (key: string, n: number) => psql(`select to_char((${lit(key + "-01")}::date + make_interval(months => ${n})), 'YYYY-MM')`);
export const prevKey = () => keyAdd(cur(), -1);

export function mkUser(o: { admin?: boolean; banned?: boolean; id?: string; label?: string } = {}): string {
  const id = o.id ?? randomUUID();
  const email = `${o.label ?? "u"}-${RUN}-${id.slice(0, 8)}@wpd4.test`;
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, banned_until, created_at, updated_at, last_sign_in_at)
  values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${email}', now(), ${o.banned ? "now() + interval '10 years'" : "null"}, now(), now(), now());
insert into public.profiles (id, platform_role) values ('${id}', ${o.admin ? "'platform_admin'" : "null"}) on conflict (id) do update set platform_role = ${o.admin ? "'platform_admin'" : "null"};
commit;`);
  return id;
}
export const setRole = (u: string, admin: boolean) => psql(`update public.profiles set platform_role = ${admin ? "'platform_admin'" : "null"} where id = '${u}';`);

/** The synthetic cast. Idempotent per suite database. */
export function seedCast() {
  expectMarker();
  mkUser({ admin: true, id: A, label: "admin-a" });
  mkUser({ admin: true, id: B, label: "admin-b" });
  mkUser({ admin: false, id: C, label: "plain-c" });
  mkUser({ admin: true, id: D, label: "admin-d" });
  mkUser({ admin: true, id: E, label: "admin-e" });
  setRole(E, false); // deactivated: held the role, then lost it
  mkUser({ admin: true, id: F, label: "admin-f" });
  mkUser({ admin: true, id: G, label: "admin-g", banned: true });
  // earlier runs' administrators must not crowd this run's recipient lists; scratch database only
  replica(`update public.profiles set platform_role = null where platform_role = 'platform_admin' and id not in ('${A}', '${B}', '${D}', '${F}', '${G}');`);
}
function expectMarker() {
  if (psql(`select to_regclass('public.tw4_local_qa_only') is not null`) !== "t") throw new Error("not a local QA database (no tw4_local_qa_only marker)");
}
/** Published prices the world needs (fixture rows only when none is active). */
export function seedPrices() {
  for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
    if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, A);
  }
  PRICE.number = num(`select customer_price_cents from public.studio_sms_price_list where kind = 'number' and active`);
  PRICE.monthly = num(`select customer_price_cents from public.studio_sms_price_list where kind = 'monthly' and active`);
}

/** A fresh synthetic business with one location, an active subaccount, funded credit and a monthly limit. */
export function world(): World {
  worldSeq += 1;
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), n: worldSeq };
  psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${RUN}-${w.n}@wpd4.test', now(), now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'WPD4 ${RUN} ${w.n}', 'wpd4-${RUN}-${w.n}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', 'WPD4 World ${RUN} ${w.n} LLC', '7777', 500000, '${A}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at)
  values ('${w.studio}', '${w.entity}', 'founding', '${A}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by)
  values ('${w.entity}', '${w.account}', 'wpd4-${RUN}-${w.n}', 'test', 'active', '${A}');
commit;`);
  call("tw4_credit_adjust", w.entity, 200_000, `wpd4-fund-${RUN}-${w.n}`, "fixture funding for the dual-control matrix", A);
  call("tw4_monthly_limit_set_admin", w.entity, A, 20_000, null, "fixture: monthly limit for the dual-control matrix");
  return w;
}
export const register = (w: World, kind: "number" | "campaign" | "messaging_service") => {
  const providerSid = sid(kind === "number" ? "PN" : kind === "campaign" ? "QE" : "MG");
  const e164 = kind === "number" ? `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}` : null;
  const out = call<{ resource_id: string; fee_kind: string | null }>("tw4_rfl_register", w.studio, A, kind, providerSid, w.account, e164, "admin", null, null);
  return { ...out, sid: providerSid, e164 };
};
export const age = (resourceId: string, days = 75) => replica(`update public.studio_sms_provider_resources set registered_at = registered_at - interval '${days} days' where id = '${resourceId}';`);
export const scan = (w: World) => call<{ opened: number; closed: number; alerts: number }>("tw4_rfl_scan_entity", w.entity);
export const exposed = (w: World, kind: "campaign" | "number" = "number") => {
  const res = register(w, kind);
  age(res.resource_id);
  scan(w);
  return { res, key: prevKey() };
};
export const exposureOf = (resourceId: string, period: string) =>
  rows<{ state: string; disposition: string | null; billed: number }>(`select state, disposition, provider_billed_cents as billed from public.studio_sms_provider_exposure where resource_id = '${resourceId}' and period_key = '${period}'`)[0];
export const audit = (w: World, action: string) => num(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}'`);
export const auditActors = (w: World, action: string) =>
  rows<{ actor_type: string; actor_user_id: string | null }>(`select actor_type, actor_user_id from public.studio_sms_onboarding_audit where studio_id = '${w.studio}' and action = '${action}' order by created_at, id`);
export const reqRow = (id: string) =>
  rows<{ status: string; requested_by: string; decided_by: string | null; consumed_by: string | null; decision_note: string | null }>(
    `select status, requested_by, decided_by, consumed_by, decision_note from public.studio_sms_rfl_dual_requests where id = '${id}'`)[0];
export const reqStatus = (id: string) => psql(`select status from public.studio_sms_rfl_dual_requests where id = '${id}'`);
export const money = (w: World) => psql(`select json_build_object('bal', a.balance_cents, 'res', a.reserved_cents, 'ledger', (select count(*) from public.studio_sms_credit_ledger l where l.legal_entity_id = a.legal_entity_id))::text
  from public.studio_sms_credit_accounts a where a.legal_entity_id = '${w.entity}'`);

type Req = { request_id: string; facts_hash: string; expires_at: string; status: string; replayed: boolean };
export const absorbRequest = (resourceId: string, period: string, actor = A, reason = REASON) => call<Req>("tw4_rfl_dual_request", actor, "absorb_exposure", resourceId, period, reason, null);
export const absorbRequestErr = (resourceId: string, period: string, actor: string, reason = REASON) => callErr("tw4_rfl_dual_request", actor, "absorb_exposure", resourceId, period, reason, null);
export const cancelRequest = (resourceId: string, approval: string, actor = A, reason = CR, decidedBy = "owner_written") =>
  call<Req>("tw4_rfl_dual_request", actor, "cancel_number", resourceId, null, reason, approval, decidedBy);
export const cancelRequestErr = (resourceId: string, approval: string, actor: string, reason = CR, decidedBy = "owner_written") =>
  callErr("tw4_rfl_dual_request", actor, "cancel_number", resourceId, null, reason, approval, decidedBy);
export const dispose = (resourceId: string, period: string, actor = A, reason = REASON) => callErr("tw4_rfl_exposure_dispose", resourceId, period, actor, "absorbed", reason);
export const authorizeNum = (resourceId: string, approval: string, actor = A, reason = CR, by = "owner_written") => callErr("tw4_rfl_cancel_authorize", resourceId, actor, approval, by, reason, true);
export const approve = (id: string, actor: string, note = NOTE) => call<{ status: string; replayed?: boolean }>("tw4_rfl_dual_approve", id, actor, note);
export const approveErr = (id: string, actor: string, note = NOTE) => callErr("tw4_rfl_dual_approve", id, actor, note);
export const rejectErr = (id: string, actor: string, note = "rejected after review of the facts") => callErr("tw4_rfl_dual_reject", id, actor, note);
export const expire = (requestId: string) =>
  replica(`update public.studio_sms_rfl_dual_requests set requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours' where id = '${requestId}';`);

/** A resource fact the approval is bound to changes: a real provider bill (absorb) or a fact-epoch step (the epoch every bound fact bumps; used for the number cancellation). */
export function bumpEpoch(resourceId: string) {
  psql(`insert into public.studio_sms_rfl_fact_epochs (resource_id, epoch) values ('${resourceId}', 1) on conflict (resource_id) do update set epoch = public.studio_sms_rfl_fact_epochs.epoch + 1;`);
}
