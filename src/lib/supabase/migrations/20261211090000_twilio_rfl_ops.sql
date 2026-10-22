-- 20261211090000_twilio_rfl_ops.sql
-- TW-4F recurring-fee lifecycle: operational database controls (PR 1 of 3; design docs/twilio/TW-4F_RFL_Ops_Design.md). Dark: nothing here is scheduled, enabled or delivered.
--   * Kill switches (scan | delivery), fail closed: the latest audited log row wins and the ABSENCE of a row is OFF. tw4_rfl_alerts_claim returns nothing while delivery is off.
--   * Scan heartbeat: one run at a time (database lease), a switch fence, an append-only run record, and tw4_rfl_health (stale = no completed run in 26 hours).
--   * Reports for platform administrators: exposure aging, provider-cost variances and an append-only variance acknowledgement (always DanceFlow-borne, never charged).
--   * Escalation (fixed policy windows, D2): a second owner notice and an administrator escalation 14 days before an authorization ends without a renewal, and an
--     administrator alert for an alert whose delivery was exhausted.
--   * Recipient lookup with tenant isolation (verified email only, capped, audience-aware) and an auditable per-recipient delivery record (never an email address).
--   * Dual control (D3): two DISTINCT platform administrators for (a) absorbing an exposure and (b) authorizing the cancellation of a provider PHONE NUMBER. A request is
--     bound by a facts hash (business, resource, provider state, action, period, exposure state and cents, open cancellations, approval reference, reason), is single use,
--     expires after 24 hours and is invalidated when a bound fact changes. Immediate safety suspension (tw4_rfl_suspend_df) never waits for approval.
-- Nothing here calls Twilio, charges a studio, edits a credit ledger or extends an authorization. Enabling a switch and scheduling are separate, owner-approved steps.
-- Requires 20261209090000. Replaces (each precondition-checked against its exact 20261209 body): tw4_rfl_alerts_claim, tw4_rfl_scan_entity, tw4_rfl_exposure_dispose,
-- tw4_rfl_cancel_authorize (same signatures; only the intended additions). The audit vocabulary and the alert-kind CHECK are EXTENDED from their live definitions.
-- Rollback: rollback/20261211090000_twilio_rfl_ops_rollback.sql (restores the four bodies byte for byte; refuses with 55000 once any evidence row of the new tables exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_provider_resources') is null or to_regclass('public.studio_sms_provider_alerts') is null or to_regclass('public.studio_sms_provider_charges') is null
     or to_regprocedure('public.tw4_rfl_alerts_claim(integer)') is null or to_regprocedure('public.tw4_rfl_scan_entity(uuid)') is null
     or to_regprocedure('public.tw4_rfl_exposure_dispose(uuid,text,uuid,text,text)') is null
     or to_regprocedure('public.tw4_rfl_cancel_authorize(uuid,uuid,text,text,text,boolean)') is null
     or to_regprocedure('public._tw4rfl_lock(uuid)') is null or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null
     or to_regprocedure('public._tw4sr_lock(uuid)') is null or to_regprocedure('public._tw4fi_ref_norm(text)') is null or to_regprocedure('public._tw4c_admin(uuid)') is null
     or to_regprocedure('public._tw4c_any_location(uuid)') is null or to_regprocedure('public._tw4c_truncate_guard()') is null then
    raise exception 'rfl-ops precondition failed: 20261209090000 (the recurring-fee lifecycle) is not applied';
  end if;
  if to_regclass('public.studio_sms_rfl_switch_log') is not null or to_regclass('public.studio_sms_rfl_dual_requests') is not null then
    raise exception 'rfl-ops precondition failed: already applied';
  end if;
  -- the four functions replaced below must still be EXACTLY the 20261209 bodies (line endings ignored): another slice must never be clobbered silently
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_rfl_alerts_claim(integer)'::regprocedure) is distinct from '2330438881b7a0a3a961428cd39a5ca8' then
    raise exception 'rfl-ops precondition failed: tw4_rfl_alerts_claim differs from 20261209090000';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_rfl_scan_entity(uuid)'::regprocedure) is distinct from '25bfa7ac72b40890f9e9cd7c0ede2617' then
    raise exception 'rfl-ops precondition failed: tw4_rfl_scan_entity differs from 20261209090000';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_rfl_exposure_dispose(uuid,text,uuid,text,text)'::regprocedure) is distinct from '7263f0645c4d0f1d035fd55c3597e7e8' then
    raise exception 'rfl-ops precondition failed: tw4_rfl_exposure_dispose differs from 20261209090000';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_rfl_cancel_authorize(uuid,uuid,text,text,text,boolean)'::regprocedure) is distinct from '2f745cd5cd6c79183a34b087883a1075' then
    raise exception 'rfl-ops precondition failed: tw4_rfl_cancel_authorize differs from 20261209090000';
  end if;
  if to_regprocedure('public.tw4_rfl_admin_overview(uuid)') is null
     or (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_rfl_admin_overview(uuid)'::regprocedure) is distinct from 'd57e583acdb138d11bc57b36e9b0d2e0' then
    raise exception 'rfl-ops precondition failed: tw4_rfl_admin_overview differs from 20261209090000';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'rfl-ops precondition failed: public.profiles is missing';
  end if;
  if to_regclass('public.outbound_deliveries') is null or not exists (select 1 from pg_attribute a where a.attrelid = 'public.outbound_deliveries'::regclass and a.attname = 'template_key' and not a.attisdropped) then
    raise exception 'rfl-ops precondition failed: public.outbound_deliveries (with template_key) is missing';
  end if;
end $$;

-- audit vocabulary and alert kinds: the LIVE lists plus this slice's values (extended, never rebuilt from a fixed list, so sibling migrations keep their own values)
do $$
declare
  v_def text;
  v_name text;
  v_vals text[];
begin
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%rfl_registered%' and pg_get_constraintdef(c.oid) like '%action%';
  if v_def is null then
    raise exception 'rfl-ops precondition failed: the audit vocabulary does not carry the lifecycle actions';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or cardinality(v_vals) < 40 or not ('state_changed' = any (v_vals)) then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['rfl_switch_set', 'rfl_variance_acked', 'rfl_dual_requested', 'rfl_dual_approved', 'rfl_dual_rejected',
    'rfl_dual_invalidated', 'rfl_dual_consumed', 'rfl_alert_delivery']) x);
  execute format('alter table public.studio_sms_onboarding_audit drop constraint %I', v_name);
  execute format('alter table public.studio_sms_onboarding_audit add constraint %I check (action = any (%L::text[]))', v_name, v_vals);

  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null then
    raise exception 'rfl-ops precondition failed: the alert-kind constraint is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or cardinality(v_vals) < 10 or not ('exposure_open' = any (v_vals)) then
    raise exception 'could not read the alert kinds from %', v_def;
  end if;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['owner_notice_second', 'owner_unresponsive', 'alert_delivery_exhausted']) x);
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges; RLS on; history is never deleted)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_rfl_switch_log (
  id uuid primary key default gen_random_uuid(),
  switch text not null check (switch in ('scan', 'delivery')),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default clock_timestamp(),
  seq bigserial not null   -- the deterministic tie-break when two changes share a timestamp
);
create index studio_sms_rfl_switch_log_latest on public.studio_sms_rfl_switch_log (switch, changed_at desc, seq desc);

create table public.studio_sms_rfl_runs (
  id uuid primary key default gen_random_uuid(),
  runner text not null check (char_length(btrim(runner)) between 3 and 80),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz null,
  summary jsonb null,   -- counts only
  error text null check (error is null or char_length(error) <= 300),
  constraint studio_sms_rfl_runs_finished check ((status = 'running') = (finished_at is null))
);
create unique index studio_sms_rfl_runs_one_running on public.studio_sms_rfl_runs ((true)) where status = 'running';
create index studio_sms_rfl_runs_recent on public.studio_sms_rfl_runs (started_at desc);

create table public.studio_sms_rfl_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.studio_sms_provider_alerts(id) on delete restrict,
  claim_token uuid not null,
  recipient_ref text not null check (recipient_ref ~ '^(owner|admin):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|none)$'),   -- <kind>:<user id>; never an email address
  recipient_kind text not null check (recipient_kind in ('owner', 'admin')),
  outcome text not null check (outcome in ('queued', 'duplicate', 'invalid_recipient', 'no_recipient')),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_rfl_alert_deliveries_once unique (alert_id, recipient_ref),
  constraint studio_sms_rfl_alert_deliveries_kind check (split_part(recipient_ref, ':', 1) = recipient_kind),
  constraint studio_sms_rfl_alert_deliveries_none check ((outcome = 'no_recipient') = (recipient_ref like '%:none'))
);

create table public.studio_sms_provider_variance_acks (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.studio_sms_provider_charges(id) on delete restrict,
  legal_entity_id uuid not null,
  acknowledged_by uuid not null,
  note text not null check (char_length(btrim(note)) between 10 and 500),
  outcome text not null default 'dancflow_borne' check (outcome = 'dancflow_borne'),   -- D5: a variance is DanceFlow's cost; it is never charged to a studio
  acknowledged_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_provider_variance_acks_once unique (charge_id)
);

