-- 20261221090000_twilio_admin_recovery_tooling.sql
-- TW-4F F4: administrative evidence, orphan exposure and operational recovery tooling (dark; Git-only until separately authorized).
--   1. A provider-VERIFIED campaign is registered in the recurring-fee inventory IN THE SAME TRANSACTION as its observation (tw4_prov_observe), from the R2a ledger's own
--      rows, mirroring 20261217 for numbers: no charge, no cover beyond the pilot's own reservation of that operation in its own month (D5), no change to tw4_rfl_register. A
--      registration that fails is audited, alerted (inventory_gap, critical, administrators only) and retryable; the observation is never discarded.
--   2. tw4_admin_registration_retry: the audited administrator retry (number or campaign). It records the platform-admin actor, the written reason and the outcome,
--      including a business refusal. tw4_num_registration_retry keeps its contract (raises on refusal) and now records the actor too.
--      tw4_admin_registration_gaps: provider-confirmed numbers AND campaigns the lifecycle inventory does not hold, with the last failure and the last retry.
--   3. tw4_admin_deferred_retirements / tw4_admin_deferred_retire: number cancellations the lifecycle confirmed while the number runner was busy (20261217 deferred the
--      ledger retirement with a warning only). The retry takes the number runner's lock order (onboarding row, location link, business row), needs the lifecycle's
--      cancelled state as its evidence and a RELEASED sender row first, and is idempotent. A written reason alone never retires anything.
--   4. tw4_admin_exposure: ONE read-only administrator view of DanceFlow-borne provider exposure: campaign orphans, number orphans (open and adopted) and unregistered
--      ledger resources, one row per provider resource (deduplicated by SID). A cost is shown only when the lifecycle recorded one; otherwise it is null (unknown), never
--      zero. Registered resources' amounts are already in tw4_rfl_exposure_report and are flagged as such: the two must never be added (20261216).
--   5. tw4_admin_prov_proof: for each unresolved fee-bearing campaign operation of a studio, whether the recorded provider listings prove absence (_tw4prov2_proof) and
--      whether the pilot rule forbids release anyway. Read only: releasing a held fee stays behind owner decision U-1 in the application.
-- Nothing here calls Twilio, charges, reserves, captures, releases a reservation, touches a pilot ceiling, an authorization, a cover row or a sender. Owners receive nothing
-- new: every alert raised here is audience 'admin'. Platform administrators only (every entry point re-checks the actor).
-- Requires 20261207 .. 20261217 (20261215 optional). Rollback: rollback/20261221090000_twilio_admin_recovery_tooling_rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4num_register_owned(uuid)') is null or to_regprocedure('public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean)') is null
     or to_regprocedure('public._tw4prov2_proof(uuid)') is null or to_regclass('public.studio_sms_num_orphans') is null
     or to_regprocedure('public.tw4_prov_orphan_exposure(uuid,uuid,boolean)') is null then
    raise exception 'recovery-tooling precondition failed: 20261207 .. 20261217 are not all applied';
  end if;
  if to_regprocedure('public._tw4prov_register_verified(uuid)') is not null then
    raise exception 'recovery-tooling precondition failed: already applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'::regprocedure), chr(13), '')), 8) <> '08dcccbe' then
    raise exception 'recovery-tooling precondition failed: public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text) differs from its main definition';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_registration_retry(uuid,uuid)'::regprocedure), chr(13), '')), 8) <> 'b7f281b3' then
    raise exception 'recovery-tooling precondition failed: public.tw4_num_registration_retry(uuid,uuid) differs from its main definition';
  end if;
end $$;

