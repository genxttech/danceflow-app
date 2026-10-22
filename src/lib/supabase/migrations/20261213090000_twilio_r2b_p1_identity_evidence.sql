-- 20261213090000_twilio_r2b_p1_identity_evidence.sql
-- TW-4F R2b-P1: provider-derived number identity (L1) and authoritative post-attempt provider evidence before a fee-bearing purchase is declared not created (L2).
--   * studio_sms_num_identity_reads: what the PROVIDER says a number sid is (E.164, account), read through the subaccount's own credentials under an onboarding lease. Append-only.
--   * tw4_num_identity_observe: records one read (lease-bound; the account must be the business's ACTIVE subaccount; fake evidence only on a local QA database).
--   * tw4_num_inventory_ack: the typed-E.164 form is REMOVED. An acknowledgement takes the E.164 from a fresh provider identity read, refuses a number whose E.164 belongs to an
--     abandoned / unresolved / failed / retired purchase, and refuses a sid the ledger knows under another E.164.
--   * _tw4num_absence_evidence + tw4_num_resolve + tw4_num_settle_admin: not_created (and any fee release not backed by provider-confirmed ownership) needs a clean, complete,
--     same-account, provider-read inventory listing taken AFTER the attempt and fresh now; an administrator's note is never evidence.
-- Nothing here calls Twilio, buys, charges, reserves or captures anything; it only tightens when a held reservation may be released. Fee authorizations, the one-live /
-- e164-once indexes, the TW045 purchase stamp and the ConfiDance cumulative ceiling are untouched.
-- Requires 20261208090000 (R2b). Independent of 20261209 (RFL) / 20261210 (R2c-I2) / 20261211 (RFL ops). Rollback: rollback/20261213090000_twilio_r2b_p1_identity_evidence_rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_num_inventory_checks') is null or to_regprocedure('public.tw4_num_inventory_ack(uuid,uuid,text,text,text)') is null
     or to_regprocedure('public.tw4_num_resolve(uuid,uuid,text,text,text)') is null or to_regprocedure('public.tw4_num_settle_admin(uuid,uuid,text,text)') is null
     or to_regprocedure('public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)') is null then
    raise exception 'R2b-P1 precondition failed: 20261208090000 (R2b) is not applied';
  end if;
  if to_regclass('public.studio_sms_num_identity_reads') is not null then
    raise exception 'R2b-P1 precondition failed: already applied';
  end if;
  -- the functions replaced below must still be the R2b versions (another slice must not be clobbered silently)
  if position('acknowledged after this attempt started' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_resolve(uuid,uuid,text,text,text)'::regprocedure)) = 0
     or position('the provider confirmed this number as owned' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_settle_admin(uuid,uuid,text,text)'::regprocedure)) = 0
     or position('declared not created' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_ack(uuid,uuid,text,text,text)'::regprocedure)) = 0 then
    raise exception 'R2b-P1 precondition failed: tw4_num_resolve / settle_admin / inventory_ack differ from 20261208090000';
  end if;
  if position('missing_count' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)'::regprocedure)) = 0
     or position('is not at the number step' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_claim(uuid,uuid,text,integer,text)'::regprocedure)) = 0 then
    raise exception 'R2b-P1 precondition failed: tw4_num_inventory_observe / tw4_num_claim differ from 20261208090000';
  end if;
end $$;

do $$
begin
  -- the functions replaced below must still be EXACTLY the R2b versions (a later or parallel slice must never be overwritten silently)
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_resolve(uuid,uuid,text,text,text)'::regprocedure), E'\r', '')) <> 'a8b1fd848a7457e5f0ba010ea17117b3'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_settle_admin(uuid,uuid,text,text)'::regprocedure), E'\r', '')) <> 'b0662ca0b3403c6e5d0a7f378fdd8592'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_ack(uuid,uuid,text,text,text)'::regprocedure), E'\r', '')) <> '1535415f8a67040881a972746e194589'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)'::regprocedure), E'\r', '')) <> 'a49069f28e34a73edba572e02df35452'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_claim(uuid,uuid,text,integer,text)'::regprocedure), E'\r', '')) <> 'e9329bf279a81978c67457f24dc2646e' then
    raise exception 'R2b-P1 precondition failed: a function it replaces differs from 20261208090000 (fingerprint)';
  end if;
end $$;

