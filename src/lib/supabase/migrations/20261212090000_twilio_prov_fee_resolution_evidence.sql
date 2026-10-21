-- 20261212090000_twilio_prov_fee_resolution_evidence.sql
-- TW-4F: evidence-backed resolution of FEE-BEARING provisioning operations (R2a ledger). Closes the gap that a held fee could be released on an administrator's word.
--
-- What changes
--   * studio_sms_prov_listings: append-only PROVIDER LISTING observations of a fee-bearing campaign's scope (the Messaging Service's campaigns), recorded only through
--     tw4_prov_listing_record: service role, onboarding lease held, the right subaccount, the ledger's own Messaging Service, a read that started AFTER the previous record,
--     and a verdict judged HERE (absent | present | inconclusive | premature). The fake source is refused outside the local QA marker.
--   * tw4_prov_resolve('not_created') on a fee-bearing operation needs authoritative proof (see _tw4prov2_proof): two independent complete listings, both at least 20 minutes
--     after the attempt, at least 10 minutes apart, the latest no older than 60 minutes, with NO present / inconclusive observation ever recorded for it.
--     Incomplete, stale, conflicting or unverifiable evidence fails closed. The ConfiDance pilot business can NEVER resolve a fee-bearing operation as not created: its cumulative
--     ceiling is not replenished by an absence determination (only a definitive provider refusal, recorded by tw4_prov_finish, releases for it).
--   * tw4_prov_settle_admin('released') no longer releases on a note alone: an abandoned operation needs its recorded verified-absence disposition; a SUCCEEDED operation (it
--     exists at the provider) is not releasable at all until a provider-verified cancellation exists (the lifecycle's cancellation digest is administrator-typed, so it is not proof);
--     never for the pilot business (judged by the exception OR by the operation's own pilot-funded reservations).
--   * tw4_prov_evidence_claim: an evidence-only lease for any non-cancelled onboarding (an unknown fee outcome parks the onboarding in 'exception', which the runner's claim refuses).
--   * Every settlement of a prov: reservation, by any path, leaves a disposition row (trigger); a "refusal" is refused while a provider listing shows a resource for the operation.
--   * studio_sms_prov_dispositions: append-only record of HOW a fee reservation was disposed (provider_refusal | verified_absence | created_claim | settled_released | settled_captured),
--     with the listing ids that justify it.
--   * studio_sms_prov_orphans: a provider resource found by a listing that the ledger does not account for (typically after an operation was resolved not created). It is recorded
--     idempotently, BLOCKS every further fee-bearing provisioning operation of that legal business (R2a and R2b ledgers, by trigger), is registered with the recurring-fee lifecycle
--     (tw4_prov_orphan_register -> tw4_rfl_register) so its provider cost is exposure, and raises idempotent owner and administrator alerts through the lifecycle's alert queue
--     (owner text carries no identifier and no money). It is NEVER charged to a studio. It stays visible until the lifecycle shows the resource cancelled with evidence.
-- Requires 20261207 (R2a), 20261208 (R2b ledger table) and 20261209 (recurring-fee lifecycle). Independent of 20261210 and 20261211.
-- Rollback: rollback/20261212090000_twilio_prov_fee_resolution_evidence_rollback.sql (refuses once any listing, disposition or orphan exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_prov_operations') is null or to_regclass('public.studio_sms_num_operations') is null
     or to_regclass('public.studio_sms_provider_resources') is null or to_regclass('public.studio_sms_provider_alerts') is null
     or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null or to_regprocedure('public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid)') is null
     or to_regprocedure('public._tw4prov_settle(uuid,text,text,text)') is null or to_regprocedure('public._tw4sr_fake_allowed()') is null then
    raise exception 'fee-resolution evidence precondition failed: 20261207 (R2a), 20261208 (R2b) and 20261209 (recurring-fee lifecycle) must be applied';
  end if;
  if to_regclass('public.studio_sms_prov_listings') is not null then
    raise exception 'fee-resolution evidence precondition failed: already applied';
  end if;
  -- the two functions replaced below must still be R2a's versions (another slice must not be clobbered silently)
  if position('only an unresolved operation can be resolved' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_resolve(uuid,uuid,text,text,text)'::regprocedure)) = 0
     or position('no reservation is held for this operation and fee' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_settle_admin(uuid,uuid,text,text,text)'::regprocedure)) = 0 then
    raise exception 'fee-resolution evidence precondition failed: tw4_prov_resolve / tw4_prov_settle_admin differ from R2a (20261207090000)';
  end if;
end $$;

-- audit vocabulary: the live list plus the evidence actions (extended, not replaced)
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
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['prov_listing', 'prov_orphan', 'prov_disposition']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; everything goes through the functions below)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_prov_listings (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.studio_sms_prov_operations(id) on delete restrict,
  onboarding_id uuid not null,
  studio_id uuid not null,
  legal_entity_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  op_kind text not null check (op_kind = 'campaign'),
  scope_sid text not null check (scope_sid ~ '^MG[0-9a-fA-F]{32}$'),            -- the Messaging Service whose campaigns were listed
  read_id uuid not null,                                                          -- one per provider read (a replay of the same read is idempotent, never a second observation)
  read_started_at timestamptz not null,                                           -- when the provider request began (adapter clock); the database requires it to follow the previous record
  observed_at timestamptz not null default clock_timestamp(),                     -- when THIS database recorded it (the clock every rule uses)
  source text not null check (source in ('provider_read', 'fake')),
  complete boolean not null,
  listed_sids text[] not null default '{}' check (cardinality(listed_sids) <= 50 and array_to_string(listed_sids, ',') ~ '^(QE[0-9a-fA-F]{32}(,QE[0-9a-fA-F]{32})*)?$'),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  verdict text not null check (verdict in ('absent', 'present', 'inconclusive', 'premature')),
  recorded_by_lease text not null check (char_length(recorded_by_lease) between 1 and 64),
  constraint studio_sms_prov_listings_read unique (operation_id, read_id),
  constraint studio_sms_prov_listings_digest unique (operation_id, evidence_digest),
  constraint studio_sms_prov_listings_verdict_shape check (
    (verdict = 'inconclusive') = (not complete) and (verdict <> 'present' or cardinality(listed_sids) > 0) and (verdict not in ('absent', 'premature') or cardinality(listed_sids) = 0))
);
create index studio_sms_prov_listings_op on public.studio_sms_prov_listings (operation_id, observed_at);

create table public.studio_sms_prov_orphans (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid not null,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  resource_kind text not null check (resource_kind = 'campaign'),
  provider_sid text not null check (provider_sid ~ '^QE[0-9a-fA-F]{32}$'),
  scope_sid text not null check (scope_sid ~ '^MG[0-9a-fA-F]{32}$'),
  first_listing_id uuid not null references public.studio_sms_prov_listings(id) on delete restrict,
  source_operation_id uuid not null references public.studio_sms_prov_operations(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'registered', 'closed')),
  rfl_resource_id uuid null,
  discovered_at timestamptz not null default clock_timestamp(),
  registered_by uuid null,
  registered_at timestamptz null,
  closed_by uuid null,
  closed_at timestamptz null,
  close_note text null check (close_note is null or char_length(close_note) between 10 and 500),
  constraint studio_sms_prov_orphans_sid unique (provider_sid),
  constraint studio_sms_prov_orphans_shape check (
    (status = 'open' and registered_at is null and closed_at is null)
    or (status = 'registered' and registered_at is not null and rfl_resource_id is not null and closed_at is null)
    or (status = 'closed' and closed_at is not null and close_note is not null))
);
create index studio_sms_prov_orphans_entity on public.studio_sms_prov_orphans (legal_entity_id) where status <> 'closed';

create table public.studio_sms_prov_dispositions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.studio_sms_prov_operations(id) on delete restrict,
  legal_entity_id uuid not null,
  studio_id uuid not null,
  fee_kind text null,
  disposition text not null check (disposition in ('provider_refusal', 'verified_absence', 'created_claim', 'settled_released', 'settled_captured', 'reservation_released', 'reservation_captured')),
  listing_ids uuid[] not null default '{}',
  actor uuid null,
  note text null check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default clock_timestamp()
);
create unique index studio_sms_prov_dispositions_once on public.studio_sms_prov_dispositions (operation_id, disposition, coalesce(fee_kind, ''));

revoke all on public.studio_sms_prov_listings, public.studio_sms_prov_orphans, public.studio_sms_prov_dispositions from public, anon, authenticated, service_role;
alter table public.studio_sms_prov_listings enable row level security;
alter table public.studio_sms_prov_orphans enable row level security;
alter table public.studio_sms_prov_dispositions enable row level security;

create or replace function public._tw4prov2_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: provisioning evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_prov_orphans' then
    if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.twilio_account_sid is distinct from old.twilio_account_sid or new.provider_sid is distinct from old.provider_sid or new.first_listing_id is distinct from old.first_listing_id
       or new.source_operation_id is distinct from old.source_operation_id or new.discovered_at is distinct from old.discovered_at then
      raise exception 'studio_sms_prov_orphans: the identity of an orphan is fixed' using errcode = '42501';
    end if;
    if old.status = 'closed' or (old.status = 'registered' and new.status = 'open') then
      raise exception 'studio_sms_prov_orphans: a status never goes backwards' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception '%: append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_prov_listings_guard before update or delete on public.studio_sms_prov_listings for each row execute function public._tw4prov2_guard();
create trigger studio_sms_prov_dispositions_guard before update or delete on public.studio_sms_prov_dispositions for each row execute function public._tw4prov2_guard();
create trigger studio_sms_prov_orphans_guard before update or delete on public.studio_sms_prov_orphans for each row execute function public._tw4prov2_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
-- the pilot business: its cumulative ceiling is never replenished by an absence determination
create or replace function public._tw4prov2_is_pilot(p_entity uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity) $$;

-- ... or the operation's own reservations were funded from the pilot ceiling (so removing the exception row never makes them releasable by absence)
create or replace function public._tw4prov2_is_pilot_op(p_op uuid, p_entity uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public._tw4prov2_is_pilot(p_entity)
      or exists (select 1 from public.studio_sms_credit_reservations cr where cr.reservation_key like 'prov:' || p_op::text || ':%' and cr.funding = 'pilot')
$$;

-- Proof that a fee-bearing campaign operation does NOT exist at the provider. Pure over the recorded listings; never trusts a caller.
create or replace function public._tw4prov2_proof(p_op uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  v_last public.studio_sms_prov_listings;
  v_a1 public.studio_sms_prov_listings;
begin
  select * into r from public.studio_sms_prov_operations x where x.id = p_op;
  if r.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_operation');
  end if;
  if r.op_kind <> 'campaign' or not r.fee_bearing then
    return jsonb_build_object('ok', false, 'reason', 'not_a_fee_campaign');
  end if;
  -- a provider listing showing anything for this scope is conflicting evidence, whenever it was recorded
  if exists (select 1 from public.studio_sms_prov_listings l where l.operation_id = p_op and l.verdict = 'present') then
    return jsonb_build_object('ok', false, 'reason', 'resource_seen');
  end if;
  select * into v_last from public.studio_sms_prov_listings l where l.operation_id = p_op order by l.observed_at desc, l.id desc limit 1;
  if v_last.id is null or v_last.verdict <> 'absent' then
    return jsonb_build_object('ok', false, 'reason', case when v_last.id is null then 'no_listing' else 'latest_not_absent' end);
  end if;
  if v_last.observed_at < clock_timestamp() - interval '60 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  if v_last.source = 'fake' and not public._tw4sr_fake_allowed() then
    return jsonb_build_object('ok', false, 'reason', 'fake_evidence');
  end if;
  -- the earlier independent observation: absent, recorded at least 10 minutes before the latest, with its read starting after the attempt's 20-minute wait
  select * into v_a1 from public.studio_sms_prov_listings l
   where l.operation_id = p_op and l.verdict = 'absent' and l.id <> v_last.id and l.observed_at <= v_last.observed_at - interval '10 minutes'
     and l.read_started_at >= r.started_at + interval '20 minutes' and (l.source = 'provider_read' or public._tw4sr_fake_allowed())
   order by l.observed_at desc, l.id desc limit 1;
  if v_a1.id is null then
    return jsonb_build_object('ok', false, 'reason', 'need_two_independent_listings');
  end if;
  -- both observations are about the same scope and the same subaccount
  if v_a1.scope_sid <> v_last.scope_sid or v_a1.twilio_account_sid <> v_last.twilio_account_sid or v_last.twilio_account_sid <> r.twilio_account_sid then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;
  if v_last.read_started_at <= v_a1.observed_at then
    return jsonb_build_object('ok', false, 'reason', 'reads_not_independent');
  end if;
  -- nothing but clean absences between the two (an inconclusive read in between breaks the chain)
  if exists (select 1 from public.studio_sms_prov_listings l where l.operation_id = p_op and l.observed_at >= v_a1.observed_at and l.verdict not in ('absent')) then
    return jsonb_build_object('ok', false, 'reason', 'chain_broken');
  end if;
  return jsonb_build_object('ok', true, 'reason', 'verified_absence', 'listing_ids', jsonb_build_array(v_a1.id, v_last.id));
end $$;

-- a late-found provider resource blocks every further FEE-BEARING provisioning operation of the business (R2a and R2b ledgers)
create or replace function public._tw4prov2_orphan_block()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.fee_bearing and exists (select 1 from public.studio_sms_prov_orphans x where x.legal_entity_id = new.legal_entity_id and x.status <> 'closed') then
    raise exception 'a provider resource this business did not authorize was found: reconcile it before any further fee-bearing operation' using errcode = 'TW047';
  end if;
  return new;
end $$;
create trigger studio_sms_prov_operations_orphan_block before insert on public.studio_sms_prov_operations for each row execute function public._tw4prov2_orphan_block();
create trigger studio_sms_num_operations_orphan_block before insert on public.studio_sms_num_operations for each row execute function public._tw4prov2_orphan_block();

-- a definitive provider refusal (recorded by tw4_prov_finish, which accepts only the 'api' code on a fee operation) leaves its own, separate disposition
create or replace function public._tw4prov2_refusal_disposition()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.fee_bearing and new.status = 'failed' and old.status is distinct from 'failed' then
    insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, note)
    select new.id, new.legal_entity_id, new.studio_id, k, 'provider_refusal', left(coalesce(new.error_code, 'api'), 64) from unnest(new.fee_kinds) k
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger studio_sms_prov_operations_refusal_disposition after update of status on public.studio_sms_prov_operations for each row execute function public._tw4prov2_refusal_disposition();

-- a "definitive refusal" claimed by the runner is refused while the ledger holds a provider listing that SHOWS a resource for the operation (conflicting evidence)
create or replace function public._tw4prov2_refusal_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.fee_bearing and new.status = 'failed' and old.status is distinct from 'failed'
     and exists (select 1 from public.studio_sms_prov_listings l where l.operation_id = new.id and l.verdict = 'present') then
    raise exception 'a provider listing shows a resource for this operation: it cannot be closed as a refusal' using errcode = 'TW046';
  end if;
  return new;
end $$;
create trigger studio_sms_prov_operations_refusal_guard before update of status on public.studio_sms_prov_operations for each row execute function public._tw4prov2_refusal_guard();

-- every settlement of a provisioning reservation, by ANY path (refusal, observation, resolution, administrator), leaves a disposition row
create or replace function public._tw4prov2_reservation_disposition()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_op uuid;
  v_o public.studio_sms_prov_operations;
begin
  if new.reservation_key like 'prov:%' and old.status = 'reserved' and new.status in ('released', 'captured') then
    begin
      v_op := split_part(new.reservation_key, ':', 2)::uuid;
    exception when others then
      return new;
    end;
    select * into v_o from public.studio_sms_prov_operations x where x.id = v_op;
    if v_o.id is not null then
      insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, note)
      values (v_o.id, v_o.legal_entity_id, v_o.studio_id, new.kind, case new.status when 'released' then 'reservation_released' else 'reservation_captured' end, left(new.funding, 20))
      on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
create trigger studio_sms_credit_reservations_prov_disposition after update of status on public.studio_sms_credit_reservations for each row execute function public._tw4prov2_reservation_disposition();

-- ---------------------------------------------------------------------------------------------------------------
-- recording a provider listing (the ONLY way evidence enters)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_listing_record(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_prov_listings;
  v_row public.studio_sms_prov_listings;
  v_now timestamptz := clock_timestamp();
  v_read_id uuid;
  v_start timestamptz;
  v_complete boolean;
  v_listed text[];
  v_verdict text;
  v_known text[];
  v_new text[];
  v_sid text;
  v_inserted uuid;
  v_orphans int := 0;
  v_open int;
  v_active text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid listing' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  -- the operation must belong to THIS onboarding (tenant scope) and be a fee-bearing campaign; any status: a late observation of a closed operation is exactly the point
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.op_kind <> 'campaign' or not r.fee_bearing then
    raise exception 'not a fee-bearing campaign operation of this onboarding' using errcode = '22023';
  end if;
  select t.twilio_account_sid into v_active from public.studio_sms_twilio_accounts t where t.legal_entity_id = r.legal_entity_id and t.status = 'active';
  if v_active is null or v_active <> r.twilio_account_sid or (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
    raise exception 'the listing is not of the operation''s own active subaccount' using errcode = 'TW005';
  end if;
  select * into v_ms from public.studio_sms_prov_operations x where x.studio_id = r.studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null;
  if v_ms.id is null or (p_facts ->> 'scope_sid') is distinct from v_ms.provider_sid then
    raise exception 'the listing is not of this studio''s own Messaging Service' using errcode = 'TW049';
  end if;
  begin
    v_read_id := (p_facts ->> 'read_id')::uuid;
    v_start := (p_facts ->> 'read_started_at')::timestamptz;
    v_complete := (p_facts ->> 'complete')::boolean;
  exception when others then
    raise exception 'invalid listing facts' using errcode = '22023';
  end;
  if v_read_id is null or v_start is null or v_complete is null or jsonb_typeof(p_facts -> 'listed') is distinct from 'array' then
    raise exception 'invalid listing facts' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct e order by e), '{}') into v_listed from jsonb_array_elements_text(p_facts -> 'listed') e;
  if exists (select 1 from unnest(v_listed) s where s !~ '^QE[0-9a-fA-F]{32}$') or cardinality(v_listed) > 50 then
    raise exception 'invalid listing facts' using errcode = '22023';
  end if;
  -- a replay of the same provider read changes nothing
  select * into v_row from public.studio_sms_prov_listings l where l.operation_id = r.id and l.read_id = v_read_id;
  if v_row.id is not null then
    if v_row.evidence_digest <> p_digest then
      raise exception 'this read was already recorded with different evidence' using errcode = 'TW046';
    end if;
    return jsonb_build_object('listing_id', v_row.id, 'verdict', v_row.verdict, 'replayed', true);
  end if;
  -- timing: a read must be fresh, must follow the attempt, and must have STARTED after the previous record (two reads are never one read recorded twice)
  if v_start > v_now or v_start < v_now - interval '10 minutes' then
    raise exception 'the read is stale or from the future' using errcode = 'TW046';
  end if;
  if v_start < r.started_at then
    raise exception 'the read began before the attempt' using errcode = 'TW046';
  end if;
  select * into v_prev from public.studio_sms_prov_listings l where l.operation_id = r.id order by l.observed_at desc, l.id desc limit 1;
  if v_prev.id is not null and v_start <= v_prev.observed_at then
    raise exception 'the read began before the previous one was recorded: not independent' using errcode = 'TW046';
  end if;

  v_verdict := case
    when not v_complete then 'inconclusive'
    when cardinality(v_listed) > 0 then 'present'
    when v_start < r.started_at + interval '20 minutes' then 'premature'
    else 'absent'
  end;
  insert into public.studio_sms_prov_listings (operation_id, onboarding_id, studio_id, legal_entity_id, twilio_account_sid, op_kind, scope_sid, read_id, read_started_at, observed_at, source, complete,
                                               listed_sids, evidence_digest, verdict, recorded_by_lease)
  values (r.id, o.id, r.studio_id, r.legal_entity_id, r.twilio_account_sid, r.op_kind, v_ms.provider_sid, v_read_id, v_start, v_now, p_source, v_complete, v_listed, p_digest, v_verdict, p_lease_owner)
  returning * into v_row;

  if v_verdict = 'present' then
    -- anything listed that no operation of the business accounts for is an orphan. Each STILL-OPEN fee-bearing attempt of this studio (any, not only the one listed)
    -- may own one such resource: the runner adopts it by lookup, so up to that many candidates are adoption candidates, not orphans. More candidates than open attempts
    -- are ambiguous and are ALL recorded (visibility over convenience; `tw4_prov_orphan_close` clears one the ledger turns out to account for).
    select coalesce(array_agg(distinct x.provider_sid), '{}') into v_known from public.studio_sms_prov_operations x where x.legal_entity_id = r.legal_entity_id and x.provider_sid is not null;
    select coalesce(array_agg(s), '{}') into v_new from unnest(v_listed) s where s <> all (v_known);
    select count(*) into v_open from public.studio_sms_prov_operations x
     where x.studio_id = r.studio_id and x.op_kind = 'campaign' and x.fee_bearing and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null;
    if cardinality(v_new) > v_open then
      perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;   -- the order tw4_prov_begin uses: onboarding, then the entity
      foreach v_sid in array v_new loop
        v_inserted := null;
        insert into public.studio_sms_prov_orphans (legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, scope_sid, first_listing_id, source_operation_id)
        values (r.legal_entity_id, r.studio_id, r.twilio_account_sid, 'campaign', v_sid, v_ms.provider_sid, v_row.id, r.id)
        on conflict (provider_sid) do nothing returning id into v_inserted;
        if v_inserted is not null then
          v_orphans := v_orphans + 1;
          -- idempotent alerts through the lifecycle's own queue: no identifier, no amount in the owner text; never a charge
          perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, null, 'inventory_gap', 'prov_orphan:' || v_inserted || ':owner', 'owner', 'warning',
            'DanceFlow found a texting registration on your account that it did not expect and is looking into it. You do not need to do anything. You will not be charged for it.');
          perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, null, 'inventory_gap', 'prov_orphan:' || v_inserted || ':admin', 'admin', 'critical',
            'A provider campaign not accounted for by the ledger was found for this business (orphan ' || v_inserted || '). Fee-bearing provisioning is blocked until it is reconciled.');
          perform public._tw4_r1_audit(o, null, 'prov_orphan', o.state, o.state, 'orphan=' || v_inserted || ';op=' || r.id || ';listing=' || v_row.id);
        end if;
      end loop;
    end if;
  end if;
  perform public._tw4_r1_audit(o, null, 'prov_listing', o.state, o.state, 'op=' || r.id || ';listing=' || v_row.id || ';verdict=' || v_verdict || ';listed=' || cardinality(v_listed));
  return jsonb_build_object('listing_id', v_row.id, 'verdict', v_verdict, 'replayed', false, 'orphans', v_orphans);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- resolution: R2a's tw4_prov_resolve with the evidence rule for FEE-BEARING 'not_created'
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
  v_kind text;
  v_proof jsonb;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ case r.op_kind when 'messaging_service' then '^MG[0-9a-fA-F]{32}$' else '^QE[0-9a-fA-F]{32}$' end) then
    raise exception 'the resource sid found at the provider is required' using errcode = '22023';
  end if;
  v_proof := null;
  if r.fee_bearing and p_resolution = 'not_created' then
    -- the ConfiDance pilot business: an absence determination never returns headroom to the cumulative ceiling
    if public._tw4prov2_is_pilot_op(r.id, r.legal_entity_id) then
      raise exception 'a fee-bearing operation of the pilot business is never released by a not-created determination' using errcode = 'TW048';
    end if;
    v_proof := public._tw4prov2_proof(r.id);
    if not (v_proof ->> 'ok')::boolean then
      raise exception 'provider-backed evidence of non-creation is required (%)', v_proof ->> 'reason' using errcode = 'TW046';
    end if;
  end if;
  update public.studio_sms_prov_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account and service confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'created' then
    foreach v_kind in array r.fee_kinds loop
      insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, actor, note)
      values (r.id, r.legal_entity_id, r.studio_id, v_kind, 'created_claim', p_actor, left(btrim(p_note), 500)) on conflict do nothing;
    end loop;
  end if;
  if r.fee_bearing and p_resolution = 'not_created' then
    foreach v_kind in array r.fee_kinds loop
      insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, listing_ids, actor, note)
      values (r.id, r.legal_entity_id, r.studio_id, v_kind, 'verified_absence', (select coalesce(array_agg(e::uuid), '{}') from jsonb_array_elements_text(v_proof -> 'listing_ids') e), p_actor, left(btrim(p_note), 500))
      on conflict do nothing;
      perform public._tw4prov_settle(r.id, v_kind, 'released', 'not_created');
    end loop;
  end if;
  if p_resolution = 'created' and r.op_kind = 'campaign' and o.state = 'service_setup' then
    update public.studio_sms_onboarding set state = 'campaign_pending', step = 'C1' where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'service_setup', 'campaign_pending', 'campaign confirmed by an admin');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution
    || case when v_proof is not null then ';basis=verified_absence' else '' end);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- settling a held reservation of a SUCCEEDED / ABANDONED operation: no release on a note alone
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_settle_admin(p_operation_id uuid, p_actor uuid, p_kind text, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
  v_basis boolean := false;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null or p_kind is null or not (p_kind = any (r.fee_kinds)) then
    raise exception 'unknown operation or fee kind' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_prov_resolve' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || p_kind and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation and fee' using errcode = '22023';
  end if;
  if p_outcome = 'released' then
    -- releasing money needs evidence the provider is not (or no longer) billing for the resource, never an administrator's note alone
    if public._tw4prov2_is_pilot_op(r.id, r.legal_entity_id) then
      raise exception 'a pilot reservation is released only by a definitive provider refusal' using errcode = 'TW048';
    end if;
    if r.status = 'abandoned' then
      v_basis := exists (select 1 from public.studio_sms_prov_dispositions d where d.operation_id = r.id and d.disposition = 'verified_absence' and d.fee_kind = p_kind)
                 and not exists (select 1 from public.studio_sms_prov_orphans x where x.source_operation_id = r.id);
    else
      -- a succeeded operation EXISTS at the provider. The lifecycle's cancellation digest is typed by an administrator and is not verified by the lifecycle, so it is NOT
      -- provider-backed proof: no release for a succeeded operation until a provider-verified cancellation exists (a later slice). Fail closed.
      v_basis := false;
    end if;
    if not v_basis then
      raise exception 'provider-backed evidence is required to release this reservation' using errcode = 'TW046';
    end if;
  end if;
  perform public._tw4prov_settle(r.id, p_kind, p_outcome, 'admin');
  insert into public.studio_sms_prov_dispositions (operation_id, legal_entity_id, studio_id, fee_kind, disposition, actor, note)
  values (r.id, r.legal_entity_id, r.studio_id, p_kind, case when p_outcome = 'released' then 'settled_released' else 'settled_captured' end, p_actor, left(btrim(p_note), 500))
  on conflict do nothing;
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || p_kind || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- orphans: register with the recurring-fee lifecycle (exposure), close once the lifecycle shows the resource cancelled with evidence
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_orphan_register(p_orphan_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  x public.studio_sms_prov_orphans;
  o public.studio_sms_onboarding;
  v_res jsonb;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into x from public.studio_sms_prov_orphans y where y.id = p_orphan_id for update;
  if x.id is null then
    raise exception 'unknown orphan' using errcode = '22023';
  end if;
  if x.status = 'registered' then
    return jsonb_build_object('status', 'registered', 'resource_id', x.rfl_resource_id, 'replayed', true);
  end if;
  if x.status <> 'open' then
    raise exception 'this orphan is already closed' using errcode = '22023';
  end if;
  -- the lifecycle registers it as inventory under the business's ACTIVE subaccount (its own checks apply): its provider cost becomes exposure, never a charge to the studio
  v_res := public.tw4_rfl_register(x.studio_id, p_actor, 'campaign', x.provider_sid, x.twilio_account_sid, null, 'admin', x.source_operation_id, null);
  update public.studio_sms_prov_orphans set status = 'registered', rfl_resource_id = (v_res ->> 'resource_id')::uuid, registered_by = p_actor, registered_at = clock_timestamp() where id = x.id;
  select * into o from public.studio_sms_onboarding y where y.studio_id = x.studio_id and y.state <> 'cancelled';
  if o.id is not null then
    perform public._tw4_r1_audit(o, p_actor, 'prov_orphan', o.state, o.state, 'orphan=' || x.id || ';registered');
  end if;
  return jsonb_build_object('status', 'registered', 'resource_id', v_res ->> 'resource_id', 'replayed', false);
end $$;

create or replace function public.tw4_prov_orphan_close(p_orphan_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  x public.studio_sms_prov_orphans;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a written reason (10-500 characters) is required' using errcode = '22023';
  end if;
  select * into x from public.studio_sms_prov_orphans y where y.id = p_orphan_id for update;
  if x.id is null then
    raise exception 'unknown orphan' using errcode = '22023';
  end if;
  if x.status = 'closed' then
    return jsonb_build_object('status', 'closed', 'replayed', true);
  end if;
  -- it stays exposure until ONE of these database-checked facts holds (never an administrator's word):
  --   (a) the ledger now accounts for the SID (an operation of the business owns it: the "orphan" was the resource of a later attempt);
  --   (b) two complete provider listings of its own scope, recorded after it was found, at least 10 minutes apart, the latest within 60 minutes, neither listing it (it is gone);
  --   (c) the lifecycle shows the registered resource cancelled with its cancellation evidence.
  if not (
    exists (select 1 from public.studio_sms_prov_operations o where o.provider_sid = x.provider_sid and o.legal_entity_id = x.legal_entity_id and o.status = 'succeeded')
    or (select count(*) >= 2 and max(l.observed_at) >= clock_timestamp() - interval '60 minutes' and max(l.observed_at) - min(l.observed_at) >= interval '10 minutes'
          from (select l.observed_at from public.studio_sms_prov_listings l
                 where l.studio_id = x.studio_id and l.scope_sid = x.scope_sid and l.twilio_account_sid = x.twilio_account_sid and l.complete and l.observed_at > x.discovered_at
                   and (l.source = 'provider_read' or public._tw4sr_fake_allowed()) and x.provider_sid <> all (l.listed_sids)
                   and not exists (select 1 from public.studio_sms_prov_listings m where m.studio_id = l.studio_id and m.scope_sid = l.scope_sid and m.observed_at > x.discovered_at
                                    and m.observed_at >= l.observed_at and x.provider_sid = any (m.listed_sids))) l(observed_at)) l
    or (x.status = 'registered' and exists (select 1 from public.studio_sms_provider_resources pr where pr.id = x.rfl_resource_id and pr.provider_state = 'cancelled' and pr.cancel_evidence_digest is not null))
  ) then
    raise exception 'an orphan is closed only when the ledger accounts for it, provider listings show it gone, or the lifecycle shows it cancelled with evidence' using errcode = 'TW046';
  end if;
  update public.studio_sms_prov_orphans set status = 'closed', closed_by = p_actor, closed_at = clock_timestamp(), close_note = btrim(p_note) where id = x.id;
  return jsonb_build_object('status', 'closed', 'replayed', false);
end $$;

-- platform-admin read: evidence, dispositions and orphans for one studio's business
create or replace function public.tw4_prov_evidence(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return null;
  end if;
  return jsonb_build_object(
    'listings', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'operation_id', l.operation_id, 'verdict', l.verdict, 'complete', l.complete, 'listed', cardinality(l.listed_sids),
        'observed_at', l.observed_at, 'source', l.source) order by l.observed_at) from public.studio_sms_prov_listings l where l.studio_id = p_studio_id), '[]'::jsonb),
    'dispositions', coalesce((select jsonb_agg(jsonb_build_object('operation_id', d.operation_id, 'fee_kind', d.fee_kind, 'disposition', d.disposition, 'created_at', d.created_at) order by d.created_at)
        from public.studio_sms_prov_dispositions d where d.studio_id = p_studio_id), '[]'::jsonb),
    'orphans', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status, 'provider_sid', x.provider_sid, 'discovered_at', x.discovered_at, 'rfl_resource_id', x.rfl_resource_id) order by x.discovered_at)
        from public.studio_sms_prov_orphans x where x.legal_entity_id = v_entity), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- an evidence-only lease: an unknown fee outcome parks the onboarding in 'exception', which tw4_prov_claim refuses, so the proof would be unreachable exactly where it is
