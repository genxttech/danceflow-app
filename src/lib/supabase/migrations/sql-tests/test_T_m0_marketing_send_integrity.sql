-- Marketing M-0 -- regression suite for 20261117090000 (stage 1) [+ optional stage 2 checks when it is applied].
--
-- Generation preservation (C2), send-time claim/completion lifecycle (C3/C4, uncertain outcomes), unsubscribe for every
-- token kind (C1, cross-campaign, idempotency, no disclosure), platform suppression (D2), test-send authorization (D3),
-- client-role guards and RLS (C8), privileges and tenant isolation.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0000ae0XXXXX). The final block ALWAYS
-- raises, so nothing persists: "M-0 SQL SUITE PASS (<n> checks)" or "M-0 SQL SUITE FAIL: <failures>".
-- Remediation (section 11): send freeze, recipient privacy, legacy unsubscribe compatibility, outbound client writes.
-- Concurrency (separate sessions) is covered by sql-tests/m0_concurrency.sh.

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlstate || ' ' || sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into t_kv values (p_k, p_v::text) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.j(p_k text) returns jsonb language sql as $$ select v::jsonb from t_kv where k = p_k $$;
create or replace function pg_temp.as_user(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true) $$;

-- Stage 1 lands with marketing sends frozen; unfreeze inside this rolled-back transaction (section 11 tests the freeze).
select public.marketing_set_send_freeze(false, 'M-0 SQL suite (rolled back)');

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------------------
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000ae000001', 'M0 Studio A', 'm0-suite-studio-a'),
  ('00000000-0000-0000-0000-0000ae000002', 'M0 Studio B', 'm0-suite-studio-b');
insert into public.organizers (id, name, slug) values
  ('00000000-0000-0000-0000-0000ae000101', 'M0 Organizer', 'm0-suite-organizer'),
  ('00000000-0000-0000-0000-0000ae000102', 'M0 Organizer B', 'm0-suite-organizer-b');

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000202', 'm0-unverified-a@example.com', null),
  ('00000000-0000-0000-0000-0000ae000203', 'm0-outsider@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000204', 'm0-org-user@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000205', 'm0-staff-b@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000206', 'm0-client-role@example.com', now());
insert into public.profiles (id, email)
select id, email from auth.users where id::text like '00000000-0000-0000-0000-0000ae0002%';
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000ae000201', '00000000-0000-0000-0000-0000ae000001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000ae000202', '00000000-0000-0000-0000-0000ae000001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000ae000205', '00000000-0000-0000-0000-0000ae000002', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000ae000206', '00000000-0000-0000-0000-0000ae000001', 'client', true);
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000204', 'organizer_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000ae000301', '00000000-0000-0000-0000-0000ae000001', 'A', 'One', 'm0-a1@example.com', 'active'),
  ('00000000-0000-0000-0000-0000ae000302', '00000000-0000-0000-0000-0000ae000001', 'A', 'Two', 'm0-a2@example.com', 'active'),
  ('00000000-0000-0000-0000-0000ae000303', '00000000-0000-0000-0000-0000ae000002', 'B', 'One', 'm0-a1@example.com', 'active');

insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type) values
  ('00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000001', 'C1', 'S', 'B', 'draft', 'manual'),
  ('00000000-0000-0000-0000-0000ae000402', '00000000-0000-0000-0000-0000ae000001', 'C2', 'S', 'B', 'draft', 'manual'),
  ('00000000-0000-0000-0000-0000ae000403', '00000000-0000-0000-0000-0000ae000002', 'CB', 'S', 'B', 'draft', 'manual'),
  ('00000000-0000-0000-0000-0000ae000406', '00000000-0000-0000-0000-0000ae000001', 'C-sent', 'S', 'B', 'sent', 'manual');
insert into public.organizer_marketing_campaigns (id, organizer_id, name, subject, body_text, status) values
  ('00000000-0000-0000-0000-0000ae000404', '00000000-0000-0000-0000-0000ae000101', 'O1', 'S', 'B', 'draft'),
  ('00000000-0000-0000-0000-0000ae000405', '00000000-0000-0000-0000-0000ae000101', 'O2', 'S', 'B', 'draft');

insert into public.organizer_contacts (id, organizer_id, email, status) values
  ('00000000-0000-0000-0000-0000ae000501', '00000000-0000-0000-0000-0000ae000101', 'm0-c1@example.com', 'active'),
  ('00000000-0000-0000-0000-0000ae000502', '00000000-0000-0000-0000-0000ae000101', 'm0-c2@example.com', 'unsubscribed'),
  ('00000000-0000-0000-0000-0000ae000503', '00000000-0000-0000-0000-0000ae000102', 'm0-c1@example.com', 'active');

insert into public.marketing_unsubscribes (studio_id, email, reason) values
  ('00000000-0000-0000-0000-0000ae000001', 'm0-pre-unsub@example.com', 'seed');
insert into public.marketing_email_suppressions (email, reason, source) values
  ('m0-bounced@example.com', 'hard_bounce', 'suite');

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Generation (studio): dedupe, suppression decided in SQL, invalid skipped, foreign client id dropped
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.save('sync1', public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001',
  '00000000-0000-0000-0000-0000ae000401', jsonb_build_array(
    jsonb_build_object('email', 'M0-A1@Example.com ', 'name', 'A One', 'ref_id', '00000000-0000-0000-0000-0000ae000301'),
    jsonb_build_object('email', 'm0-a1@example.com', 'name', 'dup'),
    jsonb_build_object('email', 'm0-a2@example.com', 'ref_id', '00000000-0000-0000-0000-0000ae000303'),
    jsonb_build_object('email', 'm0-pre-unsub@example.com'),
    jsonb_build_object('email', 'm0-bounced@example.com'),
    jsonb_build_object('email', 'not-an-email'),
    jsonb_build_object('email', ''))));