-- audit vocabulary: the live list plus the new actions (extended, not replaced)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['num_identity_read', 'num_acknowledged', 'num_history_read']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- the SIDs a listing showed (not only counts): a listing that shows the very number an operation is about is not evidence of its absence
alter table public.studio_sms_num_inventory_checks add column listed_sids text[] not null default '{}';

create table public.studio_sms_num_identity_reads (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  lease_owner text not null,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  phone_number_sid text not null check (phone_number_sid ~ '^PN[0-9a-f]{32}$'),
  e164 text not null check (e164 ~ '^\+1[2-9][0-9]{9}$'),
  sms_capable boolean null,
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default clock_timestamp()
);
create index studio_sms_num_identity_reads_sid on public.studio_sms_num_identity_reads (twilio_account_sid, phone_number_sid, observed_at desc);
create index studio_sms_num_identity_reads_e164 on public.studio_sms_num_identity_reads (legal_entity_id, e164, observed_at desc);
revoke all on public.studio_sms_num_identity_reads from public, anon, authenticated, service_role;
alter table public.studio_sms_num_identity_reads enable row level security;

create table public.studio_sms_num_history_reads (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  lease_owner text not null,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  window_start timestamptz not null,
  window_end timestamptz not null,
  -- the provider guaranteed the window was read in full (a partial or paginated-and-truncated history is complete = false and proves nothing)
  complete boolean not null,
  created_e164 text[] not null default '{}',
  source text not null check (source in ('provider_read', 'fake')),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default clock_timestamp(),
  check (window_end > window_start)
);
create index studio_sms_num_history_reads_lookup on public.studio_sms_num_history_reads (legal_entity_id, twilio_account_sid, observed_at desc);
revoke all on public.studio_sms_num_history_reads from public, anon, authenticated, service_role;
alter table public.studio_sms_num_history_reads enable row level security;