create table public.studio_sms_rfl_dual_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('absorb_exposure', 'cancel_number')),
  legal_entity_id uuid not null,
  studio_id uuid not null,
  resource_id uuid not null references public.studio_sms_provider_resources(id) on delete restrict,
  period_key text null check (period_key is null or period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  reason text not null check (char_length(reason) between 10 and 500),
  approval_ref text null check (approval_ref is null or char_length(approval_ref) between 10 and 200),
  approval_ref_norm text null,
  cancel_decided_by text null check (cancel_decided_by is null or cancel_decided_by in ('owner_written', 'founder_written')),   -- bound for a number cancellation (never policy_lapse)
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'invalidated', 'consumed')),
  requested_by uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  decided_by uuid null,
  decided_at timestamptz null,
  decision_note text null check (decision_note is null or char_length(decision_note) between 10 and 500),
  consumed_at timestamptz null,
  consumed_by uuid null,
  constraint studio_sms_rfl_dual_requests_window check (expires_at > requested_at),
  constraint studio_sms_rfl_dual_requests_shape check ((action = 'absorb_exposure') = (period_key is not null) and (action = 'cancel_number') = (approval_ref is not null)
    and (approval_ref is null) = (approval_ref_norm is null) and (action = 'cancel_number') = (cancel_decided_by is not null)),
  -- two DISTINCT platform administrators, enforced by the table itself: an approved (or consumed) request names a decider who is not the requester
  constraint studio_sms_rfl_dual_requests_distinct check (status not in ('approved', 'consumed') or (decided_by is not null and decided_by <> requested_by)),
  constraint studio_sms_rfl_dual_requests_consumed check ((status = 'consumed') = (consumed_at is not null and consumed_by is not null)),
  constraint studio_sms_rfl_dual_requests_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
-- one OPEN request per action, resource and period
create unique index studio_sms_rfl_dual_requests_one_open on public.studio_sms_rfl_dual_requests (action, resource_id, coalesce(period_key, '')) where status in ('pending', 'approved');
create index studio_sms_rfl_dual_requests_entity on public.studio_sms_rfl_dual_requests (legal_entity_id, requested_at desc);

-- the per-resource FACT EPOCH: only ever increases (bumped by triggers below), so a bound fact that changes and then reverts never restores an approval's hash
create table public.studio_sms_rfl_fact_epochs (
  resource_id uuid primary key references public.studio_sms_provider_resources(id) on delete restrict,
  epoch bigint not null check (epoch >= 1)
);

revoke all on public.studio_sms_rfl_switch_log, public.studio_sms_rfl_runs, public.studio_sms_rfl_alert_deliveries, public.studio_sms_provider_variance_acks,
  public.studio_sms_rfl_dual_requests, public.studio_sms_rfl_fact_epochs from public, anon, authenticated, service_role;
alter table public.studio_sms_rfl_switch_log enable row level security;
alter table public.studio_sms_rfl_runs enable row level security;
alter table public.studio_sms_rfl_alert_deliveries enable row level security;
alter table public.studio_sms_provider_variance_acks enable row level security;
alter table public.studio_sms_rfl_dual_requests enable row level security;
alter table public.studio_sms_rfl_fact_epochs enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- guards: append-only evidence; a run finishes once; a request moves only along its graph and only through the dual-control functions
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4rflops_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%: evidence is never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_rfl_runs' then
    if old.status <> 'running' or new.status = 'running' or new.id is distinct from old.id or new.runner is distinct from old.runner
       or new.started_at is distinct from old.started_at or new.lease_expires_at is distinct from old.lease_expires_at then
      raise exception 'a finished scan run is final' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_rfl_dual_requests' then
    if new.id is distinct from old.id or new.action is distinct from old.action or new.legal_entity_id is distinct from old.legal_entity_id or new.studio_id is distinct from old.studio_id
       or new.resource_id is distinct from old.resource_id or new.period_key is distinct from old.period_key or new.reason is distinct from old.reason
       or new.approval_ref is distinct from old.approval_ref or new.approval_ref_norm is distinct from old.approval_ref_norm or new.facts_hash is distinct from old.facts_hash
       or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at
       or coalesce(current_setting('tw4.rflops_write', true), '') <> 'on' then
      raise exception 'studio_sms_rfl_dual_requests: the binding of a request is fixed and its status moves only through the dual-control functions' using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'invalidated')) or (old.status = 'approved' and new.status in ('consumed', 'rejected', 'expired', 'invalidated'))) then
      raise exception 'studio_sms_rfl_dual_requests: % -> % is not a legal transition (a decided request is final)', old.status, new.status using errcode = '42501';
    end if;
    if new.status is not distinct from old.status and old.status not in ('pending', 'approved') and new is distinct from old then
      raise exception 'studio_sms_rfl_dual_requests: % is final', old.status using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_rfl_fact_epochs' then
    if new.resource_id is distinct from old.resource_id or new.epoch <= old.epoch then
      raise exception 'a fact epoch only increases' using errcode = '42501';
    end if;
  else
    raise exception '%: rows are append-only', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

-- a request is always BORN pending and undecided, whatever an owner-level insert supplies
create or replace function public._tw4rflops_request_insert()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.status := 'pending';
  new.decided_by := null;
  new.decided_at := null;
  new.decision_note := null;
  new.consumed_at := null;
  new.consumed_by := null;
  return new;
end $$;
create trigger studio_sms_rfl_dual_requests_00_insert before insert on public.studio_sms_rfl_dual_requests for each row execute function public._tw4rflops_request_insert();
create trigger studio_sms_rfl_fact_epochs_guard before update or delete on public.studio_sms_rfl_fact_epochs for each row execute function public._tw4rflops_guard();
create trigger studio_sms_rfl_fact_epochs_truncate before truncate on public.studio_sms_rfl_fact_epochs for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_rfl_switch_log_guard before update or delete on public.studio_sms_rfl_switch_log for each row execute function public._tw4rflops_guard();
create trigger studio_sms_rfl_runs_guard before update or delete on public.studio_sms_rfl_runs for each row execute function public._tw4rflops_guard();
create trigger studio_sms_rfl_alert_deliveries_guard before update or delete on public.studio_sms_rfl_alert_deliveries for each row execute function public._tw4rflops_guard();
create trigger studio_sms_provider_variance_acks_guard before update or delete on public.studio_sms_provider_variance_acks for each row execute function public._tw4rflops_guard();
create trigger studio_sms_rfl_dual_requests_guard before update or delete on public.studio_sms_rfl_dual_requests for each row execute function public._tw4rflops_guard();
create trigger studio_sms_rfl_switch_log_truncate before truncate on public.studio_sms_rfl_switch_log for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_rfl_runs_truncate before truncate on public.studio_sms_rfl_runs for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_rfl_alert_deliveries_truncate before truncate on public.studio_sms_rfl_alert_deliveries for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_provider_variance_acks_truncate before truncate on public.studio_sms_provider_variance_acks for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_rfl_dual_requests_truncate before truncate on public.studio_sms_rfl_dual_requests for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- kill switches (fail closed: default OFF, absence of a row is OFF, the latest audited row wins)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_switch_enabled(p_switch text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select l.enabled from public.studio_sms_rfl_switch_log l where l.switch = p_switch order by l.changed_at desc, l.seq desc limit 1), false);
$$;

