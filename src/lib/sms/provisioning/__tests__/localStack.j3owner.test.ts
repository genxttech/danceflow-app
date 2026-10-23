/**
 * TW-4F J3 (20261227090000 + the 20261208 owner entry points) against a REAL schema: get_studio_sms_number_offers, tw4_num_select_as_owner and
 * tw4_num_withdraw_as_owner through PostgREST with real signed user JWTs, plus the real server actions (numberActions.ts) driven against the same database with the
 * owner's session. Covers: owner allowed; studio admin, front desk, another studio's owner, a platform admin and an unrelated user refused; anon/service_role
 * refused by privilege (never by a call: see below); a forged studio id; a replayed approval; no published price; an at-ceiling pilot; withdrawal rules; the
 * payload key set (no SID, account, provider cost). Synthetic fixtures, removed afterwards; the global price row and pilot exception are restored. No provider.
 * LOCAL QA ONLY, on a DEDICATED Postgres with main's migrations through 20261222 + 20261227 applied.
 * NEVER call a function as anon/service_role here: on this local Postgres build a permission-denied call of a revoked function can segfault the whole server.
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:<postgrest port>  TW4A_LOCAL_JWT_SECRET=<its JWT secret>  TW4A_LOCAL_DB_CONTAINER=<dedicated db container>
 *   npx vitest run --no-file-parallelism src/lib/sms/provisioning/__tests__/localStack.j3owner.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

// the server actions run for real against this database, with the owner's session as their context
let actionCtx: { supabase: SupabaseClient; studioId: string; studioRole: string | null } | null = null;
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => ({ ...actionCtx!, user: { id: "x" }, isPlatformAdmin: false }) }));

import { approveNumberAction, withdrawNumberAction } from "@/app/app/settings/sms/numberActions";
import { getOwnerNumberOffers } from "../ownerRead";

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

const S1 = "e3330000-0000-4000-8000-00000000000a";
const S2 = "e3330000-0000-4000-8000-00000000000b";
const E1 = "e3330000-0000-4000-8000-0000000000e1";
const E2 = "e3330000-0000-4000-8000-0000000000e2";
const O1 = "e3330000-0000-4000-8000-0000000000f1";
const O2 = "e3330000-0000-4000-8000-0000000000f2";
const U = {
  owner1: "e3330000-0000-4000-8000-000000000101",
  admin1: "e3330000-0000-4000-8000-000000000102",
  front1: "e3330000-0000-4000-8000-000000000103",
  owner2: "e3330000-0000-4000-8000-000000000201",
  padmin: "e3330000-0000-4000-8000-000000000401",
  plain: "e3330000-0000-4000-8000-000000000501",
};
const hex = (n: number) => n.toString(16).padStart(32, "0");
const ACC = { 1: `AC${"f1".repeat(16)}`, 2: `AC${"f2".repeat(16)}` };
const MG = { 1: `MG${hex(0xf1)}`, 2: `MG${hex(0xf2)}` };
const QE = { 1: `QE${hex(0xf1)}`, 2: `QE${hex(0xf2)}` };
const NUMS = { 1: ["+15035550161", "+15035550162"], 2: ["+15035550171"] };
const DIGEST = "ab".repeat(32);
const PRICE = 115;
const STUDIOS = `'${S1}', '${S2}'`;
const ENTITIES = `'${E1}', '${E2}'`;
const USERS = Object.values(U).map((u) => `'${u}'`).join(", ");

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const exp = 1983812996;
const anonKey = () => (enabled ? sign({ iss: "supabase-demo", role: "anon", exp }) : "");
const userKey = (uid: string) => sign({ iss: "supabase-demo", sub: uid, role: "authenticated", aud: "authenticated", exp });
const asUser = (uid: string): SupabaseClient => createClient(URL_, anonKey(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${userKey(uid)}` } } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

const CLEAR_SCENARIO = `
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studio_sms_spend_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_number_selections where studio_id in (${STUDIOS});
delete from public.studio_sms_number_offers where studio_id in (${STUDIOS});
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});`;

const CLEANUP = `
begin;
set local session_replication_role = replica;
${CLEAR_SCENARIO}
delete from public.studio_sms_prov_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_access where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${USERS});
delete from auth.users where email like '%@tw4j3-e2e.test';
delete from public.studio_sms_price_list where description = 'j3 fixture number price';
update public.studio_sms_price_list set active = true where description like 'j3-parked:%' and not exists (select 1 from public.studio_sms_price_list x where x.kind = 'number' and x.active);
update public.studio_sms_price_list set description = substr(description, 11) where description like 'j3-parked:%';
commit;`;

// R2a's provider-confirmed Messaging Service and campaign on the active subaccount (what _tw4num_campaign accepts)
function r2a(n: 1 | 2, onboarding: string, studio: string, entity: string) {
  const ms = `e3330000-0000-4000-8000-0000000003${n}1`;
  const qe = `e3330000-0000-4000-8000-0000000003${n}2`;
  const op = (oid: string, kind: string, sid: string) => `('${oid}', '${onboarding}', '${studio}', '${entity}', '${ACC[n]}', '${kind}', 1, 1, 'succeeded', 'df:fixture:${kind}', '${DIGEST}', ${kind === "campaign"}, ${kind === "campaign" ? "array['campaign_vetting']" : "'{}'::text[]"}, '${U.padmin}', '${sid}')`;
  return `insert into public.studio_sms_prov_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, fee_bearing, fee_kinds, started_by, provider_sid)
      values ${op(ms, "messaging_service", MG[n])}, ${op(qe, "campaign", QE[n])};
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, use_case, status, source, evidence_digest)
      values ('${ms}', '${entity}', '${studio}', '${ACC[n]}', 'messaging_service', '${MG[n]}', null, null, 'ready', 'provider_read', '${DIGEST}'),
             ('${qe}', '${entity}', '${studio}', '${ACC[n]}', 'campaign', '${QE[n]}', '${MG[n]}', 'MIXED', 'verified', 'provider_read', '${DIGEST}');`;
}

const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4j3-e2e.test', now(), now(), now()
    from (values ${Object.entries(U).map(([n, uid]) => `('${uid}', '${n}')`).join(", ")}) u(id, n);
insert into public.profiles (id, platform_role) values ${Object.entries(U).map(([n, uid]) => `('${uid}', ${n === "padmin" ? "'platform_admin'" : "null"})`).join(", ")}
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${S1}', 'J3 One', 'j3-one', null, 'UTC'), ('${S2}', 'J3 Two', 'j3-two', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${U.owner1}', '${S1}', 'studio_owner', true), ('${U.admin1}', '${S1}', 'studio_admin', true), ('${U.front1}', '${S1}', 'front_desk', true), ('${U.owner2}', '${S2}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${E1}', 'J3 One LLC', '8881', 50000, '${U.padmin}'), ('${E2}', 'J3 Two LLC', '8882', 50000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${S1}', '${E1}', 'founding', '${U.padmin}', 'fixture: business one', now()), ('${S2}', '${E2}', 'founding', '${U.padmin}', 'fixture: business two', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  ('${E1}', '${ACC[1]}', 'df:test:${E1}', 'test', 'active', '${U.padmin}'), ('${E2}', '${ACC[2]}', 'df:test:${E2}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${S1}', true, 'fixture', '${U.padmin}'), ('${S2}', true, 'fixture', '${U.padmin}');
-- this suite's own number price: an existing active one is parked (restored by CLEANUP)
update public.studio_sms_price_list set active = false, description = 'j3-parked:' || description where kind = 'number' and active;
insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, active, created_by) values ('number', ${PRICE}, 100, 'j3 fixture number price', true, '${U.padmin}');
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, created_at) values
  ('${O1}', '${S1}', 'campaign_pending', 'J3 One LLC', 'llc', '8881', 1, now(), now() - interval '1 day'), ('${O2}', '${S2}', 'campaign_pending', 'J3 Two LLC', 'llc', '8882', 1, now(), now() - interval '1 day');
${r2a(1, O1, S1, E1)}
${r2a(2, O2, S2, E2)}
commit;`;

const OFFER = { 1: "e3330000-0000-4000-8000-0000000004a1", 2: "e3330000-0000-4000-8000-0000000004a2" };
const offerSql = (n: 1 | 2, live = true) => `insert into public.studio_sms_number_offers (id, studio_id, legal_entity_id, twilio_account_sid, candidates, source, evidence_digest, requested_by, expires_at)
  values ('${OFFER[n]}', '${n === 1 ? S1 : S2}', '${n === 1 ? E1 : E2}', '${ACC[n]}', '${JSON.stringify(NUMS[n].map((e164) => ({ e164, locality: "Portland", region: "OR", mms_capable: false })))}', 'fake', '${DIGEST}', '${U.padmin}', now() ${live ? "+" : "-"} interval '30 minutes');`;
// approval references are registered globally and used once (ALWAYS triggers, also in replica mode): every fixture approval gets a fresh one
let refSeq = 0;
const ref = (what: string) => `j3-fixture-${what}-${Date.now()}-${++refSeq}`;
const pilot = (ceiling = 150) => `insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${E1}', ${ceiling}, '${ref("pilot")}', '${U.padmin}');`;
const scenario = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${CLEAR_SCENARIO} ${sql} commit;`);

type Answer = { data: Record<string, unknown> | null; error: { code?: string; message?: string } | null };
const read = async (who: string, studio: string) => (await asUser(who).rpc("get_studio_sms_number_offers", { p_studio_id: studio })) as Answer;
const select = async (who: string, studio: string, offer: string, e164: string, cents = PRICE) =>
  (await asUser(who).rpc("tw4_num_select_as_owner", { p_studio_id: studio, p_offer_id: offer, p_e164: e164, p_ack_price_cents: cents })) as Answer;
const withdraw = async (who: string, studio: string, selection: string) =>
  (await asUser(who).rpc("tw4_num_withdraw_as_owner", { p_studio_id: studio, p_selection_id: selection, p_note: "fixture withdraw" })) as Answer;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const asOwnerAction = (who: string, studio: string, role = "studio_owner") => {
  actionCtx = { supabase: asUser(who), studioId: studio, studioRole: role };
};
const selections = (studio: string) => psql(`select coalesce(string_agg(status || ':' || approver_role || ':' || approver_user, ',' order by approved_at), '') from public.studio_sms_number_selections where studio_id = '${studio}'`);

describe.skipIf(!enabled)("TW-4F J3: owner number offers, approval and withdrawal (real schema, real JWTs)", () => {
  beforeAll(() => {
    expect(psql(`select to_regprocedure('public.get_studio_sms_number_offers(uuid)') is not null`)).toBe("t");
    psqlFile(FIXTURES);
  });
  beforeEach(() => scenario(`${offerSql(1)} ${offerSql(2)}`));
  afterAll(() => {
    if (enabled) psqlFile(CLEANUP);
  });

  it("privileges: the read and both owner entry points are authenticated-only; the read is security definer with a pinned search_path", () => {
    for (const fn of ["public.get_studio_sms_number_offers(uuid)", "public.tw4_num_select_as_owner(uuid, uuid, text, integer)", "public.tw4_num_withdraw_as_owner(uuid, uuid, text)"]) {
      expect(psql(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE'), has_function_privilege('anon', '${fn}', 'EXECUTE'), has_function_privilege('public', '${fn}', 'EXECUTE')`), fn).toBe("t|f|f");
    }
    expect(psql(`select has_function_privilege('service_role', 'public.get_studio_sms_number_offers(uuid)', 'EXECUTE')`)).toBe("f");
    expect(psql(`select p.prosecdef, p.provolatile, array_to_string(p.proconfig, ';') from pg_proc p where p.oid = 'public.get_studio_sms_number_offers(uuid)'::regprocedure`)).toBe("t|s|search_path=pg_catalog, public, pg_temp");
  });

  it("the read: only the active owner of THIS studio; exactly the contract keys; no SID, account or provider cost", async () => {
    const r = await read(U.owner1, S1);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ available: true, version: 1, step_open: true, price: { published: true, monthly_cents: PRICE }, funding_mode: "credit_recurring", pilot_ceiling_reached: false, blocker: "none", approval: null });
    expect((r.data!.offer as { offer_id: string; numbers: { e164: string }[] }).numbers.map((n) => n.e164)).toEqual(NUMS[1]);
    const keys = (v: unknown, path = ""): string[] =>
      Array.isArray(v) ? v.flatMap((x) => keys(x, `${path.replace(/\.$/, "")}[].`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${path}${k}`, ...keys(x, `${path}${k}.`)]) : [];
    expect([...new Set(keys(r.data))].sort()).toEqual(["approval", "available", "blocker", "funding_mode", "offer", "offer.expires_at", "offer.numbers", "offer.numbers[].e164", "offer.numbers[].locality",
      "offer.numbers[].region", "offer.offer_id", "pilot_ceiling_reached", "price", "price.monthly_cents", "price.published", "step_open", "version"].sort());
    expect(JSON.stringify(r.data)).not.toMatch(/(AC|MG|QE|PN)[0-9a-fA-F]{32}|provider|cost|digest|\b100\b|\+15035550171/);
    for (const who of [U.admin1, U.front1, U.owner2, U.padmin, U.plain]) expect((await read(who, S1)).error?.code, who).toBe("42501");
  });

  it("owner approves: one selection by the owner themself, at the published price; a replayed approval is refused and creates nothing", async () => {
    const r = await select(U.owner1, S1, OFFER[1], NUMS[1][0]);
    expect(r.error).toBeNull();
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
    expect(((await read(U.owner1, S1)).data!.approval as { status: string; e164: string }).status).toBe("open");
    // replay: the same request again, and a second number, are refused (one open approval per location)
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error?.code).toBe("23505");
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][1])).error?.code).toBe("23505");
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
    // the J2 status read now shows the number as selected
    const status = (await asUser(U.owner1).rpc("get_studio_sms_texting_status", { p_studio_id: S1 })) as Answer;
    expect((status.data!.number as { status: string; selection: string })).toMatchObject({ status: "selected", selection: "open" });
  });

  it("refused: staff, another studio's owner (forged studio id), a platform admin, a number outside the offer, another studio's offer, an expired offer", async () => {
    for (const who of [U.admin1, U.front1, U.owner2, U.padmin, U.plain]) expect((await select(who, S1, OFFER[1], NUMS[1][0])).error?.code, who).toBe("42501");
    // owner2 naming its own studio but S1's offer: unknown offer for this location
    expect((await select(U.owner2, S2, OFFER[1], NUMS[1][0])).error?.code).toBe("22023");
    expect((await select(U.owner1, S1, OFFER[1], "+15035550199")).error?.code).toBe("22023");
    scenario(offerSql(1, false));
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error?.code).toBe("TW040");
    expect(selections(S1)).toBe("");
    expect(selections(S2)).toBe("");
  });

  it("no published price: the read says so, the database refuses any acknowledged price, the action refuses without sending", async () => {
    psql(`update public.studio_sms_price_list set active = false where description = 'j3 fixture number price'`);
    try {
      const r = await read(U.owner1, S1);
      expect(r.data).toMatchObject({ price: { published: false, monthly_cents: null }, blocker: "unpriced" });
      expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error?.code).toBe("TW008");
      asOwnerAction(U.owner1, S1);
      expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes" }))).ok).toBe(false);
      expect(selections(S1)).toBe("");
    } finally {
      psql(`update public.studio_sms_price_list set active = true where description = 'j3 fixture number price'`);
    }
    // an acknowledged price other than the published one is refused too
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0], PRICE - 1)).error?.code).toBe("TW008");
  });

  it("pilot at its ceiling: the read reports it and the owner action refuses; below the ceiling it is approvable", async () => {
    scenario(`${offerSql(1)} ${pilot()}
      insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key, status) values ('${E1}', '${S1}', 'brand', 100, 'pilot', 'j3-fixture-used', 'reserved');`);
    const r = await read(U.owner1, S1);
    expect(r.data).toMatchObject({ funding_mode: "pilot", pilot_ceiling_reached: true, blocker: "pilot_ceiling" });
    asOwnerAction(U.owner1, S1);
    const out = await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes" }));
    expect(out.ok).toBe(false);
    expect(selections(S1)).toBe("");
    // below the ceiling (nothing used yet): the same action approves, through the real owner RPC
    scenario(`${offerSql(1)} ${pilot()}`);
    expect((await read(U.owner1, S1)).data).toMatchObject({ funding_mode: "pilot", pilot_ceiling_reached: false, blocker: "none" });
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes" }))).ok).toBe(true);
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
  });

  it("pinned (SQL hardening tracked separately): a DIRECT owner RPC approval at the pilot ceiling is recorded, but the purchase gate refuses it, so no money moves", async () => {
    scenario(`${offerSql(1)} ${pilot()}
      insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key, status) values ('${E1}', '${S1}', 'brand', 100, 'pilot', 'j3-fixture-used', 'reserved');
      insert into public.studio_sms_spend_events (legal_entity_id, studio_id, kind, amount_cents, status, approval_ref, authorized_by, funding) values ('${E1}', '${S1}', 'number', ${PRICE}, 'authorized', '${ref("spend")}', '${U.padmin}', 'pilot');`);
    // tw4_num_select does not check the ceiling: the approval is recorded
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error).toBeNull();
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
    // ... but the purchase's own pre-check names the ceiling, and the reservation itself refuses it (TW007), inside a transaction that is rolled back
    expect(psql(`select public._tw4num_requirements('${S1}') ->> 'blocker'`)).toBe("pilot_ceiling");
    let refused = "";
    try {
      psqlFile(`begin; select public._tw4num_reserve(o, gen_random_uuid(), ${PRICE}) from public.studio_sms_onboarding o where o.id = '${O1}'; rollback;`);
    } catch (e) {
      refused = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(refused).toContain("the pilot ceiling would be exceeded");
    expect(psql(`select count(*) from public.studio_sms_credit_reservations where legal_entity_id = '${E1}' and kind = 'number'`)).toBe("0");
  });

  it("the real server action: owner approves; a stale offer id, a changed price or a non-owner context never reaches the database", async () => {
    asOwnerAction(U.owner1, S1);
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[2], ack_price_cents: String(PRICE), confirm: "yes" }))).ok).toBe(false);
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE + 1), confirm: "yes" }))).ok).toBe(false);
    asOwnerAction(U.admin1, S1, "studio_admin");
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes" }))).ok).toBe(false);
    expect(selections(S1)).toBe("");
    asOwnerAction(U.owner1, S1);
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes", studio_id: S2 }))).ok).toBe(true);
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
    expect(selections(S2)).toBe("");
    // replaying the same submission is refused (the approval is open)
    expect((await approveNumberAction({}, form({ e164: NUMS[1][0], offer_id: OFFER[1], ack_price_cents: String(PRICE), confirm: "yes" }))).ok).toBe(false);
    expect(selections(S1)).toBe(`approved:studio_owner:${U.owner1}`);
  });

  it("withdrawal: the owner withdraws their open approval; staff and another studio's owner cannot; a replay is a no-op; a used approval is not withdrawn", async () => {
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error).toBeNull();
    const sel = psql(`select id from public.studio_sms_number_selections where studio_id = '${S1}' and status = 'approved'`);
    expect((await withdraw(U.admin1, S1, sel)).error?.code).toBe("42501");
    expect((await withdraw(U.owner2, S2, sel)).error?.code).toBe("22023");
    expect((await withdraw(U.owner2, S1, sel)).error?.code).toBe("42501");
    asOwnerAction(U.owner1, S1);
    expect((await withdrawNumberAction({}, form({ selection_id: sel }))).ok).toBe(true);
    expect(selections(S1)).toBe(`withdrawn:studio_owner:${U.owner1}`);
    expect(((await withdraw(U.owner1, S1, sel)).data as { replayed: boolean }).replayed).toBe(true);
    // after withdrawal the owner can approve again
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][1])).error).toBeNull();
    const second = psql(`select id from public.studio_sms_number_selections where studio_id = '${S1}' and status = 'approved'`);
    psql(`begin; set local session_replication_role = replica; update public.studio_sms_number_selections set status = 'consumed', consumed_at = now(), consumed_by_operation = gen_random_uuid() where id = '${second}'; commit;`);
    expect((await withdraw(U.owner1, S1, second)).error?.code).toBe("22023");
  });

  it("an approval made before the current onboarding started is still the open one (SQL's per-studio rule): shown and withdrawable, never a dead end", async () => {
    expect((await select(U.owner1, S1, OFFER[1], NUMS[1][0])).error).toBeNull();
    psql(`begin; set local session_replication_role = replica; update public.studio_sms_number_selections set approved_at = now() - interval '2 days' where studio_id = '${S1}'; commit;`);
    const r = await read(U.owner1, S1);
    expect((r.data!.approval as { status: string } | null)?.status).toBe("open");
    asOwnerAction(U.owner1, S1);
    expect((await withdrawNumberAction({}, form({ selection_id: (r.data!.approval as { selection_id: string }).selection_id }))).ok).toBe(true);
    expect(selections(S1)).toBe(`withdrawn:studio_owner:${U.owner1}`);
  });

  it("the app wrapper returns null for anyone but the owner", async () => {
    expect(await getOwnerNumberOffers(asUser(U.owner1), S1)).toMatchObject({ stepOpen: true, monthlyCents: PRICE });
    expect(await getOwnerNumberOffers(asUser(U.admin1), S1)).toBeNull();
    expect(await getOwnerNumberOffers(asUser(U.owner2), S1)).toBeNull();
  });
});