create or replace function public._tw4p1_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception '%: provider identity evidence is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_num_identity_reads_guard before update or delete on public.studio_sms_num_identity_reads for each row execute function public._tw4p1_guard();
create trigger studio_sms_num_history_reads_guard before update or delete on public.studio_sms_num_history_reads for each row execute function public._tw4p1_guard();
create trigger studio_sms_num_history_reads_truncate before truncate on public.studio_sms_num_history_reads for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_num_identity_reads_truncate before truncate on public.studio_sms_num_identity_reads for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- one provider identity read (lease-bound; the caller supplies NORMALIZED facts from a GET made with the subaccount's own credentials, never a verdict)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_identity_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_sid text;
  v_e164 text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or pg_column_size(p_facts) > 4096 or p_digest is null or p_digest !~ '^[0-9a-f]{64}$'
     or p_source is null or p_source not in ('provider_read', 'fake') then
    raise exception 'invalid identity observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_account := public._tw4num_account(o.studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  v_sid := p_facts ->> 'sid';
  v_e164 := p_facts ->> 'phone_number';
  -- the read must be OF the business's own subaccount: a number another account reports is not evidence about this one
  if (p_facts ->> 'account_sid') is distinct from v_account then
    raise exception 'the number belongs to a different account than the business''s active subaccount' using errcode = 'TW049';
  end if;
  if v_sid is null or v_sid !~ '^PN[0-9a-f]{32}$' or v_e164 is null or v_e164 !~ '^\+1[2-9][0-9]{9}$' then
    raise exception 'the provider read carries no valid number identity' using errcode = '22023';
  end if;
  insert into public.studio_sms_num_identity_reads (onboarding_id, lease_owner, legal_entity_id, twilio_account_sid, phone_number_sid, e164, sms_capable, source, evidence_digest)
  values (o.id, p_lease_owner, v_entity, v_account, v_sid, v_e164, case when jsonb_typeof(p_facts -> 'sms_capable') = 'boolean' then (p_facts ->> 'sms_capable')::boolean end, p_source, p_digest);
  perform public._tw4_r1_audit(o, null, 'num_identity_read', o.state, o.state, 'sid=' || v_sid || ';e164=' || v_e164 || ';src=' || p_source);
  return jsonb_build_object('sid', v_sid, 'e164', v_e164);
end $$;

-- the provider's number-creation history for a window, read with the subaccount's own credentials under a lease (facts only; the verdict is the database's)
create or replace function public.tw4_num_history_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_start timestamptz;
  v_end timestamptz;
  v_created text[];
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' or pg_column_size(p_facts) > 65536 or p_digest is null or p_digest !~ '^[0-9a-f]{64}$'
     or p_source is null or p_source not in ('provider_read', 'fake') or jsonb_typeof(p_facts -> 'complete') <> 'boolean' or jsonb_typeof(p_facts -> 'created_e164') <> 'array' then
    raise exception 'invalid history observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_account := public._tw4num_account(o.studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  if (p_facts ->> 'account_sid') is distinct from v_account then
    raise exception 'the history belongs to a different account than the business''s active subaccount' using errcode = 'TW049';
  end if;
  v_start := (p_facts ->> 'window_start')::timestamptz;
  v_end := (p_facts ->> 'window_end')::timestamptz;
  if v_start is null or v_end is null or v_end <= v_start or v_end > clock_timestamp() + interval '30 seconds' then
    raise exception 'invalid history window' using errcode = '22023';
  end if;
  select coalesce(array_agg(x.value), '{}'::text[]) into v_created from jsonb_array_elements_text(p_facts -> 'created_e164') x;
  if exists (select 1 from unnest(v_created) e where e !~ '^\+[1-9][0-9]{6,14}$') or cardinality(v_created) > 5000 then
    raise exception 'invalid history entries' using errcode = '22023';
  end if;
  insert into public.studio_sms_num_history_reads (onboarding_id, lease_owner, legal_entity_id, twilio_account_sid, window_start, window_end, complete, created_e164, source, evidence_digest)
  values (o.id, p_lease_owner, v_entity, v_account, v_start, v_end, (p_facts ->> 'complete')::boolean, v_created, p_source, p_digest);
  perform public._tw4_r1_audit(o, null, 'num_history_read', o.state, o.state, 'created=' || cardinality(v_created) || ';complete=' || (p_facts ->> 'complete') || ';src=' || p_source);
  return jsonb_build_object('created', cardinality(v_created), 'complete', (p_facts ->> 'complete')::boolean);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the acknowledgement: the typed-E.164 signature is gone; identity comes from a fresh provider read
-- ---------------------------------------------------------------------------------------------------------------
drop function public.tw4_num_inventory_ack(uuid, uuid, text, text, text);

create or replace function public.tw4_num_inventory_ack(p_studio_id uuid, p_actor uuid, p_phone_number_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
  i public.studio_sms_num_identity_reads;
begin
  perform public._tw4c_admin(p_actor);
  if p_phone_number_sid is null or p_phone_number_sid !~ '^PN[0-9a-f]{32}$' or p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a number sid and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  v_entity := public._tw4sr_lock(p_studio_id);
  v_account := public._tw4num_account(p_studio_id);
  if v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  -- the identity is what the PROVIDER said, recently, about THIS business's subaccount
  select * into i from public.studio_sms_num_identity_reads x where x.twilio_account_sid = v_account and x.phone_number_sid = p_phone_number_sid and x.legal_entity_id = v_entity
   order by x.observed_at desc, x.id limit 1;
  if i.id is null or i.observed_at < clock_timestamp() - interval '30 minutes' or (i.source <> 'provider_read' and not public._tw4sr_fake_allowed()) then
    raise exception 'a provider identity read of this number (within 30 minutes) is required before it is acknowledged' using errcode = 'TW048';
  end if;
  -- the ledger already knows this sid under ANOTHER number: the provider and the ledger contradict each other
  if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.provider_sid = p_phone_number_sid and x.e164 <> i.e164) then
    raise exception 'the provider and the ledger disagree about this number: investigate it, do not acknowledge it' using errcode = 'TW034';
  end if;
  -- a number that a purchase declared "not created" (or left unresolved) turned up: a paid number the ledger got wrong, not a foreign one. Fail closed as in R2b: while the business
  -- has ANY lost or unresolved purchase nothing is acknowledged for it; a number tied to a failed or retired purchase (by provider-read E.164 or sid) is refused as well.
  if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and x.status in ('in_flight', 'unknown_outcome'))
     -- the provider-read E.164 belongs to a purchase of this business under ANY status, with another sid or none (a lost, wrongly resolved, failed or retired purchase): it is that purchase's number
     or exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and x.e164 = i.e164
                  and (x.provider_sid is null or x.provider_sid <> p_phone_number_sid))
     or exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and (x.status = 'failed' or x.superseded_at is not null)
                  and x.provider_sid = p_phone_number_sid) then
    raise exception 'this number belongs to a purchase that is unresolved, lost, failed or retired: investigate it, do not acknowledge it' using errcode = 'TW034';
  end if;
  insert into public.studio_sms_num_inventory_acks (legal_entity_id, twilio_account_sid, phone_number_sid, e164, acked_by, note)
  values (v_entity, v_account, p_phone_number_sid, i.e164, p_actor, btrim(p_note)) on conflict (twilio_account_sid, phone_number_sid) do nothing;
  perform public._tw4sr_audit(p_studio_id, p_actor, 'num_acknowledged', 'sid=' || p_phone_number_sid || ';e164=' || i.e164 || ';read=' || i.id);
  return jsonb_build_object('acknowledged', p_phone_number_sid, 'e164', i.e164);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- authoritative absence evidence for a fee operation. Returns NULL when sufficient, otherwise the reason code.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4num_absence_evidence(r public.studio_sms_num_operations)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c2 public.studio_sms_num_inventory_checks;
  c1 public.studio_sms_num_inventory_checks;
  h public.studio_sms_num_history_reads;
