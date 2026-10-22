-- 20261214090000_twilio_r2b_p2_orphans_reconciliation.sql
-- TW-4F R2b-P2: orphan numbers, scheduled per-subaccount reconciliation, fail-closed inventory health and send-time safeguards (L3, L4). STACKED ON 20261213090000 (R2b-P1: identity evidence).
--   * studio_sms_num_orphans (+ append-only studio_sms_num_orphan_events): every number the provider shows in a business's subaccount that the ledger does not account for, and every
--     contradiction between the provider's listing and the ledger (ownership mismatch, a duplicate E.164, a ledger-owned number missing from a complete listing).
--   * tw4_num_inventory_observe: judges the listing with its numbers, records the findings (idempotent per subaccount + sid, serialised per subaccount), clears findings the provider
--     no longer shows. The unclean count of the stamp includes mismatches and duplicates, so the activation checklist and the P1 absence evidence stay correct unchanged.
--   * tw4_num_orphan_resolve: CONTROLLED adoption (an unknown number, only on a fresh provider identity read, never while a purchase is unresolved or when its E.164 matches a purchase;
--     DanceFlow-borne: no studio is charged, no authorization or reservation is touched, it never becomes a sender) and disposal (only on provider absence evidence).
--   * tw4_num_recon_targets / tw4_num_recon_claim: the scheduler-agnostic worklist and a service-role lease for a scheduled reconciliation run. Nothing registers a scheduler.
--   * _tw4num_health / tw4_num_inventory_status: fail-closed provider inventory health (healthy | stale | degraded | critical | unknown).
--   * _tw4sr_ready: a location does not send from a number the provider's listing contradicts.
--   * tw4_num_orphan_escalate: idempotent, age-based escalation into the recurring-fee-lifecycle alert outbox when installed (deferred, visibly, when not).
-- Nothing here calls Twilio, buys, charges, reserves, captures, adopts a chargeable resource into a studio's bill or replenishes pilot authorization.
-- Requires 20261208090000 (R2b) and 20261213090000 (R2b-P1). Rollback: rollback/20261214090000_twilio_r2b_p2_orphans_reconciliation_rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_num_identity_reads') is null or to_regprocedure('public._tw4num_absence_evidence(public.studio_sms_num_operations)') is null
     or to_regprocedure('public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)') is null or to_regprocedure('public._tw4sr_ready(uuid)') is null then
    raise exception 'R2b-P2 precondition failed: 20261208090000 (R2b) and 20261213090000 (R2b-P1) are required';
  end if;
  if to_regclass('public.studio_sms_num_orphans') is not null then
    raise exception 'R2b-P2 precondition failed: already applied';
  end if;
  if position('num_operations' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_ready(uuid)'::regprocedure)) = 0
     or position('studio_sms_num_inventory_acks' in (select p.prosrc from pg_proc p where p.oid = 'public._tw4num_known(uuid)'::regprocedure)) = 0 then
    raise exception 'R2b-P2 precondition failed: _tw4sr_ready / _tw4num_known differ from 20261208090000';
  end if;
  if position('listed_sids' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)'::regprocedure)) = 0 then
    raise exception 'R2b-P2 precondition failed: tw4_num_inventory_observe differs from 20261213090000';
  end if;
end $$;

do $$
begin
  -- the functions replaced below must still be EXACTLY the versions this slice was written against (a parallel slice must never be overwritten silently)
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_ready(uuid)'::regprocedure), E'\r', '')) <> '651e2162684185c5a721133206caf3ad'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4num_known(uuid)'::regprocedure), E'\r', '')) <> 'af641765f6a8358299c09a8b6927eca1'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_observe(uuid,text,text[],text,timestamptz)'::regprocedure), E'\r', '')) <> '97518c52d82fb05aa915ad5c81f96b44' then
    raise exception 'R2b-P2 precondition failed: a function it replaces differs from the expected version (fingerprint)';
  end if;
end $$;

alter table public.studio_sms_num_inventory_checks add column mismatch_count int not null default 0 check (mismatch_count >= 0);
alter table public.studio_sms_num_inventory_checks add column duplicate_count int not null default 0 check (duplicate_count >= 0);
comment on column public.studio_sms_num_inventory_checks.unknown_count is 'every number the ledger does not account for: unknown + ownership mismatches + duplicate E.164s (R2b-P2 keeps the activation checklist and the absence evidence correct unchanged)';

create table public.studio_sms_num_orphans (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  twilio_account_sid text not null check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  phone_number_sid text not null check (phone_number_sid ~ '^PN[0-9a-f]{32}$'),
  e164 text null check (e164 is null or e164 ~ '^\+[1-9][0-9]{6,14}$'),
  kind text not null check (kind in ('unknown', 'ownership_mismatch', 'duplicate_e164', 'ledger_missing')),
  status text not null default 'open' check (status in ('open', 'cleared', 'acknowledged', 'adopted', 'disposed')),
  ledger_operation_id uuid null references public.studio_sms_num_operations(id) on delete restrict,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  seen_count int not null default 1 check (seen_count >= 1),
  -- set when a later COMPLETE listing no longer shows an open finding (the only basis for disposal); cleared when it shows again
  absent_since timestamptz null,
  last_check_id uuid null,
  escalation_level int not null default 0 check (escalation_level between 0 and 3),
  reopen_count int not null default 0 check (reopen_count >= 0),
  escalation_failures int not null default 0 check (escalation_failures >= 0),
  escalation_attempted_at timestamptz null,
  cost_bearer text null check (cost_bearer = 'danceflow'),
  resolved_by uuid null,
  resolved_at timestamptz null,
  resolution_note text null check (resolution_note is null or char_length(resolution_note) between 10 and 300),
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_num_orphans_once unique (twilio_account_sid, phone_number_sid),
  constraint studio_sms_num_orphans_adopted check ((status = 'adopted') = (cost_bearer is not null) and (status not in ('adopted', 'disposed') or (resolved_by is not null and resolved_at is not null and resolution_note is not null))),
  constraint studio_sms_num_orphans_adopt_unknown_only check (status <> 'adopted' or kind = 'unknown')
);
create index studio_sms_num_orphans_open on public.studio_sms_num_orphans (legal_entity_id, first_seen_at) where status = 'open';