select pg_temp.chk('sync: outcome synced', pg_temp.j('sync1') ->> 'outcome' = 'synced', pg_temp.kv('sync1'));
select pg_temp.chk('sync: 2 pending after dedupe', (pg_temp.j('sync1') ->> 'pending')::int = 2, pg_temp.kv('sync1'));
select pg_temp.chk('sync: studio unsubscribe suppressed', (pg_temp.j('sync1') ->> 'unsubscribed')::int = 1, pg_temp.kv('sync1'));
select pg_temp.chk('sync: platform suppression applied', (pg_temp.j('sync1') ->> 'suppressed')::int = 1, pg_temp.kv('sync1'));
select pg_temp.chk('sync: rows normalized to lower-case', exists (select 1 from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-a1@example.com'));
select pg_temp.chk('sync: own client linked', (select client_id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-a1@example.com') = '00000000-0000-0000-0000-0000ae000301');
select pg_temp.chk('sync: other studio client id never linked', (select client_id from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-a2@example.com') is null);
select pg_temp.chk('sync: every row has a token', not exists (select 1 from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and unsubscribe_token is null));
select pg_temp.chk('sync: wrong scope is not_found',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000401', '[]'::jsonb) ->> 'outcome' = 'not_found');
select pg_temp.chk('sync: sent campaign is locked',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000406', '[]'::jsonb) ->> 'outcome' = 'campaign_locked');
select pg_temp.expect_msg('sync: non-array input refused',
  $q$select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '{}'::jsonb)$q$, '22023');

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Claim / complete lifecycle
-- ---------------------------------------------------------------------------------------------------------------
insert into t_kv select 'rid:a1', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-a1@example.com';
insert into t_kv select 'rid:a2', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-a2@example.com';
insert into t_kv select 'tok:a1', unsubscribe_token from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a1')::uuid;

select pg_temp.save('claim1', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a1')::uuid, 600));
select pg_temp.chk('claim: claimed', pg_temp.j('claim1') ->> 'outcome' = 'claimed', pg_temp.kv('claim1'));
select pg_temp.chk('claim: deterministic idempotency key', pg_temp.j('claim1') ->> 'idempotency_key' = 'mkt-studio-' || pg_temp.kv('rid:a1'));
select pg_temp.chk('claim: returns the delivered token', pg_temp.j('claim1') ->> 'unsubscribe_token' = pg_temp.kv('tok:a1'));
select pg_temp.chk('claim: row is sending with lease', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a1')::uuid and status = 'sending' and claim_expires_at > now() and attempt_count = 1 and first_attempt_at is not null));
select pg_temp.chk('claim: second claim while leased is in_flight',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a1')::uuid, 600) ->> 'outcome' = 'in_flight');
select pg_temp.chk('complete: wrong claim id is stale',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a1')::uuid, gen_random_uuid(), 'sent', 'msg-x', null) ->> 'outcome' = 'stale');
select pg_temp.chk('complete: wrong scope is stale',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000002', pg_temp.kv('rid:a1')::uuid, (pg_temp.j('claim1') ->> 'claim_id')::uuid, 'sent', 'msg-x', null) ->> 'outcome' = 'stale');
select pg_temp.chk('complete: sent',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a1')::uuid, (pg_temp.j('claim1') ->> 'claim_id')::uuid, 'sent', 'msg-a1', null) ->> 'outcome' = 'sent');
select pg_temp.chk('complete: sent row carries evidence and no claim', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a1')::uuid and status = 'sent' and provider_message_id = 'msg-a1' and sent_at is not null and claim_id is null));
select pg_temp.chk('complete: repeat completion is stale',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a1')::uuid, (pg_temp.j('claim1') ->> 'claim_id')::uuid, 'failed', null, 'late') ->> 'outcome' = 'stale');
select pg_temp.chk('claim: a sent recipient is not claimable',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a1')::uuid, 600) ->> 'outcome' = 'not_claimable');
select pg_temp.chk('claim: wrong campaign is not_found',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402', pg_temp.kv('rid:a2')::uuid, 600) ->> 'outcome' = 'not_found');
select pg_temp.chk('claim: other studio is not_found',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600) ->> 'outcome' = 'not_found');

-- released: definitively not accepted -> pending again, attempt not counted
select pg_temp.save('claim2', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600));
select pg_temp.chk('released: completion ok',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a2')::uuid, (pg_temp.j('claim2') ->> 'claim_id')::uuid, 'released', null, 'rate_limit_exceeded') ->> 'outcome' = 'released');
select pg_temp.chk('released: back to pending, attempts reset', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a2')::uuid and status = 'pending' and attempt_count = 0 and first_attempt_at is null and claim_id is null));

-- uncertain: stays sending (lease expired) and is re-claimed with the SAME idempotency key
select pg_temp.save('claim3', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600));
select pg_temp.chk('uncertain: completion keeps the row',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a2')::uuid, (pg_temp.j('claim3') ->> 'claim_id')::uuid, 'uncertain', null, 'timeout') ->> 'outcome' = 'uncertain');
select pg_temp.chk('uncertain: still sending, lease expired, error kept', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a2')::uuid and status = 'sending' and claim_expires_at <= now() and last_attempt_error = 'timeout'));
select pg_temp.save('claim4', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600));
select pg_temp.chk('uncertain: re-claimed as retry', pg_temp.j('claim4') ->> 'outcome' = 'claimed' and (pg_temp.j('claim4') ->> 'retry')::boolean, pg_temp.kv('claim4'));
select pg_temp.chk('uncertain: same idempotency key on retry', pg_temp.j('claim4') ->> 'idempotency_key' = pg_temp.j('claim3') ->> 'idempotency_key');
select pg_temp.chk('uncertain: new claim id on retry', pg_temp.j('claim4') ->> 'claim_id' <> pg_temp.j('claim3') ->> 'claim_id');
select pg_temp.chk('uncertain: old claim can no longer complete',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:a2')::uuid, (pg_temp.j('claim3') ->> 'claim_id')::uuid, 'sent', 'msg-old', null) ->> 'outcome' = 'stale');
-- older than the provider idempotency window -> delivery_unknown, never re-sent
update public.marketing_campaign_recipients set claim_expires_at = now() - interval '1 minute', first_attempt_at = now() - interval '24 hours'
where id = pg_temp.kv('rid:a2')::uuid;
select pg_temp.chk('unknown: attempt older than 23h becomes delivery_unknown',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600) ->> 'outcome' = 'delivery_unknown');
select pg_temp.chk('unknown: row terminal without a claim', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a2')::uuid and status = 'delivery_unknown' and claim_id is null));
select pg_temp.chk('unknown: not claimable afterwards',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:a2')::uuid, 600) ->> 'outcome' = 'not_claimable');
select pg_temp.expect_msg('complete: invalid outcome refused',
  $q$select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', gen_random_uuid(), gen_random_uuid(), 'delivered', null, null)$q$, '22023');
select pg_temp.expect_msg('claim: invalid scope kind refused',
  $q$select public.marketing_claim_campaign_recipient('tenant', '00000000-0000-0000-0000-0000ae000001', gen_random_uuid(), gen_random_uuid(), 600)$q$, '22023');

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Generation preserves history (C2): sent / unknown rows and their tokens survive; addresses are not re-added
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.save('sync2', public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001',
  '00000000-0000-0000-0000-0000ae000401', jsonb_build_array(
    jsonb_build_object('email', 'm0-a1@example.com'),
    jsonb_build_object('email', 'm0-a2@example.com'),
    jsonb_build_object('email', 'm0-new@example.com'))));
select pg_temp.chk('regenerate: synced', pg_temp.j('sync2') ->> 'outcome' = 'synced', pg_temp.kv('sync2'));
select pg_temp.chk('regenerate: sent row preserved with its token and provider id', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a1')::uuid and status = 'sent' and unsubscribe_token = pg_temp.kv('tok:a1') and provider_message_id = 'msg-a1'));
select pg_temp.chk('regenerate: unknown row preserved', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a2')::uuid and status = 'delivery_unknown'));
select pg_temp.chk('regenerate: already-mailed addresses not re-added', (select count(*) from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email in ('m0-a1@example.com', 'm0-a2@example.com')) = 2);
select pg_temp.chk('regenerate: only the new address is pending', (select string_agg(email, ',') from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and status = 'pending') = 'm0-new@example.com');
select pg_temp.chk('regenerate: preserved count reported', (pg_temp.j('sync2') ->> 'preserved')::int = 2, pg_temp.kv('sync2'));
insert into t_kv select 'rid:new', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401' and email = 'm0-new@example.com';
select pg_temp.save('claim5', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', pg_temp.kv('rid:new')::uuid, 600));
select pg_temp.chk('regenerate: refused while a recipient is sending',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '[]'::jsonb) ->> 'outcome' = 'delivery_in_progress');
select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:new')::uuid, (pg_temp.j('claim5') ->> 'claim_id')::uuid, 'failed', null, 'validation_error');
select pg_temp.chk('failed: definitive rejection recorded', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:new')::uuid and status = 'failed' and error_message = 'validation_error'));
select pg_temp.chk('regenerate: an empty audience keeps every mailed row',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '[]'::jsonb) ->> 'outcome' = 'synced'
  and (select count(*) from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401') = 3);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Unsubscribe by token: send-time effect, cross-campaign, idempotency, no disclosure (studio)
-- ---------------------------------------------------------------------------------------------------------------
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402',
  jsonb_build_array(jsonb_build_object('email', 'm0-a1@example.com'), jsonb_build_object('email', 'm0-a3@example.com')));
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000403',
  jsonb_build_array(jsonb_build_object('email', 'm0-a1@example.com')));
insert into t_kv select 'rid:c2a1', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-a1@example.com';

-- the address unsubscribes through the link delivered by campaign 1 (its row is already sent)
select pg_temp.save('unsub1', public.marketing_unsubscribe_by_token(pg_temp.kv('tok:a1'), 'one_click'));
select pg_temp.chk('unsubscribe: ok', (pg_temp.j('unsub1') ->> 'ok')::boolean, pg_temp.kv('unsub1'));
select pg_temp.chk('unsubscribe: result discloses no email or name', not (pg_temp.j('unsub1') ? 'email') and not (pg_temp.j('unsub1') ? 'studio_name'));
select pg_temp.chk('unsubscribe: record with audit detail', exists (select 1 from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001' and email = 'm0-a1@example.com' and source = 'one_click' and campaign_id = '00000000-0000-0000-0000-0000ae000401' and recipient_id = pg_temp.kv('rid:a1')::uuid and request_count = 1));
select pg_temp.chk('unsubscribe: sent row keeps its sent evidence', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:a1')::uuid and status = 'sent'));
select pg_temp.chk('unsubscribe (C3): another campaign''s pending row is suppressed', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:c2a1')::uuid and status = 'unsubscribed'));
select pg_temp.chk('unsubscribe: other studio untouched', exists (select 1 from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000403' and email = 'm0-a1@example.com' and status = 'pending'));
insert into t_kv select 'first_at', unsubscribed_at::text from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001' and email = 'm0-a1@example.com';
select pg_temp.save('unsub2', public.marketing_unsubscribe_by_token(upper(pg_temp.kv('tok:a1')), 'page_form'));
select pg_temp.chk('unsubscribe: repeat is idempotent', (pg_temp.j('unsub2') ->> 'ok')::boolean and (select count(*) from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001' and lower(email) = 'm0-a1@example.com') = 1);
select pg_temp.chk('unsubscribe: repeat counted, first timestamp and source kept', exists (select 1 from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001' and email = 'm0-a1@example.com' and request_count = 2 and source = 'one_click' and last_source = 'page_form' and unsubscribed_at::text = pg_temp.kv('first_at')));
select pg_temp.chk('unsubscribe: unknown token not_found', public.marketing_unsubscribe_by_token(gen_random_uuid()::text, 'one_click') ->> 'reason' = 'not_found');
select pg_temp.chk('unsubscribe: malformed token not_found', public.marketing_unsubscribe_by_token('x'' or 1=1 --', 'one_click') ->> 'reason' = 'not_found');
select pg_temp.expect_msg('unsubscribe: unknown method refused', $q$select public.marketing_unsubscribe_by_token(gen_random_uuid()::text, 'bulk')$q$, '22023');

-- claim after an unsubscribe of the same address: not sent (C3)
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402',
  jsonb_build_array(jsonb_build_object('email', 'm0-a3@example.com'), jsonb_build_object('email', 'm0-late@example.com')));
insert into t_kv select 'rid:late', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-late@example.com';
insert into public.marketing_unsubscribes (studio_id, email, reason) values ('00000000-0000-0000-0000-0000ae000001', 'm0-late@example.com', 'suite-direct');
select pg_temp.chk('claim: address unsubscribed after generation is not sent',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402', pg_temp.kv('rid:late')::uuid, 600) ->> 'outcome' = 'unsubscribed');
select pg_temp.chk('claim: suppressed row marked, no claim', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:late')::uuid and status = 'unsubscribed' and claim_id is null and attempt_count = 0));
-- platform suppression added after generation
insert into t_kv select 'rid:a3', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-a3@example.com';
insert into public.marketing_email_suppressions (email, reason, source) values ('m0-a3@example.com', 'complaint', 'suite');
select pg_temp.chk('claim: platform complaint suppresses at send time',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402', pg_temp.kv('rid:a3')::uuid, 600) ->> 'outcome' = 'suppressed');
-- an uncertain attempt is never retried once the address is suppressed
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402',
  jsonb_build_array(jsonb_build_object('email', 'm0-retry@example.com')));
insert into t_kv select 'rid:retry', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-retry@example.com';
select pg_temp.save('claim6', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402', pg_temp.kv('rid:retry')::uuid, 600));
select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:retry')::uuid, (pg_temp.j('claim6') ->> 'claim_id')::uuid, 'uncertain', null, 'network');
insert into public.marketing_unsubscribes (studio_id, email, reason) values ('00000000-0000-0000-0000-0000ae000001', 'm0-retry@example.com', 'suite-direct');
select pg_temp.chk('uncertain + unsubscribed: never re-sent, recorded unknown',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402', pg_temp.kv('rid:retry')::uuid, 600) ->> 'outcome' = 'delivery_unknown');

-- legacy page RPC goes through the same path and discloses nothing
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000403',
  jsonb_build_array(jsonb_build_object('email', 'm0-legacy@example.com')));
insert into t_kv select 'tok:legacy', unsubscribe_token from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000403' and email = 'm0-legacy@example.com';
select pg_temp.chk('legacy RPC: success without email or studio name',
  (select success and email is null and studio_name is null from public.unsubscribe_marketing_recipient(pg_temp.kv('tok:legacy'))));
select pg_temp.chk('legacy RPC: records the unsubscribe', exists (select 1 from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000002' and email = 'm0-legacy@example.com' and source = 'legacy_page'));
select pg_temp.chk('legacy RPC: unknown token is not success', (select not success from public.unsubscribe_marketing_recipient(gen_random_uuid()::text)));

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Organizer (C1): unsubscribe persists, contact marked, cross-campaign, organizer-scoped
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.save('osync', public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae000101',
  '00000000-0000-0000-0000-0000ae000404', jsonb_build_array(
    jsonb_build_object('email', 'm0-c1@example.com', 'ref_id', '00000000-0000-0000-0000-0000ae000501'),
    jsonb_build_object('email', 'm0-c2@example.com', 'ref_id', '00000000-0000-0000-0000-0000ae000502'),
    jsonb_build_object('email', 'm0-c3@example.com', 'ref_id', '00000000-0000-0000-0000-0000ae000503'))));
select pg_temp.chk('organizer sync: unsubscribed contact suppressed', (pg_temp.j('osync') ->> 'pending')::int = 2 and (pg_temp.j('osync') ->> 'unsubscribed')::int = 1, pg_temp.kv('osync'));
select pg_temp.chk('organizer sync: other organizer contact id never linked', (select organizer_contact_id from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000404' and email = 'm0-c3@example.com') is null);
select public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000405',
  jsonb_build_array(jsonb_build_object('email', 'm0-c1@example.com')));
insert into t_kv select 'otok:c1', unsubscribe_token::text from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000404' and email = 'm0-c1@example.com';
select pg_temp.save('ounsub', public.marketing_unsubscribe_by_token(pg_temp.kv('otok:c1'), 'one_click'));
select pg_temp.chk('organizer unsubscribe (C1): ok', (pg_temp.j('ounsub') ->> 'ok')::boolean and pg_temp.j('ounsub') ->> 'scope_kind' = 'organizer', pg_temp.kv('ounsub'));
select pg_temp.chk('organizer unsubscribe (C1): record persisted', exists (select 1 from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101' and email = 'm0-c1@example.com' and source = 'one_click'));
select pg_temp.chk('organizer unsubscribe: contact marked unsubscribed', (select status from public.organizer_contacts where id = '00000000-0000-0000-0000-0000ae000501') = 'unsubscribed');
select pg_temp.chk('organizer unsubscribe: other campaign pending row suppressed', (select status from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000405' and email = 'm0-c1@example.com') = 'unsubscribed');
select pg_temp.chk('organizer unsubscribe: other organizer''s contact untouched', (select status from public.organizer_contacts where id = '00000000-0000-0000-0000-0000ae000503') = 'active');
select pg_temp.chk('organizer unsubscribe: studio list untouched', not exists (select 1 from public.marketing_unsubscribes where email = 'm0-c1@example.com'));
select pg_temp.save('ounsub2', public.marketing_unsubscribe_by_token(pg_temp.kv('otok:c1'), 'page_form'));
select pg_temp.chk('organizer unsubscribe: idempotent repeat', (select request_count from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101' and email = 'm0-c1@example.com') = 2);

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Per-message tokens (commercial ARIA / automation messages) and read-only eligibility
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.save('mtok', to_jsonb(public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae000001', 'M0-Msg@Example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000601')));
select pg_temp.chk('message token: same source returns the same token',
  to_jsonb(public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae000001', 'm0-msg@example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000601')) = pg_temp.j('mtok'));
select pg_temp.expect_msg('message token: source reused for another recipient refused',
  $q$select public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae000001', 'other@example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000601')$q$, '23514');
select pg_temp.expect_msg('message token: source reused for another scope refused',
  $q$select public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae000002', 'm0-msg@example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000601')$q$, '23514');
select pg_temp.chk('eligibility: eligible before unsubscribe', public.marketing_suppression_status('studio', '00000000-0000-0000-0000-0000ae000001', 'm0-msg@example.com') = 'eligible');
select pg_temp.chk('message token: unsubscribe works', (public.marketing_unsubscribe_by_token(pg_temp.j('mtok') #>> '{}', 'one_click') ->> 'ok')::boolean);
select pg_temp.chk('eligibility: unsubscribed after the message link', public.marketing_suppression_status('studio', '00000000-0000-0000-0000-0000ae000001', 'M0-MSG@example.com ') = 'unsubscribed');
select pg_temp.chk('eligibility: scoped to the studio', public.marketing_suppression_status('studio', '00000000-0000-0000-0000-0000ae000002', 'm0-msg@example.com') = 'eligible');
select pg_temp.chk('eligibility: platform suppression applies to every scope', public.marketing_suppression_status('organizer', '00000000-0000-0000-0000-0000ae000101', 'm0-bounced@example.com') = 'suppressed');
select pg_temp.chk('eligibility: invalid address', public.marketing_suppression_status('studio', '00000000-0000-0000-0000-0000ae000001', 'nope') = 'invalid');
select pg_temp.expect_msg('eligibility: unknown scope raises (callers fail closed)', $q$select public.marketing_suppression_status('tenant', '00000000-0000-0000-0000-0000ae000001', 'a@example.com')$q$, '22023');

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Test sends (D3)
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('test send: verified studio staff allowed',
  (public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'M0-Staff-A@example.com', 3) ->> 'allowed')::boolean);
select pg_temp.chk('test send: unverified staff refused',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-unverified-a@example.com', 3) ->> 'reason' = 'recipient_not_verified_staff');
select pg_temp.chk('test send: outsider refused',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-outsider@example.com', 3) ->> 'reason' = 'recipient_not_verified_staff');
select pg_temp.chk('test send: client role is not staff',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-client-role@example.com', 3) ->> 'reason' = 'recipient_not_verified_staff');
select pg_temp.chk('test send: other studio staff refused',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-staff-b@example.com', 3) ->> 'reason' = 'recipient_not_verified_staff');
select pg_temp.chk('test send: campaign of another studio not_found',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000403', '00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', 3) ->> 'reason' = 'not_found');
select public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', 3);
select public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', 3);
select pg_temp.chk('test send: rate limited after the hourly limit',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000401', '00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', 3) ->> 'reason' = 'rate_limited');
select pg_temp.chk('test send: allowed sends recorded', (select count(*) from public.marketing_test_sends where scope_id = '00000000-0000-0000-0000-0000ae000001') = 3);
select pg_temp.chk('test send: organizer user allowed',
  (public.marketing_authorize_test_send('organizer', '00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000404', '00000000-0000-0000-0000-0000ae000204', 'm0-org-user@example.com', 3) ->> 'allowed')::boolean);
select pg_temp.chk('test send: studio staff without organizer link refused for organizer',
  public.marketing_authorize_test_send('organizer', '00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000404', '00000000-0000-0000-0000-0000ae000204', 'm0-staff-a@example.com', 3) ->> 'reason' = 'recipient_not_verified_staff');

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Privileges: every M-0 function is service-role only
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('privileges: anon/authenticated can run only the guard / policy helpers among M-0 functions',
  (select coalesce(string_agg(distinct p.proname, ',' order by p.proname), '') from pg_proc p, (values ('anon'), ('authenticated')) r(role)
   where p.pronamespace = 'public'::regnamespace and (p.proname like 'marketing\_%' or p.proname like '\_mkt\_%')
     and has_function_privilege(r.role, p.oid, 'execute'))
  = '_mkt_campaign_exists,_mkt_campaign_has_mailed,_mkt_can_view_studio_marketing,_mkt_outbound_appointment_payload,_mkt_outbound_automation_recipient_ok,marketing_send_frozen');
select pg_temp.chk('privileges: service_role can run the pipeline functions', has_function_privilege('service_role', 'public.marketing_claim_campaign_recipient(text, uuid, uuid, uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.marketing_unsubscribe_by_token(text, text)', 'execute'));
select pg_temp.chk('privileges: new tables closed to tenants', not has_table_privilege('authenticated', 'public.marketing_email_suppressions', 'select')
  and not has_table_privilege('anon', 'public.marketing_message_unsubscribe_tokens', 'select')
  and not has_table_privilege('authenticated', 'public.marketing_test_sends', 'insert'));
select pg_temp.chk('privileges: tenants cannot write unsubscribe records', not has_table_privilege('authenticated', 'public.marketing_unsubscribes', 'delete')
  and not has_table_privilege('authenticated', 'public.organizer_marketing_unsubscribes', 'insert'));

-- ---------------------------------------------------------------------------------------------------------------
-- 9. Client-role guards and RLS (C8), as the studio owner and the organizer owner
-- ---------------------------------------------------------------------------------------------------------------
-- fresh never-mailed and mailed rows for the guard probes
insert into public.marketing_unsubscribes (studio_id, email, reason) values ('00000000-0000-0000-0000-0000ae000001', 'm0-guard-unsub@example.com', 'suite-direct');
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000402',
  jsonb_build_array(jsonb_build_object('email', 'm0-guard-pending@example.com'), jsonb_build_object('email', 'm0-guard-unsub@example.com')));
insert into t_kv select 'rid:gp', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-guard-pending@example.com';
insert into t_kv select 'rid:gu', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and email = 'm0-guard-unsub@example.com' and status = 'unsubscribed';
select pg_temp.chk('guard fixture: unsubscribed probe row exists', pg_temp.kv('rid:gu') is not null);

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');

select pg_temp.expect_msg('guard: staff cannot delete an unsubscribe record',
  $q$delete from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001'$q$, '42501');
select pg_temp.expect_msg('guard: staff cannot rewrite an unsubscribe record',
  $q$update public.marketing_unsubscribes set email = 'x@example.com' where studio_id = '00000000-0000-0000-0000-0000ae000001'$q$, '42501');
select pg_temp.expect_msg('guard: staff cannot insert an unsubscribe record directly',
  $q$insert into public.marketing_unsubscribes (studio_id, email) values ('00000000-0000-0000-0000-0000ae000001', 'forged@example.com')$q$, '42501');
select pg_temp.chk('rls: staff can read their studio unsubscribes', (select count(*) from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001') >= 1);
select pg_temp.chk('rls: staff cannot read another studio unsubscribes', (select count(*) from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000002') = 0);
select pg_temp.expect_msg('guard (C2): staff cannot delete a sent recipient',
  format($q$delete from public.marketing_campaign_recipients where id = %L$q$, pg_temp.kv('rid:a1')), 'handed to the email provider');
select pg_temp.expect_msg('guard (C2): staff cannot reset a sent recipient to pending',
  format($q$update public.marketing_campaign_recipients set status = 'pending' where id = %L$q$, pg_temp.kv('rid:a1')), 'cannot change status');
select pg_temp.expect_msg('guard: staff cannot resurrect an unsubscribed recipient',
  format($q$update public.marketing_campaign_recipients set status = 'pending' where id = %L$q$, pg_temp.kv('rid:gu')), 'cannot change status');
select pg_temp.expect_msg('guard: staff cannot overwrite an unsubscribed recipient as sent',
  format($q$update public.marketing_campaign_recipients set status = 'sent' where id = %L$q$, pg_temp.kv('rid:gu')), 'cannot change status');
select pg_temp.expect_msg('guard: staff cannot rewrite a recipient token',
  format($q$update public.marketing_campaign_recipients set unsubscribe_token = 'forged' where id = %L$q$, pg_temp.kv('rid:gp')), 'managed by the send pipeline');
select pg_temp.expect_msg('guard: staff cannot claim a recipient directly',
  format($q$update public.marketing_campaign_recipients set status = 'sending' where id = %L$q$, pg_temp.kv('rid:gp')), 'set only by the send pipeline');
select pg_temp.expect_msg('guard: staff cannot insert a mailed recipient',
  $q$insert into public.marketing_campaign_recipients (campaign_id, studio_id, email, status) values ('00000000-0000-0000-0000-0000ae000402', '00000000-0000-0000-0000-0000ae000001', 'forged@example.com', 'sent')$q$, 'not yet sent');
-- pre-M-0 application compatibility (stage 1 only): never-mailed rows are still writable
select pg_temp.expect_ok('compat: staff can still mark a pending recipient sent (old app)',
  format($q$update public.marketing_campaign_recipients set status = 'sent', provider_message_id = 'old-app', sent_at = now() where id = %L$q$, pg_temp.kv('rid:gp')));
select pg_temp.expect_ok('compat: staff can still delete never-mailed rows (old app regenerate)',
  $q$delete from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402' and status in ('pending', 'unsubscribed', 'skipped', 'suppressed')$q$);
select pg_temp.expect_msg('compat: old app regenerate after a partial send now fails closed',
  $q$delete from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000402'$q$, 'handed to the email provider');
reset role;

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000204');
select pg_temp.expect_msg('guard (organizer): cannot delete an organizer unsubscribe',
  $q$delete from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101'$q$, '42501');
select pg_temp.expect_msg('guard (organizer): cannot reactivate an unsubscribed contact',
  $q$update public.organizer_contacts set status = 'active' where id = '00000000-0000-0000-0000-0000ae000501'$q$, 'resubscribed by the contact');
select pg_temp.chk('rls (organizer): can read own unsubscribes', (select count(*) from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101') = 1);
reset role;

select pg_temp.expect_ok('guard: server roles unaffected (the pipeline can update an unsubscribed contact)',
  $q$update public.organizer_contacts set updated_at = now() where id = '00000000-0000-0000-0000-0000ae000501'$q$);

-- defense in depth: the unsubscribe guard trigger holds even if a future grant/policy re-opens tenant writes
-- (probe grant + policy exist only inside this rolled-back transaction)
grant update, delete on public.marketing_unsubscribes, public.organizer_marketing_unsubscribes to authenticated;
create policy m0_suite_probe on public.marketing_unsubscribes for all to authenticated using (true) with check (true);
create policy m0_suite_probe on public.organizer_marketing_unsubscribes for all to authenticated using (true) with check (true);
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000204');
select pg_temp.expect_msg('guard (depth): trigger blocks studio unsubscribe delete without the revoke',
  $q$delete from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001'$q$, 'can only be changed by the recipient');
select pg_temp.expect_msg('guard (depth): trigger blocks studio unsubscribe update without the revoke',
  $q$update public.marketing_unsubscribes set reason = 'x' where studio_id = '00000000-0000-0000-0000-0000ae000001'$q$, 'can only be changed by the recipient');
select pg_temp.expect_msg('guard (depth): trigger blocks organizer unsubscribe delete without the revoke',
  $q$delete from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101'$q$, 'can only be changed by the recipient');
reset role;
drop policy m0_suite_probe on public.marketing_unsubscribes;
drop policy m0_suite_probe on public.organizer_marketing_unsubscribes;
revoke update, delete on public.marketing_unsubscribes, public.organizer_marketing_unsubscribes from authenticated;

-- campaign deletion still cascades through mailed recipients (the guard allows deletes of orphaned rows)
select pg_temp.expect_ok('cascade: deleting a campaign removes its mailed recipients',
  $q$delete from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae000401'$q$);
select pg_temp.chk('cascade: recipients gone', not exists (select 1 from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000401'));

-- ---------------------------------------------------------------------------------------------------------------
-- 10. Independent-review fixes: retry after release keeps the 23h rule (P2-1), mailed campaigns cannot be deleted by
--     tenants (P2-2), client-chosen recipient tokens are replaced (P2-3), automation-family content origin cannot be
--     claimed by a client write (D1), tokens resolve case-insensitively through the indexed column
-- ---------------------------------------------------------------------------------------------------------------
insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type) values
  ('00000000-0000-0000-0000-0000ae000407', '00000000-0000-0000-0000-0000ae000001', 'C-fix', 'S', 'B', 'draft', 'manual'),
  ('00000000-0000-0000-0000-0000ae000408', '00000000-0000-0000-0000-0000ae000001', 'C-draft-delete', 'S', 'B', 'draft', 'manual');
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407',
  jsonb_build_array(jsonb_build_object('email', 'm0-fix-1@example.com'), jsonb_build_object('email', 'm0-fix-2@example.com')));
insert into t_kv select 'rid:f1', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000407' and email = 'm0-fix-1@example.com';
insert into t_kv select 'rid:f2', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000407' and email = 'm0-fix-2@example.com';
insert into t_kv select 'tok:f2', unsubscribe_token from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f2')::uuid;

select pg_temp.save('fc1', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407', pg_temp.kv('rid:f1')::uuid, 600));
select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:f1')::uuid, (pg_temp.j('fc1') ->> 'claim_id')::uuid, 'uncertain', null, 'timeout');
select pg_temp.save('fc2', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407', pg_temp.kv('rid:f1')::uuid, 600));
select pg_temp.chk('P2-1: uncertain attempt re-claimed as a retry', (pg_temp.j('fc2') ->> 'retry')::boolean, pg_temp.kv('fc2'));
select pg_temp.chk('P2-1: retry released (rate limit)',
  public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:f1')::uuid, (pg_temp.j('fc2') ->> 'claim_id')::uuid, 'released', null, 'rate_limit_exceeded') ->> 'outcome' = 'released');
select pg_temp.chk('P2-1: released retry is pending but keeps the possibly-delivered first attempt',
  exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f1')::uuid and status = 'pending' and first_attempt_at is not null and attempt_count = 1));
select pg_temp.chk('P2-1: regenerate keeps a pending row with a possibly-delivered attempt',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407',
    jsonb_build_array(jsonb_build_object('email', 'm0-fix-2@example.com'))) ->> 'outcome' = 'synced'
  and exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f1')::uuid));
-- the never-mailed fix-2 row was regenerated (new id and token)
delete from t_kv where k in ('rid:f2', 'tok:f2');
insert into t_kv select 'rid:f2', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000407' and email = 'm0-fix-2@example.com';
insert into t_kv select 'tok:f2', unsubscribe_token from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f2')::uuid;
select pg_temp.save('fc3', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407', pg_temp.kv('rid:f1')::uuid, 600));
select pg_temp.chk('P2-1: within the window the pending retry is claimed as a retry (same key)',
  pg_temp.j('fc3') ->> 'outcome' = 'claimed' and (pg_temp.j('fc3') ->> 'retry')::boolean
  and pg_temp.j('fc3') ->> 'idempotency_key' = pg_temp.j('fc1') ->> 'idempotency_key', pg_temp.kv('fc3'));
select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:f1')::uuid, (pg_temp.j('fc3') ->> 'claim_id')::uuid, 'released', null, 'rate_limit_exceeded');

-- tenant delete probe while pending with a possibly-delivered attempt
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');
select pg_temp.expect_msg('P2-1: staff cannot delete a pending row whose earlier attempt may have been delivered',
  format($q$delete from public.marketing_campaign_recipients where id = %L$q$, pg_temp.kv('rid:f1')), 'handed to the email provider');
reset role;

update public.marketing_campaign_recipients set first_attempt_at = now() - interval '24 hours' where id = pg_temp.kv('rid:f1')::uuid;
select pg_temp.save('fc5', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407', pg_temp.kv('rid:f1')::uuid, 600));
select pg_temp.chk('P2-1: past the window a pending retry becomes delivery_unknown (never re-sent)',
  pg_temp.j('fc5') ->> 'outcome' = 'delivery_unknown'
  and exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f1')::uuid and status = 'delivery_unknown'),
  pg_temp.kv('fc5') || ' row=' || (select row(status, first_attempt_at, attempt_count, claim_id)::text from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f1')::uuid));

select pg_temp.save('fc4', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000407', pg_temp.kv('rid:f2')::uuid, 600));
select public.marketing_complete_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', pg_temp.kv('rid:f2')::uuid, (pg_temp.j('fc4') ->> 'claim_id')::uuid, 'released', null, 'rate_limit_exceeded');
select pg_temp.chk('P2-1: a definitively unsent first attempt is fully reset (no false unknown later)',
  exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f2')::uuid and status = 'pending' and first_attempt_at is null and attempt_count = 0),
  pg_temp.kv('fc4') || ' row=' || (select row(status, first_attempt_at, attempt_count)::text from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f2')::uuid));

select pg_temp.save('uc', public.marketing_unsubscribe_by_token(upper(pg_temp.kv('tok:f2')), 'one_click'));
select pg_temp.chk('token: an upper-case token resolves through the indexed column',
  (pg_temp.j('uc') ->> 'ok')::boolean
  and exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f2')::uuid and status = 'unsubscribed'));

-- 407 now holds a delivery_unknown row (mailed); 408 is a draft with a never-mailed row
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000408',
  jsonb_build_array(jsonb_build_object('email', 'm0-fix-3@example.com')));

insert into public.automation_actions (studio_id, rule_key, title, client_id) values ('00000000-0000-0000-0000-0000ae000001', 'unsigned_document', 'Unsigned', '00000000-0000-0000-0000-0000ae000301');
insert into t_kv select 'od-action', id::text from public.automation_actions where studio_id = '00000000-0000-0000-0000-0000ae000001' and title = 'Unsigned';
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');
insert into public.marketing_campaign_recipients (campaign_id, studio_id, email, status, unsubscribe_token)
values ('00000000-0000-0000-0000-0000ae000408', '00000000-0000-0000-0000-0000ae000001', 'm0-fix-forged@example.com', 'pending', 'forged-token-0001');
select pg_temp.expect_msg('P2-2: staff cannot delete a mailed campaign',
  $q$delete from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae000407'$q$, 'has been sent cannot be deleted');
insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, payload, related_table, related_id, status, dedupe_key)
select '00000000-0000-0000-0000-0000ae000001', 'email', 'automation_unsigned_document', 'm0-a1@example.com', 'S', 'B', '{"content_origin": "system_default"}',
       'automation_actions', pg_temp.kv('od-action')::uuid, 'draft', 'm0-suite-od-1';
select pg_temp.expect_msg('D1: a client cannot queue an ARIA execution email',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'aria_execution_aria_membership_past_due', 'm0-od@example.com', 'S', 'B', 'draft', 'm0-suite-od-2')$q$,
  'cannot be created by a signed-in user');
select pg_temp.expect_msg('D1: a client cannot queue an arbitrary template',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'client_message', 'm0-od@example.com', 'S', 'B', 'draft', 'm0-suite-od-3')$q$,
  'cannot be created by a signed-in user');
reset role;

select pg_temp.chk('P2-3: a client-chosen recipient token is replaced',
  exists (select 1 from public.marketing_campaign_recipients where email = 'm0-fix-forged@example.com' and unsubscribe_token <> 'forged-token-0001'
          and unsubscribe_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
select pg_temp.chk('P2-2: the mailed campaign and its rows survive', exists (select 1 from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae000407')
  and exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:f1')::uuid));
select pg_temp.chk('D1: a client write cannot mark automation email as system content',
  (select payload ->> 'content_origin' from public.outbound_deliveries where dedupe_key = 'm0-suite-od-1') = 'studio_customized');
select pg_temp.chk('D1: refused client rows were not stored',
  not exists (select 1 from public.outbound_deliveries where dedupe_key in ('m0-suite-od-2', 'm0-suite-od-3')));
insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, payload, status, dedupe_key) values
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_unsigned_document', 'm0-od@example.com', 'S', 'B', '{"content_origin": "system_default"}', 'draft', 'm0-suite-od-4');
select pg_temp.chk('D1: server producers keep system content',
  (select payload ->> 'content_origin' from public.outbound_deliveries where dedupe_key = 'm0-suite-od-4') = 'system_default');

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');
delete from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae000408';
reset role;
select pg_temp.chk('P2-2: staff can still delete a never-mailed draft campaign',
  not exists (select 1 from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae000408'));

-- ---------------------------------------------------------------------------------------------------------------
-- 11. Remediation: send freeze (A), recipient privacy (B), legacy unsubscribe compatibility (C), outbound writes (D)
-- ---------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000ae000207', 'm0-instructor@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000208', 'm0-frontdesk@example.com', now()),
  ('00000000-0000-0000-0000-0000ae000209', 'm0-platform@example.com', now());
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000ae000207', 'm0-instructor@example.com'),
  ('00000000-0000-0000-0000-0000ae000208', 'm0-frontdesk@example.com'),
  ('00000000-0000-0000-0000-0000ae000209', 'm0-platform@example.com');
update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-0000ae000209';
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000ae000207', '00000000-0000-0000-0000-0000ae000001', 'instructor', true),
  ('00000000-0000-0000-0000-0000ae000208', '00000000-0000-0000-0000-0000ae000001', 'front_desk', true);

-- B. Recipient / unsubscribe visibility (direct PostgREST access = role authenticated + JWT claims)
create temp table t_vis (who text, recipients bigint, tokens bigint, unsubscribes bigint, org_recipients bigint) on commit drop;
grant all on t_vis to authenticated, anon;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');
insert into t_vis select 'owner', (select count(*) from public.marketing_campaign_recipients), (select count(unsubscribe_token) from public.marketing_campaign_recipients),
  (select count(*) from public.marketing_unsubscribes), (select count(*) from public.organizer_marketing_campaign_recipients);
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000208');
insert into t_vis select 'front_desk', (select count(*) from public.marketing_campaign_recipients), (select count(unsubscribe_token) from public.marketing_campaign_recipients),
  (select count(*) from public.marketing_unsubscribes), (select count(*) from public.organizer_marketing_campaign_recipients);
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000207');
insert into t_vis select 'instructor', (select count(*) from public.marketing_campaign_recipients), (select count(unsubscribe_token) from public.marketing_campaign_recipients),
  (select count(*) from public.marketing_unsubscribes), (select count(*) from public.organizer_marketing_campaign_recipients);
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000206');
insert into t_vis select 'client_role', (select count(*) from public.marketing_campaign_recipients), (select count(unsubscribe_token) from public.marketing_campaign_recipients),
  (select count(*) from public.marketing_unsubscribes), (select count(*) from public.organizer_marketing_campaign_recipients);
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000205');
insert into t_vis select 'other_studio_owner', (select count(*) from public.marketing_campaign_recipients where studio_id = '00000000-0000-0000-0000-0000ae000001'),
  (select count(unsubscribe_token) from public.marketing_campaign_recipients where studio_id = '00000000-0000-0000-0000-0000ae000001'),
  (select count(*) from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001'), 0;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000209');
insert into t_vis select 'platform_admin', (select count(*) from public.marketing_campaign_recipients where studio_id = '00000000-0000-0000-0000-0000ae000001'), 0,
  (select count(*) from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001'), 0;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000204');
insert into t_vis select 'organizer_owner', (select count(*) from public.marketing_campaign_recipients), 0, (select count(*) from public.marketing_unsubscribes),
  (select count(*) from public.organizer_marketing_campaign_recipients where organizer_id = '00000000-0000-0000-0000-0000ae000101');
reset role;
set local role anon;
insert into t_vis select 'anon', (select count(*) from public.marketing_campaign_recipients), 0, (select count(*) from public.marketing_unsubscribes),
  (select count(*) from public.organizer_marketing_campaign_recipients);
reset role;
insert into t_kv select 'studioA_recipients', count(*)::text from public.marketing_campaign_recipients where studio_id = '00000000-0000-0000-0000-0000ae000001';
insert into t_kv select 'studioA_unsubs', count(*)::text from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001';
insert into t_kv select 'org101_recipients', count(*)::text from public.organizer_marketing_campaign_recipients where organizer_id = '00000000-0000-0000-0000-0000ae000101';

select pg_temp.chk('B: studio owner sees the studio''s recipients, tokens and unsubscribes',
  (select recipients = pg_temp.kv('studioA_recipients')::bigint and tokens > 0 and unsubscribes = pg_temp.kv('studioA_unsubs')::bigint from t_vis where who = 'owner'),
  (select row(t.*)::text from t_vis t where who = 'owner'));
select pg_temp.chk('B: front desk (campaign manager) sees them too',
  (select recipients = pg_temp.kv('studioA_recipients')::bigint and unsubscribes = pg_temp.kv('studioA_unsubs')::bigint from t_vis where who = 'front_desk'));
select pg_temp.chk('B: instructor sees no recipient, token or unsubscribe (FC-1B5D)',
  (select recipients = 0 and tokens = 0 and unsubscribes = 0 from t_vis where who = 'instructor'), (select row(t.*)::text from t_vis t where who = 'instructor'));
select pg_temp.chk('B: a client-role account sees nothing',
  (select recipients = 0 and tokens = 0 and unsubscribes = 0 and org_recipients = 0 from t_vis where who = 'client_role'));
select pg_temp.chk('B: another studio''s owner sees nothing of this studio',
  (select recipients = 0 and tokens = 0 and unsubscribes = 0 from t_vis where who = 'other_studio_owner'));
select pg_temp.chk('B: a platform admin (profiles.platform_role) keeps access',
  (select recipients = pg_temp.kv('studioA_recipients')::bigint and unsubscribes = pg_temp.kv('studioA_unsubs')::bigint from t_vis where who = 'platform_admin'));
select pg_temp.chk('B: organizer users keep their own organizer recipients and see no studio data',
  (select org_recipients = pg_temp.kv('org101_recipients')::bigint and org_recipients > 0 and recipients = 0 and unsubscribes = 0 from t_vis where who = 'organizer_owner'));
select pg_temp.chk('B: anon sees nothing', (select recipients = 0 and unsubscribes = 0 and org_recipients = 0 from t_vis where who = 'anon'));
select pg_temp.chk('B: no permissive SELECT policy on recipients/unsubscribes uses the role-agnostic studio access check',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('marketing_campaign_recipients', 'marketing_unsubscribes')
              and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL') and coalesce(qual, '') like '%user_has_studio_access%'));

-- A. Send freeze
insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type) values
  ('00000000-0000-0000-0000-0000ae000409', '00000000-0000-0000-0000-0000ae000001', 'C-freeze', 'S', 'B', 'draft', 'manual');
select public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000409',
  jsonb_build_array(jsonb_build_object('email', 'm0-freeze-1@example.com'), jsonb_build_object('email', 'm0-pre-unsub@example.com')));
insert into t_kv select 'rid:fz', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000409' and email = 'm0-freeze-1@example.com';
insert into t_kv select 'rid:fzu', id::text from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000409' and email = 'm0-pre-unsub@example.com';
select pg_temp.chk('A fixture: a never-mailed unsubscribed row exists', exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fzu')::uuid and status = 'unsubscribed'));
insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, payload, status, dedupe_key) values
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_low_package_balance', 'm0-od@example.com', 'S', 'B', '{"content_origin": "system_default"}', 'queued', 'm0-fz-commercial'),
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_unsigned_document', 'm0-od@example.com', 'S', 'B', '{"content_origin": "system_default"}', 'queued', 'm0-fz-operational'),
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_unsigned_document', 'm0-od@example.com', 'S', 'B', '{"content_origin": "studio_customized"}', 'queued', 'm0-fz-customized'),
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'aria_execution_aria_intro_no_purchase', 'm0-od@example.com', 'S', 'B', null, 'queued', 'm0-fz-aria'),
  ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'm0-od@example.com', null, null, '{}', 'queued', 'm0-fz-transactional'),
  ('00000000-0000-0000-0000-0000ae000001', 'sms', 'automation_low_package_balance', null, null, 'B', '{}', 'queued', 'm0-fz-sms');

select public.marketing_set_send_freeze(true, 'suite: freeze on');
select pg_temp.save('fzc', public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000409', pg_temp.kv('rid:fz')::uuid, 600));
select pg_temp.chk('A: frozen -> the campaign claim refuses and sends nothing', pg_temp.j('fzc') ->> 'outcome' = 'frozen', pg_temp.kv('fzc'));
select pg_temp.chk('A: frozen -> the recipient is untouched (still pending, no attempt)',
  exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fz')::uuid and status = 'pending' and attempt_count = 0 and claim_id is null));
select pg_temp.chk('A: frozen -> test sends are refused',
  public.marketing_authorize_test_send('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000409',
    '00000000-0000-0000-0000-0000ae000201', 'm0-staff-a@example.com', 10) ->> 'reason' = 'frozen');
create temp table t_claimed (dedupe_key text) on commit drop;
insert into t_claimed select dedupe_key from public.claim_outbound_deliveries('00000000-0000-0000-0000-0000ae0009f1', 200, 300) where dedupe_key like 'm0-fz-%';
select pg_temp.chk('A: frozen -> the dispatcher holds commercial email (automation, customized operational, ARIA)',
  not exists (select 1 from t_claimed where dedupe_key in ('m0-fz-commercial', 'm0-fz-customized', 'm0-fz-aria')), (select string_agg(dedupe_key, ',') from t_claimed));
select pg_temp.chk('A: frozen -> operational, transactional and SMS deliveries still go out',
  (select count(*) from t_claimed where dedupe_key in ('m0-fz-operational', 'm0-fz-transactional', 'm0-fz-sms')) = 3, (select string_agg(dedupe_key, ',') from t_claimed));
select pg_temp.chk('A: held email stays queued (not dropped)',
  (select count(*) from public.outbound_deliveries where dedupe_key in ('m0-fz-commercial', 'm0-fz-customized', 'm0-fz-aria') and status = 'queued' and claim_owner is null) = 3);

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000201');
select pg_temp.chk('A: frozen -> the pre-M-0 send path (client role) sees no pending recipient',
  (select count(*) from public.marketing_campaign_recipients where status = 'pending') = 0
  and (select count(*) from public.marketing_campaign_recipients where status <> 'pending') > 0);
select pg_temp.expect_msg('A: frozen -> client roles cannot insert recipients (pre-M-0 regenerate fails closed)',
  $q$insert into public.marketing_campaign_recipients (campaign_id, studio_id, email, status) values ('00000000-0000-0000-0000-0000ae000409', '00000000-0000-0000-0000-0000ae000001', 'm0-fz-new@example.com', 'pending')$q$, '42501');
update public.marketing_campaign_recipients set status = 'sent' where id = pg_temp.kv('rid:fz')::uuid;
delete from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fz')::uuid;
-- a never-mailed non-pending row is visible but still cannot be deleted or changed while frozen
delete from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fzu')::uuid;
update public.marketing_campaign_recipients set name = 'changed while frozen' where id = pg_temp.kv('rid:fzu')::uuid;
reset role;
select pg_temp.chk('A: frozen -> client roles cannot delete or change visible never-mailed rows either',
  exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fzu')::uuid and name is distinct from 'changed while frozen'));
select pg_temp.chk('A: frozen -> client-role update/delete of the pending row had no effect',
  exists (select 1 from public.marketing_campaign_recipients where id = pg_temp.kv('rid:fz')::uuid and status = 'pending'));

select pg_temp.expect_msg('A: freeze needs a reason', $q$select public.marketing_set_send_freeze(false, '  ')$q$, '22023');
select pg_temp.expect_msg('A: freeze needs a value', $q$select public.marketing_set_send_freeze(null, 'x')$q$, '22023');
select pg_temp.chk('A: only the service role can change the freeze',
  not has_function_privilege('authenticated', 'public.marketing_set_send_freeze(boolean, text)', 'execute')
  and not has_function_privilege('anon', 'public.marketing_set_send_freeze(boolean, text)', 'execute')
  and has_function_privilege('service_role', 'public.marketing_set_send_freeze(boolean, text)', 'execute'));
select pg_temp.chk('A: the control tables are closed to tenants',
  not has_table_privilege('authenticated', 'public.marketing_send_controls', 'select')
  and not has_table_privilege('authenticated', 'public.marketing_send_controls', 'update'));

select public.marketing_set_send_freeze(false, 'suite: freeze off');
delete from t_claimed;
insert into t_claimed select dedupe_key from public.claim_outbound_deliveries('00000000-0000-0000-0000-0000ae0009f2', 200, 300) where dedupe_key like 'm0-fz-%';
select pg_temp.chk('A: unfrozen -> held commercial email is released to the dispatcher',
  (select count(*) from t_claimed where dedupe_key in ('m0-fz-commercial', 'm0-fz-customized', 'm0-fz-aria')) = 3, (select string_agg(dedupe_key, ',') from t_claimed));
select pg_temp.chk('A: unfrozen -> the campaign claim works again',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000409', pg_temp.kv('rid:fz')::uuid, 600) ->> 'outcome' = 'claimed');
select pg_temp.chk('A: every freeze change is logged', (select count(*) from public.marketing_send_control_events where reason like 'suite:%') = 2);
delete from public.marketing_send_controls;
select pg_temp.chk('A: a missing control row means frozen (fail closed)', public.marketing_send_frozen());
select public.marketing_set_send_freeze(false, 'suite: restore');

-- C. Legacy organizer unsubscribe page (pre-M-0 application, service role)
insert into public.organizer_marketing_campaigns (id, organizer_id, name, subject, body_text, status) values
  ('00000000-0000-0000-0000-0000ae000410', '00000000-0000-0000-0000-0000ae000101', 'O-legacy', 'S', 'B', 'draft'),
  ('00000000-0000-0000-0000-0000ae000411', '00000000-0000-0000-0000-0000ae000101', 'O-legacy-2', 'S', 'B', 'draft'),
  ('00000000-0000-0000-0000-0000ae000412', '00000000-0000-0000-0000-0000ae000102', 'O-other-org', 'S', 'B', 'draft');
insert into public.organizer_contacts (id, organizer_id, email, status) values
  ('00000000-0000-0000-0000-0000ae000510', '00000000-0000-0000-0000-0000ae000101', 'm0-legacy-1@example.com', 'active');
select public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000410',
  jsonb_build_array(jsonb_build_object('email', 'M0-Legacy-1@Example.com'), jsonb_build_object('email', 'm0-legacy-2@example.com')));
select public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae000101', '00000000-0000-0000-0000-0000ae000411',
  jsonb_build_array(jsonb_build_object('email', 'm0-legacy-1@example.com')));
select public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae000102', '00000000-0000-0000-0000-0000ae000412',
  jsonb_build_array(jsonb_build_object('email', 'm0-legacy-1@example.com')));
insert into t_kv select 'lg1', id::text from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000410' and lower(email) = 'm0-legacy-1@example.com';
insert into t_kv select 'lg2', id::text from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000410' and email = 'm0-legacy-2@example.com';
update public.organizer_marketing_campaign_recipients set status = 'sent', sent_at = now(), provider_message_id = 'legacy-msg'
where id = pg_temp.kv('lg1')::uuid;

set local role service_role;
-- exactly what the pre-M-0 page does after its (failing) organizer upsert
update public.organizer_marketing_campaign_recipients
set status = 'unsubscribed', error_message = 'Recipient unsubscribed from organizer marketing'
where id = pg_temp.kv('lg1')::uuid;
reset role;
select pg_temp.chk('C: the legacy organizer page opt-out is persisted for the organizer',
  (select count(*) from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101' and lower(email) = 'm0-legacy-1@example.com') = 1);
select pg_temp.chk('C: it suppresses the address''s other pending rows of that organizer',
  (select status from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000411') = 'unsubscribed');
select pg_temp.chk('C: it marks the organizer contact unsubscribed',
  (select status from public.organizer_contacts where id = '00000000-0000-0000-0000-0000ae000510') = 'unsubscribed');
select pg_temp.chk('C: another organizer is unaffected (tenant scope)',
  (select status from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae000412') = 'pending'
  and not exists (select 1 from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000102'));
select pg_temp.chk('C: the delivered row keeps its delivery evidence',
  exists (select 1 from public.organizer_marketing_campaign_recipients where id = pg_temp.kv('lg1')::uuid and sent_at is not null and provider_message_id = 'legacy-msg'));
set local role service_role;
update public.organizer_marketing_campaign_recipients
set status = 'unsubscribed', error_message = 'Recipient unsubscribed from organizer marketing'
where id = pg_temp.kv('lg1')::uuid;
update public.organizer_marketing_campaign_recipients set status = 'unsubscribed', error_message = 'Removed by an import'
where id = pg_temp.kv('lg2')::uuid;
reset role;
select pg_temp.chk('C: a repeated legacy request is idempotent (one record)',
  (select count(*) from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101' and lower(email) = 'm0-legacy-1@example.com') = 1);
select pg_temp.chk('C: other status changes are not treated as opt-outs',
  not exists (select 1 from public.organizer_marketing_unsubscribes where organizer_id = '00000000-0000-0000-0000-0000ae000101' and lower(email) = 'm0-legacy-2@example.com'));

-- C. Legacy studio RPC resolves studio per-message tokens (rollback compatibility), nothing else new
select pg_temp.save('lmt', to_jsonb(public.marketing_issue_message_unsubscribe_token('studio', '00000000-0000-0000-0000-0000ae000001', 'm0-legacy-msg@example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000602')));
select pg_temp.save('omt', to_jsonb(public.marketing_issue_message_unsubscribe_token('organizer', '00000000-0000-0000-0000-0000ae000101', 'm0-legacy-omsg@example.com', 'outbound_deliveries', '00000000-0000-0000-0000-0000ae000603')));
set local role anon;
insert into t_kv select 'lr1', (select success::text from public.unsubscribe_marketing_recipient(upper(pg_temp.j('lmt') #>> '{}')));
insert into t_kv select 'lr2', (select success::text from public.unsubscribe_marketing_recipient(pg_temp.j('omt') #>> '{}'));
insert into t_kv select 'lr3', (select success::text from public.unsubscribe_marketing_recipient(gen_random_uuid()::text));
insert into t_kv select 'lr4', (select success::text from public.unsubscribe_marketing_recipient('not-a-token'));
reset role;
select pg_temp.chk('C: legacy studio page accepts a studio per-message token (any case)', pg_temp.kv('lr1') = 'true', pg_temp.kv('lr1'));
select pg_temp.chk('C: ... and records the studio opt-out',
  exists (select 1 from public.marketing_unsubscribes where studio_id = '00000000-0000-0000-0000-0000ae000001' and lower(email) = 'm0-legacy-msg@example.com'));
select pg_temp.chk('C: legacy studio page refuses an organizer message token', pg_temp.kv('lr2') = 'false'
  and not exists (select 1 from public.organizer_marketing_unsubscribes where lower(email) = 'm0-legacy-omsg@example.com'));
select pg_temp.chk('C: legacy studio page refuses unknown / malformed tokens', pg_temp.kv('lr3') = 'false' and pg_temp.kv('lr4') = 'false');

-- D. Outbound deliveries written by client roles
insert into public.appointments (id, studio_id, client_id, partner_client_id, appointment_type, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000ae000801', '00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000301', '00000000-0000-0000-0000-0000ae000302',
   'private_lesson', now() + interval '1 day', now() + interval '1 day 1 hour'),
  ('00000000-0000-0000-0000-0000ae000802', '00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000303', null,
   'private_lesson', now() + interval '1 day', now() + interval '1 day 1 hour');
update public.clients set phone = '+1 (919) 555-0101' where id = '00000000-0000-0000-0000-0000ae000301';
insert into public.automation_actions (id, studio_id, rule_key, title) values
  ('00000000-0000-0000-0000-0000ae000701', '00000000-0000-0000-0000-0000ae000001', 'low_package_balance', 'Low balance'),
  ('00000000-0000-0000-0000-0000ae000702', '00000000-0000-0000-0000-0000ae000002', 'low_package_balance', 'Other studio');
update public.automation_actions set client_id = '00000000-0000-0000-0000-0000ae000301' where id = '00000000-0000-0000-0000-0000ae000701';
update public.automation_actions set client_id = '00000000-0000-0000-0000-0000ae000303' where id = '00000000-0000-0000-0000-0000ae000702';
insert into public.booking_requests (id, studio_id, requested_starts_at, requested_ends_at, customer_email) values
  ('00000000-0000-0000-0000-0000ae000901', '00000000-0000-0000-0000-0000ae000001', now() + interval '2 days', now() + interval '2 days 1 hour', 'm0-booker@example.com');
insert into public.automation_actions (id, studio_id, rule_key, title, related_table, related_id) values
  ('00000000-0000-0000-0000-0000ae000703', '00000000-0000-0000-0000-0000ae000001', 'pending_booking_request', 'Booking', 'booking_requests', '00000000-0000-0000-0000-0000ae000901');
update public.appointments set title = 'Showcase Rehearsal' where id = '00000000-0000-0000-0000-0000ae000801';

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000207');  -- instructor of studio A (allowed to insert by RLS)
select pg_temp.expect_ok('D: an appointment notification to the appointment''s client is accepted',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, body_html, reply_to_email, related_table, related_id, status, payload, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'M0-A1@Example.com', 'HUGE SALE', 'Buy now', '<b>x</b>', 'evil@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued', '{"appointmentLabel": "Private Lesson"}', 'm0-d-ok-email')$q$);
select pg_temp.expect_ok('D: ... and to the partner',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_rescheduled', 'm0-a2@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued', 'm0-d-ok-partner')$q$);
select pg_temp.expect_ok('D: an appointment SMS to the client''s phone is accepted',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_phone, body_text, related_table, related_id, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'sms', 'appointment_cancelled', '+19195550101', 'Click my link', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued', 'm0-d-ok-sms')$q$);
select pg_temp.expect_msg('D: an appointment notification to a non-participant is refused',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'stranger@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued')$q$, 'participants');
select pg_temp.expect_msg('D: an appointment SMS to another phone is refused',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_phone, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'sms', 'appointment_confirmed', '+19195559999', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued')$q$, 'participants');
select pg_temp.expect_msg('D: an appointment notification without its appointment is refused',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'm0-a1@example.com', 'queued')$q$, 'participants');
select pg_temp.expect_msg('D: another studio''s appointment cannot be used',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'm0-a1@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000802', 'queued')$q$, 'participants');
select pg_temp.expect_msg('D: no delivery can be queued for another tenant',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000002', 'email', 'appointment_confirmed', 'm0-a1@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000802', 'queued')$q$, '42501');
select pg_temp.expect_msg(format('D: a signed-in user cannot queue %s', k),
  format($q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, status) values ('00000000-0000-0000-0000-0000ae000001', 'email', %L, 'anyone@example.com', 'S', 'B', 'queued')$q$, k),
  'cannot be created by a signed-in user')
from unnest(array['welcome_to_danceflow', 'platform_admin_invite', 'danceflow_security_notice', 'platform_digest', 'aria_execution_aria_membership_past_due',
                  'aria_execution_aria_low_package_balance', 'booking_request_received_client', 'event_registration_confirmed', 'client_message']) k;
select pg_temp.expect_msg('D: a legacy automation email needs an automation action of the studio',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_low_package_balance', 'anyone@example.com', 'S', 'B', 'queued')$q$, 'cannot be created by a signed-in user');
select pg_temp.expect_msg('D: ... of this studio (not another tenant''s action)',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_low_package_balance', 'm0-a1@example.com', 'S', 'B', 'automation_actions', '00000000-0000-0000-0000-0000ae000702', 'queued')$q$, 'cannot be created by a signed-in user');  -- the address matches that action's (other-studio) client
select pg_temp.expect_ok('D: a legacy automation draft for the studio''s own action is accepted',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, payload, related_table, related_id, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_unsigned_document', 'm0-a1@example.com', 'S', 'B', '{"content_origin": "system_default"}', 'automation_actions', '00000000-0000-0000-0000-0000ae000701', 'draft', 'm0-d-ok-automation')$q$);
select pg_temp.expect_ok('D: a forged appointment payload is accepted only as rebuilt from the database',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status, payload, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'appointment_confirmed', 'm0-a1@example.com', 'appointments', '00000000-0000-0000-0000-0000ae000801', 'queued',
             '{"senderDisplayName": "Chase Fraud Dept", "appointmentLabel": "HUGE SALE click evil.example", "clientFirstName": "Valued customer",
               "recipientClientId": "00000000-0000-0000-0000-0000ae000302", "roomName": "Visit evil.example", "extra": "x"}', 'm0-d-forged')$q$);
select pg_temp.expect_msg('D: a legacy automation email to someone other than the action''s client is refused',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_low_package_balance', 'anyone@example.com', 'S', 'B', 'automation_actions', '00000000-0000-0000-0000-0000ae000701', 'queued')$q$, 'cannot be created by a signed-in user');
select pg_temp.expect_ok('D: a legacy booking-request automation to that request''s customer is accepted',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, reply_to_email, related_table, related_id, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae000001', 'email', 'automation_pending_booking_request', 'M0-Booker@Example.com', 'S', 'B', 'evil@example.com', 'automation_actions', '00000000-0000-0000-0000-0000ae000703', 'draft', 'm0-d-ok-booking')$q$);
select pg_temp.expect_msg('D: legacy automation SMS is refused',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_phone, body_text, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae000001', 'sms', 'automation_low_package_balance', '+19195550101', 'B', 'automation_actions', '00000000-0000-0000-0000-0000ae000701', 'queued')$q$, 'cannot be created by a signed-in user');
reset role;

select pg_temp.chk('D: accepted appointment rows carry no client-supplied subject, body, html or reply-to',
  (select count(*) from public.outbound_deliveries where dedupe_key in ('m0-d-ok-email', 'm0-d-ok-partner', 'm0-d-ok-sms')
     and subject is null and body_text is null and body_html is null and reply_to_email is null) = 3);
select pg_temp.chk('D: a forged sender name, consent subject and free text never reach the queued row',
  (select payload from public.outbound_deliveries where dedupe_key = 'm0-d-forged') ->> 'senderDisplayName' is null
  and (select payload from public.outbound_deliveries where dedupe_key = 'm0-d-forged') ->> 'extra' is null
  and (select payload ->> 'appointmentLabel' from public.outbound_deliveries where dedupe_key = 'm0-d-forged') = 'Showcase Rehearsal'
  and (select payload ->> 'clientFirstName' from public.outbound_deliveries where dedupe_key = 'm0-d-forged') = 'A'
  and (select payload ->> 'roomName' from public.outbound_deliveries where dedupe_key = 'm0-d-forged') is null
  and (select payload ->> 'recipientClientId' from public.outbound_deliveries where dedupe_key = 'm0-d-forged') = '00000000-0000-0000-0000-0000ae000301'
  and (select payload ->> 'recipientRole' from public.outbound_deliveries where dedupe_key = 'm0-d-forged') = 'primary',
  (select payload::text from public.outbound_deliveries where dedupe_key = 'm0-d-forged'));
select pg_temp.chk('D: the appointment payload is the database''s (partner and SMS consent subject bound to the matched client)',
  (select payload ->> 'recipientClientId' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-partner') = '00000000-0000-0000-0000-0000ae000302'
  and (select payload ->> 'recipientRole' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-partner') = 'partner'
  and (select payload ->> 'recipientClientId' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-sms') = '00000000-0000-0000-0000-0000ae000301'
  and (select payload ->> 'reason' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-sms') = 'cancelled'
  and (select payload ->> 'startsAt' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-email') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$');
select pg_temp.chk('D: an accepted legacy automation row carries no client reply-to',
  (select reply_to_email from public.outbound_deliveries where dedupe_key = 'm0-d-ok-booking') is null
  and (select payload ->> 'content_origin' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-booking') = 'studio_customized');
select pg_temp.chk('D: the accepted legacy automation row is forced to studio content (commercial controls apply)',
  (select payload ->> 'content_origin' from public.outbound_deliveries where dedupe_key = 'm0-d-ok-automation') = 'studio_customized'
  and public._mkt_is_commercial_outbound('email', 'automation_unsigned_document',
        (select payload from public.outbound_deliveries where dedupe_key = 'm0-d-ok-automation')));

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000209');  -- platform admin (the only client role RLS lets update)
select pg_temp.expect_msg('D: a queued notification cannot be re-routed by a client role',
  $q$update public.outbound_deliveries set recipient_email = 'elsewhere@example.com' where dedupe_key = 'm0-d-ok-email'$q$, 're-routed');
select pg_temp.expect_msg('D: ... nor switched to another template',
  $q$update public.outbound_deliveries set template_key = 'welcome_to_danceflow' where dedupe_key = 'm0-d-ok-email'$q$, 're-routed');
reset role;
insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, subject, body_text, status, dedupe_key)
values ('00000000-0000-0000-0000-0000ae000001', 'email', 'welcome_to_danceflow', 'm0-sys@example.com', 'S', 'B', 'queued', 'm0-d-server');
select pg_temp.chk('D: server writes are unaffected by the client guard',
  exists (select 1 from public.outbound_deliveries where dedupe_key = 'm0-d-server' and subject = 'S'));
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae000207');  -- instructor of studio A probing studio B
insert into t_kv select 'oracle', (public._mkt_outbound_appointment_payload('00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000802', 'email', 'm0-a1@example.com', null, 'appointment_confirmed') is not null)::text;
insert into t_kv select 'oracle-own', (public._mkt_outbound_appointment_payload('00000000-0000-0000-0000-0000ae000001', '00000000-0000-0000-0000-0000ae000801', 'email', 'm0-a1@example.com', null, 'appointment_confirmed') is not null)::text;
insert into t_kv select 'oracle-aa', public._mkt_outbound_automation_recipient_ok('00000000-0000-0000-0000-0000ae000002', '00000000-0000-0000-0000-0000ae000702', 'm0-a1@example.com')::text;
reset role;
select pg_temp.chk('D: the appointment helper reveals nothing about another studio (no participant oracle)', pg_temp.kv('oracle') = 'false' and pg_temp.kv('oracle-own') = 'true');
select pg_temp.chk('D: the automation helper reveals nothing about another studio', pg_temp.kv('oracle-aa') = 'false');
select pg_temp.chk('D: the helper functions refuse callers without a role in the studio',
  not has_function_privilege('anon', 'public._mkt_outbound_appointment_payload(uuid, uuid, text, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public._mkt_campaign_exists(text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public._mkt_campaign_has_mailed(text, uuid)', 'execute'));

-- ---------------------------------------------------------------------------------------------------------------
-- Verdict (always raises: nothing persists)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'M-0 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'M-0 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
