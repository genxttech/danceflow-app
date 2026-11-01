/**
 * TW-4F J1 against a REAL schema: the platform-admin orchestration (src/lib/sms/provisioning/runOrchestration.ts, the command layer of
 * src/app/platform/sms/provisioningRunActions.ts) drives the EXISTING R2a and R2b ledgers through the real factory in fake mode (no Twilio, no SMS, no Stripe):
 * Messaging Service -> fee-gated campaign -> provider verdict -> number offer -> owner approval (the owner's own session) -> the ConfiDance pilot ceiling
 * refusal -> purchase and attachment, with replays and the refusals in between. Synthetic fixtures with their own id block; every row written is removed.
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations 20261207090000 .. 20261217090000 applied and the local-QA marker table present, behind its own PostgREST:
 *
 *   TW4A_LOCAL_URL=http://127.0.0.1:56741  TW4A_LOCAL_NO_REST_PREFIX=1  TW4A_LOCAL_JWT_SECRET=<that PostgREST's secret>  TW4A_LOCAL_DB_CONTAINER=<that Postgres>
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.tw4fj1.test.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteFixtureRequestsSql, deletePricesSql, ownerReactivate, seedPrice } from "./priceFixture";
import { spendEvidenceRpc, exceptionEvidenceRpc } from "./rflEvidenceHelper";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const holder = globalThis as unknown as { __j1Admin?: SupabaseClient };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => holder.__j1Admin }));

import { numberCommand, provisioningCommand, type RunDeps } from "@/lib/sms/provisioning/runOrchestration";
import { FAKE_NUMBER_CATALOGUE, buildNumberRuntime, buildProvisioningRuntime, fakeNumberHub, fakeProvisioningHub } from "../factory";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const NO_PREFIX = process.env.TW4A_LOCAL_NO_REST_PREFIX === "1";
const loopback = (() => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname);
  } catch {
    return false;
  }
})();
const enabled = Boolean(URL_ && SECRET && PG) && loopback;

const mkClient = (key: string) =>
  createClient(URL_, key, { auth: { persistSession: false, autoRefreshToken: false }, ...(NO_PREFIX ? { global: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetch(String(input).replace("/rest/v1", ""), init);
      } catch (error) {
        if (attempt >= 2 || !/ECONNRESET|fetch failed/.test(String((error as Error)?.cause ?? error))) throw error;
      }
    }
  } } } : {}) });

const SC = "a1f10000-0000-4000-8000-00000000000c"; // the ConfiDance pilot business, one location
const SN = "a1f10000-0000-4000-8000-00000000000e"; // a location of a business with NO subaccount
const EC = "e1f10000-0000-4000-8000-0000000000c1";
const EN = "e1f10000-0000-4000-8000-0000000000e1";
const OC = "01f10000-0000-4000-8000-0000000000c1";
const ON = "01f10000-0000-4000-8000-0000000000e1";
const U = { owner: "a1f10000-0000-4000-8000-000000000101", padmin: "a1f10000-0000-4000-8000-000000000401", stranger: "a1f10000-0000-4000-8000-000000000501" };
const ACC = `AC${"c7".repeat(16)}`;
const BRAND = `BN${"c7".repeat(16)}`;
const RUN = randomBytes(3).toString("hex");
const PRICE = { vetting: 1900, monthly: 1250, number: 200 };
const LOCAL_ENV = { NODE_ENV: "test", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: URL_ || "http://127.0.0.1:1" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
}
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const psqlFile = (sql: string) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

const STUDIOS = `'${SC}', '${SN}'`;
const ENTITIES = `'${EC}', '${EN}'`;
const CLEANUP = `
begin;
set local session_replication_role = replica;
do $$ begin
  if to_regclass('public.studio_sms_provider_resources') is not null then
    delete from public.studio_sms_provider_cover where resource_id in (select id from public.studio_sms_provider_resources where legal_entity_id in (${ENTITIES}));
    delete from public.studio_sms_provider_alerts where legal_entity_id in (${ENTITIES});
    delete from public.studio_sms_provider_resources where legal_entity_id in (${ENTITIES});
  end if;
  if to_regclass('public.studio_sms_num_orphans') is not null then
    delete from public.studio_sms_num_orphan_events where orphan_id in (select id from public.studio_sms_num_orphans where legal_entity_id in (${ENTITIES}));
    delete from public.studio_sms_num_orphans where legal_entity_id in (${ENTITIES});
  end if;
  if to_regclass('public.studio_sms_num_history_reads') is not null then delete from public.studio_sms_num_history_reads where legal_entity_id in (${ENTITIES}); end if;
  if to_regclass('public.studio_sms_num_identity_reads') is not null then delete from public.studio_sms_num_identity_reads where legal_entity_id in (${ENTITIES}); end if;
  if to_regclass('public.studio_sms_prov_orphans') is not null then delete from public.studio_sms_prov_orphans where studio_id in (${STUDIOS}); end if;
  if to_regclass('public.studio_sms_prov_dispositions') is not null then delete from public.studio_sms_prov_dispositions where studio_id in (${STUDIOS}); end if;
  if to_regclass('public.studio_sms_prov_listings') is not null then delete from public.studio_sms_prov_listings where studio_id in (${STUDIOS}); end if;
end $$;
delete from public.studio_sms_num_inventory_checks where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_num_inventory_acks where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_num_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_num_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_number_selections where studio_id in (${STUDIOS});
delete from public.studio_sms_number_offers where studio_id in (${STUDIOS});
delete from public.studio_sms_billed_senders where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_resources where studio_id in (${STUDIOS});
delete from public.studio_sms_prov_operations where studio_id in (${STUDIOS});
delete from public.studio_sms_pilot_exceptions where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_approval_refs where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_recurring_authorizations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_spend_events where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_ledger where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_reservations where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_credit_accounts where legal_entity_id in (${ENTITIES});
${deleteFixtureRequestsSql(U.padmin)}
${deletePricesSql(`created_by = '${U.padmin}'`)}
delete from public.studio_sms_provisioning_steps where studio_id in (${STUDIOS});
delete from public.studio_sms_registrations where studio_id in (${STUDIOS});
delete from public.studio_sms_runner_windows where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_access where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding where studio_id in (${STUDIOS});
delete from public.studio_sms_twilio_accounts where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_entity_studios where legal_entity_id in (${ENTITIES});
delete from public.studio_sms_legal_entities where id in (${ENTITIES});
delete from public.user_studio_roles where studio_id in (${STUDIOS});
delete from public.studio_sms_onboarding_audit where studio_id in (${STUDIOS});
delete from public.studios where id in (${STUDIOS});
delete from public.profiles where id in (${Object.values(U).map((u) => `'${u}'`).join(", ")});
delete from auth.users where email like '%@tw4fj1-e2e.test';
commit;`;

const FIXTURES = `${CLEANUP}
begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.n || '@tw4fj1-e2e.test', now(), now(), now()
    from (values ('${U.owner}'::uuid, 'owner'), ('${U.padmin}', 'padmin'), ('${U.stranger}', 'stranger')) u(id, n);
insert into public.profiles (id, platform_role) values ('${U.owner}', null), ('${U.padmin}', 'platform_admin'), ('${U.stranger}', null)
  on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values ('${SC}', 'J1 Pilot Location', 'j1-pilot', null, 'UTC'), ('${SN}', 'J1 No Account Location', 'j1-noacct', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${U.owner}', '${SC}', 'studio_owner', true), ('${U.owner}', '${SN}', 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  ('${EC}', 'ConfiDance Unlimited, LLC', '7713', 15000, '${U.padmin}'), ('${EN}', 'J1 No Account LLC', '7714', 15000, '${U.padmin}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  ('${SC}', '${EC}', 'founding', '${U.padmin}', 'fixture: verified pilot business', now()), ('${SN}', '${EN}', 'founding', '${U.padmin}', 'fixture: verified business without subaccount', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${EC}', '${ACC}', 'df:test:${EC}', 'test', 'active', '${U.padmin}');
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) select s, true, 'fixture: J1 orchestration tests', '${U.padmin}' from unnest(array[${STUDIOS}]::uuid[]) s;
commit;
begin;
set local session_replication_role = replica;
insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at) values
  ('${OC}', '${SC}', 'service_setup', 'ConfiDance Unlimited, LLC', 'llc', '7713', 1, now()), ('${ON}', '${SN}', 'service_setup', 'J1 No Account LLC', 'llc', '7714', 1, now());
insert into public.studio_sms_registrations (studio_id, registration_status, brand_sid, brand_status) values ('${SC}', 'in_review', '${BRAND}', 'approved');
insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
  values ('${OC}', '${SC}', 'B1', 1, 'succeeded', '${BRAND}', false, '${ACC}');
commit;`;

describe.skipIf(!enabled)("TW-4F J1: platform-admin orchestration drives the R2a/R2b ledgers (real schema, fake provider)", () => {
  let admin: SupabaseClient;
  let snapshotActivePrices: string[] = [];
  const deps: RunDeps = { provisioning: () => buildProvisioningRuntime(LOCAL_ENV), numbers: () => buildNumberRuntime(LOCAL_ENV) };
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => (await admin.rpc(fn, args)) as { data: unknown; error: { code?: string; message?: string } | null };
  const aged = (sql: string) => psqlFile(`begin; set local session_replication_role = replica; ${sql}; commit;`);
  const ref = (label: string) => `Owner email ${RUN} ${label} approving one fee`;
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };
  const prov = (values: Record<string, string>, actor = U.padmin) => provisioningCommand(deps, actor, form({ studioId: SC, ...values }));
  const num = (values: Record<string, string>, actor = U.padmin) => numberCommand(deps, actor, form({ studioId: SC, ...values }));
  const authorize = (kind: string, cents: number, label: string) =>
    rpc("tw4_spend_authorize", { p_entity_id: EC, p_kind: kind, p_amount_cents: cents, p_approval_ref: ref(label), p_actor: U.padmin, p_funding: "pilot", p_studio_id: SC, ...spendEvidenceRpc("pilot", kind, EC, SC, cents) });
  const asOwner = () => mkClient(sign({ role: "authenticated", sub: U.owner, aud: "authenticated", exp: 1983812996 }));
  const state = () => psql(`select state from public.studio_sms_onboarding where studio_id = '${SC}'`);
  const provOps = (kind: string) => psql(`select coalesce(string_agg(attempt || ':' || status, ',' order by attempt), '') from public.studio_sms_prov_operations where studio_id = '${SC}' and op_kind = '${kind}'`);
  const numOps = (kind: string) => psql(`select coalesce(string_agg(attempt || ':' || status, ',' order by attempt), '') from public.studio_sms_num_operations where studio_id = '${SC}' and op_kind = '${kind}'`);
  const reservations = (kind: string) => psql(`select coalesce(string_agg(status || ':' || amount_cents || ':' || funding, ',' order by created_at), '') from public.studio_sms_credit_reservations where legal_entity_id = '${EC}' and kind = '${kind}'`);
  const provFake = () => fakeProvisioningHub(LOCAL_ENV)!.adapterFor(ACC);
  const numFake = () => fakeNumberHub(LOCAL_ENV)!.adapterFor(ACC);

  beforeAll(async () => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null and to_regclass('public.studio_sms_num_operations') is not null and to_regclass('public.studio_sms_prov_operations') is not null`)).toBe("t");
    expect(psql(`select count(*) from public.studio_sms_pilot_exceptions where legal_entity_id <> '${EC}'`), "the database holds one pilot slot: use a dedicated database").toBe("0");
    psqlFile(FIXTURES);
    admin = mkClient(sign({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }));
    holder.__j1Admin = admin;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = await admin.rpc("tw4_num_status", { p_studio_id: SC, p_actor: U.padmin });
      if (!probe.error || probe.error.code) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    snapshotActivePrices = psql("select id from public.studio_sms_price_list where active").split("\n").filter(Boolean);
    for (const [kind, customer, provider] of [["campaign_vetting", PRICE.vetting, 1500], ["monthly", PRICE.monthly, 1000], ["number", PRICE.number, 115]] as const) {
      seedPrice(psql, { kind: kind, customer: customer, provider: provider, description: `fixture ${kind}`, approver: U.padmin });
    }
    for (const s of [SC, SN]) expect((await rpc("tw4_runner_set_window", { p_studio_id: s, p_actor: U.padmin, p_hours: 2, p_reason: "fixture: J1 orchestration window" })).error).toBeNull();
    expect((await rpc("tw4_pilot_exception_create", { p_entity_id: EC, p_ceiling_cents: 15_000, p_approval_ref: ref("pilot-founder"), p_actor: U.padmin, ...exceptionEvidenceRpc(EC, 15_000) })).error).toBeNull();
  });

  afterAll(() => {
    if (!enabled) return;
    try {
      psqlFile(CLEANUP);
      ownerReactivate(psql, `id in (${snapshotActivePrices.map((id) => `'${id}'`).join(", ") || "null"})`);
    } catch {
      /* best effort */
    }
  });

  it("a non-admin actor reaching the command layer is refused by the database's own actor check; nothing is created", async () => {
    for (const actor of [U.owner, U.stranger]) {
      const result = await prov({ intent: "service" }, actor);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/could not be looked up/);
      expect((await num({ intent: "offer" }, actor)).ok).toBe(false);
    }
    expect(provOps("messaging_service")).toBe("");
    expect(provFake().calls).toHaveLength(0);
  });

  it("a studio whose business has no subaccount is refused before any adapter or ledger row exists", async () => {
    const result = await provisioningCommand(deps, U.padmin, form({ studioId: SN, intent: "service" }));
    expect(result).toMatchObject({ ok: false, outcome: "needs_subaccount" });
    expect(psql(`select count(*) from public.studio_sms_prov_operations where studio_id = '${SN}'`)).toBe("0");
  });

  it("R2a: the Messaging Service reaches the ledger's post-create state (succeeded, provider-read ready) once; a replay creates nothing", async () => {
    const result = await prov({ intent: "service" });
    expect(result, result.message).toMatchObject({ ok: true, outcome: "service_ready" });
    expect(provOps("messaging_service")).toBe("1:succeeded");
    expect(psql(`select status || ':' || source from public.studio_sms_prov_resources where studio_id = '${SC}' and resource_kind = 'messaging_service'`)).toBe("ready:fake");
    expect(psql(`select twilio_account_sid from public.studio_sms_prov_operations where studio_id = '${SC}' and op_kind = 'messaging_service'`)).toBe(ACC);
    expect(state()).toBe("service_setup");
    expect((await prov({ intent: "service" })).outcome).toBe("service_ready");
    expect(provFake().count("createMessagingService")).toBe(1);
    expect(provOps("messaging_service")).toBe("1:succeeded");
  });

  it("the campaign: no owner-approved spend -> refused, nothing reserved or created; approved -> submitted once; a replay submits nothing", async () => {
    const blocked = await prov({ intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" });
    expect(blocked.ok).toBe(false);
    expect(["spend_blocked", "waiting_fee_confirmation"]).toContain(blocked.outcome);
    expect(provFake().count("createCampaign")).toBe(0);
    expect(reservations("campaign_vetting")).toBe("");
    expect((await authorize("campaign_vetting", PRICE.vetting, "vetting")).error).toBeNull();
    expect((await authorize("monthly", PRICE.monthly, "monthly")).error).toBeNull();
    const submitted = await prov({ intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" });
    expect(submitted, submitted.message).toMatchObject({ ok: true, outcome: "campaign_submitted" });
    expect(provOps("campaign")).toBe("1:succeeded");
    expect(state()).toBe("campaign_pending");
    expect(reservations("campaign_vetting")).toBe(`captured:${PRICE.vetting}:pilot`);
    expect(reservations("monthly")).toBe(`reserved:${PRICE.monthly}:pilot`);
    const replay = await prov({ intent: "campaign", confirmFee: "on", confirmPhrase: "SUBMIT" });
    expect(replay.ok).toBe(true);
    expect(provFake().count("createCampaign")).toBe(1);
    expect(provOps("campaign")).toBe("1:succeeded");
    expect(reservations("campaign_vetting")).toBe(`captured:${PRICE.vetting}:pilot`);
  });

  it("the provider verdict comes only from a status check (GET-only): VERIFIED captures the first month", async () => {
    expect((await prov({ intent: "refresh" })).outcome).toBe("campaign_pending");
    const qe = [...provFake().campaigns.keys()][0];
    provFake().setCampaignStatus(qe, "VERIFIED");
    const before = provFake().calls.length;
    const verified = await prov({ intent: "refresh" });
    expect(verified, verified.message).toMatchObject({ ok: true, outcome: "campaign_verified" });
    expect(provFake().calls.slice(before).every((c) => c.method.startsWith("get"))).toBe(true);
    expect(reservations("monthly")).toBe(`captured:${PRICE.monthly}:pilot`);
  });

  it("R2b: a number offer list is produced (free) and recorded for the owner; nothing is bought", async () => {
    const offered = await num({ intent: "offer" });
    expect(offered, offered.message).toMatchObject({ ok: true, outcome: "offered" });
    for (const e164 of FAKE_NUMBER_CATALOGUE) expect(offered.message).toContain(e164);
    expect(psql(`select count(*) from public.studio_sms_number_offers where studio_id = '${SC}'`)).toBe("1");
    expect(numFake().count("purchaseNumber")).toBe(0);
    expect(numOps("number_purchase")).toBe("");
  });

  it("acquisition refuses while the owner has not approved a number, even with the fee confirmed and a number typed", async () => {
    const result = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[0] });
    expect(result, result.message).toMatchObject({ ok: false, outcome: "no_selection" });
    expect(numFake().count("purchaseNumber")).toBe(0);
    expect(numOps("number_purchase")).toBe("");
    expect(reservations("number")).toBe("");
  });

  it("the owner approves a number in their own session; the admin cannot buy a different number than the approved one", async () => {
    const offerId = psql(`select id from public.studio_sms_number_offers where studio_id = '${SC}' order by created_at desc limit 1`);
    const chosen = await asOwner().rpc("tw4_num_select_as_owner", { p_studio_id: SC, p_offer_id: offerId, p_e164: FAKE_NUMBER_CATALOGUE[0], p_ack_price_cents: PRICE.number });
    expect(chosen.error).toBeNull();
    // the pilot business still needs its own written approval of THIS fee (the database's blocker wins over everything else)
    const unapproved = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[0] });
    expect(unapproved).toMatchObject({ ok: false, outcome: "spend_blocked" });
    expect((await authorize("number", PRICE.number, "number-1")).error).toBeNull();
    const mismatch = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[1] });
    expect(mismatch).toMatchObject({ ok: false, outcome: "selection_mismatch" });
    expect(numFake().count("purchaseNumber")).toBe(0);
    expect(numFake().count("listIncomingNumbers")).toBe(0);
    expect(numOps("number_purchase")).toBe("");
    expect(reservations("number")).toBe("");
  });

  it("the ConfiDance cumulative ceiling refuses a purchase that would exceed it: nothing reserved, recorded or bought", async () => {
    // 1900 vetting + 1250 first month already count against the ceiling; 3300 leaves 150 < 200
    aged(`update public.studio_sms_pilot_exceptions set ceiling_cents = 3300 where legal_entity_id = '${EC}'`);
    const capped = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[0] });
    expect(capped, capped.message).toMatchObject({ ok: false, outcome: "insufficient_credit" });
    expect(capped.message).toMatch(/cumulative ceiling/);
    expect(numFake().count("purchaseNumber")).toBe(0);
    expect(numOps("number_purchase")).toBe("");
    expect(reservations("number")).toBe("");
    aged(`update public.studio_sms_pilot_exceptions set ceiling_cents = 15000 where legal_entity_id = '${EC}'`);
  });

  it("the approved number is bought once inside the ceiling, confirmed by a provider read and attached; a replay buys nothing", async () => {
    const bought = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[0] });
    expect(bought, bought.message).toMatchObject({ ok: true, outcome: "number_ready" });
    expect(numFake().count("purchaseNumber")).toBe(1);
    expect(numOps("number_purchase")).toBe("1:succeeded");
    expect(numOps("number_attach")).toBe("1:succeeded");
    expect(reservations("number")).toBe(`captured:${PRICE.number}:pilot`);
    expect(psql(`select e164 from public.studio_sms_num_operations where studio_id = '${SC}' and op_kind = 'number_purchase'`)).toBe(FAKE_NUMBER_CATALOGUE[0]);
    const replay = await num({ intent: "acquire", confirmFee: "on", approvedE164: FAKE_NUMBER_CATALOGUE[0] });
    expect(replay.ok, replay.message).toBe(true);
    expect(numFake().count("purchaseNumber")).toBe(1);
    expect(numOps("number_purchase")).toBe("1:succeeded");
    expect(reservations("number")).toBe(`captured:${PRICE.number}:pilot`);
    const before = numFake().calls.length;
    expect((await num({ intent: "refresh" })).outcome).toBe("number_ready");
    expect(numFake().calls.slice(before).every((c) => !["purchaseNumber", "attachNumber"].includes(c.method))).toBe(true);
  });

  it("the pilot ceiling was never exceeded and no credit was involved", () => {
    const used = Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${EC}' and funding = 'pilot' and status in ('reserved', 'captured')`));
    expect(used).toBe(PRICE.vetting + PRICE.monthly + PRICE.number);
    expect(used).toBeLessThanOrEqual(15_000);
    expect(psql(`select count(*) from public.studio_sms_credit_ledger where legal_entity_id = '${EC}'`)).toBe("0");
  });
});
