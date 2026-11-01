/**
 * D4-1 shared price fixture for the localStack suites. LOCAL QA DATABASE ONLY: every statement below asserts the tw4_local_qa_only marker table inside the SQL itself.
 *
 * Since migration 20270204090000 a price is published ONLY by an approved dual-control price change. The public functions (tw4_price_propose / approve / reject) take the
 * identity from the caller's own aal2 JWT, so a suite that runs as the database owner uses the internal _tw4price_do_* functions (nobody else can execute them) with
 * explicit actors. `seedPrice` does what production does in one transaction: one registered platform administrator proposes and a DIFFERENT one approves. The suite's own
 * administrator is the APPROVER (the price row is created_by that administrator, as before); a dedicated fixture administrator is the REQUESTER and is demoted again in the
 * same transaction. Both are put in the protected approver registry by an owner-level insert (the registry has no API-role grants).
 *
 * The migration makes published prices undeletable, uneditable and unrepeatable (ENABLE ALWAYS triggers, also under session_replication_role = replica). The few suite
 * teardown steps that must still remove or restore fixture rows therefore switch the guard off VISIBLY for one statement (alter table ... disable trigger), as the owner, and
 * switch it back on ALWAYS. Nothing here is reachable from a production role.
 */

/** The fixture administrator that proposes the prices (synthetic; demoted straight after each use). */
export const PRICE_FIXTURE_REQUESTER = "d41f1c70-0000-4000-8000-0000000000aa";

type Psql = (sql: string) => string;

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Inside every owner-level snippet: refuse to run anywhere that is not a local QA database. */
const MARKER = `if to_regclass('public.tw4_local_qa_only') is null then raise exception 'price fixture: not a local QA database (no tw4_local_qa_only marker)'; end if;`;

export type SeedPrice = { kind: string; customer: number; provider: number; description: string; approver: string; ifMissing?: boolean };

/** The statements (no BEGIN / COMMIT, no output) that publish a price through the workflow, for a suite that builds its own transaction. */
export function seedPriceSql(p: SeedPrice): string {
  return `do $d41$ begin
  ${MARKER}
  ${p.ifMissing ? `if exists (select 1 from public.studio_sms_price_list where kind = ${lit(p.kind)} and active) then return; end if;` : ""}
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
    values ('${PRICE_FIXTURE_REQUESTER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'price-fixture-requester@d41.test', now(), now(), now(), now())
    on conflict (id) do nothing;
  insert into public.profiles (id, platform_role) values ('${PRICE_FIXTURE_REQUESTER}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
  insert into public.studio_sms_price_approvers (user_id, added_note) values ('${PRICE_FIXTURE_REQUESTER}', 'local QA fixture requester'), ('${p.approver}', 'local QA fixture approver') on conflict (user_id) do nothing;
  perform public._tw4price_do_approve((public._tw4price_do_propose(${lit(p.kind)}, ${Math.trunc(p.customer)}, ${Math.trunc(p.provider)}, ${lit(p.description)},
    'fixture price for a local QA suite (dual control: proposed by the fixture administrator)', '${PRICE_FIXTURE_REQUESTER}')->>'request_id')::uuid,
    '${p.approver}', 'fixture approval by the suite administrator (second administrator)');
  update public.profiles set platform_role = null where id = '${PRICE_FIXTURE_REQUESTER}';
end $d41$;`;
}

/** Propose (fixture administrator) and approve (`approver`) in ONE transaction. Returns the published price id. Throws when the database refuses. */
export function seedPrice(psql: Psql, p: SeedPrice): string {
  const out = psql(`begin;
${seedPriceSql(p)}
select id from public.studio_sms_price_list where kind = ${lit(p.kind)} and active;
commit;`);
  const id = out.split("\n").map((l) => l.trim()).find((l) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(l));
  if (!id) throw new Error(`price fixture: the price change was not applied (${out.slice(0, 300)})`);
  return id;
}

/** Seed a price only when none is active for the kind (the old "if none active" fixture idiom). */
export function seedPriceIfMissing(psql: Psql, p: SeedPrice): void {
  if (!psql(`select 1 from public.studio_sms_price_list where kind = ${lit(p.kind)} and active`)) seedPrice(psql, p);
}

/** Register a user as a price approver (owner-level insert into the protected registry; the registry has no API-role grants). */
export function registerApproverSql(userId: string, note = "local QA registered approver"): string {
  return `do $d41$ begin ${MARKER} insert into public.studio_sms_price_approvers (user_id, added_note) values ('${userId}', ${lit(note)}) on conflict (user_id) do nothing; end $d41$;`;
}

/** Owner-level re-activation of a retired price (a fixture reset a suite did with plain UPDATEs). Both guards are switched off for that one statement. */
export function ownerReactivate(psql: Psql, whereSql: string): void {
  psql(`begin;
do $d41$ begin ${MARKER} end $d41$;
alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
set local session_replication_role = replica;   -- the older ordinary guard (a published price is never edited) is off too, exactly as the suites' own resets always did
update public.studio_sms_price_list set active = true where ${whereSql};
alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
commit;`);
}

/** Owner-level removal of fixture price rows (teardown). A published price is undeletable in production (ENABLE ALWAYS delete guard): the owner switches it off visibly. */
export const deletePricesSql = (whereSql: string): string => `do $d41$ begin ${MARKER}
  alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
  set local session_replication_role = replica;
  delete from public.studio_sms_price_list where ${whereSql};
  alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
end $d41$;`;

/** Local-QA-only owner step: remove the fixture price-change requests (append-only evidence with an ENABLE ALWAYS guard: switched off visibly for that one delete). Safe on a stack without the table. */
export const deleteFixtureRequestsSql = (approver: string): string => `do $d41$ begin ${MARKER}
  if to_regclass('public.studio_sms_price_change_requests') is not null then
    alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
    delete from public.studio_sms_price_change_requests where requested_by = '${PRICE_FIXTURE_REQUESTER}' or decided_by = '${approver}';
    alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
  end if;
  if to_regclass('public.studio_sms_price_audit') is not null then
    -- the audit rows of the fixture proposals (immutable evidence in production; a local suite removes its own, visibly)
    alter table public.studio_sms_price_audit disable trigger studio_sms_price_audit_guard;
    delete from public.studio_sms_price_audit;
    alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_guard;
  end if;
end $d41$;`;

/** Local-QA-only owner step: make a request look older (to exercise expiry). */
export function ownerAgeRequest(psql: Psql, requestId: string, hours = 25): void {
  psql(`begin;
do $d41$ begin ${MARKER} end $d41$;
alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
update public.studio_sms_price_change_requests set requested_at = requested_at - interval '${hours} hours', expires_at = expires_at - interval '${hours} hours', cooling_until = cooling_until - interval '${hours} hours' where id = '${requestId}';
alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
commit;`);
}

/** Local-QA-only owner step: set the protected price authorization mode (production: owner-level migration only). The team-mode suites run in 'team'; the single-owner suites in 'single_owner'. */
export function setPriceMode(psql: Psql, mode: "team" | "single_owner"): void {
  psql(`begin;
do $d41$ begin ${MARKER} end $d41$;
alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard;
update public.studio_sms_price_auth_config set mode = '${mode}';
alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;
commit;`);
}