-- audit vocabulary: the live list plus the new action (extended, not replaced)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_actions is null or cardinality(v_actions) < 10 or not ('num_retired' = any (v_actions)) or not ('rfl_registered' = any (v_actions)) then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_actions := (select array_agg(distinct x order by x) from unnest(v_actions || array['rfl_registration_retry']) x);
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- campaign registration from the R2a ledger
-- ---------------------------------------------------------------------------------------------------------------
-- the pilot reservation that paid a campaign's first month ('prov:<operation>:<monthly kind>'), or null. R2b/RFL decision D5 (TW-4F_R2b_RFL_Integration.md §5), the
-- rule numbers already follow: a business with standing authorizations is covered by them; a released reservation pays nothing; and the attempt's own pilot
-- reservation is bound as the registration period's cover ONLY while it is reserved/captured AND the registration month equals the month the reservation was MADE
-- (its created_at). A campaign approved in a later month than it was reserved registers with NO cover: that month needs its own written approval
-- (tw4_rfl_pilot_cover), which #280's activation funding check expects (it accepts an initial cover only in the reservation's own month).
create or replace function public._tw4prov_ledger_reservation(p_op uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select cr.id from public.studio_sms_prov_operations o
          join public.studio_sms_credit_reservations cr on cr.reservation_key = 'prov:' || o.id::text || ':' || (public.tw4_location_fee_kinds(o.studio_id) ->> 'campaign_monthly_kind')
        where o.id = p_op and cr.funding = 'pilot' and cr.status in ('reserved', 'captured')
          and public._tw4ml_month_key(o.legal_entity_id, cr.created_at) = public._tw4ml_month_key(o.legal_entity_id, clock_timestamp()); $$;

-- registers the location's provider-verified campaign from the LEDGER'S rows (never from caller-typed identifiers), as the system, under the caller's locks
create or replace function public._tw4prov_register_verified(p_op uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  p public.studio_sms_prov_operations;
  r public.studio_sms_provider_resources;
  v_res uuid;
begin
  select * into p from public.studio_sms_prov_operations x where x.id = p_op and x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null and x.provider_sid is not null
     and exists (select 1 from public.studio_sms_prov_resources pr where pr.operation_id = x.id and pr.provider_sid = x.provider_sid and pr.status = 'verified'
                  and (pr.source = 'provider_read' or public._tw4sr_fake_allowed()));
  if p.id is null then
    raise exception 'there is no live, provider-verified campaign to register' using errcode = 'TW032';
  end if;
  v_res := public._tw4prov_ledger_reservation(p.id);
  select * into r from public.studio_sms_provider_resources x where x.provider_sid = p.provider_sid;
  -- the lifecycle shows it CANCELLED (an administrator-typed digest, not provider proof) while the provider still reports it VERIFIED: never a silent replay. Refused,
  -- so the observation alerts the administrators and the campaign stays listed as a gap and as DanceFlow-borne exposure.
  if r.id is not null and r.provider_state = 'cancelled' then
    raise exception 'the provider reports this campaign verified but the recurring-fee lifecycle shows it cancelled' using errcode = 'TW040';
  end if;
  -- an already registered resource with the same facts (for example an orphan of this attempt that an administrator registered) is a replay: registration only.
  -- No cover is attached to an existing resource here; an uncovered period needs its own written approval (tw4_rfl_pilot_cover).
  return public._tw4rfl_register_core(p.studio_id, p.started_by, 'campaign', p.provider_sid, p.twilio_account_sid, null, 'r2a', p.id, v_res, true);
end $$;

-- the live ledger operation a retry for (studio, kind) would register, or null
create or replace function public._tw4f4_retry_target(p_studio_id uuid, p_kind text)
returns uuid language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_kind
    when 'number' then (select x.id from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null)
    when 'campaign' then (select x.id from public.studio_sms_prov_operations x where x.studio_id = p_studio_id and x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null)
  end;
$$;

-- one retry under the location link, business row and credit account (the order 20261217's tw4_num_registration_retry took). Raises on refusal.
create or replace function public._tw4f4_retry(p_studio_id uuid, p_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_op uuid;
  v_res jsonb;
begin
  perform public._tw4rfl_lock(public._tw4sr_lock(p_studio_id));
  v_op := public._tw4f4_retry_target(p_studio_id, p_kind);
  if v_op is null then
    raise exception 'there is no live % to register', case p_kind when 'number' then 'number purchase' else 'campaign' end using errcode = 'TW032';
  end if;
  -- a campaign is registered from its latest provider read: never while a run (which may be recording a newer read) holds the location's lease
  if p_kind = 'campaign' and exists (select 1 from public.studio_sms_onboarding o where o.studio_id = p_studio_id and o.state <> 'cancelled' and o.lease_owner is not null and o.lease_expires_at > now()) then
    raise exception 'a run holds the lease; retry after it finishes' using errcode = '55P03';
  end if;
  v_res := case p_kind when 'number' then public._tw4num_register_owned(v_op) else public._tw4prov_register_verified(v_op) end;
  return v_res || jsonb_build_object('operation_id', v_op);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- audited administrator retry
-- ---------------------------------------------------------------------------------------------------------------
-- The application's retry. Records WHO retried (platform_admin actor), WHY (written reason) and the OUTCOME, including a business refusal, which is returned rather
-- than raised so its audit row is kept. Lock and serialization failures, missing privileges and bugs propagate (nothing is recorded for them).
create or replace function public.tw4_admin_registration_retry(p_studio_id uuid, p_actor uuid, p_kind text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_res jsonb;
  v_code text;
  v_outcome text;
begin
  perform public._tw4c_admin(p_actor);
  if p_studio_id is null or p_kind is null or p_kind not in ('number', 'campaign') or p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a location, a kind (number or campaign) and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'unknown location' using errcode = '22023';
  end if;
  begin
    v_res := public._tw4f4_retry(p_studio_id, p_kind);
  exception when others then
    if SQLSTATE not in ('TW010', 'TW032', 'TW040', '22023', '23505', '23514') then
      raise;
    end if;
    v_code := SQLSTATE;
  end;
  if v_code is not null then
    perform public._tw4rfl_audit(p_studio_id, p_actor, 'rfl_registration_retry',
      'kind=' || p_kind || ';op=' || coalesce(public._tw4f4_retry_target(p_studio_id, p_kind)::text, 'none') || ';outcome=refused;code=' || v_code || ';by=' || p_actor
      || ';note=' || left(btrim(p_note), 120));
    return jsonb_build_object('outcome', 'refused', 'code', v_code);
  end if;
  v_outcome := case when (v_res ->> 'replayed')::boolean then 'already_registered' else 'registered' end;
  perform public._tw4rfl_audit(p_studio_id, p_actor, 'rfl_registration_retry',
    'kind=' || p_kind || ';op=' || (v_res ->> 'operation_id') || ';outcome=' || v_outcome || ';resource=' || (v_res ->> 'resource_id') || ';by=' || p_actor
    || ';note=' || left(btrim(p_note), 120));
  return jsonb_build_object('outcome', v_outcome, 'resource_id', v_res ->> 'resource_id', 'operation_id', v_res ->> 'operation_id');
end $$;

-- 20261221: the 20261217 administrator retry keeps its contract (same locks, same refusals, raises on refusal) and now records the administrator who retried it
create or replace function public.tw4_num_registration_retry(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_res jsonb;
begin
  perform public._tw4c_admin(p_actor);
  v_res := public._tw4f4_retry(p_studio_id, 'number');
  perform public._tw4rfl_audit(p_studio_id, p_actor, 'rfl_registration_retry',
    'kind=number;op=' || (v_res ->> 'operation_id') || ';outcome=' || case when (v_res ->> 'replayed')::boolean then 'already_registered' else 'registered' end
    || ';resource=' || (v_res ->> 'resource_id') || ';by=' || p_actor || ';note=(tw4_num_registration_retry)');
  return v_res - 'operation_id';
end $$;

-- provider-confirmed numbers and provider-verified campaigns the lifecycle inventory does not hold (their provider cost is exposed), with the last failure and last retry
create or replace function public.tw4_admin_registration_gaps(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'kind', g.kind, 'studio_id', g.studio_id, 'legal_entity_id', g.legal_entity_id, 'operation_id', g.op_id, 'provider_sid', g.provider_sid, 'e164', g.e164, 'observed_at', g.observed_at,
      'last_failure_at', (select a.created_at from public.studio_sms_provider_alerts a where a.kind = 'inventory_gap' and a.dedupe_key = 'unregistered:' || g.op_id),
      'last_retry', (select jsonb_build_object('at', au.created_at, 'by', au.actor_user_id, 'outcome', substring(au.note from ';outcome=([a-z_]+)'), 'code', substring(au.note from ';code=([A-Z0-9]+)'))
                       from public.studio_sms_onboarding_audit au where au.studio_id = g.studio_id and au.action = 'rfl_registration_retry' and au.note like 'kind=' || g.kind || ';op=' || g.op_id || ';%'
                      order by au.created_at desc, au.id desc limit 1))
      order by g.observed_at, g.op_id)
    from (
      select 'number'::text as kind, x.studio_id, x.legal_entity_id, x.id as op_id, x.provider_sid, x.e164, nr.observed_at
        from public.studio_sms_num_operations x join public.studio_sms_num_resources nr on nr.operation_id = x.id and nr.status = 'owned'
       where x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
         and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = x.provider_sid)
      union all
      select 'campaign', x.studio_id, x.legal_entity_id, x.id, x.provider_sid, null, pr.observed_at
        from public.studio_sms_prov_operations x join public.studio_sms_prov_resources pr on pr.operation_id = x.id and pr.provider_sid = x.provider_sid and pr.status = 'verified'
       where x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null
         and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = x.provider_sid and r.provider_state <> 'cancelled')
    ) g), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- deferred number retirements (20261217's _tw4num_on_number_cancelled deferred them with a warning alert only)
-- ---------------------------------------------------------------------------------------------------------------
-- the latest sender row of a location, if it is about this number (null otherwise: a sender on another number is not this number's prerequisite)
create or replace function public._tw4f4_sender_status(p_studio_id uuid, p_phone_number_sid text)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select case when s.phone_number_sid = p_phone_number_sid then s.status end from public.studio_sms_billed_senders s where s.studio_id = p_studio_id order by s.seq desc limit 1; $$;

-- a number the lifecycle shows CANCELLED (with evidence) while the number ledger still holds it live: rent stays held and the location cannot replace it until it is retired
create or replace function public.tw4_admin_deferred_retirements(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'studio_id', d.studio_id, 'legal_entity_id', d.legal_entity_id, 'resource_id', d.resource_id, 'phone_number_sid', d.provider_sid, 'e164', d.e164, 'cancelled_at', d.cancelled_at,
      'operations', d.ops, 'sender_status', d.sender_status, 'deferral_alerted', d.alerted,
      'blockers', jsonb_build_object('lease_held', d.leased, 'operation_unresolved', d.unresolved, 'sender_release_required', d.sender_status is not null and d.sender_status <> 'released'),
      'ready', not d.leased and not d.unresolved and (d.sender_status is null or d.sender_status = 'released'))
      order by d.cancelled_at, d.resource_id)
    from (
      select r.studio_id, r.legal_entity_id, r.id as resource_id, r.provider_sid, r.e164, r.cancelled_at,
             (select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.op_kind) order by x.op_kind, x.id) from public.studio_sms_num_operations x
               where x.studio_id = r.studio_id and x.op_kind in ('number_purchase', 'number_attach') and x.status = 'succeeded' and x.superseded_at is null and x.provider_sid = r.provider_sid) as ops,
             public._tw4f4_sender_status(r.studio_id, r.provider_sid) as sender_status,
             exists (select 1 from public.studio_sms_onboarding o where o.studio_id = r.studio_id and o.state <> 'cancelled' and o.lease_owner is not null and o.lease_expires_at > now()) as leased,
             exists (select 1 from public.studio_sms_num_operations x where x.studio_id = r.studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) as unresolved,
             exists (select 1 from public.studio_sms_provider_alerts a where a.kind = 'inventory_gap' and a.legal_entity_id = r.legal_entity_id and a.studio_id = r.studio_id
                      and a.dedupe_key like 'cancel_ledger:%') as alerted
        from public.studio_sms_provider_resources r
       where r.resource_kind = 'number' and r.provider_state = 'cancelled'
         and exists (select 1 from public.studio_sms_num_operations x where x.studio_id = r.studio_id and x.op_kind in ('number_purchase', 'number_attach') and x.status = 'succeeded'
                       and x.superseded_at is null and x.provider_sid = r.provider_sid)
    ) d), '[]'::jsonb);