-- one row per business: when a reconciliation lease was last TAKEN for it. Targets rotate by it, so businesses that cannot be listed never starve the rest of the fleet.
create table public.studio_sms_num_recon_attempts (
  legal_entity_id uuid primary key references public.studio_sms_legal_entities(id) on delete restrict,
  last_attempt_at timestamptz not null default clock_timestamp(),
  attempts bigint not null default 1
);
revoke all on public.studio_sms_num_recon_attempts from public, anon, authenticated, service_role;
alter table public.studio_sms_num_recon_attempts enable row level security;

create index studio_sms_num_inventory_checks_latest on public.studio_sms_num_inventory_checks (legal_entity_id, twilio_account_sid, listed_at desc, created_at desc);

create table public.studio_sms_num_orphan_events (
  id uuid primary key default gen_random_uuid(),
  orphan_id uuid not null references public.studio_sms_num_orphans(id) on delete restrict,
  event text not null check (event in ('detected', 'reopened', 'cleared', 'became_known', 'absent', 'adopted', 'disposed', 'escalated', 'escalation_failed')),
  actor uuid null,
  detail text null check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default clock_timestamp()
);
create index studio_sms_num_orphan_events_orphan on public.studio_sms_num_orphan_events (orphan_id, created_at);

revoke all on public.studio_sms_num_orphans, public.studio_sms_num_orphan_events from public, anon, authenticated, service_role;
alter table public.studio_sms_num_orphans enable row level security;
alter table public.studio_sms_num_orphan_events enable row level security;

create or replace function public._tw4p2_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_table_name = 'studio_sms_num_orphan_events' then
    raise exception 'studio_sms_num_orphan_events is append-only' using errcode = '42501';
  end if;
  -- orphans: never deleted; identity columns never change
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_num_orphans rows are never deleted' using errcode = '42501';
  end if;
  if new.legal_entity_id is distinct from old.legal_entity_id or new.twilio_account_sid is distinct from old.twilio_account_sid or new.phone_number_sid is distinct from old.phone_number_sid
     or new.first_seen_at is distinct from old.first_seen_at or new.created_at is distinct from old.created_at then
    raise exception 'studio_sms_num_orphans: identity and first-seen fields are immutable' using errcode = '42501';
  end if;
  -- an adopted or disposed finding is final unless the provider shows a disposed number again (a reopening)
  if old.status = 'adopted' and new.status is distinct from 'adopted' then
    raise exception 'an adopted number is not un-adopted' using errcode = '42501';
  end if;
  if old.status = 'disposed' and new.status not in ('disposed', 'open') then
    raise exception 'a disposed finding only reopens' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_num_orphans_guard before update or delete on public.studio_sms_num_orphans for each row execute function public._tw4p2_guard();
create trigger studio_sms_num_orphan_events_guard before update or delete on public.studio_sms_num_orphan_events for each row execute function public._tw4p2_guard();
create trigger studio_sms_num_orphans_truncate before truncate on public.studio_sms_num_orphans for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_num_orphan_events_truncate before truncate on public.studio_sms_num_orphan_events for each statement execute function public._tw4c_truncate_guard();

create or replace function public._tw4p2_event(p_orphan uuid, p_event text, p_actor uuid, p_detail text)
returns void language sql security definer
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.studio_sms_num_orphan_events (orphan_id, event, actor, detail) values (p_orphan, p_event, p_actor, left(p_detail, 300));
$$;