begin
  if public._tw4num_account(r.studio_id) is distinct from r.twilio_account_sid then
    return 'subaccount_changed_or_not_active';
  end if;
  -- the ConfiDance pilot's cumulative ceiling never regains capacity through absence: its fee is released only by a definitive provider refusal (a separate path)
  if exists (select 1 from public.studio_sms_pilot_exceptions y where y.legal_entity_id = r.legal_entity_id) then
    return 'pilot_never_by_absence';
  end if;
  -- the LATEST listing decides: it must be recent, complete and clean
  select * into c2 from public.studio_sms_num_inventory_checks x where x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
   order by x.listed_at desc, x.created_at desc, x.id limit 1;
  if c2.id is null then return 'no_inventory_check'; end if;
  if c2.source <> 'provider_read' and not public._tw4sr_fake_allowed() then return 'untrusted_evidence_source'; end if;
  if c2.listed_at < clock_timestamp() - interval '60 minutes' then return 'listing_is_stale'; end if;
  if c2.unknown_count > 0 then return 'listing_shows_unknown_numbers'; end if;
  if c2.missing_count > 0 then return 'listing_is_incomplete'; end if;
  -- both the caller's clock and the database's must be at least 20 minutes after the attempt (the caller-supplied listed_at may run ahead of the database clock)
  if c2.listed_at < r.started_at + interval '20 minutes' or c2.created_at < r.started_at + interval '20 minutes' then return 'listing_predates_the_attempt'; end if;
  -- a second, independent (another run), complete, clean listing at least 10 minutes earlier, also 20+ minutes after the attempt
  select * into c1 from public.studio_sms_num_inventory_checks x where x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
     and x.id <> c2.id and x.lease_owner <> c2.lease_owner and x.unknown_count = 0 and x.missing_count = 0 and (x.source = 'provider_read' or public._tw4sr_fake_allowed())
     and x.listed_at >= r.started_at + interval '20 minutes' and x.created_at >= r.started_at + interval '20 minutes' and x.listed_at <= c2.listed_at - interval '10 minutes' and x.created_at <= c2.listed_at
   order by x.listed_at desc, x.created_at desc, x.id limit 1;
  if c1.id is null then return 'second_independent_listing_required'; end if;
  -- no listing since the first was unclean
  if exists (select 1 from public.studio_sms_num_inventory_checks x where x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
               and x.listed_at >= c1.listed_at and (x.unknown_count > 0 or x.missing_count > 0)) then
    return 'a_listing_since_the_first_was_unclean';
  end if;
  -- NO listing since the attempt SHOWS the number this operation recorded (a recorded sid is "known", so the counts alone would call it clean)
  if r.provider_sid is not null and exists (select 1 from public.studio_sms_num_inventory_checks x where x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
                                             and x.listed_at >= r.started_at and r.provider_sid = any (x.listed_sids)) then
    return 'the_number_is_in_the_listing';
  end if;
  -- a sender or acknowledgement was recorded since the attempt began that the ledger does not back: the number the attempt may have bought was typed in somewhere else
  if exists (select 1 from public.studio_sms_num_inventory_acks a where a.legal_entity_id = r.legal_entity_id and a.created_at >= r.started_at)
     or exists (select 1 from public.studio_sms_entity_studios es join public.studio_sms_billed_senders b on b.studio_id = es.studio_id
                 where es.legal_entity_id = r.legal_entity_id and b.created_at >= r.started_at and b.status <> 'released'
                   and not exists (select 1 from public.studio_sms_num_operations o2 where o2.legal_entity_id = r.legal_entity_id and o2.op_kind = 'number_purchase' and o2.status = 'succeeded'
                                      and o2.provider_sid = b.phone_number_sid and o2.e164 = b.sender_e164 and o2.id <> r.id)) then
    return 'a_number_was_recorded_since_the_attempt';
  end if;
  -- the provider has shown a number with this very E.164 in this subaccount since the attempt began
  if exists (select 1 from public.studio_sms_num_identity_reads i where i.legal_entity_id = r.legal_entity_id and i.twilio_account_sid = r.twilio_account_sid and i.e164 = r.e164
              and i.observed_at >= r.started_at) then
    return 'the_number_is_present_at_the_provider';
  end if;
  -- DELETED AFTER PURCHASE: a number can be bought, billed and deleted, and then no listing shows it. Absence from inventory alone never proves a purchase did not happen:
  -- the provider's own creation history for the window must be complete and must not show this E.164. Until an adapter can read that history (not verified against the real
  -- provider), this refuses every time outside a local QA database: a pre-activation blocker.
  select * into h from public.studio_sms_num_history_reads x where x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid and x.complete
     and (x.source = 'provider_read' or public._tw4sr_fake_allowed()) and x.window_start <= r.started_at - interval '5 minutes' and x.window_end >= c1.listed_at and x.observed_at >= clock_timestamp() - interval '60 minutes'
   order by x.observed_at desc, x.id limit 1;
  if h.id is null then return 'creation_history_unavailable'; end if;
  if r.e164 = any (h.created_e164) then return 'provider_history_shows_creation'; end if;
  return null;
