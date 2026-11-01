/**
 * TW-4F J4 (activation console, 20261226090000) against a REAL schema: the full sender-activation path driven through the real server functions in
 * src/lib/sms/activation.ts (over a psql-backed `rpc` client, no PostgREST), one refusal per checklist item, the KI-1 owner gate for the pilot business,
 * superseded pilot covers, suspension / reactivation, replays and non-admin refusals. Synthetic fixtures with fresh ids per run; fake provider evidence only
 * (no Twilio, no SMS, no Stripe, no network).
 * LOCAL QA ONLY: a DEDICATED Postgres with migrations through 20261226090000 (incl. 20261218 F3, 20261219 F1, 20261225 RFL D5) and public.tw4_local_qa_only:
 *
 *   TW4A_LOCAL_DB_CONTAINER=<container>  TW4RFL_DB=postgres
 *   npx vitest run --no-file-parallelism src/lib/sms/twilioIsv/__tests__/localStack.j4activation.test.ts
 *
 * Re-runnable on the same database: every business, location and identifier is new per run; the one pilot business is reused (a new LOCATION per scenario) and
 * its pilot reservations are released again afterwards. The usage-reconciler health run (F3) is inserted INSIDE each transaction that needs it and deleted
 * before commit, so the platform-wide reconciler state is never changed by this suite. Item refusals run in transactions that are always rolled back.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pilotCoverArgs, pilotExceptionArgs } from "./rflEvidenceHelper";
import { activate, activationCheck, attestOptOut, markReady, recordSenderFromLedger, runComplianceValidation, suspend, verifyForActivation, type OptOutChecklist } from "../../activation";
import { FakeSenderReadProvider } from "../../senderVerification";
import { FakeNumberAdapter } from "../fakeNumbers";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const DB = process.env.TW4RFL_DB ?? "";
const enabled = Boolean(PG && DB);

const RUN = randomBytes(3).toString("hex");
const P = `a4${RUN}-0000-4000-8000-000000000401`;
const OUTSIDER = `a4${RUN}-0000-4000-8000-000000000999`;
const RUNNER = `j4-${RUN}`;
const NOTE = "documented reason for this activation step in the J4 suite";
const CHECKLIST: OptOutChecklist = { advanced_opt_out_enabled: true, stop_keyword_confirmed: true, start_keyword_confirmed: true, help_keyword_confirmed: true, confirmation_replies_confirmed: true };
const KI1 = "ki1_owner_redecision_pending:lifted_only_by_migration";
const ITEM_IDS = [
  "subaccount_active", "service_ready", "campaign_verified", "number_owned", "number_attached", "sender_ready", "opt_out_attested", "compliance_passed", "rfl_ready",
  "inventory_reconciled", "inbound_route_pinned", "usage_reconciler_ready", "funding_continuity", "pilot_ki1_redecided",
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// psql plumbing
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const sqlArgs = ["exec", "-i", PG, "psql", "-U", "postgres", "-d", DB, "-q", "-At", "-v", "ON_ERROR_STOP=1"];
const psql = (sql: string): string => execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const s = String(v).replace(/'/g, "''");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
};
const callSql = (fn: string, ...args: unknown[]) => `select public.${fn}(${args.map(lit).join(", ")})::text;`;
const call = <T = Record<string, unknown>>(fn: string, ...args: unknown[]): T => JSON.parse(psql(callSql(fn, ...args)) || "null") as T;
const replica = (sql: string) => psql(`begin; set local session_replication_role = replica; ${sql} commit;`);

/** F3 (20261218) readiness: a fresh completed, evidence-reading usage_reconcile run, visible only inside the transaction that inserts it (deleted before commit). */
const RECON_IN = `insert into public.studio_sms_reconcile_runs (job, runner, status, started_at, lease_expires_at, finished_at, summary)
  values ('usage_reconcile', '${RUNNER}', 'completed', now() - interval '1 minute', now() + interval '4 minutes', now(), '{"evidence_read": true, "due": 0}'::jsonb);`;
const RECON_OUT = `set local session_replication_role = replica; delete from public.studio_sms_reconcile_runs where runner = '${RUNNER}'; set local session_replication_role = origin;`;

type RpcResult = { data: unknown; error: { code: string; message: string } | null };
/**
 * The minimal `rpc` the server functions in activation.ts need, over psql as the database owner: named arguments, one transaction per call, and a psql ERROR mapped
 * to `{ error: { code: SQLSTATE, message } }` exactly as PostgREST reports it. `recon` wraps the call with the transaction-local reconciler run.
 */
function pgClient(opts: { recon?: boolean } = {}) {
  const calls: string[] = [];
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
    calls.push(fn);
    const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
    const sql = `\\set VERBOSITY verbose\nbegin;\n${opts.recon ? RECON_IN : ""}\nselect public.${fn}(${named})::text;\n${opts.recon ? RECON_OUT : ""}\ncommit;\n`;
    try {
      const out = execFileSync("docker", sqlArgs, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      return { data: out ? JSON.parse(out.split("\n").pop() as string) : null, error: null };
    } catch (error) {
      const err = String((error as { stderr?: Buffer | string }).stderr ?? error);
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(err);
      return { data: null, error: m ? { code: m[1], message: m[2] } : { code: "unknown", message: err.slice(0, 500) } };
    }
  };
  return { client: { rpc } as unknown as Pick<SupabaseClient, "rpc">, calls, rpc };
}
const admin = pgClient({ recon: true });
const bare = pgClient();