create or replace function public._tw4num_known(p_entity uuid)
returns text[] language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(distinct k.sid), '{}'::text[]) from (
    select p.provider_sid sid from public.studio_sms_num_operations p where p.legal_entity_id = p_entity and p.provider_sid is not null and p.superseded_at is null and p.status <> 'abandoned'
    union select l.phone_number_sid from public.studio_sms_entity_studios es2 cross join lateral (select * from public.studio_sms_billed_senders b2 where b2.studio_id = es2.studio_id order by b2.seq desc limit 1) l
      where es2.legal_entity_id = p_entity and l.phone_number_sid is not null and l.status <> 'released'
    union select a.phone_number_sid from public.studio_sms_num_inventory_acks a where a.legal_entity_id = p_entity
    -- a number an administrator ADOPTED as a DanceFlow-borne resource (never the studio's, never a sender): accounted for, therefore not unknown
    union select z.phone_number_sid from public.studio_sms_num_orphans z where z.legal_entity_id = p_entity and z.status = 'adopted') k;
$$;

-- is the number a location sends from contradicted by the provider? (the ledger/provider disagreement is open, not merely an unrelated foreign number)
create or replace function public._tw4num_send_blocked(p_account text, p_sid text, p_e164 text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_num_orphans z where z.twilio_account_sid = p_account and z.status = 'open'
                   and z.kind in ('ownership_mismatch', 'duplicate_e164', 'ledger_missing') and (z.phone_number_sid = p_sid or z.e164 = p_e164));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- the provider listing, judged: the DATABASE decides what is unknown, mismatched, duplicated or missing
-- ---------------------------------------------------------------------------------------------------------------
drop function public.tw4_num_inventory_observe(uuid, text, text[], text, timestamptz);

create or replace function public.tw4_num_inventory_observe(p_onboarding_id uuid, p_lease_owner text, p_numbers jsonb, p_source text, p_listed_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_known text[];
  v_sids text[];
  v_unknown int := 0;
  v_mismatch int := 0;
  v_duplicate int := 0;
  v_missing int := 0;
  v_check uuid;
  n record;
  l public.studio_sms_num_operations;
  z public.studio_sms_num_orphans;
  v_kind text;
  v_ledger uuid;
  v_new boolean;
  v_apply boolean;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_numbers is null or jsonb_typeof(p_numbers) <> 'array' then
    raise exception 'an inventory of numbers is required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_numbers) > 1000 then
    raise exception 'a listing of more than 1000 numbers needs manual reconciliation (nothing is recorded as clean)' using errcode = 'TW051';
  end if;
  -- every listed number carries its sid AND its E.164 (a listing without them cannot be judged), and a sid appears once
  if exists (select 1 from jsonb_array_elements(p_numbers) e where jsonb_typeof(e.value) <> 'object' or (e.value ->> 'sid') is null or (e.value ->> 'sid') !~ '^PN[0-9a-f]{32}$'
                or (e.value ->> 'phone_number') is null or (e.value ->> 'phone_number') !~ '^\+[1-9][0-9]{6,14}$')
     or (select count(*) <> count(distinct e.value ->> 'sid') from jsonb_array_elements(p_numbers) e) then
    raise exception 'an inventory of numbers is required' using errcode = '22023';
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
  -- one observation per subaccount at a time: concurrent listings must not race the findings
  perform pg_advisory_xact_lock(hashtextextended('num_inventory:' || v_account, 0));
  v_known := public._tw4num_known(v_entity);
  select coalesce(array_agg(e.value ->> 'sid'), '{}'::text[]) into v_sids from jsonb_array_elements(p_numbers) e;
  -- out-of-order listings (a slower, older one committing after a newer one) must not move findings: they are recorded as checks, nothing more
  v_apply := p_listed_at >= coalesce((select max(x.listed_at) from public.studio_sms_num_inventory_checks x where x.twilio_account_sid = v_account and x.legal_entity_id = v_entity), '-infinity'::timestamptz);
  v_check := gen_random_uuid();   -- the check row is append-only: it is inserted once, at the end, with its final counts

  for n in select e.value ->> 'sid' sid, e.value ->> 'phone_number' e164 from jsonb_array_elements(p_numbers) e loop
    v_kind := null;
    v_ledger := null;
    if n.sid = any (v_known) then
      select * into l from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.provider_sid = n.sid and x.op_kind = 'number_purchase' and x.superseded_at is null and x.status <> 'abandoned'
       order by x.attempt desc limit 1;
      if l.id is not null and l.e164 <> n.e164 then
        v_kind := 'ownership_mismatch';
        v_ledger := l.id;
        v_mismatch := v_mismatch + 1;
      end if;
    else
      v_unknown := v_unknown + 1;
      v_kind := 'unknown';
      -- the provider shows a DIFFERENT sid for an E.164 that a purchase of this business is about
      if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and x.e164 = n.e164
                   and x.provider_sid is distinct from n.sid) then
        v_kind := 'duplicate_e164';
        v_unknown := v_unknown - 1;
        v_duplicate := v_duplicate + 1;
      end if;
    end if;
    if not v_apply then
      null;
    elsif v_kind is not null then
      insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, ledger_operation_id, first_seen_at, last_seen_at, last_check_id)
      values (v_entity, v_account, n.sid, n.e164, v_kind, v_ledger, p_listed_at, p_listed_at, v_check)
      on conflict (twilio_account_sid, phone_number_sid) do nothing returning * into z;
      v_new := z.id is not null;
      if v_new then
        perform public._tw4p2_event(z.id, 'detected', null, 'kind=' || v_kind);
      else
        select * into z from public.studio_sms_num_orphans x where x.twilio_account_sid = v_account and x.phone_number_sid = n.sid for update;
        if z.legal_entity_id is distinct from v_entity then
          raise exception 'the number is recorded for another business' using errcode = '22023';
        end if;
        if z.status in ('cleared', 'disposed', 'acknowledged') then
          update public.studio_sms_num_orphans set status = 'open', kind = v_kind, e164 = n.e164, ledger_operation_id = v_ledger, last_seen_at = p_listed_at, seen_count = z.seen_count + 1,
                 absent_since = null, last_check_id = v_check, escalation_level = 0, reopen_count = z.reopen_count + 1, resolved_by = null, resolved_at = null, resolution_note = null where id = z.id;
          perform public._tw4p2_event(z.id, 'reopened', null, 'kind=' || v_kind || ';was=' || z.status || ';note=' || coalesce(left(z.resolution_note, 150), ''));
        elsif z.status = 'open' then
          update public.studio_sms_num_orphans set kind = v_kind, e164 = n.e164, ledger_operation_id = v_ledger, last_seen_at = greatest(z.last_seen_at, p_listed_at), seen_count = z.seen_count + 1,
                 absent_since = null, last_check_id = v_check where id = z.id;
        end if;
      end if;
    else
      -- accounted for and consistent: a contradiction the provider no longer shows is cleared, an unknown finding that became known is closed
      for z in select * from public.studio_sms_num_orphans x where x.twilio_account_sid = v_account and x.phone_number_sid = n.sid and x.status = 'open' for update loop
        if z.kind = 'unknown' then
          update public.studio_sms_num_orphans set status = 'acknowledged', last_seen_at = greatest(z.last_seen_at, p_listed_at), last_check_id = v_check where id = z.id;
          perform public._tw4p2_event(z.id, 'became_known', null, 'accounted for by the ledger or an acknowledgement');
        else
          update public.studio_sms_num_orphans set status = 'cleared', last_seen_at = greatest(z.last_seen_at, p_listed_at), last_check_id = v_check where id = z.id;
          perform public._tw4p2_event(z.id, 'cleared', null, 'the provider no longer contradicts the ledger');
        end if;
      end loop;
    end if;
  end loop;

  -- ledger-owned numbers of this business that a COMPLETE listing did not show
  for n in select p.provider_sid sid, p.e164 e164, p.id opid from public.studio_sms_num_operations p
            where p.legal_entity_id = v_entity and p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null and p.twilio_account_sid = v_account
              and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = p.id and r.status = 'owned') and not (p.provider_sid = any (v_sids)) loop
    v_missing := v_missing + 1;
    continue when not v_apply;
    insert into public.studio_sms_num_orphans (legal_entity_id, twilio_account_sid, phone_number_sid, e164, kind, ledger_operation_id, first_seen_at, last_seen_at, last_check_id)
    values (v_entity, v_account, n.sid, n.e164, 'ledger_missing', n.opid, p_listed_at, p_listed_at, v_check)
    on conflict (twilio_account_sid, phone_number_sid) do nothing returning * into z;
    if z.id is not null then
      perform public._tw4p2_event(z.id, 'detected', null, 'kind=ledger_missing');
    else
      select * into z from public.studio_sms_num_orphans x where x.twilio_account_sid = v_account and x.phone_number_sid = n.sid for update;
      if z.status in ('cleared', 'disposed', 'acknowledged') then
        update public.studio_sms_num_orphans set status = 'open', kind = 'ledger_missing', e164 = n.e164, ledger_operation_id = n.opid, last_seen_at = p_listed_at, seen_count = z.seen_count + 1,
               absent_since = null, last_check_id = v_check, escalation_level = 0, reopen_count = z.reopen_count + 1, resolved_by = null, resolved_at = null, resolution_note = null where id = z.id;
        perform public._tw4p2_event(z.id, 'reopened', null, 'kind=ledger_missing;was=' || z.status || ';note=' || coalesce(left(z.resolution_note, 150), ''));
      elsif z.status = 'open' then
        update public.studio_sms_num_orphans set kind = 'ledger_missing', absent_since = null, last_seen_at = greatest(z.last_seen_at, p_listed_at), seen_count = z.seen_count + 1, last_check_id = v_check where id = z.id;
      end if;
    end if;
  end loop;

  -- a ledger_missing finding whose purchase was retired, superseded or is no longer a live one is closed (the contradiction is gone with the purchase)
  if v_apply then
    for z in select * from public.studio_sms_num_orphans x where x.twilio_account_sid = v_account and x.status = 'open' and x.kind = 'ledger_missing'
              and not exists (select 1 from public.studio_sms_num_operations o2 where o2.id = x.ledger_operation_id and o2.superseded_at is null and o2.status = 'succeeded') for update loop
      update public.studio_sms_num_orphans set status = 'cleared', last_check_id = v_check where id = z.id;
      perform public._tw4p2_event(z.id, 'cleared', null, 'the purchase is no longer live');
    end loop;
  end if;

  -- open findings the listing no longer shows: absence is recorded (never closes anything by itself)
  for z in select * from public.studio_sms_num_orphans x where x.twilio_account_sid = v_account and x.status = 'open' and x.kind <> 'ledger_missing' and not (x.phone_number_sid = any (v_sids))
            and x.absent_since is null and v_apply for update loop
    update public.studio_sms_num_orphans set absent_since = p_listed_at where id = z.id;
    perform public._tw4p2_event(z.id, 'absent', null, 'a complete listing no longer shows it');
  end loop;

  insert into public.studio_sms_num_inventory_checks (id, onboarding_id, lease_owner, legal_entity_id, listed_count, unknown_count, missing_count, mismatch_count, duplicate_count, twilio_account_sid, source, listed_at, listed_sids)
  values (v_check, o.id, p_lease_owner, v_entity, cardinality(v_sids), v_unknown + v_mismatch + v_duplicate, v_missing, v_mismatch, v_duplicate, v_account, p_source, p_listed_at, v_sids);
  return jsonb_build_object('listed', cardinality(v_sids), 'unknown', v_unknown + v_mismatch + v_duplicate, 'missing', v_missing, 'mismatch', v_mismatch, 'duplicate', v_duplicate);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- controlled adoption / disposal (platform administrator, written reason). Nothing here touches a studio's bill, an authorization, a reservation or a sender.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_orphan_resolve(p_orphan_id uuid, p_actor uuid, p_resolution text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  z public.studio_sms_num_orphans;
  i public.studio_sms_num_identity_reads;
  c public.studio_sms_num_inventory_checks;
  v_current text;