end $$;

create or replace function public.tw4_num_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
  v_reason text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'the number sid found at the provider is required' using errcode = '22023';
  end if;
  if p_resolution = 'not_created' and r.fee_bearing and exists (select 1 from public.studio_sms_num_inventory_acks a where a.legal_entity_id = r.legal_entity_id and a.created_at >= r.started_at) then
    raise exception 'a number was acknowledged after this attempt started: investigate it before declaring the purchase not created' using errcode = 'TW034';
  end if;
  if p_resolution = 'created' and p_provider_sid !~ '^PN[0-9a-f]{32}$' then
    raise exception 'a canonical (lowercase) provider sid is required' using errcode = '22023';
  end if;
  -- a purchase declared CREATED needs the provider's own identity read after the attempt: the typed sid is only a claim, and a wrong one would hide the real number
  if p_resolution = 'created' and not exists (select 1 from public.studio_sms_num_identity_reads x where x.twilio_account_sid = r.twilio_account_sid and x.legal_entity_id = r.legal_entity_id
       and x.phone_number_sid = p_provider_sid and x.e164 = r.e164 and x.observed_at >= r.started_at and (x.source = 'provider_read' or public._tw4sr_fake_allowed())) then
    raise exception 'a provider identity read of this sid and E.164 after the attempt is required before a purchase is declared created' using errcode = 'TW048';
  end if;
  -- A number purchase (fee-bearing or credit-funded: either way it carries provider rent and the duplicate-purchase risk) is declared NOT CREATED only on authoritative, post-attempt, clean provider evidence (a complete inventory listing of THIS subaccount taken after the attempt
  -- with nothing unknown or missing, and no provider-read number with this E.164). An administrator's note alone never releases a fee or frees the approval.
  if p_resolution = 'not_created' and r.op_kind = 'number_purchase' then
    perform pg_advisory_xact_lock(hashtextextended('num_inventory:' || r.twilio_account_sid, 0));   -- a listing committing concurrently is seen, never raced
    v_reason := public._tw4num_absence_evidence(r);
    if v_reason is not null then
      raise exception 'post-attempt provider inventory evidence is required before a purchase is declared not created: %', v_reason using errcode = 'TW050';
    end if;
  end if;
  update public.studio_sms_num_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'not_created' then
    perform public._tw4num_settle_if_held(r.id, 'released', 'not_created');
    perform public._tw4num_free_selection(r.selection_id, p_actor, 'resolved: not created');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