const hex = (n: number) => randomBytes(n).toString("hex");
const sid = (prefix: string) => `${prefix}${hex(16)}`;
const digest = () => hex(32);
const ref = (label: string) => `Written approval ${RUN} ${label} ${hex(3)}`;
const e164 = () => `+12${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------------
type World = { entity: string; studio: string; owner: string; account: string; pilot: boolean };
/** every pilot location this run created: their pilot reservations and spend authorizations are given back at the end, whatever happened */
const pilotLocations: World[] = [];
const cur = () => psql(`select public._tw4ml_month_key((select y.legal_entity_id from public.studio_sms_pilot_exceptions y limit 1), now())`);
const keyAdd = (k: string, n: number) => psql(`select public._tw4ml_key_add('${k}', ${n})`);

/** A synthetic business (or another location of the one pilot business) with an active subaccount, funded credit, a monthly limit and onboarding access. */
function world(opts: { pilot?: boolean } = {}): World {
  const w: World = { entity: randomUUID(), studio: randomUUID(), owner: randomUUID(), account: sid("AC"), pilot: Boolean(opts.pilot) };
  if (w.pilot) pilotLocations.push(w);
  const people = `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${w.owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-${hex(4)}@j4activation-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${w.owner}', null) on conflict (id) do nothing;
insert into public.studios (id, name, slug, public_name, timezone) values ('${w.studio}', 'J4 ${hex(3)}', 'j4-${hex(4)}', null, 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${w.owner}', '${w.studio}', 'studio_owner', true);`;
  const access = `insert into public.studio_sms_onboarding_access (studio_id, enabled, reason, updated_by) values ('${w.studio}', true, 'fixture: J4 suite', '${P}');`;
  if (w.pilot) {
    // the platform allows exactly ONE pilot business: every pilot scenario gets a fresh LOCATION of it
    const existing = psql(`select y.legal_entity_id || '|' || t.twilio_account_sid from public.studio_sms_pilot_exceptions y join public.studio_sms_twilio_accounts t on t.legal_entity_id = y.legal_entity_id and t.status = 'active'`);
    if (existing) {
      [w.entity, w.account] = existing.split("|");
      psql(`begin; ${people} commit;`);
      replica(`insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: another location of the pilot business', now()); ${access}`);
      return w;
    }
  }
  psql(`begin; ${people}
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values ('${w.entity}', '${w.pilot ? "ConfiDance Unlimited, LLC" : `J4 World ${hex(3)} LLC`}', '7777', ${w.pilot ? 15000 : 500000}, '${P}');
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values ('${w.studio}', '${w.entity}', 'founding', '${P}', 'fixture: verified synthetic business', now());
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values ('${w.entity}', '${w.account}', 'j4-${hex(3)}', 'test', 'active', '${P}');
commit;`);
  replica(access);
  call("tw4_credit_adjust", w.entity, 200_000, `j4-fund-${hex(4)}`, "fixture funding for the J4 suite", P);
  call("tw4_monthly_limit_set_admin", w.entity, P, 20_000, null, "fixture: monthly limit for the J4 suite");
  if (w.pilot) call("tw4_pilot_exception_create", ...pilotExceptionArgs(psql, w.entity, 15000, `Founder written pilot approval ${RUN}`, P));
  return w;
}

type Loc = World & { onboarding: string; op: string; attach: string; pn: string; number: string; mg: string; qe: string; bn: string };
const price = (kind: string) => Number(psql(`select customer_price_cents from public.studio_sms_price_list where kind = '${kind}' and active`));

/**
 * A location as R2a and R2b leave it, everything a provider would have to confirm seeded as OBSERVED TRUTH: the verified Messaging Service and campaign (R2a's
 * provider reads), the purchase and attach operations; then the REAL functions take over: the owner's recurring authorizations (credit business), the provider
 * read-backs (tw4_num_observe: owned, registered in the recurring-fee inventory; attached), the campaign registration (tw4_rfl_register), and a clean provider
 * inventory listing (tw4_num_inventory_observe). The runner lease is released at the end (the act_* functions refuse a leased location).
 */
function foundation(o: { pilot?: boolean; purchaseReservation?: boolean } = {}): Loc {
  const w = world({ pilot: o.pilot });
  const l: Loc = { ...w, onboarding: randomUUID(), op: randomUUID(), attach: randomUUID(), pn: sid("PN"), number: e164(), mg: sid("MG"), qe: sid("QE"), bn: sid("BN") };
  if (!l.pilot) {
    // the owner's standing authorizations (the first month is set aside from settled credit: the recurring-fee lifecycle's current-period cover)
    call("tw4_recurring_authorize", l.studio, l.owner, "number", price("number"), 3, null);
    call("tw4_recurring_authorize", l.studio, l.owner, "monthly", price("monthly"), 3, null);
  }
  const selection = randomUUID();
  replica(`insert into public.studio_sms_onboarding (id, studio_id, state, legal_name, entity_type, ein_last4, submission_seq, submitted_at, lease_owner, lease_expires_at)
    values ('${l.onboarding}', '${l.studio}', 'campaign_pending', 'J4 LLC', 'llc', '7777', 1, now(), 'lc', now() + interval '2 hours');
  insert into public.studio_sms_number_selections (id, offer_id, studio_id, legal_entity_id, twilio_account_sid, e164, price_cents, funding_mode, approver_user, approver_role, approval_ref, statement, expires_at, status, consumed_at, consumed_by_operation)
    values ('${selection}', '${randomUUID()}', '${l.studio}', '${l.entity}', '${l.account}', '${l.number}', ${price("number")}, '${l.pilot ? "pilot" : "credit_recurring"}', '${l.owner}', 'studio_owner', '${ref("selection")}',
            'fixture: the owner approved this single number for purchase in the J4 suite', now() + interval '1 day', 'consumed', now(), '${l.op}');
  insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
    values ('${l.onboarding}', '${l.studio}', 'B1', 1, 'succeeded', '${l.bn}', false, '${l.account}');
  insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, selection_id, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.op}', '${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'number_purchase', 1, 1, 'succeeded', '${selection}', '${l.number}', 'fixture number', '${digest()}',
            '{"funding_mode":"${l.pilot ? "pilot" : "credit"}"}'::jsonb, '${l.pn}', true, array['number'], '${P}', now());
  with ms as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid, started_by)
      values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'messaging_service', 1, 1, 'succeeded', 'df:test:j4:ms', '${digest()}', '${l.mg}', '${P}') returning id),
       qe as (insert into public.studio_sms_prov_operations (onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, friendly_name, request_digest, provider_sid,
                                                              fee_bearing, fee_kinds, started_by)
      values ('${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'campaign', 1, 1, 'succeeded', 'df:test:j4:c1', '${digest()}', '${l.qe}', true, array['campaign_vetting'], '${P}') returning id)
  insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status, source, evidence_digest, verified_at)
    select ms.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'messaging_service', '${l.mg}', null, null, null, 'ready', 'fake', '${digest()}', now() from ms
    union all select qe.id, '${l.entity}'::uuid, '${l.studio}'::uuid, '${l.account}', 'campaign', '${l.qe}', '${l.mg}', '${l.bn}', 'MIXED', 'verified', 'fake', '${digest()}', now() from qe;`);
  if (o.purchaseReservation) {
    replica(`insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, status, reservation_key, closed_at)
      values ('${l.entity}', '${l.studio}', 'number', ${price("number")}, 'pilot', 'captured', 'prov:${l.op}:number', now());`);
  }
  expect(call<{ status: string }>("tw4_num_observe", l.onboarding, "lc", l.op, { sid: l.pn, account_sid: l.account, phone_number: l.number, sms_capable: true }, "fake", digest()).status).toBe("owned");
  expect(resource(l, "number"), "the observed number is registered in the recurring-fee inventory").not.toBe("");
  call("tw4_rfl_register", l.studio, P, "campaign", l.qe, l.account, null, "admin", null, null);
  replica(`insert into public.studio_sms_num_operations (id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, attempt, submission_seq, status, e164, friendly_name, request_digest, params,
                                                 provider_sid, fee_bearing, fee_kinds, started_by, finished_at)
    values ('${l.attach}', '${l.onboarding}', '${l.studio}', '${l.entity}', '${l.account}', 'number_attach', 1, 1, 'succeeded', '${l.number}', 'fixture attach', '${digest()}',
            '{"messaging_service_sid":"${l.mg}","phone_number_sid":"${l.pn}"}'::jsonb, '${l.pn}', false, '{}'::text[], '${P}', now());`);
  expect(call<{ status: string }>("tw4_num_observe", l.onboarding, "lc", l.attach, { account_sid: l.account, service_sid: l.mg, number_sids: [l.pn] }, "fake", digest()).status).toBe("attached");
  inventory(l);
  replica(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
  return l;
}

/** A complete, clean fake provider listing of the business's subaccount (every live, owned ledger number of the business, all its locations). */
function inventory(l: Loc) {
  const leased = psql(`select lease_owner is not null and lease_expires_at > now() from public.studio_sms_onboarding where id = '${l.onboarding}'`) === "t";
  if (!leased) replica(`update public.studio_sms_onboarding set lease_owner = 'lc', lease_expires_at = now() + interval '1 hour' where id = '${l.onboarding}';`);
  const listing = psql(`select coalesce(jsonb_agg(distinct jsonb_build_object('sid', p.provider_sid, 'phone_number', p.e164)), '[]'::jsonb)::text from public.studio_sms_num_operations p
    where p.legal_entity_id = '${l.entity}' and p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null and p.twilio_account_sid = '${l.account}'
      and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = p.id and r.status = 'owned')`);
  psql(`select public.tw4_num_inventory_observe('${l.onboarding}'::uuid, 'lc', '${listing}'::jsonb, 'fake', now())::text;`);
  expect(psql(`select unknown_count || ':' || missing_count from public.studio_sms_num_inventory_checks where legal_entity_id = '${l.entity}' order by listed_at desc, created_at desc limit 1`)).toBe("0:0");
  if (!leased) replica(`update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';`);
}

let INBOUND = "";
/** The pinned inbound origin is platform-wide: reuse the current pin, or pin one if the database has none. */
function ensurePin() {
  let origin = psql(`select origin from public.studio_sms_inbound_route_pins order by id desc limit 1`);
  if (!origin) {
    call("tw4_inbound_route_pin_set", P, "https://app.example.test", "pin the canonical origin for the J4 suite");
    origin = "https://app.example.test";
  }
  INBOUND = `${origin}/api/sms/twilio/inbound`;
}

/** The provider as the fakes see it: the compliance reads (FakeNumberAdapter) and the sender reads (FakeSenderReadProvider). */
function fakes(l: Loc) {
  const adapter = new FakeNumberAdapter(l.account);
  adapter.registerService(l.mg, { inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
  adapter.registerCampaign(l.qe, { messaging_service_sid: l.mg });
  const provider = new FakeSenderReadProvider();
  provider.script("account", l.account, { sid: l.account, status: "active" });
  provider.script("service", l.mg, { sid: l.mg, account_sid: l.account, us_app_to_person_registered: true, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false });
  provider.script("campaign", l.qe, { sid: l.qe, account_sid: l.account, messaging_service_sid: l.mg, campaign_status: "VERIFIED", mock: false, brand_registration_sid: l.bn, us_app_to_person_usecase: "MIXED" });
  provider.script("brand", l.bn, { sid: l.bn, status: "APPROVED", mock: false });
  provider.script("number", l.pn, { sid: l.pn, account_sid: l.account, phone_number: l.number, sms_capable: true, status: "in-use", sms_url: null });
  provider.script("service_number", l.pn, { sid: l.pn, service_sid: l.mg, account_sid: l.account });
  return { adapter, provider };
}

/** Everything the console does, through the REAL server functions: record the sender from the ledger, attest Advanced Opt-Out, validate compliance, verify the sender. */
async function bringGreen(l: Loc) {
  const { adapter, provider } = fakes(l);
  const recorded = await recordSenderFromLedger(admin.client, l.studio, P);
  expect(recorded, "record sender").toMatchObject({ ok: true, data: { status: "pending" } });
  expect((await attestOptOut(admin.client, { studioId: l.studio, actorId: P, checklist: CHECKLIST, evidenceRef: `Twilio console screenshot J4 ${RUN}` })).ok).toBe(true);
  expect(await runComplianceValidation(admin.client, adapter, { studioId: l.studio, actorId: P, inboundUrl: INBOUND })).toEqual({ ok: true, data: { outcome: "passed", codes: [] } });
  expect(await verifyForActivation(admin.client, provider, { studioId: l.studio, actorId: P, inboundUrl: INBOUND })).toMatchObject({ ok: true, data: { outcome: "verified" } });
  return { adapter, provider };
}

const resource = (l: Loc, kind: "number" | "campaign") => psql(`select id from public.studio_sms_provider_resources where studio_id = '${l.studio}' and resource_kind = '${kind}' and provider_state = 'active'`);
const cover = (l: Loc, kind: "number" | "campaign", period: string) => call<{ cover_id: string }>("tw4_rfl_pilot_cover", ...pilotCoverArgs(psql, resource(l, kind), period, ref(`${kind}-${period}`), P));
/**
 * Gives the pilot's room back after a scenario (fixture bookkeeping, not a product path): its pilot reservations are released (the 15000-cent ceiling) and its pilot
 * spend authorizations voided (the business's cumulative spend cap counts them), so the suite is budget-neutral and re-runnable on one database.
 */
const releaseLocation = (w: World) =>
  replica(`update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where studio_id = '${w.studio}' and funding = 'pilot' and status <> 'released';
    update public.studio_sms_spend_events set status = 'void' where studio_id = '${w.studio}' and funding = 'pilot' and status <> 'void';`);
const committed = (w: World) => Number(psql(`select public._tw4f3a_committed('${w.entity}')`));
const pilotUsed = (w: World) => Number(psql(`select coalesce(sum(amount_cents), 0) from public.studio_sms_credit_reservations where legal_entity_id = '${w.entity}' and funding = 'pilot' and status in ('reserved', 'captured')`));

type Item = { id: string; ok: boolean; detail: string };
type Funding = { ok: boolean; detail: string; uncovered?: string[] };
const state = (l: Loc) => psql(`select state || '|' || coalesce(step, '') from public.studio_sms_onboarding where id = '${l.onboarding}'`);
const latestSender = (l: Loc) => psql(`select coalesce((select status from public.studio_sms_billed_senders where studio_id = '${l.studio}' order by seq desc limit 1), '')`);
const audits = (l: Loc, ...actions: string[]) => Number(psql(`select count(*) from public.studio_sms_onboarding_audit where studio_id = '${l.studio}' and action in (${actions.map((a) => `'${a}'`).join(", ")})`));
const checkItems = async (l: Loc) => {
  const res = await activationCheck(admin.client, l.studio, P);
  if (!res.ok) throw new Error(`activationCheck failed: ${res.code}`);
  return res.data;
};
/** The item ids a TW042 refusal lists ("id:detail,id:detail"; a detail may itself hold commas, e.g. the lifecycle's blocker array). */
const unmetOf = (message: string | undefined) => {
  const list = /activation checklist unmet: (.*)$/.exec(message ?? "")?.[1] ?? "";
  return ITEM_IDS.filter((id) => list.startsWith(`${id}:`) || list.includes(`,${id}:`)).sort();
};

/** The instant after which a standing authorization still covers the NEXT billing month for tw4_rfl_studio_ready: 28 days past the start of the next month (business timezone). */
const nextPeriodExemptionFrom = (l: Loc) => `(public._tw4ml_month_start('${l.entity}'::uuid, public._tw4ml_key_add(public._tw4ml_month_key('${l.entity}'::uuid, now()), 1)) + interval '28 days')`;

/**
 * One rolled-back transaction: puts the location in `ready_for_activation`, applies `breakSql` (as replica), then evaluates the checklist and tries
 * tw4_act_activate; then puts it in `campaign_pending` and tries tw4_act_mark_ready. Failed tries are caught in a subtransaction, so the state after each try shows
 * what the function left behind. Nothing is committed.
 */
function probe(l: Loc, breakSql: string, o: { recon?: boolean } = {}) {
  const tryFn = (q: string) => `pg_temp.j4_try($j4$${q}$j4$)`;
  const out = psql(`begin;
${o.recon === false ? "" : RECON_IN}
set local session_replication_role = replica;
update public.studio_sms_onboarding set state = 'ready_for_activation', step = 'A1', lease_owner = null, lease_expires_at = null where id = '${l.onboarding}';
${breakSql}
set local session_replication_role = origin;
create function pg_temp.j4_try(q text) returns text language plpgsql as $f$ begin execute q; return 'ok'; exception when others then return sqlstate || ': ' || sqlerrm; end $f$;
select 'J4|items|' || public._tw4act_items('${l.studio}')::text;
select 'J4|activate|' || ${tryFn(`select public.tw4_act_activate('${l.studio}'::uuid, '${P}'::uuid, '${NOTE}')`)};
select 'J4|after_activate|' || (select state from public.studio_sms_onboarding where id = '${l.onboarding}');
set local session_replication_role = replica;
update public.studio_sms_onboarding set state = 'campaign_pending' where id = '${l.onboarding}';
set local session_replication_role = origin;
select 'J4|mark|' || ${tryFn(`select public.tw4_act_mark_ready('${l.studio}'::uuid, '${P}'::uuid, '${NOTE}')`)};
select 'J4|after_mark|' || (select state from public.studio_sms_onboarding where id = '${l.onboarding}');
rollback;`);
  const get = (key: string) => (out.split("\n").find((line) => line.startsWith(`J4|${key}|`)) ?? "").slice(`J4|${key}|`.length);
  const items = JSON.parse(get("items") || "[]") as Item[];
  return { items, failing: items.filter((i) => !i.ok).map((i) => i.id).sort(), activate: get("activate"), afterActivate: get("after_activate"), mark: get("mark"), afterMark: get("after_mark") };
}

describe.skipIf(!enabled)("TW-4F J4: activation console end to end (real schema, real server functions, fake provider)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.tw4_local_qa_only') is not null`), "a local QA database is required").toBe("t");
    expect(psql(`select left(md5(replace(prosrc, chr(13), '')), 8) from pg_proc where oid = 'public._tw4act_items(uuid)'::regprocedure`), "20261226090000 must be applied").toBe("bdd8399d");
    expect(psql(`select to_regprocedure('public._tw4usage_reconciler_ready()') is not null and to_regprocedure('public.tw4_rfl_studio_ready(uuid)') is not null`)).toBe("t");
    psql(`begin;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, last_sign_in_at)
  values ('${P}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'padmin-${RUN}@j4activation-e2e.test', now(), now(), now()),
         ('${OUTSIDER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'out-${RUN}@j4activation-e2e.test', now(), now(), now());
insert into public.profiles (id, platform_role) values ('${P}', 'platform_admin'), ('${OUTSIDER}', null) on conflict (id) do update set platform_role = excluded.platform_role;
commit;`);
    for (const [kind, customer, provider] of [["number", 200, 115], ["monthly", 1000, 150]] as const) {
      if (!psql(`select 1 from public.studio_sms_price_list where kind = '${kind}' and active`)) call("tw4_price_set", kind, customer, provider, `fixture ${kind} price`, P);
    }
    ensurePin();
  });

  afterAll(() => {
    for (const w of pilotLocations) releaseLocation(w);
    if (pilotLocations.length) {
      const studios = pilotLocations.map((w) => `'${w.studio}'`).join(", ");
      // budget-neutral: nothing this run set aside still counts against the pilot ceiling or the business's spend cap
      expect(psql(`select (select count(*) from public.studio_sms_credit_reservations where studio_id in (${studios}) and funding = 'pilot' and status <> 'released') || ':' ||
        (select count(*) from public.studio_sms_spend_events where studio_id in (${studios}) and funding = 'pilot' and status <> 'void')`)).toBe("0:0");
    }
  });

  describe("a credit-funded (non-pilot) location", () => {
    let L: Loc;

    it("1. happy path: every checklist item is green through the real functions, mark ready, activate (state active, step A2, audit rows)", async () => {
      L = foundation();
      const before = await checkItems(L);
      expect(before.state).toBe("campaign_pending");
      expect(before.items.map((i) => i.id)).toEqual(ITEM_IDS);
      // what is still missing before the console steps run
      const missing = Object.fromEntries(before.items.filter((i) => !i.ok).map((i) => [i.id, i.detail]));
      expect(missing).toEqual({ sender_ready: "sender_not_verified_or_stale", opt_out_attested: "attestation_missing_or_stale", compliance_passed: "no_compliance_check" });
      expect(before.ledger).toMatchObject({ accountSid: L.account, messagingServiceSid: L.mg, campaignSid: L.qe, phoneNumberSid: L.pn, e164: L.number, senderId: null });
      // without the reconciler run the same item is red (the client's transaction-local run is the only thing making it green)
      const plain = await activationCheck(bare.client, L.studio, P);
      expect(plain.ok && plain.data.items.find((i) => i.id === "usage_reconciler_ready")).toMatchObject({ ok: false });

      await bringGreen(L);
      const green = await checkItems(L);
      expect(green.items.filter((i) => !i.ok)).toEqual([]);
      expect(green.ready).toBe(true);
      for (const item of green.items) expect(item.detail, item.id).toBe(item.id === "pilot_ki1_redecided" ? "not_pilot" : "ok");
      expect(green.ledger.senderId).toMatch(/^[0-9a-f-]{36}$/);

      expect(await markReady(admin.client, L.studio, P, NOTE)).toEqual({ ok: true, data: { state: "ready_for_activation" } });
      expect(state(L)).toBe("ready_for_activation|A1");
      expect(await activate(admin.client, L.studio, P, NOTE)).toEqual({ ok: true, data: { state: "active" } });
      expect(state(L)).toBe("active|A2");
      expect(audits(L, "activation_ready")).toBe(1);
      expect(audits(L, "activation_done")).toBe(1);
      expect(latestSender(L)).toBe("approved");
      // the send gate: an active location's ledger sender is ready
      expect(psql(`select (public._tw4sr_ready('${L.studio}')).id is not null`)).toBe("t");
    });

    // each case breaks exactly one condition; `also` lists the items that necessarily fail with it (they read the same fact), the refusal names the case's own item
    const BREAKS: Array<{ id: string; detail: string | RegExp; also?: string[]; recon?: false; sql: (l: Loc) => string }> = [
      { id: "subaccount_active", detail: "no_active_subaccount", also: ["campaign_verified", "compliance_passed", "inventory_reconciled", "number_attached", "number_owned", "opt_out_attested", "rfl_ready", "sender_ready", "service_ready"],
        sql: (l) => `update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = '${l.entity}' and status = 'active';` },
      { id: "service_ready", detail: "service_not_ready", also: ["campaign_verified", "compliance_passed", "opt_out_attested", "rfl_ready", "sender_ready"],
        sql: (l) => `update public.studio_sms_prov_operations set superseded_at = now() where studio_id = '${l.studio}' and op_kind = 'messaging_service';` },
      { id: "campaign_verified", detail: "campaign_not_verified", also: ["compliance_passed", "opt_out_attested", "rfl_ready", "sender_ready"],
        sql: (l) => `update public.studio_sms_prov_operations set superseded_at = now() where studio_id = '${l.studio}' and op_kind = 'campaign';` },
      // 20261226: a purchase whose ownership read-back is lost fails with its own detail (previously 'ok')
      { id: "number_owned", detail: "ownership_not_confirmed",
        sql: (l) => `update public.studio_sms_num_resources set status = 'mismatch', mismatch_code = 'sid_mismatch' where operation_id = '${l.op}';` },
      { id: "number_attached", detail: "no_attachment",
        sql: (l) => `update public.studio_sms_num_operations set superseded_at = now() where id = '${l.attach}';` },
      { id: "sender_ready", detail: "sender_not_verified_or_stale",
        sql: (l) => `update public.studio_sms_sender_verifications set created_at = now() - interval '25 hours' where studio_id = '${l.studio}';` },
      { id: "opt_out_attested", detail: "attestation_missing_or_stale",
        sql: (l) => `update public.studio_sms_optout_attestations set created_at = now() - interval '31 days' where studio_id = '${l.studio}';` },
      { id: "compliance_passed", detail: "compliance_failed_or_stale",
        sql: (l) => `update public.studio_sms_compliance_checks set created_at = now() - interval '25 hours' where studio_id = '${l.studio}';` },
      { id: "rfl_ready", detail: /^rfl_blockers:.*campaign_not_in_inventory/,
        sql: (l) => `update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where studio_id = '${l.studio}' and resource_kind = 'campaign';` },
      { id: "inventory_reconciled", detail: "inventory_check_stale",
        sql: (l) => `update public.studio_sms_num_inventory_checks set listed_at = listed_at - interval '25 hours', created_at = created_at - interval '25 hours' where legal_entity_id = '${l.entity}';` },
      // the compliance verdict is judged against the CURRENT pin, so it cannot stay green without one
      { id: "inbound_route_pinned", detail: "inbound_route_not_pinned", also: ["compliance_passed"], sql: () => `delete from public.studio_sms_inbound_route_pins;` },
      { id: "usage_reconciler_ready", detail: /^(no_completed_run|stale|evidence_failing|no_evidence_reads|stuck_lease)$/, recon: false, sql: () => `` },
      // a hold on the business's credit (through the real admin function); an authorization ending within 35 days is a funding lapse too, but it also fails the
      // lifecycle's next-period cover (rfl_ready reads the same authorization)
      { id: "funding_continuity", detail: "credit_on_hold",
        sql: (l) => `select public.tw4_credit_set_hold('${l.entity}'::uuid, true, 'fixture: hold inside a rolled-back transaction', '${P}'::uuid);` },
      // The expiry must fail BOTH readers of the same fact: funding wants more than 35 days, and the lifecycle's next-period cover exemption wants more than 28 days past the
      // start of the next billing month (tw4_rfl_studio_ready). 'now + 30 days' only fails the second while that start is at least 2 days away, i.e. not on the last two days of a
      // billing month, so the expiry is capped just below the exemption threshold (the cap is a no-op on every other day).
      { id: "funding_continuity", detail: "number_authorization_short_or_missing", also: ["rfl_ready"],
        sql: (l) => `update public.studio_sms_recurring_authorizations set expires_at = least(now() + interval '30 days', ${nextPeriodExemptionFrom(l)} - interval '1 minute') where studio_id = '${l.studio}' and kind = 'number' and status = 'active';` },
      // the business becomes the (one) pilot business inside the rolled-back transaction; the pilot path then also refuses its standing authorizations
      { id: "pilot_ki1_redecided", detail: KI1, also: ["funding_continuity", "rfl_ready"],
        sql: (l) => `delete from public.studio_sms_pilot_exceptions; insert into public.studio_sms_pilot_exceptions (legal_entity_id, ceiling_cents, approval_ref, approved_by) values ('${l.entity}', 15000, 'Founder written pilot approval (rolled back)', '${P}');` },
    ];

    it("2. one refusal per checklist item: activate and mark ready refuse with TW042 naming the item and its detail; the state does not change", () => {
      expect([...new Set(BREAKS.map((b) => b.id))].sort()).toEqual([...ITEM_IDS].sort());
      const committed = state(L);
      const auditBefore = audits(L, "activation_ready", "activation_done", "state_changed");
      // control: the same transaction with nothing broken activates
      const control = probe(L, "");
      expect(control.failing).toEqual([]);
      expect(control.activate).toBe("ok");
      expect(control.mark).toBe("ok");
      for (const b of BREAKS) {
        const r = probe(L, b.sql(L), { recon: b.recon });
        const item = r.items.find((i) => i.id === b.id);
        expect(item?.ok, b.id).toBe(false);
        if (typeof b.detail === "string") expect(item?.detail, b.id).toBe(b.detail);
        else expect(item?.detail, b.id).toMatch(b.detail);
        expect(r.failing, `${b.id}: only the broken condition (and what reads the same fact) fails`).toEqual([b.id, ...(b.also ?? [])].sort());
        for (const [label, err, after, expectedState] of [["activate", r.activate, r.afterActivate, "ready_for_activation"], ["mark_ready", r.mark, r.afterMark, "campaign_pending"]] as const) {
          expect(err, `${b.id} ${label}`).toMatch(/^TW042: activation checklist unmet: /);
          expect(err, `${b.id} ${label}`).toContain(`${b.id}:${item?.detail}`);
          expect(unmetOf(err), `${b.id} ${label}`).toEqual(r.failing);
          expect(after, `${b.id} ${label} leaves the state`).toBe(expectedState);
        }
      }
      expect(state(L)).toBe(committed);
      expect(audits(L, "activation_ready", "activation_done", "state_changed")).toBe(auditBefore);
      expect(psql(`select count(*) from public.studio_sms_inbound_route_pins`)).not.toBe("0");
    });

    it("2b. the lifecycle's next-period exemption has a date-independent boundary: an authorization expiring 28 days past the next month start fails rfl_ready and funding together, one minute later it fails only funding; a cancelled campaign still fails rfl_ready alone", () => {
      const set = (expr: string) => `update public.studio_sms_recurring_authorizations set expires_at = ${expr} where studio_id = '${L.studio}' and kind = 'number' and status = 'active';`;
      const below = probe(L, set(`${nextPeriodExemptionFrom(L)} - interval '1 minute'`));
      expect(below.failing).toEqual(["funding_continuity", "rfl_ready"]);
      expect(below.items.find((i) => i.id === "rfl_ready")?.detail).toBe('rfl_blockers:["number_next_period_uncovered"]');
      const above = probe(L, set(`${nextPeriodExemptionFrom(L)} + interval '1 minute'`));
      expect(above.failing).toEqual(["funding_continuity"]);
      expect(above.items.find((i) => i.id === "rfl_ready")?.detail).toBe("ok");
      expect(above.activate).toMatch(/^TW042: activation checklist unmet: funding_continuity:/);
      const cancelled = probe(L, `update public.studio_sms_provider_resources set provider_state = 'cancelled', cancelled_at = now(), cancel_evidence_digest = '${digest()}' where studio_id = '${L.studio}' and resource_kind = 'campaign';`);
      expect(cancelled.failing).toEqual(["rfl_ready"]);
      expect(cancelled.activate).toMatch(/^TW042: activation checklist unmet: rfl_ready:rfl_blockers:.*campaign_not_in_inventory/);
    });

    it("5. suspend: state suspended, step A3, sender revoked; reactivation needs the full checklist again", async () => {
      expect(await suspend(admin.client, L.studio, P, "owner asked to pause texting for the J4 suite")).toEqual({ ok: true, data: { state: "suspended" } });
      expect(state(L)).toBe("suspended|A3");
      expect(latestSender(L)).toBe("revoked");
      expect(audits(L, "activation_suspended")).toBe(1);
      expect(psql(`select (public._tw4sr_ready('${L.studio}')).id is not null`)).toBe("f");
      // not green: the revoked sender is not ready
      const refused = await activate(admin.client, L.studio, P, NOTE);
      expect(refused).toMatchObject({ ok: false, code: "TW042" });
      expect(!refused.ok && refused.message).toContain("sender_ready:sender_not_verified_or_stale");
      expect(unmetOf(!refused.ok ? refused.message : "")).toEqual(["sender_ready"]);
      expect(state(L)).toBe("suspended|A3");
      // green again: a new sender row from the ledger, verified from provider reads (attestation and compliance are still current)
      const { provider } = fakes(L);
      expect(await recordSenderFromLedger(admin.client, L.studio, P)).toMatchObject({ ok: true, data: { status: "pending" } });
      expect(await verifyForActivation(admin.client, provider, { studioId: L.studio, actorId: P, inboundUrl: INBOUND })).toMatchObject({ ok: true, data: { outcome: "verified" } });
      expect((await checkItems(L)).ready).toBe(true);
      expect(await activate(admin.client, L.studio, P, "reactivated after the full checklist passed again")).toEqual({ ok: true, data: { state: "active" } });
      expect(state(L)).toBe("active|A2");
      expect(audits(L, "activation_done")).toBe(2);
    });

    it("6. replays: recording the sender twice replays; activate on active, suspend on suspended and a second mark ready refuse TW030", async () => {
      const sendersBefore = psql(`select count(*) from public.studio_sms_billed_senders where studio_id = '${L.studio}'`);
      const again = await recordSenderFromLedger(admin.client, L.studio, P);
      expect(again).toMatchObject({ ok: true, data: { status: "approved", replayed: true } });
      const twice = await recordSenderFromLedger(admin.client, L.studio, P);
      expect(twice.ok && twice.data).toEqual(again.ok && again.data);
      expect(psql(`select count(*) from public.studio_sms_billed_senders where studio_id = '${L.studio}'`)).toBe(sendersBefore);

      expect(await activate(admin.client, L.studio, P, NOTE)).toMatchObject({ ok: false, code: "TW030" });
      expect(state(L)).toBe("active|A2");

      // mark ready twice (in a transaction that is rolled back: the location stays active for the cases below)
      const out = psql(`begin;
${RECON_IN}
set local session_replication_role = replica;
update public.studio_sms_onboarding set state = 'campaign_pending' where id = '${L.onboarding}';
set local session_replication_role = origin;
create function pg_temp.j4_try(q text) returns text language plpgsql as $f$ begin execute q; return 'ok'; exception when others then return sqlstate || ': ' || sqlerrm; end $f$;
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_act_mark_ready('${L.studio}'::uuid, '${P}'::uuid, '${NOTE}')$j4$);
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_act_mark_ready('${L.studio}'::uuid, '${P}'::uuid, '${NOTE}')$j4$);
select 'J4|' || (select state from public.studio_sms_onboarding where id = '${L.onboarding}');
rollback;`).split("\n").filter((x) => x.startsWith("J4|")).map((x) => x.slice(3));
      expect(out[0]).toBe("ok");
      expect(out[1]).toMatch(/^TW030: onboarding state ready_for_activation cannot be marked ready/);
      expect(out[2]).toBe("ready_for_activation");

      expect(await suspend(admin.client, L.studio, P, "pause texting before the replay check")).toMatchObject({ ok: true });
      const suspendedAgain = await suspend(admin.client, L.studio, P, "pause texting a second time (replay)");
      expect(suspendedAgain).toMatchObject({ ok: false, code: "TW030" });
      expect(state(L)).toBe("suspended|A3");
      expect(audits(L, "activation_suspended")).toBe(2);
    });

    it("7. a non-administrator is refused (42501) by every act function, and nothing changes", async () => {
      const snapshot = () => psql(`select (select state || ':' || coalesce(step, '') from public.studio_sms_onboarding where id = '${L.onboarding}') || '|' ||
        (select count(*) from public.studio_sms_optout_attestations where studio_id = '${L.studio}') || '|' || (select count(*) from public.studio_sms_compliance_checks where studio_id = '${L.studio}') || '|' ||
        (select count(*) from public.studio_sms_billed_senders where studio_id = '${L.studio}') || '|' || (select count(*) from public.studio_sms_sender_verifications where studio_id = '${L.studio}') || '|' ||
        (select count(*) from public.studio_sms_onboarding_audit where studio_id = '${L.studio}')`);
      const before = snapshot();
      const committedState = psql(`select state from public.studio_sms_onboarding where id = '${L.onboarding}'`);
      // every act_* entry point the database has is covered here
      expect(psql(`select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'tw4\\_act\\_%'`))
        .toBe("tw4_act_activate,tw4_act_attest,tw4_act_check,tw4_act_compliance_record,tw4_act_exposure,tw4_act_mark_ready,tw4_act_suspend,tw4_act_verify_sender");
      const { adapter, provider } = fakes(L);
      const c = admin.client;
      const results: Record<string, { ok: boolean; code?: string }> = {
        check: await activationCheck(c, L.studio, OUTSIDER),
        record_sender: await recordSenderFromLedger(c, L.studio, OUTSIDER),
        attest: await attestOptOut(c, { studioId: L.studio, actorId: OUTSIDER, checklist: CHECKLIST, evidenceRef: "Twilio console screenshot by an outsider" }),
        compliance: await runComplianceValidation(c, adapter, { studioId: L.studio, actorId: OUTSIDER, inboundUrl: INBOUND }),
        verify: await verifyForActivation(c, provider, { studioId: L.studio, actorId: OUTSIDER, inboundUrl: INBOUND }),
        mark_ready: await markReady(c, L.studio, OUTSIDER, NOTE),
        activate: await activate(c, L.studio, OUTSIDER, NOTE),
        suspend: await suspend(c, L.studio, OUTSIDER, NOTE),
      };
      // the two provider-evidence writes and the exposure read, called directly (the server functions above stop at the refused check before reaching them)
      const facts = { campaign: { sid: L.qe }, service: { sid: L.mg } };
      const sender = psql(`select id from public.studio_sms_billed_senders where studio_id = '${L.studio}' order by seq desc limit 1`);
      for (const [name, fn, args] of [
        ["compliance_record", "tw4_act_compliance_record", { p_studio_id: L.studio, p_actor: OUTSIDER, p_facts: facts, p_expected_inbound: INBOUND, p_source: "fake", p_digest: digest() }],
        ["verify_sender", "tw4_act_verify_sender", { p_studio_id: L.studio, p_sender_id: sender, p_actor: OUTSIDER, p_evidence: {}, p_source: "fake" }],
        ["exposure", "tw4_act_exposure", { p_actor: OUTSIDER }],
      ] as const) {
        const r = await admin.rpc(fn, args);
        results[name] = r.error ? { ok: false, code: r.error.code } : { ok: true };
      }
      for (const [name, r] of Object.entries(results)) expect(r, name).toMatchObject({ ok: false, code: "42501" });
      // and from the ready state too (the admin check comes before any state check)
      replica(`update public.studio_sms_onboarding set state = 'ready_for_activation' where id = '${L.onboarding}';`);
      expect(await activate(c, L.studio, OUTSIDER, NOTE)).toMatchObject({ ok: false, code: "42501" });
      replica(`update public.studio_sms_onboarding set state = '${committedState}' where id = '${L.onboarding}';`);
      expect(snapshot()).toBe(before);
    });
  });

  describe("the KI-1 owner gate (pilot business)", () => {
    let PL: Loc;

    it("3a. a pilot location with every other item green is refused by mark ready and activate (TW042) naming only pilot_ki1_redecided", async () => {
      PL = foundation({ pilot: true });
      await bringGreen(PL);
      for (const kind of ["number", "campaign"] as const) {
        cover(PL, kind, cur());
        cover(PL, kind, keyAdd(cur(), 1));
      }
      const check = await checkItems(PL);
      expect(check.ready).toBe(false);
      expect(check.items.filter((i) => !i.ok)).toEqual([{ id: "pilot_ki1_redecided", ok: false, detail: KI1 }]);
      expect(check.items.find((i) => i.id === "funding_continuity")).toEqual({ id: "funding_continuity", ok: true, detail: "ok" });

      const refused = await markReady(admin.client, PL.studio, P, NOTE);
      expect(refused).toMatchObject({ ok: false, code: "TW042" });
      expect(!refused.ok && refused.message).toBe(`activation checklist unmet: pilot_ki1_redecided:${KI1}`);
      expect(state(PL)).toBe("campaign_pending|N3");
      const r = probe(PL, "");
      expect(r.failing).toEqual(["pilot_ki1_redecided"]);
      expect(r.activate).toBe(`TW042: activation checklist unmet: pilot_ki1_redecided:${KI1}`);
      expect(r.afterActivate).toBe("ready_for_activation");
      expect(r.mark).toBe(`TW042: activation checklist unmet: pilot_ki1_redecided:${KI1}`);
      expect(audits(PL, "activation_ready", "activation_done")).toBe(0);
    });

    it("3b. a non-pilot location's item is ok with detail not_pilot (covered by the credit location above); a pilot one without green items still lists KI-1 among the unmet", async () => {
      const bare = foundation({ pilot: true });
      const r = probe(bare, "");
      expect(r.items.find((i) => i.id === "pilot_ki1_redecided")).toEqual({ id: "pilot_ki1_redecided", ok: false, detail: KI1 });
      expect(r.failing).toContain("pilot_ki1_redecided");
      expect(r.activate).toContain(`pilot_ki1_redecided:${KI1}`);
      expect(r.mark).toContain(`pilot_ki1_redecided:${KI1}`);
      const credit = foundation();
      expect(probe(credit, "").items.find((i) => i.id === "pilot_ki1_redecided")).toEqual({ id: "pilot_ki1_redecided", ok: true, detail: "not_pilot" });
      releaseLocation(bare);
    });

    it("3c. no switch, flag or function lifts the gate: only a migration can (switches toggled in a rolled-back transaction; no API role may run the checklist)", () => {
      const item = () => `select 'J4|' || (select i::text from jsonb_array_elements(public._tw4act_items('${PL.studio}')) i where i ->> 'id' = 'pilot_ki1_redecided');`;
      const out = psql(`begin;
${RECON_IN}
create function pg_temp.j4_try(q text) returns text language plpgsql as $f$ begin execute q; return 'ok'; exception when others then return sqlstate || ': ' || sqlerrm; end $f$;
${item()}
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_usage_set_switch(true, '${P}'::uuid, 'switch billed texting on for the J4 gate check')$j4$);
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_recurring_set_switch(true, '${P}'::uuid, 'switch recurring charges on for the J4 gate check')$j4$);
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_rfl_set_switch('scan', true, '${P}'::uuid, 'switch the lifecycle scan on for the J4 gate check')$j4$);
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_rfl_set_switch('delivery', true, '${P}'::uuid, 'switch alert delivery on for the J4 gate check')$j4$);
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_credit_set_hold('${PL.entity}'::uuid, false, 'clear any hold for the J4 gate check', '${P}'::uuid)$j4$);
${item()}
set local session_replication_role = replica;
update public.studio_sms_onboarding set state = 'ready_for_activation', step = 'A1' where id = '${PL.onboarding}';
set local session_replication_role = origin;
select 'J4|' || pg_temp.j4_try($j4$select public.tw4_act_activate('${PL.studio}'::uuid, '${P}'::uuid, '${NOTE}')$j4$);
rollback;`).split("\n").filter((x) => x.startsWith("J4|")).map((x) => x.slice(3));
      const gate = JSON.stringify({ id: "pilot_ki1_redecided", ok: false, detail: KI1 });
      expect(JSON.parse(out[0])).toEqual(JSON.parse(gate));
      // the switches themselves either changed or refused for their own reasons; either way the gate is unchanged
      expect(out.slice(1, 6)).toHaveLength(5);
      expect(JSON.parse(out[6])).toEqual(JSON.parse(gate));
      expect(out[7]).toBe(`TW042: activation checklist unmet: pilot_ki1_redecided:${KI1}`);
      // only _tw4act_items DEFINES the item (other functions may read the checklist, e.g. the owner texting status maps it to an owner area); the activation path
      // decides only through it: mark ready and activate call _tw4act_require, which is the unchanged 20261208 body over _tw4act_items. The item depends on the
      // pilot row alone, which no function updates or deletes.
      expect(psql(`select string_agg(p.oid::regprocedure::text, ',') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~ $re$'id',\\s*'pilot_ki1_redecided'$re$`)).toBe("_tw4act_items(uuid)");
      expect(psql(`select left(md5(replace(p.prosrc, chr(13), '')), 8) from pg_proc p where p.oid = 'public._tw4act_require(uuid)'::regprocedure`)).toBe("984dbba2");
      for (const fn of ["tw4_act_mark_ready(uuid,uuid,text)", "tw4_act_activate(uuid,uuid,text)"]) {
        expect(psql(`select position('perform public._tw4act_require(p_studio_id)' in p.prosrc) > 0 from pg_proc p where p.oid = 'public.${fn}'::regprocedure`), fn).toBe("t");
      }
      expect(psql(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.prosrc ~* 'delete\\s+from\\s+public\\.studio_sms_pilot_exceptions' or p.prosrc ~* 'update\\s+public\\.studio_sms_pilot_exceptions')`)).toBe("0");
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const fn of ["_tw4act_items(uuid)", "_tw4act_funding(uuid)", "_tw4act_pilot_funding(uuid,uuid)", "_tw4act_require(uuid)"]) {
          expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
        }
        expect(psql(`select has_table_privilege('${role}', 'public.studio_sms_pilot_exceptions', 'insert,update,delete')`), role).toBe("f");
      }
      for (const fn of ["tw4_act_mark_ready(uuid,uuid,text)", "tw4_act_activate(uuid,uuid,text)", "tw4_act_suspend(uuid,uuid,text)", "tw4_act_check(uuid,uuid)"]) {
        expect(psql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`), fn).toBe("t");
        for (const role of ["anon", "authenticated"]) expect(psql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), `${role} ${fn}`).toBe("f");
      }
    });

    it("3d. a pilot location that is already active (fixture) can still be suspended: state suspended, sender revoked", async () => {
      expect(latestSender(PL)).toBe("approved");
      replica(`update public.studio_sms_onboarding set state = 'active', step = 'A2' where id = '${PL.onboarding}';`);
      expect(await suspend(admin.client, PL.studio, P, "the owner pauses the pilot location in the J4 suite")).toEqual({ ok: true, data: { state: "suspended" } });
      expect(state(PL)).toBe("suspended|A3");
      expect(latestSender(PL)).toBe("revoked");
      expect(audits(PL, "activation_suspended")).toBe(1);
      // and it cannot come back while KI-1 stands (the revoked sender is listed too)
      const back = await activate(admin.client, PL.studio, P, NOTE);
      expect(back).toMatchObject({ ok: false, code: "TW042" });
      expect(unmetOf(!back.ok ? back.message : "")).toEqual(["pilot_ki1_redecided", "sender_ready"]);
      expect(state(PL)).toBe("suspended|A3");
      const used = pilotUsed(PL);
      const cap = committed(PL);
      releaseLocation(PL);
      expect(pilotUsed(PL)).toBeLessThan(used);
      expect(committed(PL)).toBeLessThan(cap);
    });
  });

  describe("superseded pilot covers (20261225 / 20261226)", () => {
    it("4. a cover marked superseded never funds the period in _tw4act_pilot_funding / _tw4act_funding", () => {
      const l = foundation({ pilot: true, purchaseReservation: true });
      const numberCover = () => psql(`select id || '|' || basis from public.studio_sms_provider_cover where resource_id = '${resource(l, "number")}' and period_key = '${cur()}' and superseded_at is null`);
      expect(numberCover().split("|")[1]).toBe("initial_reservation");
      cover(l, "campaign", cur());
      const funding = () => call<Funding>("_tw4act_funding", l.studio);
      const pilotFunding = () => call<Funding>("_tw4act_pilot_funding", l.studio, l.entity);
      // control: the registration-month reservation funds the number's current period
      expect(funding()).toMatchObject({ ok: true, detail: "ok" });
      expect(pilotFunding()).toMatchObject({ ok: true, detail: "ok" });
      const [coverId] = numberCover().split("|");
      // supersede it exactly as 20261225's all-or-none shape requires (evidence kept, never deleted)
      replica(`update public.studio_sms_provider_cover set superseded_at = now(), superseded_by = '${P}', superseded_reason = 'reservation_month_differs', superseded_by_cover_id = '${randomUUID()}' where id = '${coverId}';`);
      expect(psql(`select count(*) from public.studio_sms_provider_cover where id = '${coverId}' and superseded_at is not null`)).toBe("1");
      // the reservation itself is still captured, of the right kind, location and month: only the supersede mark keeps it from funding
      expect(psql(`select cr.status || ':' || cr.kind || ':' || (public._tw4ml_month_key(cr.legal_entity_id, cr.created_at) = '${cur()}') from public.studio_sms_provider_cover pc join public.studio_sms_credit_reservations cr on cr.id = pc.reservation_id where pc.id = '${coverId}'`)).toBe("captured:number:true");
      expect(funding()).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["number"] });
      expect(pilotFunding()).toMatchObject({ ok: false, detail: "pilot_current_period_unapproved", uncovered: ["number"] });
      expect(call<Item[]>("_tw4act_items", l.studio).find((i) => i.id === "funding_continuity")).toEqual({ id: "funding_continuity", ok: false, detail: "pilot_current_period_unapproved" });
      // the lifecycle's own cover verdict agrees (20261225)
      expect(psql(`select public._tw4rfl_cover(r, '${cur()}') from public.studio_sms_provider_resources r where r.id = '${resource(l, "number")}'`)).toMatch(/^uncovered:/);
      // and the 20261226 body is what refuses it: with the superseded_at filter removed (inside a rolled-back transaction) the same row would fund the period
      const body = psql(`select pg_get_functiondef('public._tw4act_pilot_funding(uuid,uuid)'::regprocedure)`);
      const count = (body.match(/and pc\.superseded_at is null/g) ?? []).length;
      expect(count).toBe(2);
      const without = body.replace(/ and pc\.superseded_at is null/g, "").replace("FUNCTION public._tw4act_pilot_funding(", "FUNCTION pg_temp.j4_unfiltered_funding(");
      const unfiltered = psql(`begin;
${without};
select 'J4|' || pg_temp.j4_unfiltered_funding('${l.studio}'::uuid, '${l.entity}'::uuid)::text;
rollback;`).split("\n").find((x) => x.startsWith("J4|"));
      expect(JSON.parse((unfiltered ?? "J4|null").slice(3))).toMatchObject({ ok: true });
      releaseLocation(l);
    });
  });
});