end $$;

-- the guarded retry: the SAME retirement _tw4num_on_number_cancelled would have made, with the same all-or-nothing guards, taken in the number runner's lock order
-- (onboarding row, then location link, then business row: tw4_num_retire's order), WAITING for the rows instead of skipping them. Its evidence is the lifecycle's
-- cancelled state of this very number, never the administrator's note. Idempotent: a number the ledger no longer holds live is reported, not retired twice.
create or replace function public.tw4_admin_deferred_retire(p_studio_id uuid, p_phone_number_sid text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_res public.studio_sms_provider_resources;
  v_ops uuid[];
  v_number text;
  v_sender text;
  v_from_state text;
begin
  perform public._tw4c_admin(p_actor);
  if p_studio_id is null or p_phone_number_sid is null or p_phone_number_sid !~ '^PN[0-9a-f]{32}$' or p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a location, the number''s SID and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  v_entity := public._tw4sr_lock(p_studio_id);
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for no key update;
  select * into v_res from public.studio_sms_provider_resources r where r.provider_sid = p_phone_number_sid and r.studio_id = p_studio_id and r.legal_entity_id = v_entity and r.resource_kind = 'number';
  if v_res.id is null or v_res.provider_state <> 'cancelled' then
    raise exception 'the recurring-fee lifecycle does not show this number cancelled: cancel it there, with evidence, first' using errcode = 'TW034';
  end if;
  if o.id is not null and o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; retry after it finishes' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.status in ('in_flight', 'unknown_outcome') and x.superseded_at is null) then
    raise exception 'resolve the unknown outcome first' using errcode = 'TW034';
  end if;
  v_sender := public._tw4f4_sender_status(p_studio_id, p_phone_number_sid);
  if v_sender is not null and v_sender <> 'released' then
    raise exception 'release the sender row first (tw4_sender_revoke with release)' using errcode = 'TW022';
  end if;
  select array_agg(q.id order by q.id), max(q.e164) into v_ops, v_number from (select x.id, x.e164 from public.studio_sms_num_operations x where x.studio_id = p_studio_id
     and x.op_kind in ('number_purchase', 'number_attach') and x.status = 'succeeded' and x.superseded_at is null and x.provider_sid = p_phone_number_sid for update) q;
  if coalesce(cardinality(v_ops), 0) = 0 then
    return jsonb_build_object('retired', false, 'replayed', true);
  end if;
  update public.studio_sms_num_operations set superseded_at = clock_timestamp() where id = any (v_ops);
  if o.id is not null then
    perform public._tw4_r1_audit(o, p_actor, 'num_retired', o.state, o.state, 'number=' || v_number || ';deferred retirement after lifecycle cancellation (resource ' || v_res.id || ');'
      || left(btrim(p_note), 120));
    if o.state in ('ready_for_activation', 'active', 'suspended') then
      v_from_state := o.state;
      update public.studio_sms_onboarding set state = 'exception', step = 'N9', last_error_code = 'num_retired', last_error_field = null where id = o.id returning * into o;
      perform public._tw4_r1_audit(o, p_actor, 'state_changed', v_from_state, 'exception', 'number cancelled at the provider');
    end if;
  else
    perform public._tw4rfl_audit(p_studio_id, p_actor, 'num_retired', 'number=' || v_number || ';deferred retirement after lifecycle cancellation (resource ' || v_res.id || ');'
      || left(btrim(p_note), 120));
  end if;
  return jsonb_build_object('retired', true, 'replayed', false, 'operations', to_jsonb(v_ops));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- consolidated, read-only exposure (DanceFlow-borne provider resources no studio pays for)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_admin_exposure(p_actor uuid, p_legal_entity_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  with findings as (
    -- campaign orphans (20261212): every live finding (closed ones are history)
    select x.provider_sid, 'campaign'::text as resource_kind, x.legal_entity_id, x.studio_id, x.twilio_account_sid, 'campaign_orphan'::text as finding, x.status as finding_status,
           x.id as finding_id, x.discovered_at as since
      from public.studio_sms_prov_orphans x where x.status <> 'closed'
    union all
    -- number orphans (20261214): open findings and numbers DanceFlow adopted (it pays for them)
    select z.phone_number_sid, 'number', z.legal_entity_id, null::uuid, z.twilio_account_sid, 'number_' || z.kind, z.status, z.id, z.first_seen_at
      from public.studio_sms_num_orphans z where z.status in ('open', 'adopted')
    union all
    -- ledger resources the provider confirmed but the lifecycle inventory does not hold
    select x.provider_sid, 'number', x.legal_entity_id, x.studio_id, x.twilio_account_sid, 'unregistered_ledger_resource', 'open', x.id, nr.observed_at
      from public.studio_sms_num_operations x join public.studio_sms_num_resources nr on nr.operation_id = x.id and nr.status = 'owned'
     where x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = x.provider_sid)
    union all
    select x.provider_sid, 'campaign', x.legal_entity_id, x.studio_id, x.twilio_account_sid, 'unregistered_ledger_resource', 'open', x.id, pr.observed_at
      from public.studio_sms_prov_operations x join public.studio_sms_prov_resources pr on pr.operation_id = x.id and pr.provider_sid = x.provider_sid and pr.status = 'verified'
     where x.op_kind = 'campaign' and x.status = 'succeeded' and x.superseded_at is null and not exists (select 1 from public.studio_sms_provider_resources r where r.provider_sid = x.provider_sid and r.provider_state <> 'cancelled')
  ), filtered as (
    select f.* from findings f where p_legal_entity_id is null or f.legal_entity_id = p_legal_entity_id
  ), resources as (
    -- ONE row per provider resource, whatever number of findings name it
    select f.provider_sid, min(f.resource_kind) as resource_kind, min(f.legal_entity_id::text)::uuid as legal_entity_id, min(f.studio_id::text)::uuid as studio_id,
           min(f.twilio_account_sid) as twilio_account_sid, min(f.since) as since,
           jsonb_agg(jsonb_build_object('finding', f.finding, 'status', f.finding_status, 'id', f.finding_id, 'since', f.since) order by f.since, f.finding) as findings
      from filtered f group by f.provider_sid
  ), costed as (
    select r.*, pr.id as rfl_resource_id, pr.provider_state as rfl_provider_state, pr.source as rfl_source, c.n_rows, c.n_open, c.billed,
           -- an estimate with an unknown period in it is not an estimate: null
           case when c.n_open_unpriced > 0 then null else c.expected end as expected,
           case when pr.id is null or coalesce(c.n_rows, 0) = 0 then 'unknown' when c.n_open > 0 then 'recorded' else 'none_open' end as cost_basis
      from resources r
      left join public.studio_sms_provider_resources pr on pr.provider_sid = r.provider_sid
      left join lateral (
        select count(*)::int as n_rows, (count(*) filter (where e.state = 'open'))::int as n_open,
               (count(*) filter (where e.state = 'open' and e.expected_provider_cents is null))::int as n_open_unpriced,
               sum(e.provider_billed_cents) filter (where e.state = 'open')::bigint as billed, sum(e.expected_provider_cents) filter (where e.state = 'open')::bigint as expected
          from public.studio_sms_provider_exposure e where e.resource_id = pr.id) c on pr.id is not null
  )
  select jsonb_build_object(
    'resources', coalesce(jsonb_agg(jsonb_build_object(
      'provider_sid', c.provider_sid, 'resource_kind', c.resource_kind, 'legal_entity_id', c.legal_entity_id, 'studio_id', c.studio_id, 'twilio_account_sid', c.twilio_account_sid,
      'since', c.since, 'age_days', floor(extract(epoch from clock_timestamp() - c.since) / 86400)::int, 'findings', c.findings,
      -- a studio's own registered resource (a contradiction finding about it) is billed through the lifecycle, not borne by DanceFlow
      'cost_bearer', case when c.rfl_resource_id is not null and c.rfl_source <> 'admin' then 'lifecycle' else 'danceflow' end,
      'rfl_resource_id', c.rfl_resource_id, 'rfl_provider_state', c.rfl_provider_state,
      'cost', jsonb_build_object(
        -- only OPEN recorded periods are a known cost; "nothing open" says nothing about the current period
        'basis', c.cost_basis, 'known', c.cost_basis = 'recorded',
        'provider_billed_cents', case when c.cost_basis = 'recorded' then c.billed end,
        'expected_provider_cents_estimate', case when c.cost_basis = 'recorded' then c.expected end,
        'open_exposure_periods', case when c.cost_basis <> 'unknown' then c.n_open end,
        'in_rfl_exposure_report', c.rfl_resource_id is not null))
      order by c.since, c.provider_sid), '[]'::jsonb),
    'aggregate', jsonb_build_object(
      'resources', count(*),
      'campaigns', count(*) filter (where c.resource_kind = 'campaign'),
      'numbers', count(*) filter (where c.resource_kind = 'number'),
      'cost_unknown', count(*) filter (where c.cost_basis <> 'recorded'),
      'cost_recorded', count(*) filter (where c.cost_basis = 'recorded'),
      'in_rfl_exposure_report', count(*) filter (where c.rfl_resource_id is not null),
      -- recorded OPEN lifecycle exposure only, each resource once; null when nothing is recorded. Unknown costs are never summed as zero.
      'provider_billed_cents', sum(c.billed) filter (where c.cost_basis = 'recorded'),
      'expected_provider_cents_estimate', case when bool_or(c.expected is null) filter (where c.cost_basis = 'recorded') then null
                                               else sum(c.expected) filter (where c.cost_basis = 'recorded') end,
      'amounts_overlap_rfl_exposure_report', true),
    'notes', jsonb_build_array(
      'A resource without a recorded lifecycle cost has an UNKNOWN cost (null), not zero.',
      'Recorded amounts are open lifecycle exposure periods of resources registered in the lifecycle: they are already in tw4_rfl_exposure_report; never add the two.',
      'Unexpected resources are borne by DanceFlow (cost_bearer danceflow); a contradiction about a studio''s own registered resource stays with the lifecycle (cost_bearer lifecycle). Nothing here charges a studio or asks an owner to authorize or pay.'))
    into v
    from costed c;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- evidence console read: would the recorded provider listings prove absence? (release itself stays an owner decision, U-1)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_admin_prov_proof(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'operation_id', r.id, 'status', r.status, 'started_at', r.started_at, 'fee_kinds', to_jsonb(r.fee_kinds),
      'scope_sid', r.params ->> 'messaging_service_sid',
      'listings', (select count(*) from public.studio_sms_prov_listings l where l.operation_id = r.id),
      'latest', (select jsonb_build_object('verdict', l.verdict, 'observed_at', l.observed_at, 'source', l.source, 'complete', l.complete) from public.studio_sms_prov_listings l
                  where l.operation_id = r.id order by l.observed_at desc, l.id desc limit 1),
      'proof', public._tw4prov2_proof(r.id),
      'pilot', public._tw4prov2_is_pilot_op(r.id, r.legal_entity_id),
      'release_permitted_by_evidence', coalesce((public._tw4prov2_proof(r.id) ->> 'ok')::boolean, false) and not public._tw4prov2_is_pilot_op(r.id, r.legal_entity_id))
      order by r.started_at, r.id)
    from public.studio_sms_prov_operations r
   where r.studio_id = p_studio_id and r.op_kind = 'campaign' and r.fee_bearing and r.status in ('unknown_outcome', 'in_flight') and r.superseded_at is null), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tw4_prov_observe (R2a, 20261207) with the campaign registration
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_prov_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_expected_inbound text,
                                                   p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_prov_resources;
  v_status text;
  v_code text := null;
  v_provider_status text := null;
  v_reasons text := null;
  v_brand text;
  v_path text;
  v_parent text := null;
  v_use text := null;
  v_from_state text;
  v_kind text;
  v_reg_error text := null;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.status <> 'succeeded' or r.superseded_at is not null then
    raise exception 'only a live, succeeded operation can be observed' using errcode = '22023';
  end if;
  v_from_state := o.state;
  select * into v_prev from public.studio_sms_prov_resources x where x.operation_id = r.id;

  if (p_facts ->> 'sid') is distinct from r.provider_sid then
    v_status := 'mismatch'; v_code := 'sid_mismatch';
  elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
    v_status := 'mismatch'; v_code := 'account_mismatch';
  elsif r.op_kind = 'messaging_service' then
    if p_expected_inbound is null or p_expected_inbound !~ '^https://[^\s]+/api/sms/twilio/inbound$' then
      raise exception 'the expected inbound route is required' using errcode = '22023';
    end if;
    if (p_facts ->> 'use_inbound_webhook_on_number') is distinct from 'false' or (p_facts ->> 'inbound_request_url') is distinct from p_expected_inbound then
      v_status := 'mismatch'; v_code := 'inbound_route';
    else
      v_status := 'ready';
    end if;
  else
    select * into v_ms from public.studio_sms_prov_operations x where x.studio_id = r.studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null;
    v_brand := public._tw4prov_brand(r.studio_id);
    v_path := public.tw4_location_fee_kinds(r.studio_id) ->> 'path';
    v_parent := p_facts ->> 'messaging_service_sid';
    v_use := p_facts ->> 'us_app_to_person_usecase';
    v_provider_status := left(upper(coalesce(p_facts ->> 'campaign_status', '')), 40);
    if v_ms.id is null or v_parent is distinct from v_ms.provider_sid then
      v_status := 'mismatch'; v_code := 'service_mismatch';
    elsif v_brand is null or (p_facts ->> 'brand_registration_sid') is distinct from v_brand then
      v_status := 'mismatch'; v_code := 'brand_mismatch';
    elsif v_use is null or v_use not in ('MIXED', 'LOW_VOLUME') or v_use is distinct from (r.params ->> 'use_case') or v_use is distinct from public._tw4prov_use_case(v_path) then
      v_status := 'mismatch'; v_code := 'use_case_mismatch';
    elsif (p_facts ->> 'mock') is distinct from 'false' then
      v_status := 'mismatch'; v_code := 'mock_or_unknown';
    elsif v_provider_status = 'VERIFIED' then
      v_status := 'verified';
    elsif v_provider_status = 'FAILED' then
      v_status := 'failed';
      v_reasons := left(regexp_replace(coalesce(p_facts ->> 'errors', ''), '[^[:print:]]', ' ', 'g'), 500);
    elsif v_provider_status = 'IN_PROGRESS' then
      v_status := 'pending';
    else
      v_status := 'pending'; v_code := 'status_unrecognized';
    end if;
  end if;

  if v_prev.id is null then
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status,
                                                 mismatch_code, provider_status, failure_reasons, source, evidence_digest, verified_at)
    values (r.id, r.legal_entity_id, r.studio_id, r.twilio_account_sid, r.op_kind, r.provider_sid, v_parent, case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end,
            v_use, v_status, v_code, v_provider_status, v_reasons, p_source, p_digest, case when v_status = 'verified' then clock_timestamp() end);
  else
    update public.studio_sms_prov_resources set status = v_status, mismatch_code = v_code, provider_status = v_provider_status, failure_reasons = v_reasons, source = p_source,
      evidence_digest = p_digest, observed_at = clock_timestamp(), parent_sid = coalesce(v_parent, parent_sid), use_case = coalesce(v_use, use_case),
      brand_sid = coalesce(case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end, brand_sid),
      verified_at = case when v_status = 'verified' then coalesce(verified_at, clock_timestamp()) else null end
    where id = v_prev.id;
  end if;

  -- 20261221: a provider-VERIFIED campaign is registered below; the business row and its credit account are locked first (the lifecycle's order: business, credit account,
  -- then its rows), so the fee settlement and the registration never take them in the opposite order
  if r.op_kind = 'campaign' and v_status = 'verified' then
    perform public._tw4rfl_lock(r.legal_entity_id);
  end if;
  -- fees follow provider evidence: the vetting fee is captured once the provider holds the campaign; the first month on approval, released on rejection
  if r.fee_bearing and r.op_kind = 'campaign' and v_status in ('pending', 'verified', 'failed') then
    foreach v_kind in array r.fee_kinds loop
      if exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || v_kind and cr.status = 'reserved') then
        if v_kind = 'campaign_vetting' or v_status = 'verified' then
          perform public._tw4prov_settle(r.id, v_kind, 'captured', r.provider_sid);
        elsif v_status = 'failed' then
          perform public._tw4prov_settle(r.id, v_kind, 'released', 'campaign_rejected');
        end if;
      end if;
    end loop;
  end if;
  -- 20261221: a campaign the provider reports VERIFIED is registered in the recurring-fee inventory in THIS transaction, from the ledger's own rows (the caller names nothing),
  -- mirroring 20261217 for numbers. No charge and no cover change beyond the pilot's own first-month reservation of this operation. A registration that cannot be made never
  -- discards the provider's evidence: the observation stays, the failure is audited and alerted, and an administrator retries it (tw4_admin_registration_retry).
  -- Lock and serialization failures are not business refusals and propagate.
  if r.op_kind = 'campaign' and v_status = 'verified' then
    begin
      perform public._tw4prov_register_verified(r.id);
    exception when others then
      if SQLSTATE not in ('TW010', 'TW032', 'TW040', '22023', '23505', '23514') then
        raise;
      end if;
      v_reg_error := SQLSTATE || ':' || left(SQLERRM, 80);
      perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, null, 'inventory_gap', 'unregistered:' || r.id, 'admin', 'critical',
        'A campaign is approved at the provider but could not be registered in the recurring-fee inventory. Provider cost is exposed: retry the registration from the recovery panel.');
    end;
  end if;
  -- a provider rejection (or a later failure of a campaign that was approved) sends the onboarding to a human; it is never retried or paid again automatically
  if r.op_kind = 'campaign' and v_status = 'failed' and public._sms_onb_transition_allowed(o.state, 'exception') then
    update public.studio_sms_onboarding set state = 'exception', step = 'C1', last_error_code = 'campaign_rejected', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', v_from_state, 'exception', 'campaign rejected by the provider');
  elsif r.op_kind = 'campaign' and v_status = 'verified' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N1', last_error_code = null where id = o.id returning * into o;
  end if;
  perform public._tw4_r1_audit(o, null, 'prov_observed', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || v_status || coalesce(';code=' || v_code, '') || ';src=' || p_source || coalesce(';registration_failed=' || v_reg_error, ''));
  return jsonb_build_object('status', v_status, 'code', v_code, 'state', o.state);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: helpers callable by no API role; administrator entry points service-role only (the actor is re-checked inside)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4prov_ledger_reservation(uuid), public._tw4prov_register_verified(uuid), public._tw4f4_retry_target(uuid, text), public._tw4f4_retry(uuid, text),
  public._tw4f4_sender_status(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.tw4_admin_registration_retry(uuid, uuid, text, text), public.tw4_admin_registration_gaps(uuid), public.tw4_admin_deferred_retirements(uuid),
  public.tw4_admin_deferred_retire(uuid, text, uuid, text), public.tw4_admin_exposure(uuid, uuid), public.tw4_admin_prov_proof(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tw4_admin_registration_retry(uuid, uuid, text, text), public.tw4_admin_registration_gaps(uuid), public.tw4_admin_deferred_retirements(uuid),
  public.tw4_admin_deferred_retire(uuid, text, uuid, text), public.tw4_admin_exposure(uuid, uuid), public.tw4_admin_prov_proof(uuid, uuid) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['public._tw4prov_ledger_reservation(uuid)', 'public._tw4prov_register_verified(uuid)', 'public._tw4f4_retry_target(uuid,text)', 'public._tw4f4_retry(uuid,text)',
                              'public._tw4f4_sender_status(uuid,text)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') or has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'recovery-tooling postcondition failed: % is callable by an API role', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.tw4_admin_registration_retry(uuid,uuid,text,text)', 'public.tw4_admin_registration_gaps(uuid)', 'public.tw4_admin_deferred_retirements(uuid)',
                              'public.tw4_admin_deferred_retire(uuid,text,uuid,text)', 'public.tw4_admin_exposure(uuid,uuid)', 'public.tw4_admin_prov_proof(uuid,uuid)',
                              'public.tw4_num_registration_retry(uuid,uuid)', 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'recovery-tooling postcondition failed: unexpected privileges on %', v_fn;
    end if;
  end loop;
end $$;

commit;
