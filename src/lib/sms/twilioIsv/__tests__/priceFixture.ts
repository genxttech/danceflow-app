/**
 * D4-1 shared price fixture for the localStack suites. LOCAL QA DATABASE ONLY (every caller already requires the local-QA marker).
 *
 * Since migration 20270204090000 a price is published ONLY by an approved dual-control price change: tw4_price_set refuses every caller and a direct INSERT into
 * studio_sms_price_list is refused by its trigger. A suite that needs a published price therefore does what production does: one platform administrator proposes and a
 * DIFFERENT one approves. `seedPrice` does exactly that in one transaction, with the suite's own administrator as the APPROVER (so the price row is created_by that
 * administrator, as before) and a dedicated fixture administrator as the REQUESTER. The fixture administrator is demoted again in the same transaction, so it never
 * appears in a recipient list or an administrator count. Nothing here reaches a hosted service.
 */

/** The fixture administrator that proposes the prices (synthetic; demoted straight after each use). */
export const PRICE_FIXTURE_REQUESTER = "d41f1c70-0000-4000-8000-0000000000aa";

type Psql = (sql: string) => string;

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

export type SeedPrice = { kind: string; customer: number; provider: number; description: string; approver: string; ifMissing?: boolean };

/** The statements (no BEGIN / COMMIT, no output) that publish a price through the workflow, for a suite that builds its own transaction. */
export function seedPriceSql(p: SeedPrice): string {
  return `do $d41$ begin
  ${p.ifMissing ? `if exists (select 1 from public.studio_sms_price_list where kind = ${lit(p.kind)} and active) then return; end if;` : ""}
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at)
    values ('${PRICE_FIXTURE_REQUESTER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'price-fixture-requester@d41.test', now(), now(), now(), now())
    on conflict (id) do nothing;
  insert into public.profiles (id, platform_role) values ('${PRICE_FIXTURE_REQUESTER}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
  perform public.tw4_price_approve((public.tw4_price_propose(${lit(p.kind)}, ${Math.trunc(p.customer)}, ${Math.trunc(p.provider)}, ${lit(p.description)},
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

/** Owner-level re-activation of a retired price (a fixture reset a suite did with plain UPDATEs). The production trigger refuses it for everyone, so a suite that must
 *  restore a snapshot switches both guards off for that one statement, as the database owner, and switches the new one back on ALWAYS. */
export function ownerReactivate(psql: Psql, whereSql: string): void {
  psql(`begin;
alter table public.studio_sms_price_list disable trigger studio_sms_price_list_00_activation;
set local session_replication_role = replica;   -- the older ordinary guard (a published price is never edited) is off too, exactly as the suites' own resets always did
update public.studio_sms_price_list set active = true where ${whereSql};
alter table public.studio_sms_price_list enable always trigger studio_sms_price_list_00_activation;
commit;`);
}

/** Local-QA-only owner step: remove the fixture price-change requests (the request table is append-only evidence, and its guard is ENABLE ALWAYS, so a suite that cleans up
 *  after itself must switch the guard off, visibly, for that one delete and switch it back on ALWAYS). Safe on a stack without the table. */
export const deleteFixtureRequestsSql = (approver: string): string => `do $d41$ begin if to_regclass('public.studio_sms_price_change_requests') is not null then
  alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
  delete from public.studio_sms_price_change_requests where requested_by = '${PRICE_FIXTURE_REQUESTER}' or decided_by = '${approver}';
  alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
end if; end $d41$;`;

/** Local-QA-only owner step: make a request look older (to exercise expiry). Same explicit trigger switch as above. */
export function ownerAgeRequest(psql: Psql, requestId: string, hours = 25): void {
  psql(`begin;
alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
update public.studio_sms_price_change_requests set requested_at = requested_at - interval '${hours} hours', expires_at = expires_at - interval '${hours} hours' where id = '${requestId}';
alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard;
commit;`);
}