begin
  perform public._tw4c_admin(p_actor);
  if p_orphan_id is null or p_resolution is null or p_resolution not in ('adopt', 'dispose', 'close_former') or p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a resolution (adopt, dispose or close_former) and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  select * into z from public.studio_sms_num_orphans x where x.id = p_orphan_id;
  if z.id is null then
    raise exception 'unknown finding' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('num_inventory:' || z.twilio_account_sid, 0));
  select * into z from public.studio_sms_num_orphans x where x.id = p_orphan_id for update;
  if z.status <> 'open' then
    raise exception 'this finding is not open' using errcode = 'TW034';
  end if;
  v_current := public._tw4num_account((select es.studio_id from public.studio_sms_entity_studios es where es.legal_entity_id = z.legal_entity_id order by es.studio_id limit 1));
  if p_resolution = 'close_former' then
    -- a finding in a former subaccount is closed by a person only when that subaccount is CLOSED at the provider-account level (no further billing can accrue); nothing is read from it
    if v_current is not distinct from z.twilio_account_sid or not exists (select 1 from public.studio_sms_twilio_accounts a where a.legal_entity_id = z.legal_entity_id and a.twilio_account_sid = z.twilio_account_sid and a.status = 'closed') then
      raise exception 'only a finding in a CLOSED former subaccount is closed this way' using errcode = 'TW049';
    end if;
    update public.studio_sms_num_orphans set status = 'disposed', cost_bearer = null, resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note) where id = z.id;
    perform public._tw4p2_event(z.id, 'disposed', p_actor, 'former subaccount closed; note=' || left(btrim(p_note), 150));
    return jsonb_build_object('status', 'disposed');
  end if;
  if v_current is distinct from z.twilio_account_sid then
    raise exception 'the business''s active subaccount is not the one this finding was made in' using errcode = 'TW049';
  end if;
  if p_resolution = 'adopt' then
    -- only a foreign-looking number, only on a fresh provider identity read of this very number, never while this business has a purchase that was lost or is unresolved
    -- (it could BE that purchase: that is resolved through the purchase, which carries the reservation and the ceiling), and never when its E.164 belongs to a purchase
    if z.kind <> 'unknown' then
      raise exception 'only an unknown number is adopted: a contradiction is investigated, not adopted' using errcode = 'TW034';
    end if;
    select * into i from public.studio_sms_num_identity_reads x where x.twilio_account_sid = z.twilio_account_sid and x.phone_number_sid = z.phone_number_sid and x.legal_entity_id = z.legal_entity_id
     order by x.observed_at desc, x.id limit 1;
    if i.id is null or i.observed_at < clock_timestamp() - interval '30 minutes' or i.e164 is distinct from z.e164 or (i.source <> 'provider_read' and not public._tw4sr_fake_allowed())
       or i.observed_at < coalesce(z.absent_since, '-infinity'::timestamptz) then
      raise exception 'a provider identity read of this number (within 30 minutes) that matches the finding is required' using errcode = 'TW048';
    end if;
    if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = z.legal_entity_id and x.op_kind = 'number_purchase' and x.status in ('abandoned', 'in_flight', 'unknown_outcome'))
       or exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = z.legal_entity_id and x.op_kind = 'number_purchase' and (x.e164 = z.e164 or x.provider_sid = z.phone_number_sid)) then
      raise exception 'this business has a purchase that was lost or is unresolved, or the number belongs to one of its purchases: resolve the purchase, do not adopt the number' using errcode = 'TW034';
    end if;
    update public.studio_sms_num_orphans set status = 'adopted', cost_bearer = 'danceflow', resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note) where id = z.id;
    perform public._tw4p2_event(z.id, 'adopted', p_actor, 'danceflow-borne; no studio charge, no authorization or reservation touched; note=' || left(btrim(p_note), 150));
    return jsonb_build_object('status', 'adopted', 'cost_bearer', 'danceflow');
  end if;
  -- dispose: the provider's own listing no longer shows it (taken after it was last seen, fresh now), and no provider read of it since
  if z.absent_since is null then
    raise exception 'a complete provider listing that no longer shows this number is required first' using errcode = 'TW050';
  end if;
  select * into c from public.studio_sms_num_inventory_checks x where x.legal_entity_id = z.legal_entity_id and x.twilio_account_sid = z.twilio_account_sid order by x.listed_at desc, x.created_at desc, x.id limit 1;
  if c.id is null or (c.source <> 'provider_read' and not public._tw4sr_fake_allowed()) or c.listed_at < z.absent_since or c.listed_at < z.last_seen_at or c.listed_at < clock_timestamp() - interval '30 minutes' then
    raise exception 'the latest provider listing does not show it as absent (stale, untrusted or older than the finding)' using errcode = 'TW050';
  end if;
  if z.phone_number_sid = any (c.listed_sids) then
    raise exception 'the latest provider listing still shows this number' using errcode = 'TW050';
  end if;
  if exists (select 1 from public.studio_sms_num_identity_reads x where x.twilio_account_sid = z.twilio_account_sid and x.phone_number_sid = z.phone_number_sid and x.observed_at >= z.absent_since) then
    raise exception 'the provider answered a read of this number after it was listed absent' using errcode = 'TW050';
  end if;
  update public.studio_sms_num_orphans set status = 'disposed', cost_bearer = null, resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note) where id = z.id;
  perform public._tw4p2_event(z.id, 'disposed', p_actor, 'released by DanceFlow at the provider console; provider listing confirms absence; note=' || left(btrim(p_note), 150));
  return jsonb_build_object('status', 'disposed');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- fail-closed inventory health of a business's subaccount
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4num_health(p_studio_id uuid, p_detail boolean)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text := public._tw4num_account(p_studio_id);
  c public.studio_sms_num_inventory_checks;
  v_clean timestamptz;
  v_reasons text[] := '{}';
  v_status text;
  v_open int;
  v_contra int;
  v_borne int;
  v_former int;