create or replace function public.tw4_rfl_set_switch(p_switch text, p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_switch is null or p_switch not in ('scan', 'delivery') or p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a switch (scan | delivery), a state and a written reason (10 to 300 characters) are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_rfl_switch'));
  insert into public.studio_sms_rfl_switch_log (switch, enabled, changed_by, reason, changed_at) values (p_switch, p_enabled, p_actor, btrim(p_reason), clock_timestamp());
  -- the platform-level switch has no location: the audit row hangs on the first linked location (as the usage switch does); the log row above is the authoritative record
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select es.studio_id, null, 'platform_admin', p_actor, 'rfl_switch_set', left('switch=' || p_switch || ';enabled=' || p_enabled || ';' || btrim(p_reason), 300)
    from public.studio_sms_entity_studios es order by es.linked_at limit 1;
  return jsonb_build_object('switch', p_switch, 'enabled', p_enabled);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- scan heartbeat: one run at a time, fenced by the scan switch; the run record is append-only evidence
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_scan_begin(p_runner text, p_lease_seconds int default 600)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_runner is null or char_length(btrim(p_runner)) not between 3 and 80 or p_lease_seconds is null or p_lease_seconds not between 60 and 3600 then
    raise exception 'invalid scan run' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_rfl_scan_run'));
  -- a run whose lease expired without finishing is closed as failed (so a crashed runner never blocks the next one, and health never shows 'running' forever),
  -- even while the scan switch is off
  update public.studio_sms_rfl_runs set status = 'failed', finished_at = clock_timestamp(), error = 'lease expired before the run finished'
   where status = 'running' and lease_expires_at <= clock_timestamp();
  if not public.tw4_rfl_switch_enabled('scan') then
    return jsonb_build_object('ran', false, 'reason', 'switched_off', 'run_id', null);
  end if;
  insert into public.studio_sms_rfl_runs (runner, lease_expires_at) values (btrim(p_runner), clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict ((true)) where status = 'running' do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('ran', false, 'reason', 'busy', 'run_id', null);
  end if;
  return jsonb_build_object('ran', true, 'reason', null, 'run_id', v_id);
end $$;

create or replace function public.tw4_rfl_scan_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare x public.studio_sms_rfl_runs;
begin
  if p_status is null or p_status not in ('completed', 'failed') then
    raise exception 'invalid run outcome' using errcode = '22023';
  end if;
  -- the summary is COUNTS ONLY: a flat object of numbers (no text, no identifiers, no amounts' provenance)
  if p_summary is not null and (jsonb_typeof(p_summary) <> 'object' or (select count(*) from jsonb_object_keys(p_summary)) > 30
       or exists (select 1 from jsonb_each(p_summary) kv where jsonb_typeof(kv.value) <> 'number' or char_length(kv.key) > 40)) then
    raise exception 'the run summary is counts only: a flat object of numbers' using errcode = '22023';
  end if;
  select * into x from public.studio_sms_rfl_runs r where r.id = p_run_id for update;
  if x.id is null then
    raise exception 'unknown scan run' using errcode = '22023';
  end if;
  if x.status <> 'running' then
    return jsonb_build_object('updated', false);   -- final once (a lease that expired was already closed as failed)
  end if;
  update public.studio_sms_rfl_runs set status = p_status, finished_at = clock_timestamp(), summary = p_summary, error = left(p_error, 300) where id = x.id;
  return jsonb_build_object('updated', true);
end $$;

create or replace function public.tw4_rfl_health(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_last timestamptz;
  v_ok timestamptz;
  v_status text;
begin
  perform public._tw4c_admin(p_actor);
  select r.started_at, r.status into v_last, v_status from public.studio_sms_rfl_runs r order by r.started_at desc, r.id desc limit 1;
  select max(r.finished_at) into v_ok from public.studio_sms_rfl_runs r where r.status = 'completed';
  return jsonb_build_object(
    'scan_switch', public.tw4_rfl_switch_enabled('scan'),
    'delivery_switch', public.tw4_rfl_switch_enabled('delivery'),
    'last_run_at', v_last,
    'last_success_at', v_ok,
    'last_status', v_status,
    'stale', v_ok is null or v_ok < now() - interval '26 hours',
    'runs_failed_24h', (select count(*) from public.studio_sms_rfl_runs r where r.status = 'failed' and coalesce(r.finished_at, r.started_at) > now() - interval '24 hours'),
    'alerts_pending', (select count(*) from public.studio_sms_provider_alerts a where a.status = 'pending'),
    'alerts_failed', (select count(*) from public.studio_sms_provider_alerts a where a.status = 'failed'),
    'alerts_exhausted', (select count(*) from public.studio_sms_provider_alerts a where a.attempts >= 5 and (a.status = 'failed' or (a.status = 'sending' and a.claimed_at < now() - interval '15 minutes'))),
    'oldest_pending_alert_age_seconds', (select floor(extract(epoch from now() - min(a.created_at)))::bigint from public.studio_sms_provider_alerts a where a.status = 'pending'),
    'open_exposure_count', (select count(*) from public.studio_sms_provider_exposure e where e.state = 'open'),
    'open_cancel_operations', (select count(*) from public.studio_sms_provider_cancel_ops o where o.status in ('authorized', 'in_flight', 'unknown_outcome')));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reports (platform administrators; cents are allowed in these reads and never in an email)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_exposure_report(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.first_detected_at, t.resource_id, t.period_key), '[]'::jsonb) into v from (
    select r.legal_entity_id, r.studio_id, r.id as resource_id, r.resource_kind, r.fee_kind, e.period_key, e.reason, e.state, e.first_detected_at,
           floor(extract(epoch from now() - e.first_detected_at) / 86400)::int as age_days,
           case when now() - e.first_detected_at <= interval '8 days' - interval '1 microsecond' then '0-7'
                when now() - e.first_detected_at < interval '31 days' then '8-30'
                when now() - e.first_detected_at < interval '91 days' then '31-90' else '90+' end as aging_bucket,
           e.expected_provider_cents, e.provider_billed_cents,
           (select q.status from public.studio_sms_rfl_dual_requests q where q.action = 'absorb_exposure' and q.resource_id = e.resource_id and q.period_key = e.period_key
               and q.status in ('pending', 'approved') and q.expires_at > clock_timestamp() order by q.requested_at desc limit 1) as dual_request_status
      from public.studio_sms_provider_exposure e join public.studio_sms_provider_resources r on r.id = e.resource_id
     where e.state = 'open') t;
  return v;
end $$;

create or replace function public.tw4_rfl_variance_report(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select coalesce(jsonb_agg((row_to_json(t)::jsonb - 'created_at') order by t.created_at desc, t.charge_id), '[]'::jsonb) into v from (
    select c.id as charge_id, c.legal_entity_id, c.studio_id, c.kind, c.provider_ref, c.expected_cost_cents, c.provider_cost_cents, c.variance_cents, c.created_at,
           (k.id is not null) as acknowledged, k.acknowledged_at, k.acknowledged_by, k.note
      from public.studio_sms_provider_charges c left join public.studio_sms_provider_variance_acks k on k.charge_id = c.id
     where c.status = 'variance' and c.kind in ('number', 'monthly', 'monthly_low_volume')) t;
  return v;
end $$;

-- the single, append-only acknowledgement of a recorded variance: the outcome is always DanceFlow-borne. It never touches a credit ledger, balance or reservation.
create or replace function public.tw4_rfl_variance_ack(p_charge_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c public.studio_sms_provider_charges;
  v_id uuid;
  v_studio uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an acknowledgement needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into c from public.studio_sms_provider_charges x where x.id = p_charge_id;
  if c.id is null then
    raise exception 'unknown provider charge' using errcode = '22023';
  end if;
  if c.status <> 'variance' or c.kind not in ('number', 'monthly', 'monthly_low_volume') then
    raise exception 'only a recorded variance of a recurring provider fee is acknowledged here' using errcode = 'TW041';
  end if;
  insert into public.studio_sms_provider_variance_acks (charge_id, legal_entity_id, acknowledged_by, note) values (c.id, c.legal_entity_id, p_actor, btrim(p_note))
  on conflict (charge_id) do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('acknowledged', true, 'replayed', true);   -- one acknowledgement per charge, ever
  end if;
  v_studio := coalesce(c.studio_id, public._tw4c_any_location(c.legal_entity_id));
  perform public._tw4rfl_audit(v_studio, p_actor, 'rfl_variance_acked', 'charge=' || c.id || ';outcome=dancflow_borne');
  return jsonb_build_object('acknowledged', true, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- alert recipients (verified email only; tenant isolation; caps) and the per-recipient delivery record
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_rfl_alert_recipients(p_alert_id uuid)
returns table (recipient_kind text, user_id uuid, studio_id uuid, email text, email_verified boolean)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_provider_alerts;
  v_loc uuid;
begin
  select * into a from public.studio_sms_provider_alerts x where x.id = p_alert_id;
  if a.id is null or a.status = 'delivered' then
    return;
  end if;
  -- an administrator row carries a location too (the delivery sink needs one): the alert's own, else the earliest-linked location of the alert's legal business
  v_loc := coalesce(a.studio_id, (select es.studio_id from public.studio_sms_entity_studios es where es.legal_entity_id = a.legal_entity_id order by es.linked_at, es.studio_id limit 1));
  if a.audience in ('owner', 'both') then
    -- active studio owners of the alert's location, or of EVERY location of the alert's legal business (never another business's: the link row ties the location to it)
    return query
    select 'owner'::text, o.uid, o.sid, o.mail, true
      from (select distinct on (usr.user_id) usr.user_id as uid, usr.studio_id as sid, u.email::text as mail
              from public.user_studio_roles usr
              join public.studio_sms_entity_studios es on es.studio_id = usr.studio_id and es.legal_entity_id = a.legal_entity_id
              join auth.users u on u.id = usr.user_id
             where usr.role = 'studio_owner' and usr.active and (a.studio_id is null or usr.studio_id = a.studio_id)
               and u.email is not null and btrim(u.email) <> '' and u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
             order by usr.user_id, usr.studio_id) o
     order by o.uid limit 5;
  end if;
  if a.audience in ('admin', 'both') then
    return query
    select 'admin'::text, pr.id, v_loc, u.email::text, true
      from public.profiles pr join auth.users u on u.id = pr.id
     where pr.platform_role = 'platform_admin' and u.email is not null and btrim(u.email) <> '' and u.email_confirmed_at is not null and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
     order by pr.id limit 10;
  end if;
end $$;

create or replace function public.tw4_rfl_alert_delivery_record(p_alert_id uuid, p_claim_token uuid, p_recipient_ref text, p_recipient_kind text, p_outcome text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_provider_alerts;
  v_id uuid;
begin
  if p_recipient_kind is null or p_recipient_kind not in ('owner', 'admin') or p_outcome is null or p_outcome not in ('queued', 'duplicate', 'invalid_recipient', 'no_recipient')
     or p_recipient_ref is null or p_recipient_ref !~ '^(owner|admin):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|none)$'
     or split_part(p_recipient_ref, ':', 1) <> p_recipient_kind or (p_outcome = 'no_recipient') <> (p_recipient_ref like '%:none') then
    raise exception 'invalid delivery record (a recipient reference is <kind>:<user id>, never an email address)' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_provider_alerts x where x.id = p_alert_id for share;
  if a.id is null or p_claim_token is null or a.claim_token is distinct from p_claim_token or a.status <> 'sending' then
    return jsonb_build_object('recorded', false, 'replayed', false);   -- not the current claim
  end if;
  insert into public.studio_sms_rfl_alert_deliveries (alert_id, claim_token, recipient_ref, recipient_kind, outcome) values (a.id, p_claim_token, p_recipient_ref, p_recipient_kind, p_outcome)
  on conflict (alert_id, recipient_ref) do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('recorded', true, 'replayed', true);
  end if;
  perform public._tw4rfl_audit(coalesce(a.studio_id, public._tw4c_any_location(a.legal_entity_id)), null, 'rfl_alert_delivery', 'alert=' || a.id || ';recipient=' || p_recipient_ref || ';outcome=' || p_outcome);
  return jsonb_build_object('recorded', true, 'replayed', false);
end $$;

-- an alert whose delivery was exhausted (5 failed attempts, or a claim abandoned at the fifth) becomes ONE administrator alert. An exhausted escalation is itself not
-- escalated (that would never end); it stays visible in tw4_rfl_health.alerts_exhausted.
create or replace function public.tw4_rfl_escalate_delivery()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a record;
  v_n int := 0;
begin
  for a in select x.id, x.legal_entity_id, x.studio_id, x.resource_id, x.kind from public.studio_sms_provider_alerts x
            where x.attempts >= 5 and x.kind <> 'alert_delivery_exhausted' and (x.status = 'failed' or (x.status = 'sending' and x.claimed_at < now() - interval '15 minutes'))
            order by x.created_at, x.id loop
    if public._tw4rfl_alert(a.legal_entity_id, a.studio_id, a.resource_id, 'alert_delivery_exhausted', 'exhausted:' || a.id, 'admin', 'critical',
         'An alert (' || replace(a.kind, '_', ' ') || ') could not be delivered after repeated attempts and needs an administrator.') then
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('escalated', v_n);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- dual control (D3)
-- ---------------------------------------------------------------------------------------------------------------
-- the facts a request is bound to; recomputed at approval, at listing and at consumption (NULL = the resource is unknown). The per-resource FACT EPOCH is part of the hash:
-- it only ever increases, so a bound fact that changes and then REVERTS (a cancellation opened and withdrawn, an exposure covered and reopened) never restores the hash.
create or replace function public._tw4rflops_facts(p_action text, p_resource uuid, p_period text, p_ref_norm text, p_reason text, p_decided_by text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
  v_state text := '-';
  v_expected int;
  v_billed int := 0;
  v_ops text;
  v_epoch bigint;
begin
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource;
  if r.id is null then
    return null;
  end if;
  if p_action = 'absorb_exposure' then
    select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = p_period;
    if e.id is not null then
      v_state := e.state; v_expected := e.expected_provider_cents; v_billed := e.provider_billed_cents;
    else
      -- the exposure row is recorded by the disposition itself when no scan has yet: it will be open with the published expected cost
      v_state := 'open';
      select pl.provider_cost_cents into v_expected from public.studio_sms_price_list pl where pl.kind = r.fee_kind and pl.active;
    end if;
  end if;
  select coalesce(string_agg(o.id::text, ',' order by o.id), '') into v_ops from public.studio_sms_provider_cancel_ops o
   where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome');
  select fe.epoch into v_epoch from public.studio_sms_rfl_fact_epochs fe where fe.resource_id = r.id;
  return encode(sha256(convert_to(concat_ws('|', r.legal_entity_id::text, r.id::text, r.provider_state, p_action, coalesce(p_period, ''), v_state, coalesce(v_expected::text, '-'), v_billed::text, v_ops,
    coalesce(p_ref_norm, ''), coalesce(p_decided_by, ''), coalesce(v_epoch, 0)::text, encode(sha256(convert_to(btrim(coalesce(p_reason, '')), 'UTF8')), 'hex')), 'UTF8')), 'hex');
end $$;

-- the fact epoch moves on every change of a bound fact (never on a scan's last-detected-at / reason touch, and not when an exposure row is first recorded open without a bill)
create or replace function public._tw4rflops_epoch()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_res uuid;
begin
  if tg_table_name = 'studio_sms_provider_resources' then
    v_res := new.id;
  else
    v_res := new.resource_id;
  end if;
  insert into public.studio_sms_rfl_fact_epochs (resource_id, epoch) values (v_res, 1)
  on conflict (resource_id) do update set epoch = public.studio_sms_rfl_fact_epochs.epoch + 1;
  return null;
end $$;
create trigger studio_sms_provider_cancel_ops_90_epoch_ins after insert on public.studio_sms_provider_cancel_ops for each row execute function public._tw4rflops_epoch();
create trigger studio_sms_provider_cancel_ops_90_epoch_upd after update on public.studio_sms_provider_cancel_ops for each row when (old.status is distinct from new.status) execute function public._tw4rflops_epoch();
create trigger studio_sms_provider_exposure_90_epoch_ins after insert on public.studio_sms_provider_exposure for each row when (new.provider_billed_cents > 0 or new.state <> 'open') execute function public._tw4rflops_epoch();
create trigger studio_sms_provider_exposure_90_epoch_upd after update on public.studio_sms_provider_exposure for each row
  when (old.state is distinct from new.state or old.provider_billed_cents is distinct from new.provider_billed_cents or old.provider_charge_refs is distinct from new.provider_charge_refs
        or old.disposition is distinct from new.disposition or old.expected_provider_cents is distinct from new.expected_provider_cents) execute function public._tw4rflops_epoch();
create trigger studio_sms_provider_resources_90_epoch_upd after update on public.studio_sms_provider_resources for each row when (old.provider_state is distinct from new.provider_state) execute function public._tw4rflops_epoch();

-- enforcement: the caller holds the location link, business and credit-account locks. Finds the APPROVED, unexpired request bound to exactly this action, resource, period,
-- reason, (for a cancellation) approval reference and decision type, requested by someone who is STILL a platform administrator, re-verifies its facts (including the epoch),
-- and CONSUMES it (single use: the row is locked, and the whole call rolls back with the action). A refusal raises and rolls back, so permanent invalidation never relies on
-- it: the epoch makes a changed-then-reverted fact permanent, and the non-raising paths (approve, list, request) also mark the request invalidated.
create or replace function public._tw4rflops_consume(p_action text, r public.studio_sms_provider_resources, p_period text, p_ref text, p_reason text, p_decided_by text, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_rfl_dual_requests;
  v_norm text := case when p_ref is null then null else public._tw4fi_ref_norm(p_ref) end;
begin
  select * into q from public.studio_sms_rfl_dual_requests x
   where x.action = p_action and x.resource_id = r.id and coalesce(x.period_key, '') = coalesce(p_period, '') and x.status = 'approved'
   order by x.requested_at desc limit 1 for update;
  if q.id is null then
    raise exception 'this action needs an approved dual-control request (two distinct platform administrators): none is approved for this resource%', case when p_period is null then '' else ' and period' end using errcode = 'TW042';
  end if;
  if q.expires_at <= clock_timestamp() then
    raise exception 'the dual-control approval has expired (24 hours): request it again' using errcode = 'TW042';
  end if;
  if not public._tw4_r1_is_platform_admin(q.requested_by) or not public._tw4_r1_is_platform_admin(q.decided_by) then
    raise exception 'the administrator who requested or approved this is no longer a platform administrator: request it again' using errcode = 'TW042';
  end if;
  if q.reason is distinct from p_reason or q.approval_ref_norm is distinct from v_norm or q.cancel_decided_by is distinct from p_decided_by then
    raise exception 'the approved dual-control request is bound to a different reason, approval reference or decision type' using errcode = 'TW042';
  end if;
  if public._tw4rflops_facts(p_action, r.id, p_period, v_norm, p_reason, p_decided_by) is distinct from q.facts_hash then
    raise exception 'a fact the dual-control approval was bound to has changed: request and approve it again' using errcode = 'TW042';
  end if;
  perform set_config('tw4.rflops_write', 'on', true);
  update public.studio_sms_rfl_dual_requests set status = 'consumed', consumed_at = clock_timestamp(), consumed_by = p_actor where id = q.id;
  perform set_config('tw4.rflops_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_dual_consumed', 'request=' || q.id || ';action=' || p_action || ';resource=' || r.id);
  return q.id;
end $$;

create or replace function public.tw4_rfl_dual_request(p_actor uuid, p_action text, p_resource_id uuid, p_period_key text, p_reason text, p_approval_ref text, p_decided_by text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
  q public.studio_sms_rfl_dual_requests;
  v_period text;
  v_norm text;
  v_hash text;
  v_now timestamptz;
  v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  if p_action is null or p_action not in ('absorb_exposure', 'cancel_number') or p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'a dual-control request needs an action (absorb_exposure | cancel_number) and a written reason of 10 to 500 characters' using errcode = '22023';
  end if;
  if p_action = 'absorb_exposure' then
    if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception 'an absorption request names the service period' using errcode = '22023';
    end if;
    if p_decided_by is not null then
      raise exception 'an absorption request carries no decision type' using errcode = '22023';
    end if;
    v_period := p_period_key;
  else
    if p_approval_ref is null or char_length(btrim(p_approval_ref)) not between 10 and 200 then
      raise exception 'a number-cancellation request needs the written approval reference (10 to 200 characters)' using errcode = '22023';
    end if;
    if p_decided_by is null or p_decided_by not in ('owner_written', 'founder_written') then
      raise exception 'a number-cancellation request needs the decision type (owner_written | founder_written): a phone number is never released on a policy decision' using errcode = '22023';
    end if;
    v_norm := public._tw4fi_ref_norm(p_approval_ref);
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(r.studio_id);   -- location link, then business row, then credit account
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if p_action = 'absorb_exposure' then
    if r.fee_kind is null then
      raise exception 'a free resource has no exposure to absorb' using errcode = '22023';
    end if;
    select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = v_period for update;
    if e.id is not null then
      if e.state <> 'open' then
        raise exception 'the exposure is already closed (%)', e.disposition using errcode = 'TW041';
      end if;
    elsif v_period < public._tw4ml_month_key(r.legal_entity_id, r.registered_at) or public._tw4rfl_cover(r, v_period) like 'covered:%' or now() <= public._tw4rfl_due_from(r, v_period) then
      raise exception 'no exposure is recorded for that period' using errcode = 'TW041';
    end if;
  else
    if r.resource_kind <> 'number' then
      raise exception 'dual control covers the cancellation of a phone number only (campaign and Messaging Service cancellations are unchanged)' using errcode = '22023';
    end if;
    if r.provider_state <> 'active' then
      raise exception 'the resource is already cancelled' using errcode = 'TW041';
    end if;
    if exists (select 1 from public.studio_sms_provider_cancel_ops o where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome')) then
      raise exception 'a cancellation of this resource is already open' using errcode = 'TW043';
    end if;
    if exists (select 1 from public.studio_sms_provider_cancel_ops o where o.ref_norm = v_norm) or exists (select 1 from public.studio_sms_approval_refs ar where ar.ref_norm = v_norm) then
      raise exception 'this approval reference was already used: one written decision authorizes one cancellation, once' using errcode = 'TW043';
    end if;
  end if;
  v_hash := public._tw4rflops_facts(p_action, r.id, v_period, v_norm, p_reason, p_decided_by);
  v_now := clock_timestamp();
  -- one OPEN request per action, resource and period: the same facts replay it; an expired one is closed; one whose facts moved (or whose requester is no longer an
  -- administrator) is invalidated for good and replaced
  select * into q from public.studio_sms_rfl_dual_requests x
   where x.action = p_action and x.resource_id = r.id and coalesce(x.period_key, '') = coalesce(v_period, '') and x.status in ('pending', 'approved') for update;
  if q.id is not null then
    if q.expires_at <= v_now then
      perform set_config('tw4.rflops_write', 'on', true);
      update public.studio_sms_rfl_dual_requests set status = 'expired' where id = q.id;
      perform set_config('tw4.rflops_write', 'off', true);
    elsif q.facts_hash = v_hash and public._tw4_r1_is_platform_admin(q.requested_by) and (q.decided_by is null or public._tw4_r1_is_platform_admin(q.decided_by)) then
      return jsonb_build_object('request_id', q.id, 'facts_hash', q.facts_hash, 'expires_at', q.expires_at, 'status', q.status, 'replayed', true);
    else
      perform set_config('tw4.rflops_write', 'on', true);
      update public.studio_sms_rfl_dual_requests set status = 'invalidated' where id = q.id;
      perform set_config('tw4.rflops_write', 'off', true);
      perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_dual_invalidated', 'request=' || q.id || ';reason=superseded: different facts or the requester is no longer an administrator');
    end if;
  end if;
  insert into public.studio_sms_rfl_dual_requests (action, legal_entity_id, studio_id, resource_id, period_key, reason, approval_ref, approval_ref_norm, cancel_decided_by, facts_hash, requested_by, requested_at, expires_at)
  values (p_action, r.legal_entity_id, r.studio_id, r.id, v_period, btrim(p_reason), case when p_action = 'cancel_number' then btrim(p_approval_ref) end, v_norm, p_decided_by, v_hash, p_actor, v_now, v_now + interval '24 hours')
  returning id into v_id;
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_dual_requested', 'request=' || v_id || ';action=' || p_action || ';resource=' || r.id || ';period=' || coalesce(v_period, '-'));
  select * into q from public.studio_sms_rfl_dual_requests x where x.id = v_id;
  return jsonb_build_object('request_id', q.id, 'facts_hash', q.facts_hash, 'expires_at', q.expires_at, 'status', q.status, 'replayed', false);
end $$;

create or replace function public.tw4_rfl_dual_approve(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_rfl_dual_requests;
  r public.studio_sms_provider_resources;
  v_hash text;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an approval needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_rfl_dual_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown request' using errcode = '22023';
  end if;
  if q.requested_by = p_actor then
    raise exception 'the requester cannot approve their own request: a second platform administrator must' using errcode = '42501';
  end if;
  perform public._tw4sr_lock(q.studio_id);
  perform public._tw4rfl_lock(q.legal_entity_id);
  select * into q from public.studio_sms_rfl_dual_requests x where x.id = p_request_id for update;
  select * into r from public.studio_sms_provider_resources x where x.id = q.resource_id for update;
  if q.status = 'approved' and q.decided_by = p_actor then
    return jsonb_build_object('status', 'approved', 'replayed', true);
  end if;
  if q.status in ('expired', 'invalidated') then
    return jsonb_build_object('status', q.status, 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this request is already % and cannot be approved', q.status using errcode = 'TW041';
  end if;
  if q.expires_at <= clock_timestamp() then
    perform set_config('tw4.rflops_write', 'on', true);
    update public.studio_sms_rfl_dual_requests set status = 'expired' where id = q.id;
    perform set_config('tw4.rflops_write', 'off', true);
    return jsonb_build_object('status', 'expired', 'replayed', false);
  end if;
  v_hash := public._tw4rflops_facts(q.action, q.resource_id, q.period_key, q.approval_ref_norm, q.reason, q.cancel_decided_by);
  if v_hash is distinct from q.facts_hash or not public._tw4_r1_is_platform_admin(q.requested_by) then
    perform set_config('tw4.rflops_write', 'on', true);
    update public.studio_sms_rfl_dual_requests set status = 'invalidated' where id = q.id;
    perform set_config('tw4.rflops_write', 'off', true);
    perform public._tw4rfl_audit(q.studio_id, p_actor, 'rfl_dual_invalidated', 'request=' || q.id || ';reason=a bound fact changed (or the requester is no longer an administrator) before approval');
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  perform set_config('tw4.rflops_write', 'on', true);
  update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  perform set_config('tw4.rflops_write', 'off', true);
  perform public._tw4rfl_audit(q.studio_id, p_actor, 'rfl_dual_approved', 'request=' || q.id || ';action=' || q.action || ';resource=' || q.resource_id);
  return jsonb_build_object('status', 'approved', 'replayed', false);
end $$;

create or replace function public.tw4_rfl_dual_reject(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_rfl_dual_requests;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a rejection needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_rfl_dual_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown request' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(q.studio_id);
  perform public._tw4rfl_lock(q.legal_entity_id);
  select * into q from public.studio_sms_rfl_dual_requests x where x.id = p_request_id for update;
  if q.status = 'rejected' then
    return jsonb_build_object('status', 'rejected', 'replayed', true);
  end if;
  if q.status not in ('pending', 'approved') then
    raise exception 'this request is already % and cannot be rejected', q.status using errcode = 'TW041';
  end if;
  perform set_config('tw4.rflops_write', 'on', true);
  update public.studio_sms_rfl_dual_requests set status = 'rejected', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  perform set_config('tw4.rflops_write', 'off', true);
  perform public._tw4rfl_audit(q.studio_id, p_actor, 'rfl_dual_rejected', 'request=' || q.id || ';action=' || q.action || ';by_requester=' || (q.requested_by = p_actor));
  return jsonb_build_object('status', 'rejected', 'replayed', false);
end $$;

-- lists the open requests; on the way it closes (persistently) every one that has expired, whose bound facts moved, or whose requester is no longer an administrator.
-- Rows another transaction is working on are skipped (they are being consumed or decided right now).
create or replace function public.tw4_rfl_dual_list(p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb;
  q public.studio_sms_rfl_dual_requests;
begin
  perform public._tw4c_admin(p_actor);
  for q in select * from public.studio_sms_rfl_dual_requests x where x.status in ('pending', 'approved') order by x.requested_at, x.id for update skip locked loop
    if q.expires_at <= clock_timestamp() then
      perform set_config('tw4.rflops_write', 'on', true);
      update public.studio_sms_rfl_dual_requests set status = 'expired' where id = q.id;
      perform set_config('tw4.rflops_write', 'off', true);
    elsif public._tw4rflops_facts(q.action, q.resource_id, q.period_key, q.approval_ref_norm, q.reason, q.cancel_decided_by) is distinct from q.facts_hash
          or not public._tw4_r1_is_platform_admin(q.requested_by) or (q.decided_by is not null and not public._tw4_r1_is_platform_admin(q.decided_by)) then
      perform set_config('tw4.rflops_write', 'on', true);
      update public.studio_sms_rfl_dual_requests set status = 'invalidated' where id = q.id;
      perform set_config('tw4.rflops_write', 'off', true);
      perform public._tw4rfl_audit(q.studio_id, p_actor, 'rfl_dual_invalidated', 'request=' || q.id || ';reason=a bound fact changed (or the requester or approver is no longer an administrator)');
    end if;
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.requested_at, t.request_id), '[]'::jsonb) into v from (
    select q2.id as request_id, q2.action, q2.legal_entity_id, q2.studio_id, q2.resource_id, r.resource_kind, q2.period_key, q2.reason, q2.approval_ref, q2.cancel_decided_by, q2.cancel_decided_by as decided_by,
           e.expected_provider_cents, e.provider_billed_cents, q2.requested_by, q2.requested_at, q2.expires_at, q2.status
      from public.studio_sms_rfl_dual_requests q2 join public.studio_sms_provider_resources r on r.id = q2.resource_id
      left join public.studio_sms_provider_exposure e on e.resource_id = q2.resource_id and e.period_key = q2.period_key
     where q2.status in ('pending', 'approved') and q2.expires_at > clock_timestamp()) t;
  return v;
end $$;

-- an administrator who is demoted (or whose profile is deleted) loses every open request they made or approved AT ONCE and for good: re-promotion does not revive them.
-- (A demotion made with triggers disabled is still caught the next time approve / list / consume / request looks, and persisted then.)
create or replace function public._tw4rflops_demotion()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare q record;
begin
  if tg_op = 'UPDATE' and not (old.platform_role is not distinct from 'platform_admin' and new.platform_role is distinct from 'platform_admin') then
    return null;
  end if;
  if tg_op = 'DELETE' and old.platform_role is distinct from 'platform_admin' then
    return null;
  end if;
  for q in select x.id, x.studio_id from public.studio_sms_rfl_dual_requests x where x.status in ('pending', 'approved') and (x.requested_by = old.id or x.decided_by = old.id) order by x.id for update loop
    perform set_config('tw4.rflops_write', 'on', true);
    update public.studio_sms_rfl_dual_requests set status = 'invalidated' where id = q.id;
    perform set_config('tw4.rflops_write', 'off', true);
    perform public._tw4rfl_audit(q.studio_id, null, 'rfl_dual_invalidated', 'request=' || q.id || ';reason=an administrator of this request was demoted');
  end loop;
  return null;
end $$;
create trigger profiles_90_rflops_demotion after update of platform_role on public.profiles for each row
  when (old.platform_role is not distinct from 'platform_admin' and new.platform_role is distinct from 'platform_admin') execute function public._tw4rflops_demotion();
create trigger profiles_90_rflops_demotion_del after delete on public.profiles for each row
  when (old.platform_role is not distinct from 'platform_admin') execute function public._tw4rflops_demotion();

-- ---------------------------------------------------------------------------------------------------------------
-- replaced functions: the 20261209 bodies plus ONLY the additions marked 20261211
-- ---------------------------------------------------------------------------------------------------------------
-- delivery is a kill switch: while it is off the outbox is not claimed
create or replace function public.tw4_rfl_alerts_claim(p_limit int)
returns table (alert_id uuid, claim_token uuid, legal_entity_id uuid, studio_id uuid, kind text, audience text, severity text, summary text)
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_token uuid := gen_random_uuid();
begin
  if not public.tw4_rfl_switch_enabled('delivery') then
    return;   -- 20261211: delivery is a kill switch (default OFF, fail closed): nothing is claimed while it is off
  end if;
  return query
  with c as (
    select x.id from public.studio_sms_provider_alerts x
     where (x.status in ('pending', 'failed') or (x.status = 'sending' and x.claimed_at < now() - interval '15 minutes')) and x.attempts < 5
     order by x.created_at, x.id limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked),
  u as (
    update public.studio_sms_provider_alerts a set status = 'sending', attempts = a.attempts + 1, claim_token = v_token, claimed_at = now()
     from c where a.id = c.id returning a.*)
  select u.id, u.claim_token, u.legal_entity_id, u.studio_id, u.kind, u.audience, u.severity, u.summary from u;
end $$;

-- the 35-day notice is unchanged; the 14-day second notice and the administrator escalation are added
create or replace function public.tw4_rfl_scan_entity(p_entity_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  r public.studio_sms_provider_resources;
  v_cov text;
  v_cur text;
  v_nxt text;
  v_first text;
  k text;
  v_i int;
  v_reason text;
  v_expected int;
  v_opened int := 0;
  v_closed int := 0;
  v_alerts int := 0;
  v_pilot boolean;
  v_auth public.studio_sms_recurring_authorizations;
  v_next_total bigint := 0;
  e public.studio_sms_provider_exposure;
  v_exp_id uuid;
  v_charge record;
begin
  a := public._tw4rfl_lock(p_entity_id);
  v_pilot := exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = p_entity_id);
  v_cur := public._tw4ml_month_key(p_entity_id, now());
  v_nxt := public._tw4ml_key_add(v_cur, 1);
  for r in select * from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null order by x.id loop
    v_first := public._tw4ml_month_key(p_entity_id, r.registered_at);
    select p.provider_cost_cents into v_expected from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active;
    -- catch-up: every period since registration (at most the last 12) is judged, so a scan that did not run for a while still records what went uncovered; the
    -- sending gate looks only at the previous and the current period (history never suspends by itself)
    for v_i in -11..0 loop
      k := public._tw4ml_key_add(v_cur, v_i);
      continue when k < v_first;
      v_cov := public._tw4rfl_cover(r, k);
      select * into e from public.studio_sms_provider_exposure x where x.resource_id = r.id and x.period_key = k for update;
      if v_cov like 'covered:%' then
        if e.id is not null and e.state = 'open' and e.reason <> 'billed_after_cancellation' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), last_detected_at = now(),
                 disposition = case v_cov when 'covered:charge' then 'covered_by_charge' when 'covered:pilot_approval' then 'covered_by_pilot_approval' else 'covered_by_reservation' end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_closed', 'resource=' || r.id || ';period=' || k || ';by=' || v_cov);
          v_closed := v_closed + 1;
        end if;
      elsif now() > public._tw4rfl_due_from(r, k) or (e.id is not null and e.provider_billed_cents > 0) then
        v_reason := substr(v_cov, 11);
        if e.id is null then
          insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
          values (r.id, r.legal_entity_id, r.studio_id, k, v_reason, v_expected) returning id into v_exp_id;
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason);
          perform public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'exposure_open', 'exposure:' || v_exp_id, 'both', 'critical',
            'A recurring provider fee is running without a current authorization (' || replace(v_reason, '_', ' ') || '). Texting for this location is suspended while its current or previous period stays uncovered.');
          v_opened := v_opened + 1;
        elsif e.state = 'open' then
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set last_detected_at = now(), reason = case when e.reason = 'billed_after_cancellation' then e.reason else v_reason end where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
        elsif e.disposition in ('covered_by_charge', 'covered_by_reservation', 'covered_by_pilot_approval') then
          -- cover disappeared (a released reservation): the period is exposed again; an administrator's written disposition is final and is not reopened by time
          perform set_config('tw4.rfl_write', 'on', true);
          update public.studio_sms_provider_exposure set state = 'open', closed_at = null, disposition = null, reason = v_reason, last_detected_at = now() where id = e.id;
          perform set_config('tw4.rfl_write', 'off', true);
          perform public._tw4rfl_audit(r.studio_id, null, 'rfl_exposure_opened', 'resource=' || r.id || ';period=' || k || ';reason=' || v_reason || ';reopened=true');
          v_opened := v_opened + 1;
        end if;
      end if;
    end loop;
    -- upcoming: will the NEXT period be covered by an owner act? (alerts only; nothing is extended or charged here)
    v_cov := public._tw4rfl_cover(r, v_nxt);
    if v_cov like 'uncovered:%' then
      if v_pilot then
        if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'pilot_approval_needed', r.id || ':' || v_nxt, 'both', 'warning',
             'The ' || replace(r.resource_kind, '_', ' ') || ' fee for ' || v_nxt || ' needs a recorded written approval before that period starts.') then v_alerts := v_alerts + 1; end if;
      else
        select * into v_auth from public.studio_sms_recurring_authorizations x where x.legal_entity_id = r.legal_entity_id and x.studio_id = r.studio_id
           and x.kind = any (public._tw4rfl_charge_kinds(r.fee_kind)) and x.status = 'active' and x.expires_at > now() order by x.created_at desc limit 1;
        if v_auth.id is not null and v_auth.expires_at > public._tw4ml_month_start(p_entity_id, v_nxt) and v_auth.total_limit_cents
             - coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = v_auth.id and c.status = 'charged'), 0) >= v_auth.price_cents then
          v_next_total := v_next_total + v_auth.price_cents;   -- the standing authorization will charge it: only funding can stop it
        else
          if public._tw4rfl_alert(r.legal_entity_id, r.studio_id, r.id, 'next_period_uncovered', r.id || ':' || v_nxt, 'both', 'warning',
               'The authorization for the ' || replace(r.resource_kind, '_', ' ') || ' fee ends or reaches its limit before ' || v_nxt || '. Renew it in your texting settings to keep texting on.') then v_alerts := v_alerts + 1; end if;
        end if;
      end if;
    end if;
  end loop;
  -- authorizations ending within 35 days (once per authorization)
  for v_auth in select x.* from public.studio_sms_recurring_authorizations x where x.legal_entity_id = p_entity_id and x.status = 'active' and x.expires_at > now()
                   and x.expires_at <= now() + interval '35 days' and exists (select 1 from public.studio_sms_provider_resources rr where rr.legal_entity_id = x.legal_entity_id
                   and rr.studio_id = x.studio_id and rr.provider_state = 'active' and rr.fee_kind = any (array[x.kind, case when x.kind = 'monthly' then 'monthly_low_volume' when x.kind = 'monthly_low_volume' then 'monthly' end])) loop
    if public._tw4rfl_alert(p_entity_id, v_auth.studio_id, null, 'authorization_expiring', 'auth:' || v_auth.id, 'both', 'warning',
         'A recurring texting authorization ends on ' || to_char(v_auth.expires_at at time zone public._tw4ml_tz_for(p_entity_id, v_cur), 'YYYY-MM-DD') || '. Reauthorize it before then; DanceFlow never extends it for you.') then v_alerts := v_alerts + 1; end if;
  end loop;
  -- 20261211: the second notice and the administrator escalation, 14 days (fixed policy window) before an authorization ends without a renewal.
  -- (only ONE active authorization exists per location and kind, so the "no renewal" sub-condition matters across the two campaign kinds of one fee: monthly / monthly_low_volume)
  for v_auth in select x.* from public.studio_sms_recurring_authorizations x where x.legal_entity_id = p_entity_id and x.status = 'active' and x.expires_at > now()
                   and x.expires_at <= now() + interval '14 days' and exists (select 1 from public.studio_sms_provider_resources rr where rr.legal_entity_id = x.legal_entity_id
                   and rr.studio_id = x.studio_id and rr.provider_state = 'active' and rr.fee_kind = any (public._tw4rfl_charge_kinds(x.kind)))
                   and not exists (select 1 from public.studio_sms_recurring_authorizations nx where nx.id <> x.id and nx.legal_entity_id = x.legal_entity_id and nx.studio_id = x.studio_id
                   and nx.kind = any (public._tw4rfl_charge_kinds(x.kind)) and nx.status = 'active' and nx.expires_at > x.expires_at) loop
    if public._tw4rfl_alert(p_entity_id, v_auth.studio_id, null, 'owner_notice_second', 'auth2:' || v_auth.id, 'both', 'warning',
         'A recurring texting authorization ends on ' || to_char(v_auth.expires_at at time zone public._tw4ml_tz_for(p_entity_id, v_cur), 'YYYY-MM-DD') || ' and has not yet been renewed. Reauthorize it before then; DanceFlow never extends it for you.') then v_alerts := v_alerts + 1; end if;
    if public._tw4rfl_alert(p_entity_id, v_auth.studio_id, null, 'owner_unresponsive', 'auth:' || v_auth.id || ':escalate', 'admin', 'critical',
         'A recurring texting authorization ends within 14 days and has not yet been renewed; reminders were queued for the owner.') then v_alerts := v_alerts + 1; end if;
  end loop;
  -- funding: the next period's authorized charges versus spendable credit; negative balance; hold
  if exists (select 1 from public.studio_sms_provider_resources x where x.legal_entity_id = p_entity_id and x.provider_state = 'active' and x.fee_kind is not null) then
    if a.balance_cents < 0 then
      if public._tw4rfl_alert(p_entity_id, null, null, 'negative_balance', p_entity_id || ':' || v_cur, 'admin', 'critical', 'A business with live recurring provider resources has a negative credit balance.') then v_alerts := v_alerts + 1; end if;
    end if;
    if a.hold then
      if public._tw4rfl_alert(p_entity_id, null, null, 'account_on_hold', p_entity_id || ':' || v_cur, 'both', 'warning', 'The credit account is on hold while recurring provider resources are live.') then v_alerts := v_alerts + 1; end if;
    end if;
    if v_next_total > 0 and now() >= public._tw4ml_month_start(p_entity_id, v_nxt) - interval '7 days' and (a.balance_cents - a.reserved_cents) < v_next_total then
      if public._tw4rfl_alert(p_entity_id, null, null, 'funding_low', p_entity_id || ':' || v_nxt, 'both', 'warning',
           'Prepaid credit does not cover the recurring charges due for ' || v_nxt || '. Add credit before that period starts.') then v_alerts := v_alerts + 1; end if;
    end if;
  end if;
  -- provider-cost discrepancies on recurring kinds (once per recorded charge)
  for v_charge in select c.id from public.studio_sms_provider_charges c where c.legal_entity_id = p_entity_id and c.status = 'variance' and c.kind in ('number', 'monthly', 'monthly_low_volume') loop
    if public._tw4rfl_alert(p_entity_id, null, null, 'provider_variance', 'charge:' || v_charge.id, 'admin', 'warning', 'A recurring provider charge differs from its published expected cost.') then v_alerts := v_alerts + 1; end if;
  end loop;
  return jsonb_build_object('opened', v_opened, 'closed', v_closed, 'alerts', v_alerts);
end $$;

-- absorbing an exposure now needs an approved dual-control request (not_billed_confirmed is unchanged)
create or replace function public.tw4_rfl_exposure_dispose(p_resource_id uuid, p_period_key text, p_actor uuid, p_disposition text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  e public.studio_sms_provider_exposure;
begin
  perform public._tw4c_admin(p_actor);
  if p_disposition is null or p_disposition not in ('absorbed', 'not_billed_confirmed') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a disposition (absorbed | not_billed_confirmed) needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(r.studio_id);   -- 20261211: location link, then business row, then credit account
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into e from public.studio_sms_provider_exposure x where x.resource_id = p_resource_id and x.period_key = p_period_key for update;
  if e.id is null then
    -- the scan may not have run yet: an uncovered, past-grace period of a known resource is recorded here, then dispositioned (a covered or in-grace one is not exposure)
    if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or r.fee_kind is null or p_period_key < public._tw4ml_month_key(r.legal_entity_id, r.registered_at)
       or public._tw4rfl_cover(r, p_period_key) like 'covered:%' or now() <= public._tw4rfl_due_from(r, p_period_key) then
      raise exception 'no exposure is recorded for that period' using errcode = 'TW041';
    end if;
    insert into public.studio_sms_provider_exposure (resource_id, legal_entity_id, studio_id, period_key, reason, expected_provider_cents)
    values (r.id, r.legal_entity_id, r.studio_id, p_period_key, substr(public._tw4rfl_cover(r, p_period_key), 11),
            (select p.provider_cost_cents from public.studio_sms_price_list p where p.kind = r.fee_kind and p.active)) returning * into e;
  end if;
  if e.state = 'closed' and e.disposition = p_disposition and e.disposed_by = p_actor and e.disposition_note = btrim(p_note) then
    return jsonb_build_object('exposure_id', e.id, 'replayed', true);
  end if;
  if e.state <> 'open' then
    raise exception 'the exposure is already closed (%)', e.disposition using errcode = 'TW041';
  end if;
  if p_disposition = 'absorbed' then
    perform public._tw4rflops_consume('absorb_exposure', r, p_period_key, null, btrim(p_note), null, p_actor);   -- 20261211: dual control: an approved request from a second platform administrator
  end if;
  if p_disposition = 'not_billed_confirmed' and e.provider_billed_cents > 0 then
    raise exception 'the provider bill is recorded as evidence: this exposure can only be absorbed' using errcode = 'TW042';
  end if;
  perform set_config('tw4.rfl_write', 'on', true);
  update public.studio_sms_provider_exposure set state = 'closed', closed_at = now(), disposition = p_disposition, disposed_by = p_actor, disposition_note = btrim(p_note) where id = e.id;
  perform set_config('tw4.rfl_write', 'off', true);
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_exposure_disposed', 'resource=' || r.id || ';period=' || p_period_key || ';disposition=' || p_disposition || ';billed_cents=' || e.provider_billed_cents);
  return jsonb_build_object('exposure_id', e.id, 'replayed', false);
end $$;

-- authorizing the cancellation of a provider NUMBER now needs an approved dual-control request (campaigns and Messaging Services are unchanged)
create or replace function public.tw4_rfl_cancel_authorize(p_resource_id uuid, p_actor uuid, p_approval_ref text, p_decided_by text, p_reason text, p_irreversible_ack boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_provider_resources;
  o public.studio_sms_provider_cancel_ops;
  v_norm text;
  v_oldest timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  if p_decided_by is null or p_decided_by not in ('owner_written', 'founder_written', 'policy_lapse') or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10
     or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a cancellation needs a decision type, a written approval reference (10+ characters) and a written reason (10+ characters)' using errcode = '22023';
  end if;
  if p_irreversible_ack is distinct from true then
    raise exception 'cancelling a provider resource cannot be undone: the irreversibility acknowledgement is required' using errcode = 'TW042';
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id;
  if r.id is null then
    raise exception 'unknown resource' using errcode = '22023';
  end if;
  perform public._tw4sr_lock(r.studio_id);   -- 20261211: location link, then business row, then credit account
  perform public._tw4rfl_lock(r.legal_entity_id);
  select * into r from public.studio_sms_provider_resources x where x.id = p_resource_id for update;
  if r.provider_state <> 'active' then
    raise exception 'the resource is already cancelled' using errcode = 'TW041';
  end if;
  v_norm := public._tw4fi_ref_norm(p_approval_ref);
  select * into o from public.studio_sms_provider_cancel_ops x where x.ref_norm = v_norm;
  if o.id is not null then
    if o.resource_id = r.id and o.authorized_by = p_actor and o.decided_by = p_decided_by and o.status = 'authorized' then
      return jsonb_build_object('operation_id', o.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written decision authorizes one cancellation, once' using errcode = 'TW043';
  end if;
  if exists (select 1 from public.studio_sms_provider_cancel_ops x where x.resource_id = r.id and x.status in ('authorized', 'in_flight', 'unknown_outcome')) then
    raise exception 'a cancellation of this resource is already open' using errcode = 'TW043';
  end if;
  if r.resource_kind = 'number' then
    -- a phone number is valuable and unrecoverable: only an explicit owner / founder decision, and never while it is the live sender
    if p_decided_by = 'policy_lapse' then
      raise exception 'a phone number is never released on a policy decision: it needs the owner''s or the founder''s written decision' using errcode = 'TW042';
    end if;
    if public._tw4rfl_live_sender(r) then
      raise exception 'suspend DanceFlow sending for this location before cancelling its number' using errcode = 'TW041';
    end if;
  end if;
  if p_decided_by = 'policy_lapse' then
    select min(e.first_detected_at) into v_oldest from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.state = 'open';
    if v_oldest is null or v_oldest > now() - interval '14 days' then
      raise exception 'a lapse cancellation needs an exposure open for at least 14 days' using errcode = 'TW042';
    end if;
  end if;
  if r.resource_kind = 'number' then
    perform public._tw4rflops_consume('cancel_number', r, null, p_approval_ref, btrim(p_reason), p_decided_by, p_actor);   -- 20261211: dual control for a phone number: an approved request from a second platform administrator
  end if;
  perform public._tw4fi_register(p_approval_ref, 'cancellation', r.legal_entity_id, r.studio_id, null, null, null, null, p_actor);   -- the permanent, shared reference namespace (TW019 when used anywhere)
  insert into public.studio_sms_provider_cancel_ops (resource_id, legal_entity_id, studio_id, decided_by, approval_ref, ref_norm, reason, irreversible_ack, authorized_by)
  values (r.id, r.legal_entity_id, r.studio_id, p_decided_by, btrim(p_approval_ref), v_norm, btrim(p_reason), true, p_actor) returning * into o;
  perform public._tw4rfl_audit(r.studio_id, p_actor, 'rfl_cancel_authorized', 'operation=' || o.id || ';resource=' || r.id || ';kind=' || r.resource_kind || ';by=' || p_decided_by);
  return jsonb_build_object('operation_id', o.id, 'replayed', false);
end $$;

-- the administrator panel needs the id of the open cancellation next to its status
create or replace function public.tw4_rfl_admin_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  perform public._tw4c_admin(p_actor);
  select jsonb_build_object(
    'resources', coalesce((select jsonb_agg(jsonb_build_object(
        'resource_id', r.id, 'legal_entity_id', r.legal_entity_id, 'studio_id', r.studio_id, 'kind', r.resource_kind, 'fee_kind', r.fee_kind, 'provider_state', r.provider_state,
        'df_sending', public._tw4rfl_df_sending(r.studio_id),
        'current_period', public._tw4rfl_cover(r, public._tw4ml_month_key(r.legal_entity_id, now())),
        'next_period', public._tw4rfl_cover(r, public._tw4ml_key_add(public._tw4ml_month_key(r.legal_entity_id, now()), 1)),
        'open_cancel_operation_id', (select o.id from public.studio_sms_provider_cancel_ops o where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome')),
        'open_cancel_operation', (select o.status from public.studio_sms_provider_cancel_ops o where o.resource_id = r.id and o.status in ('authorized', 'in_flight', 'unknown_outcome')))
        order by r.registered_at, r.id) from public.studio_sms_provider_resources r), '[]'::jsonb),
    'open_exposure', coalesce((select jsonb_agg(jsonb_build_object('resource_id', e.resource_id, 'period_key', e.period_key, 'reason', e.reason, 'expected_provider_cents', e.expected_provider_cents,
        'provider_billed_cents', e.provider_billed_cents, 'first_detected_at', e.first_detected_at) order by e.first_detected_at) from public.studio_sms_provider_exposure e where e.state = 'open'), '[]'::jsonb),
    'open_exposure_expected_cents', coalesce((select sum(coalesce(e.expected_provider_cents, 0)) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'open_exposure_billed_cents', coalesce((select sum(e.provider_billed_cents) from public.studio_sms_provider_exposure e where e.state = 'open'), 0),
    'alerts_waiting', (select count(*) from public.studio_sms_provider_alerts a where a.status <> 'delivered'),
    'cancel_operations_open', (select count(*) from public.studio_sms_provider_cancel_ops o where o.status in ('authorized', 'in_flight', 'unknown_outcome'))) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privacy: an email addressed to a platform administrator is queued under a studio (outbound_deliveries.studio_id) and the existing SELECT policies let that studio's staff
-- read recipient_email / subject / body. Admin-addressed templates are keyed platform_rfl_admin_<kind>: every SELECT policy open to API roles gets the same predicate
-- PLUS "and template_key does not start with platform_rfl_admin_". The originals are kept (studio_sms_rfl_policy_backup) so the rollback restores them exactly.
-- service_role and the table owner are unaffected (they bypass RLS / have their own ALL policy).
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_rfl_policy_backup (
  policy_name text primary key,
  table_name text not null,
  cmd text not null check (cmd in ('r', '*')),   -- SELECT or ALL (the SELECT-capable permissive policies)
  role_names text[] not null,                    -- empty = PUBLIC
  original_qual text not null,
  original_check text null,
  rewritten_qual text not null
);
revoke all on public.studio_sms_rfl_policy_backup from public, anon, authenticated, service_role;
alter table public.studio_sms_rfl_policy_backup enable row level security;
do $$
declare
  p record;
  v_new text;
  v_applies boolean;
  v_roles text[];
  v_n int := 0;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.outbound_deliveries'::regclass) then
    raise exception 'rfl-ops precondition failed: row level security is not enabled on outbound_deliveries';
  end if;
  -- every PERMISSIVE policy that can grant SELECT (FOR SELECT or FOR ALL) to anyone who is not a privileged role (service_role, postgres, a superuser) is narrowed.
  -- A FOR ALL policy gets only its USING rewritten (its WITH CHECK is kept; when it had none, the old USING becomes its explicit WITH CHECK so writes behave as before).
  -- A policy this block cannot rewrite safely makes the whole migration fail (nothing is applied).
  for p in select pol.polname as name, pol.polcmd as cmd, pol.polroles as roles, pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as wc
             from pg_policy pol where pol.polrelid = 'public.outbound_deliveries'::regclass and pol.polpermissive and pol.polcmd in ('r', '*') order by pol.polname loop
    if p.roles = '{0}'::oid[] then
      v_applies := true;   -- PUBLIC
    else
      v_applies := exists (select 1 from pg_roles r where r.oid = any (p.roles) and r.rolname not in ('service_role', 'postgres') and not r.rolsuper);
    end if;
    continue when not v_applies;
    if p.qual is null then
      raise exception 'rfl-ops precondition failed: policy % can grant SELECT but has no USING expression; it cannot be restricted safely', p.name;
    end if;
    if position('platform\_rfl\_admin\_' in p.qual) > 0 then
      raise exception 'rfl-ops precondition failed: policy % already hides administrator templates', p.name;
    end if;
    v_roles := case when p.roles = '{0}'::oid[] then '{}'::text[] else array(select r.rolname::text from pg_roles r where r.oid = any (p.roles) order by r.rolname) end;
    v_new := '(' || p.qual || ') and not coalesce(template_key like ''platform\_rfl\_admin\_%'', false)';
    insert into public.studio_sms_rfl_policy_backup (policy_name, table_name, cmd, role_names, original_qual, original_check, rewritten_qual)
    values (p.name, 'outbound_deliveries', p.cmd, v_roles, p.qual, p.wc, v_new);
    execute format('alter policy %I on public.outbound_deliveries using (%s)%s', p.name, v_new, case when p.cmd = '*' and p.wc is null then format(' with check (%s)', p.qual) else '' end);
    v_n := v_n + 1;
  end loop;
  -- fail closed: nothing SELECT-capable for a non-privileged role may be left without the exclusion
  if exists (select 1 from pg_policy pol where pol.polrelid = 'public.outbound_deliveries'::regclass and pol.polpermissive and pol.polcmd in ('r', '*')
               and (pol.polroles = '{0}'::oid[] or exists (select 1 from pg_roles r where r.oid = any (pol.polroles) and r.rolname not in ('service_role', 'postgres') and not r.rolsuper))
               and position('platform\_rfl\_admin\_' in coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')) = 0) then
    raise exception 'rfl-ops precondition failed: a SELECT-capable policy on outbound_deliveries could not be restricted';
  end if;
end $$;

-- the identity sequence of the switch log keeps no API-role grant (Supabase default privileges would otherwise hand them out)
revoke all on sequence public.studio_sms_rfl_switch_log_seq_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4rflops_guard(), public._tw4rflops_request_insert(), public._tw4rflops_epoch(), public._tw4rflops_demotion(), public._tw4rflops_facts(text, uuid, text, text, text, text),
  public._tw4rflops_consume(text, public.studio_sms_provider_resources, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_rfl_switch_enabled(text), public.tw4_rfl_set_switch(text, boolean, uuid, text), public.tw4_rfl_scan_begin(text, int), public.tw4_rfl_scan_finish(uuid, text, jsonb, text),
  public.tw4_rfl_health(uuid), public.tw4_rfl_exposure_report(uuid), public.tw4_rfl_variance_report(uuid), public.tw4_rfl_variance_ack(uuid, uuid, text),
  public.tw4_rfl_alert_recipients(uuid), public.tw4_rfl_alert_delivery_record(uuid, uuid, text, text, text), public.tw4_rfl_escalate_delivery(),
  public.tw4_rfl_dual_request(uuid, text, uuid, text, text, text, text), public.tw4_rfl_dual_approve(uuid, uuid, text), public.tw4_rfl_dual_reject(uuid, uuid, text),
  public.tw4_rfl_dual_list(uuid) from public, anon, authenticated;
grant execute on function public.tw4_rfl_switch_enabled(text), public.tw4_rfl_set_switch(text, boolean, uuid, text), public.tw4_rfl_scan_begin(text, int), public.tw4_rfl_scan_finish(uuid, text, jsonb, text),
  public.tw4_rfl_health(uuid), public.tw4_rfl_exposure_report(uuid), public.tw4_rfl_variance_report(uuid), public.tw4_rfl_variance_ack(uuid, uuid, text),
  public.tw4_rfl_alert_recipients(uuid), public.tw4_rfl_alert_delivery_record(uuid, uuid, text, text, text), public.tw4_rfl_escalate_delivery(),
  public.tw4_rfl_dual_request(uuid, text, uuid, text, text, text, text), public.tw4_rfl_dual_approve(uuid, uuid, text), public.tw4_rfl_dual_reject(uuid, uuid, text),
  public.tw4_rfl_dual_list(uuid) to service_role;

commit;