create or replace function public.tw4_num_settle_admin(p_operation_id uuid, p_actor uuid, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
  v_reason text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null or not r.fee_bearing then
    raise exception 'unknown operation or no fee' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_num_resolve' using errcode = '22023';
  end if;
  if p_outcome = 'released' and exists (select 1 from public.studio_sms_num_resources x where x.operation_id = r.id and x.status = 'owned') then
    raise exception 'the provider confirmed this number as owned: its fee cannot be released' using errcode = '22023';
  end if;
  -- a fee is released only on provider evidence that the number is absent (never on the administrator's attestation)
  if p_outcome = 'released' then
    perform pg_advisory_xact_lock(hashtextextended('num_inventory:' || r.twilio_account_sid, 0));
    v_reason := public._tw4num_absence_evidence(r);
    if v_reason is not null then
      raise exception 'post-attempt provider inventory evidence is required before a fee is released: %', v_reason using errcode = 'TW050';
    end if;
  end if;
  if r.status = 'abandoned' and p_outcome = 'captured' then
    raise exception 'an operation declared not created cannot capture a fee' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':number' and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation' using errcode = '22023';
  end if;
  perform public._tw4prov_settle(r.id, 'number', p_outcome, 'admin');
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

create or replace function public.tw4_num_inventory_observe(p_onboarding_id uuid, p_lease_owner text, p_sids text[], p_source text, p_listed_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_known text[];
  v_unknown int;
  v_missing int;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_sids is null or cardinality(p_sids) > 1000 or exists (select 1 from unnest(p_sids) x where x is null or x !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'an inventory of number sids is required' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('provider_read', 'fake') or p_listed_at is null or p_listed_at > clock_timestamp() + interval '30 seconds' or p_listed_at < clock_timestamp() - interval '10 minutes' then
    raise exception 'invalid inventory observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_account := public._tw4num_account(o.studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  v_known := public._tw4num_known(v_entity);
  select count(*) into v_unknown from unnest(p_sids) x where not (x = any (v_known));
  select count(*) into v_missing from (
    select p.provider_sid sid from public.studio_sms_num_operations p
     where p.legal_entity_id = v_entity and p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null and p.twilio_account_sid = v_account
       and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = p.id and r.status = 'owned')) l
   where not (l.sid = any (p_sids));
  insert into public.studio_sms_num_inventory_checks (onboarding_id, lease_owner, legal_entity_id, listed_count, unknown_count, missing_count, twilio_account_sid, source, listed_at, listed_sids)
  values (o.id, p_lease_owner, v_entity, cardinality(p_sids), v_unknown, v_missing, v_account, p_source, p_listed_at, p_sids);
  return jsonb_build_object('listed', cardinality(p_sids), 'unknown', v_unknown, 'missing', v_missing);
end $$;

create or replace function public.tw4_num_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer default 300, p_mode text default 'run')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_lease_owner is null or char_length(p_lease_owner) not between 1 and 64 or p_lease_seconds is null or p_lease_seconds not between 30 and 900
     or p_mode is null or p_mode not in ('run', 'refresh') then
    raise exception 'invalid lease' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  if p_mode = 'run' and not exists (select 1 from public.studio_sms_runner_windows w where w.studio_id = p_studio_id and w.expires_at > now()) then
    raise exception 'the runner window for this studio is closed' using errcode = 'TW001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no onboarding to run' using errcode = '22023';
  end if;
  if o.state <> 'campaign_pending' and not (p_mode = 'refresh' and (o.state in ('ready_for_activation', 'active', 'suspended') or (o.state = 'exception' and coalesce(o.last_error_code, '') like 'num\_%'))) then
    raise exception 'onboarding state % is not at the number step', o.state using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'runner_lease', o.state, o.state, 'claimed number ' || p_mode);
  return jsonb_build_object('onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

revoke all on function public._tw4p1_guard(), public._tw4num_absence_evidence(public.studio_sms_num_operations) from public, anon, authenticated, service_role;
revoke all on function public.tw4_num_identity_observe(uuid, text, jsonb, text, text), public.tw4_num_history_observe(uuid, text, jsonb, text, text), public.tw4_num_inventory_ack(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.tw4_num_identity_observe(uuid, text, jsonb, text, text), public.tw4_num_history_observe(uuid, text, jsonb, text, text), public.tw4_num_inventory_ack(uuid, uuid, text, text) to service_role;

commit;