begin
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null or v_account is null then
    return jsonb_build_object('status', 'unknown', 'reasons', jsonb_build_array('no_active_subaccount'), 'open_findings', (select count(*) from public.studio_sms_num_orphans z where z.legal_entity_id = v_entity and z.status = 'open'));
  end if;
  select * into c from public.studio_sms_num_inventory_checks x where x.legal_entity_id = v_entity and x.twilio_account_sid = v_account order by x.listed_at desc, x.created_at desc, x.id limit 1;
  if p_detail then
    select max(x.listed_at) into v_clean from public.studio_sms_num_inventory_checks x where x.legal_entity_id = v_entity and x.twilio_account_sid = v_account and x.unknown_count = 0 and x.missing_count = 0
     and (x.source = 'provider_read' or public._tw4sr_fake_allowed());
  end if;
  select count(*) filter (where z.status = 'open'), count(*) filter (where z.status = 'open' and z.kind in ('ownership_mismatch', 'duplicate_e164', 'ledger_missing')), count(*) filter (where z.status = 'adopted')
    into v_open, v_contra, v_borne from public.studio_sms_num_orphans z where z.legal_entity_id = v_entity and z.twilio_account_sid = v_account;
  -- findings made in a FORMER subaccount stay visible until a person resolves them
  select count(*) into v_former from public.studio_sms_num_orphans z where z.legal_entity_id = v_entity and z.twilio_account_sid <> v_account and z.status = 'open';
  if c.id is null then
    v_reasons := array_append(v_reasons, 'no_inventory_check');
  elsif c.source <> 'provider_read' and not public._tw4sr_fake_allowed() then
    v_reasons := array_append(v_reasons, 'untrusted_evidence_source');
  end if;
  v_status := case
    when cardinality(v_reasons) > 0 then 'unknown'
    when v_contra > 0 then 'critical'
    when c.listed_at < clock_timestamp() - interval '24 hours' then 'stale'
    when v_former > 0 then 'degraded'
    when c.unknown_count > 0 or c.missing_count > 0 or v_open > 0 then 'degraded'
    else 'healthy' end;
  if v_contra > 0 then v_reasons := array_append(v_reasons, 'provider_contradicts_ledger'); end if;
  if c.id is not null and (c.unknown_count > 0 or c.missing_count > 0) then v_reasons := array_append(v_reasons, 'latest_listing_unclean'); end if;
  if v_open > 0 and v_contra = 0 then v_reasons := array_append(v_reasons, 'open_unaccounted_numbers'); end if;
  if v_former > 0 then v_reasons := array_append(v_reasons, 'findings_in_former_subaccount'); end if;
  if v_status = 'stale' then v_reasons := array_append(v_reasons, 'listing_is_stale'); end if;
  return jsonb_build_object('status', v_status, 'reasons', to_jsonb(v_reasons), 'last_check_at', c.listed_at, 'last_clean_at', v_clean, 'open_findings', v_open, 'contradictions', v_contra, 'danceflow_borne', v_borne);