-- needed. This claim takes the SAME onboarding lease (mutual exclusion with every runner), for any non-cancelled onboarding, changes no state and permits only reads
-- and evidence records (it does not open the runner window and cannot start a provisioning step: tw4_prov_begin still needs the window and a provisionable state).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_evidence_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_lease_owner is null or char_length(p_lease_owner) not between 1 and 64 or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'invalid lease' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'there is no onboarding to read evidence for' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = o.id returning * into o;
  perform public._tw4_r1_audit(o, p_actor, 'runner_lease', o.state, o.state, 'claimed provider evidence read');
  return jsonb_build_object('onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4prov2_guard(), public._tw4prov2_is_pilot(uuid), public._tw4prov2_is_pilot_op(uuid, uuid), public._tw4prov2_proof(uuid), public._tw4prov2_orphan_block(),
  public._tw4prov2_refusal_disposition(), public._tw4prov2_refusal_guard(), public._tw4prov2_reservation_disposition() from public, anon, authenticated, service_role;
revoke all on function public.tw4_prov_listing_record(uuid, text, uuid, jsonb, text, text), public.tw4_prov_orphan_register(uuid, uuid), public.tw4_prov_orphan_close(uuid, uuid, text),
  public.tw4_prov_evidence(uuid, uuid), public.tw4_prov_evidence_claim(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.tw4_prov_listing_record(uuid, text, uuid, jsonb, text, text), public.tw4_prov_orphan_register(uuid, uuid), public.tw4_prov_orphan_close(uuid, uuid, text),
  public.tw4_prov_evidence(uuid, uuid), public.tw4_prov_evidence_claim(uuid, uuid, text, integer) to service_role;
-- the replaced functions keep R2a's grants (create or replace preserves them); assert it
do $$
begin
  if has_function_privilege('anon', 'public.tw4_prov_resolve(uuid,uuid,text,text,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_resolve(uuid,uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_prov_settle_admin(uuid,uuid,text,text,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_settle_admin(uuid,uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_prov_listing_record(uuid,text,uuid,jsonb,text,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_listing_record(uuid,text,uuid,jsonb,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_prov_listing_record(uuid,text,uuid,jsonb,text,text)', 'EXECUTE') then
    raise exception 'fee-resolution evidence postcondition failed: unexpected privileges';
  end if;
end $$;

commit;