end $$;

create or replace function public._tw4num_health(p_studio_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4num_health(p_studio_id, true); $$;

create or replace function public.tw4_num_inventory_status(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
begin
  perform public._tw4c_admin(p_actor);
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  return jsonb_build_object('health', public._tw4num_health(p_studio_id), 'findings', coalesce((
    select jsonb_agg(jsonb_build_object('id', z.id, 'kind', z.kind, 'status', z.status, 'phone_number_sid', z.phone_number_sid, 'e164', z.e164, 'twilio_account_sid', z.twilio_account_sid, 'first_seen_at', z.first_seen_at, 'last_seen_at', z.last_seen_at,
             'seen_count', z.seen_count, 'absent_since', z.absent_since, 'escalation_level', z.escalation_level, 'cost_bearer', z.cost_bearer) order by z.first_seen_at, z.id)
      from public.studio_sms_num_orphans z where z.legal_entity_id = v_entity and z.status in ('open', 'adopted')), '[]'::jsonb));
end $$;

-- cost exposure visibility for platform administrators: how many numbers DanceFlow may be paying for with no studio paying (open unknown + adopted), per business
create or replace function public.tw4_num_orphan_exposure(p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(x.j order by x.legal_entity_id) from (
    select z.legal_entity_id, jsonb_build_object('legal_entity_id', z.legal_entity_id, 'open_unknown', count(*) filter (where z.status = 'open' and z.kind = 'unknown'),
           'open_contradictions', count(*) filter (where z.status = 'open' and z.kind <> 'unknown'), 'danceflow_borne', count(*) filter (where z.status = 'adopted'),
           'oldest_open_age_seconds', floor(extract(epoch from (clock_timestamp() - min(z.first_seen_at) filter (where z.status = 'open'))))::bigint) j
      from public.studio_sms_num_orphans z where z.status in ('open', 'adopted') group by z.legal_entity_id) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- scheduled reconciliation: the worklist and a service-role lease (no human actor). No scheduler is registered here.
-- ---------------------------------------------------------------------------------------------------------------
-- does this business have, or may it have, provider resources in its subaccount? (a purchase, a Messaging Service / campaign, a sender row, or an open finding) -- not only recorded number purchases
create or replace function public._tw4num_has_resources(p_entity uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_num_operations n where n.legal_entity_id = p_entity)
      or exists (select 1 from public.studio_sms_prov_operations n where n.legal_entity_id = p_entity)
      or exists (select 1 from public.studio_sms_billed_senders n where n.legal_entity_id = p_entity)
      or exists (select 1 from public.studio_sms_num_orphans z where z.legal_entity_id = p_entity and z.status = 'open');
$$;

-- businesses with an active subaccount and provider resources but NO onboarding a reconciliation lease can be taken on: they need MANUAL reconciliation and are listed, never silently skipped
create or replace function public.tw4_num_recon_manual(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object('legal_entity_id', a.legal_entity_id, 'twilio_account_sid', a.twilio_account_sid,
      'reason', case when exists (select 1 from public.studio_sms_entity_studios es2 join public.studio_sms_onboarding o2 on o2.studio_id = es2.studio_id where es2.legal_entity_id = a.legal_entity_id and o2.state not in ('cancelled', 'blocked')) then 'access_disabled' else 'no_leasable_onboarding' end) order by a.legal_entity_id)
    from public.studio_sms_twilio_accounts a
   where a.status = 'active' and public._tw4num_has_resources(a.legal_entity_id)
     and not exists (select 1 from public.studio_sms_entity_studios es join public.studio_sms_onboarding o on o.studio_id = es.studio_id where es.legal_entity_id = a.legal_entity_id and o.state not in ('cancelled', 'blocked') and public._sms_onb_access_enabled(es.studio_id))), '[]'::jsonb);
end $$;

create or replace function public.tw4_num_recon_targets(p_limit integer, p_max_age_seconds integer)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 or p_max_age_seconds is null or p_max_age_seconds not between 60 and 604800 then
    raise exception 'invalid worklist request' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(t.j order by t.sort_att nulls first, t.sort_at nulls first, t.legal_entity_id) from (
    select e.legal_entity_id, c.listed_at sort_at, (select ra.last_attempt_at from public.studio_sms_num_recon_attempts ra where ra.legal_entity_id = e.legal_entity_id) sort_att, jsonb_build_object('studio_id', e.studio_id, 'legal_entity_id', e.legal_entity_id, 'twilio_account_sid', e.account,
             'last_checked_at', c.listed_at, 'reason', case when c.id is null then 'never_checked' when c.unknown_count > 0 or c.missing_count > 0 then 'latest_unclean'
                                                          when exists (select 1 from public.studio_sms_num_orphans z where z.legal_entity_id = e.legal_entity_id and z.status = 'open') then 'open_findings'
                                                          else 'due' end) j
      from (select distinct on (es.legal_entity_id) es.legal_entity_id, es.studio_id, a.twilio_account_sid account
              from public.studio_sms_entity_studios es
              join public.studio_sms_twilio_accounts a on a.legal_entity_id = es.legal_entity_id and a.status = 'active'
              join public.studio_sms_onboarding o on o.studio_id = es.studio_id and o.state not in ('cancelled', 'blocked')
             where public._sms_onb_access_enabled(es.studio_id)
               and public._tw4num_has_resources(es.legal_entity_id)
             order by es.legal_entity_id, es.studio_id) e
      left join lateral (select * from public.studio_sms_num_inventory_checks x where x.legal_entity_id = e.legal_entity_id and x.twilio_account_sid = e.account order by x.listed_at desc, x.created_at desc, x.id limit 1) c on true
     where c.id is null or c.listed_at < clock_timestamp() - make_interval(secs => p_max_age_seconds) or c.unknown_count > 0 or c.missing_count > 0
        or exists (select 1 from public.studio_sms_num_orphans z where z.legal_entity_id = e.legal_entity_id and z.status = 'open')
     order by (select ra.last_attempt_at from public.studio_sms_num_recon_attempts ra where ra.legal_entity_id = e.legal_entity_id) nulls first, c.listed_at nulls first, e.legal_entity_id limit p_limit) t), '[]'::jsonb);
end $$;

create or replace function public.tw4_num_recon_claim(p_studio_id uuid, p_lease_owner text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if p_lease_owner is null or p_lease_owner !~ '^recon:[A-Za-z0-9_-]{1,50}$' or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid lease' using errcode = '22023';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    raise exception 'not available for this studio' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_onboarding:' || p_studio_id::text, 0));
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null or o.state in ('cancelled', 'blocked') then
    raise exception 'there is no onboarding to reconcile' using errcode = 'TW030';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() and o.lease_owner <> p_lease_owner then
    raise exception 'another run holds the lease' using errcode = '55P03';
  end if;
  update public.studio_sms_onboarding set lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = o.id returning * into o;
  insert into public.studio_sms_num_recon_attempts (legal_entity_id) select es.legal_entity_id from public.studio_sms_entity_studios es where es.studio_id = p_studio_id
    on conflict (legal_entity_id) do update set last_attempt_at = clock_timestamp(), attempts = studio_sms_num_recon_attempts.attempts + 1;
  perform public._tw4_r1_audit(o, null, 'runner_lease', o.state, o.state, 'claimed scheduled inventory reconciliation');
  return jsonb_build_object('onboarding_id', o.id, 'studio_id', o.studio_id, 'state', o.state, 'submission_seq', o.submission_seq);
end $$;

-- a reconciliation lease (owner 'recon:...') is for listings only: the database refuses any operation row it would start
create or replace function public._tw4p2_no_recon_ops()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.studio_sms_onboarding o where o.id = new.onboarding_id and o.lease_owner like 'recon:%' and o.lease_expires_at > now()) then
    raise exception 'a reconciliation lease cannot start a provider operation' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_num_operations_no_recon before insert on public.studio_sms_num_operations for each row execute function public._tw4p2_no_recon_ops();
create trigger studio_sms_prov_operations_no_recon before insert on public.studio_sms_prov_operations for each row execute function public._tw4p2_no_recon_ops();

-- ---------------------------------------------------------------------------------------------------------------
-- idempotent, age-based escalation into the recurring-fee-lifecycle alert outbox (when installed). Without it nothing is advanced and the deferral is reported.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_num_orphan_escalate(p_limit integer)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  z public.studio_sms_num_orphans;
  v_target int;
  v_raised int := 0;
  v_seen int := 0;
  v_failed int := 0;
  v_pending int;
  v_outbox boolean := to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is not null;
  v_new boolean;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  select count(*) into v_pending from public.studio_sms_num_orphans x
   where x.status = 'open' and x.escalation_level < case when x.kind = 'unknown' then case when x.first_seen_at < clock_timestamp() - interval '72 hours' then 3 when x.first_seen_at < clock_timestamp() - interval '24 hours' then 2 else 1 end
                                                         else case when x.first_seen_at < clock_timestamp() - interval '72 hours' then 3 else 2 end end;
  if not v_outbox then
    return jsonb_build_object('outbox', false, 'raised', 0, 'deferred', v_pending);
  end if;
  for z in select x.* from public.studio_sms_num_orphans x where x.status = 'open'
            and x.escalation_level < case when x.kind = 'unknown' then case when x.first_seen_at < clock_timestamp() - interval '72 hours' then 3 when x.first_seen_at < clock_timestamp() - interval '24 hours' then 2 else 1 end
                                          else case when x.first_seen_at < clock_timestamp() - interval '72 hours' then 3 else 2 end end
            order by x.escalation_attempted_at nulls first, x.first_seen_at, x.id limit p_limit for update skip locked loop
    v_seen := v_seen + 1;
    update public.studio_sms_num_orphans set escalation_attempted_at = clock_timestamp() where id = z.id;
    v_target := case when z.kind = 'unknown' then case when z.first_seen_at < clock_timestamp() - interval '72 hours' then 3 when z.first_seen_at < clock_timestamp() - interval '24 hours' then 2 else 1 end
                      else case when z.first_seen_at < clock_timestamp() - interval '72 hours' then 3 else 2 end end;
    begin
      execute format('select public._tw4rfl_alert(%L::uuid, null::uuid, null::uuid, %L, %L, %L, %L, %L)', z.legal_entity_id, 'inventory_gap', 'numorphan:' || z.id || ':' || z.reopen_count || ':L' || v_target, 'admin',
                     case when v_target >= 2 then 'critical' else 'warning' end,
                     'Unaccounted number in a business subaccount (' || z.kind || ', ...' || right(z.phone_number_sid, 6) || '), escalation level ' || v_target) into v_new;
      update public.studio_sms_num_orphans set escalation_level = v_target where id = z.id;
      perform public._tw4p2_event(z.id, 'escalated', null, 'level=' || v_target);
      if v_new then v_raised := v_raised + 1; end if;
    exception when others then
      v_failed := v_failed + 1;   -- the level is not advanced: the next run retries; the failure is recorded (SQLSTATE only, never message text)
      update public.studio_sms_num_orphans set escalation_failures = escalation_failures + 1 where id = z.id;
      perform public._tw4p2_event(z.id, 'escalation_failed', null, 'sqlstate=' || sqlstate || ';level=' || v_target);
    end;
  end loop;
  return jsonb_build_object('outbox', true, 'raised', v_raised, 'considered', v_seen, 'failed', v_failed);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the send gate, with the provider-contradiction check
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4sr_ready(p_studio_id uuid)
returns public.studio_sms_billed_senders language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  none public.studio_sms_billed_senders;
  s public.studio_sms_billed_senders;
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
begin
  if not exists (select 1 from public.studio_sms_num_operations o where o.studio_id = p_studio_id) and not exists (select 1 from public.studio_sms_prov_operations o where o.studio_id = p_studio_id) then
    return public._tw4sr_ready_core(p_studio_id);   -- neither R2a nor R2b touched this location: PR #249 behaviour exactly
  end if;
  -- an R2b location sends only while ACTIVE ...
  if not exists (select 1 from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state = 'active') then
    return none;
  end if;
  s := public._tw4sr_ready_core(p_studio_id);
  if s.id is null then
    return none;
  end if;
  -- ... and only from the sender its own LEDGER bought and attached (a free-form PR #249 sender row, another service or another number of the business does not send)
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'owned');
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'attached');
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  if v_p.id is null or v_a.id is null or v_ms.id is null or v_qe.id is null or v_a.provider_sid is distinct from v_p.provider_sid
     or s.phone_number_sid is distinct from v_p.provider_sid or s.sender_e164 is distinct from v_p.e164 or s.messaging_service_sid is distinct from v_ms.provider_sid
     or s.campaign_sid is distinct from v_qe.provider_sid or s.account_sid is distinct from v_p.twilio_account_sid then
    return none;
  end if;
  -- ordinary billable sending is HELD while the business's provider-inventory evidence is stale, missing, untrusted or contradictory (inbound STOP/START/HELP handling does not use this gate);
  -- and the number this location sends from must not be contradicted by the provider: an open ownership mismatch, duplicate E.164 or missing-from-listing finding for THIS sid or E.164 stops it
  if public._tw4num_send_blocked(s.account_sid, s.phone_number_sid, s.sender_e164) or (public._tw4num_health(p_studio_id, false) ->> 'status') in ('unknown', 'stale', 'critical') then
    return none;   -- a HOLD, not a revocation: the sender row, the spending authorization and every reservation are untouched, and fresh authoritative evidence lifts it
  end if;
  return s;
end $$;

revoke all on function public._tw4p2_no_recon_ops(), public._tw4p2_guard(), public._tw4p2_event(uuid, text, uuid, text), public._tw4num_send_blocked(text, text, text), public._tw4num_health(uuid), public._tw4num_health(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.tw4_num_inventory_observe(uuid, text, jsonb, text, timestamptz), public.tw4_num_orphan_resolve(uuid, uuid, text, text), public.tw4_num_inventory_status(uuid, uuid),
  public.tw4_num_orphan_exposure(uuid), public.tw4_num_recon_targets(integer, integer), public.tw4_num_recon_claim(uuid, text, integer), public.tw4_num_orphan_escalate(integer) from public, anon, authenticated;
grant execute on function public.tw4_num_inventory_observe(uuid, text, jsonb, text, timestamptz), public.tw4_num_orphan_resolve(uuid, uuid, text, text), public.tw4_num_inventory_status(uuid, uuid),
  public.tw4_num_orphan_exposure(uuid), public.tw4_num_recon_targets(integer, integer), public.tw4_num_recon_claim(uuid, text, integer), public.tw4_num_orphan_escalate(integer) to service_role;

revoke all on function public._tw4num_has_resources(uuid), public.tw4_num_recon_manual(uuid) from public, anon, authenticated;
grant execute on function public.tw4_num_recon_manual(uuid) to service_role;
revoke all on function public._tw4num_has_resources(uuid) from service_role;

commit;
