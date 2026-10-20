-- 20261205090000_twilio_usage_reconciliation.sql
-- Scheduled SMS usage reconciliation and stale-reservation recovery (owner handoff "TW-4F - Scheduled SMS Reconciliation & Financial Integrity",
-- 2026-10-20; design docs/twilio/TW-4F_Usage_Reconciliation_Design.md). Connects the existing pieces; NO second ledger: every money movement still goes
-- through the 20261201 / 20261203 functions and the credit ledger.
--   * Runs: one lease per job (usage_reconcile; sender_reverify reserved for the 24 h re-verify), a stale lease is closed as failed, every run is recorded with
--     its counts. Writes that only a run makes (stale releases, escalation, inbound recovery, inbound checkpoints) are FENCED by a live lease.
--   * Outbound evidence: tw4_usage_settle now also checks the evidence's IDENTITY (direction, Messaging Service, sender number, destination, the attempt's
--     subaccount belonging to its legal business) and TIMESTAMPS (created inside the send window). Any mismatch goes to review; nothing is charged or released
--     on evidence that does not prove it is this text. A provider price far above the expected cost, or a text with no final status after 7 days, goes to review.
--   * Evidence that cannot be read: tw4_usage_evidence_failed counts failures with backoff (5 min doubling, at most 6 h). A definite failure (404, mismatch)
--     goes to review at once; a transient one (timeout, 5xx, credentials) goes to review after 12 failures and 24 h. NEVER a release.
--   * Stale reservations: tw4_usage_release_stale releases ONLY attempts still 'reserved' (no dispatch marker: definitive no-dispatch) older than 10 minutes,
--     bounded per run. An attempt with a marker ('submitting' / 'unknown') or a SID is never released by a timer: it is escalated (escalated_at) for a platform
--     admin's written resolution (tw4_usage_resolve, unchanged).
--   * Inbound recovery: tw4_inbound_recover records a text the webhook missed from the subaccount's own Message resource through tw4_inbound_record (source
--     'reconciler'), so the D1 ceiling, pilot no-debt, recurring protection and compliance exclusions are the SAME rules. Classification fails safe: anything
--     not provably ordinary (keyword, uncertain, incomplete evidence) is recorded as compliance (never charged). Per-subaccount checkpoints only move forward.
--   * Platform-admin read: tw4_usage_reconcile_overview (runs, lag, open/escalated attempts, inbound recovery, gaps). Identifiers and counts; no bodies or numbers.
--   * History: every attempt state change or evidence write from here on is appended to studio_sms_usage_attempt_events by a trigger (money facts only).
-- Requires 20261204090000. Rollback: rollback/20261205090000_twilio_usage_reconciliation_rollback.sql (refuses once any run, checkpoint, recovery or
-- reconciliation evidence exists). NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_usage_release_unprepared(uuid,text)') is null or to_regprocedure('public.tw4_inbound_record(uuid,text,text,int,int,text,text,timestamptz,text)') is null
     or to_regprocedure('public.tw4_inbound_studio_for(text,text,text)') is null then
    raise exception 'usage-reconciliation precondition failed: sender readiness (20261204090000) is not applied';
  end if;
  if to_regclass('public.studio_sms_reconcile_runs') is not null then
    raise exception 'usage-reconciliation precondition failed: already applied';
  end if;
  -- the functions replaced below must still be the 20261201 versions (another slice must not be clobbered silently)
  if position('only a submitted text is settled from evidence' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_settle(uuid,jsonb)'::regprocedure)) = 0
     or position('y.last_reconciled_at < now() - interval ''10 minutes''' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_usage_due(int)'::regprocedure)) = 0 then
    raise exception 'usage-reconciliation precondition failed: tw4_usage_settle / tw4_usage_due differ from 20261201090000';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges)
-- ---------------------------------------------------------------------------------------------------------------
-- one lease per job; a run only goes running -> completed | failed (once)
create table public.studio_sms_reconcile_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null check (job in ('usage_reconcile', 'sender_reverify')),
  runner text not null check (char_length(btrim(runner)) between 3 and 80),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz null,
  summary jsonb null check (summary is null or (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 8192)),
  error text null check (error is null or char_length(error) <= 300),
  constraint studio_sms_reconcile_runs_finished check ((status = 'running') = (finished_at is null))
);
create unique index studio_sms_reconcile_runs_one_running on public.studio_sms_reconcile_runs (job) where status = 'running';
create index studio_sms_reconcile_runs_recent on public.studio_sms_reconcile_runs (job, started_at desc);

-- inbound recovery checkpoint per subaccount: every inbound text created up to scanned_through has been examined. Only moves forward.
create table public.studio_sms_inbound_scan_cursors (
  account_sid text primary key check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  scanned_through timestamptz not null,
  last_run_id uuid not null references public.studio_sms_reconcile_runs(id),
  updated_at timestamptz not null default clock_timestamp()
);

-- one row per inbound text the reconciler recorded (the webhook had not): why it was classified as it was, and whether the webhook was seen at all
create table public.studio_sms_inbound_recoveries (
  provider_sid text primary key check (provider_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  studio_id uuid not null,
  run_id uuid not null references public.studio_sms_reconcile_runs(id),
  classification text not null check (classification in ('ordinary', 'compliance')),
  basis text not null check (basis in ('ordinary', 'keyword', 'uncertain', 'incomplete')),
  webhook_seen boolean not null,
  -- an opt-out keyword: whether its consent effect (the canonical STOP) was applied by the recovery (null for anything else)
  consent_applied boolean null,
  -- an uncertain text containing an opt-out word ("please stop texting"): not applied (the webhook would not have either), listed for a person
  possible_opt_out boolean not null default false,
  charged_cents int not null check (charged_cents >= 0),
  recovered_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_inbound_recoveries_basis check ((classification = 'ordinary') = (basis = 'ordinary')),
  constraint studio_sms_inbound_recoveries_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_inbound_recoveries_recent on public.studio_sms_inbound_recoveries (recovered_at desc);

-- listed inbound texts the reconciler could NOT record: unroutable (no sender row for that number) or refused by the database. Unresolved evidence for a
-- person (nothing is guessed, nothing is charged); identifiers only.
create table public.studio_sms_inbound_unresolved (
  provider_sid text primary key check (provider_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  run_id uuid not null references public.studio_sms_reconcile_runs(id),
  reason text not null check (reason in ('unrouted', 'refused')),
  code text null check (code is null or code ~ '^[A-Za-z0-9_]{3,20}$'),
  noted_at timestamptz not null default clock_timestamp()
);
create index studio_sms_inbound_unresolved_recent on public.studio_sms_inbound_unresolved (noted_at desc);

-- reconciliation state on the attempt (written only through the usage functions, like every other attempt column)
alter table public.studio_sms_usage_attempts add column evidence_failures int not null default 0 check (evidence_failures >= 0);
alter table public.studio_sms_usage_attempts add column evidence_error_code text null check (evidence_error_code is null or evidence_error_code ~ '^[a-z][a-z0-9_]{2,59}$');
alter table public.studio_sms_usage_attempts add column evidence_next_at timestamptz null;
alter table public.studio_sms_usage_attempts add column evidence_created_at timestamptz null;
alter table public.studio_sms_usage_attempts add column escalated_at timestamptz null;
create index studio_sms_usage_attempts_due on public.studio_sms_usage_attempts (last_reconciled_at nulls first, submitted_at) where state = 'submitted';

revoke all on public.studio_sms_reconcile_runs, public.studio_sms_inbound_scan_cursors, public.studio_sms_inbound_recoveries, public.studio_sms_inbound_unresolved
  from public, anon, authenticated, service_role;
alter table public.studio_sms_inbound_unresolved enable row level security;
alter table public.studio_sms_reconcile_runs enable row level security;
alter table public.studio_sms_inbound_scan_cursors enable row level security;
alter table public.studio_sms_inbound_recoveries enable row level security;

create or replace function public._tw4ur_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'studio_sms_reconcile_runs' then
    if old.status <> 'running' or new.status = 'running' or new.id <> old.id or new.job <> old.job or new.runner <> old.runner or new.started_at <> old.started_at
       or new.lease_expires_at <> old.lease_expires_at then
      raise exception 'a finished reconciliation run is final' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'studio_sms_inbound_scan_cursors' then
    if new.account_sid <> old.account_sid or new.legal_entity_id <> old.legal_entity_id or new.scanned_through < old.scanned_through then
      raise exception 'an inbound checkpoint only moves forward' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_reconcile_runs_guard before update or delete on public.studio_sms_reconcile_runs for each row execute function public._tw4ur_guard();
create trigger studio_sms_inbound_scan_cursors_guard before update or delete on public.studio_sms_inbound_scan_cursors for each row execute function public._tw4ur_guard();
create trigger studio_sms_inbound_recoveries_guard before update or delete on public.studio_sms_inbound_recoveries for each row execute function public._tw4ur_guard();
create trigger studio_sms_inbound_unresolved_guard before update or delete on public.studio_sms_inbound_unresolved for each row execute function public._tw4ur_guard();
create trigger studio_sms_inbound_unresolved_truncate before truncate on public.studio_sms_inbound_unresolved for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_reconcile_runs_truncate before truncate on public.studio_sms_reconcile_runs for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_scan_cursors_truncate before truncate on public.studio_sms_inbound_scan_cursors for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_recoveries_truncate before truncate on public.studio_sms_inbound_recoveries for each statement execute function public._tw4c_truncate_guard();

-- auditable transition history of every billed text from here on: one row per state change or evidence write, whichever function made it (a trigger,
-- so no path can skip it). A snapshot of the money-relevant facts only: no body, no client number.
create table public.studio_sms_usage_attempt_events (
  id bigserial primary key,
  attempt_id uuid not null references public.studio_sms_usage_attempts(id),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  from_state text null,
  to_state text not null,
  facts jsonb not null,
  at timestamptz not null default clock_timestamp()
);
create index studio_sms_usage_attempt_events_attempt on public.studio_sms_usage_attempt_events (attempt_id, id);
revoke all on public.studio_sms_usage_attempt_events from public, anon, authenticated, service_role;
revoke all on sequence public.studio_sms_usage_attempt_events_id_seq from public, anon, authenticated, service_role;
alter table public.studio_sms_usage_attempt_events enable row level security;
create trigger studio_sms_usage_attempt_events_guard before update or delete on public.studio_sms_usage_attempt_events for each row execute function public._tw4ur_guard();
create trigger studio_sms_usage_attempt_events_truncate before truncate on public.studio_sms_usage_attempt_events for each statement execute function public._tw4c_truncate_guard();

create or replace function public._tw4ur_attempt_event()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- a repeated read that learns nothing new (same status, segments and price) is not a transition: no row (a pending text is read every 10 minutes)
  if tg_op = 'UPDATE' and new.state is not distinct from old.state and new.evidence_status is not distinct from old.evidence_status
     and new.evidence_segments is not distinct from old.evidence_segments and new.evidence_price_micros is not distinct from old.evidence_price_micros
     and new.evidence_failures is not distinct from old.evidence_failures and new.escalated_at is not distinct from old.escalated_at
     and new.provider_sid is not distinct from old.provider_sid and new.callback_rank is not distinct from old.callback_rank then
    return null;
  end if;
  insert into public.studio_sms_usage_attempt_events (attempt_id, legal_entity_id, from_state, to_state, facts)
  values (new.id, new.legal_entity_id, case when tg_op = 'UPDATE' then old.state end, new.state, jsonb_strip_nulls(jsonb_build_object(
    'has_provider_message', new.provider_sid is not null, 'callback_status', new.callback_status, 'evidence_status', new.evidence_status,
    'evidence_segments', new.evidence_segments, 'evidence_media', new.evidence_media, 'evidence_price_micros', new.evidence_price_micros,
    'evidence_price_unit', new.evidence_price_unit, 'evidence_created_at', new.evidence_created_at, 'evidence_failures', nullif(new.evidence_failures, 0),
    'evidence_error_code', new.evidence_error_code, 'submit_error_code', new.submit_error_code, 'review_reason', new.review_reason,
    'charged_cents', new.charged_cents, 'reserved_cents', new.reserved_cents, 'resolved_outcome', new.resolved_outcome, 'resolved_by', new.resolved_by,
    'escalated', new.escalated_at is not null)));
  return null;
end $$;
create trigger studio_sms_usage_attempts_90_events after insert or update on public.studio_sms_usage_attempts for each row execute function public._tw4ur_attempt_event();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
-- raises unless the run holds a live lease for the job (a writer that lost its lease must stop; errcode TW023, not 40001: PostgREST retries those)
create or replace function public._tw4ur_fence(p_run_id uuid, p_job text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_run_id is null or not exists (select 1 from public.studio_sms_reconcile_runs r where r.id = p_run_id and r.job = p_job and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the reconciliation run is not active' using errcode = 'TW023';
  end if;
end $$;

-- the account is (or was) this legal business's own subaccount: evidence is only ever read through, and only ever matches, the business's own account
create or replace function public._tw4ur_account_of(p_entity uuid, p_account text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.studio_sms_twilio_accounts t where t.legal_entity_id = p_entity and t.twilio_account_sid = p_account); $$;

-- an ISO-8601 instant with an explicit zone (what the provider seam sends), else null; never raises
create or replace function public._tw4ur_instant(p text)
returns timestamptz language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------------------------------------------
-- takes the job's single lease (an expired one is closed as failed first). Overlapping invocations get {acquired:false, reason:'busy'}.
create or replace function public.tw4_reconcile_run_begin(p_job text, p_runner text, p_lease_seconds int default 300)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_job is null or p_job not in ('usage_reconcile', 'sender_reverify') or p_runner is null or char_length(btrim(p_runner)) not between 3 and 80
     or p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid reconciliation run' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_reconcile_run:' || p_job));
  update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'lease expired before the run finished'
   where job = p_job and status = 'running' and lease_expires_at <= clock_timestamp();
  insert into public.studio_sms_reconcile_runs (job, runner, lease_expires_at) values (p_job, btrim(p_runner), clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict (job) where status = 'running' do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('acquired', false, 'reason', 'busy');
  end if;
  return jsonb_build_object('acquired', true, 'run_id', v_id,
                            'lease_expires_at', (select r.lease_expires_at from public.studio_sms_reconcile_runs r where r.id = v_id));
end $$;

-- records the outcome once (a finished run is final; a repeat is a replay). A run whose lease expired is still recorded as it reports.
create or replace function public.tw4_reconcile_run_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.studio_sms_reconcile_runs;
begin
  if p_status is null or p_status not in ('completed', 'failed') or (p_summary is not null and jsonb_typeof(p_summary) <> 'object') then
    raise exception 'invalid run outcome' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_reconcile_runs x where x.id = p_run_id for update;
  if r.id is null then
    raise exception 'unknown reconciliation run' using errcode = '22023';
  end if;
  if r.status <> 'running' then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  update public.studio_sms_reconcile_runs set status = p_status, finished_at = clock_timestamp(), summary = p_summary, error = left(p_error, 300) where id = r.id;
  return jsonb_build_object('status', p_status, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- outbound: stale reservations, evidence, escalation
-- ---------------------------------------------------------------------------------------------------------------
-- releases at most p_limit attempts still 'reserved' (NO dispatch marker: the marker is written before any provider call and is exclusive with this
-- release under the attempt lock, so these definitely never reached the provider) and older than 10 minutes. Includes a transient credentials_unavailable
-- attempt that its delivery never retried. Nothing else is touched.
create or replace function public.tw4_usage_release_stale(p_run_id uuid, p_limit int default 200)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  a public.studio_sms_usage_attempts;
  n int := 0;
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  -- the oldest batch, locked business by business (the order tw4_usage_release_unsent uses), so two releasers never wait on each other in a cycle
  for r in select q.id from (select x.id, x.legal_entity_id, x.created_at from public.studio_sms_usage_attempts x where x.state = 'reserved' and x.created_at < now() - interval '10 minutes'
                              order by x.created_at limit least(greatest(coalesce(p_limit, 200), 1), 500)) q order by q.legal_entity_id, q.created_at loop
    a := public._tw4us_lock_attempt(r.id);
    if a.state = 'reserved' and a.created_at < now() - interval '10 minutes' then
      perform public._tw4us_release_reservation(a, 'never_sent');
      update public.studio_sms_usage_attempts set state = 'released', closed_at = clock_timestamp(), submit_error_code = coalesce(submit_error_code, 'stale_unmarked') where id = a.id;
      update public.sms_message_logs set status = 'failed', provider_error_code = 'not_sent', failed_at = now(), updated_at = now() where id = a.message_log_id;
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('released', n);
end $$;

-- evidence from the provider's Message resource. As 20261201090000 (charge table on STATUS; price is cost evidence only), plus identity and time checks:
-- nothing is charged or released on evidence that does not prove it describes THIS text.
create or replace function public.tw4_usage_settle(p_attempt_id uuid, p_evidence jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_status text := lower(coalesce(p_evidence->>'status', ''));
  v_sid text := p_evidence->>'sid';
  v_account text := p_evidence->>'account_sid';
  v_direction text := lower(coalesce(p_evidence->>'direction', ''));
  v_mg text := nullif(p_evidence->>'messaging_service_sid', '');
  v_from text := nullif(p_evidence->>'from', '');
  v_to text := nullif(p_evidence->>'to', '');
  v_created timestamptz := public._tw4ur_instant(p_evidence->>'date_created');
  v_phone text;
  v_segments int;
  v_media int;
  v_price numeric;
  v_unit text := upper(nullif(btrim(coalesce(p_evidence->>'price_unit', '')), ''));
  v_pending boolean;
  v_review text;
  v_cents int;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'invalid evidence' using errcode = '22023';
  end if;
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state = 'settled' then
    return jsonb_build_object('outcome', 'settled', 'charged_cents', a.charged_cents, 'replayed', true);
  end if;
  if a.state <> 'submitted' or a.provider_sid is null then
    raise exception 'only a submitted text is settled from evidence (state %)', a.state using errcode = '22023';
  end if;
  if v_sid is distinct from a.provider_sid or v_account is distinct from a.account_sid then
    raise exception 'the evidence is for another message or account' using errcode = '42501';
  end if;
  if coalesce(p_evidence->>'num_segments', '') ~ '^[0-9]{1,3}$' then v_segments := (p_evidence->>'num_segments')::int; end if;
  if coalesce(p_evidence->>'num_media', '') ~ '^[0-9]{1,3}$' then v_media := (p_evidence->>'num_media')::int; end if;
  if coalesce(p_evidence->>'price', '') ~ '^-?[0-9]{1,6}(\.[0-9]{1,10})?$' then v_price := abs((p_evidence->>'price')::numeric) * 1000000; end if;
  select l.phone_e164 into v_phone from public.sms_message_logs l where l.id = a.message_log_id;
  v_pending := v_status in ('accepted', 'scheduled', 'queued', 'sending', 'sent');
  update public.studio_sms_usage_attempts
     set evidence_status = left(v_status, 40), evidence_segments = v_segments, evidence_media = v_media, evidence_price_micros = v_price,
         evidence_price_unit = left(v_unit, 10), evidence_at = clock_timestamp(), last_reconciled_at = clock_timestamp(), evidence_created_at = v_created,
         evidence_failures = 0, evidence_error_code = null, evidence_next_at = null
   where id = a.id;

  -- 20261205: identity and time. Checked BEFORE the status table, so a mismatched 'failed' is never released either.
  if not public._tw4ur_account_of(a.legal_entity_id, a.account_sid) then
    v_review := 'the subaccount does not belong to the business';
  elsif v_direction <> 'outbound-api' then
    v_review := 'evidence is not an outbound API message';
  elsif v_mg is distinct from a.messaging_service_sid then
    v_review := 'evidence names another Messaging Service';
  elsif v_to is distinct from v_phone then
    v_review := 'evidence names another destination';
  elsif a.sender_e164 is not null and v_from is not null and v_from <> a.sender_e164 then
    v_review := 'evidence names another sender number';
  elsif a.sender_e164 is not null and v_from is null and not v_pending then
    v_review := 'evidence has no sender number';
  elsif v_created is null then
    v_review := 'evidence has no creation time';
  elsif v_created < coalesce(a.submitting_at, a.created_at) - interval '5 minutes' or v_created > clock_timestamp() + interval '5 minutes'
        or (a.submitted_at is not null and v_created > a.submitted_at + interval '5 minutes') then
    v_review := 'evidence was created outside the send window';
  end if;

  if v_review is null then
    if v_status in ('failed', 'canceled') then
      perform public._tw4us_release_reservation(a, 'not_charged:' || v_status);
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 0, closed_at = clock_timestamp() where id = a.id;
      update public.sms_message_logs set status = 'failed', failed_at = now(), updated_at = now() where id = a.message_log_id;
      return jsonb_build_object('outcome', 'settled', 'charged_cents', 0, 'replayed', false);
    elsif a.provider_sid like 'MM%' or coalesce(v_media, 0) > 0 then
      v_review := 'multimedia message';
    elsif v_price is not null and v_unit is distinct from 'USD' then
      v_review := 'price not in USD';
    elsif v_status in ('delivered', 'undelivered', 'read') or (v_status = 'sent' and a.submitted_at < now() - interval '72 hours') then
      if v_segments is null or v_segments < 1 or v_segments > 10 or v_segments > a.estimated_segments + 2 then
        v_review := 'segment count outside the expected range';
      elsif v_price is not null and v_price > greatest(a.unit_provider_cost_cents, 1)::numeric * 10000 * v_segments * 5 then
        v_review := 'provider price far above the expected cost';
      else
        v_cents := public._tw4us_charge(a, v_segments, 'evidence:' || v_status);
        update public.studio_sms_usage_attempts set state = 'settled', charged_cents = v_cents, closed_at = clock_timestamp() where id = a.id;
        update public.sms_message_logs set status = case when v_status = 'undelivered' then 'failed' when v_status = 'sent' then 'sent' else 'delivered' end,
               segment_count = v_segments, delivered_at = case when v_status in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end, updated_at = now()
         where id = a.message_log_id;
        return jsonb_build_object('outcome', 'settled', 'charged_cents', v_cents, 'replayed', false);
      end if;
    elsif v_pending then
      if a.submitted_at < now() - interval '7 days' then
        v_review := 'no final status after 7 days';
      else
        return jsonb_build_object('outcome', 'pending', 'replayed', false);
      end if;
    else
      v_review := 'unrecognized provider status';
    end if;
  end if;
  update public.studio_sms_usage_attempts set state = 'review', review_reason = v_review, closed_at = null, escalated_at = coalesce(escalated_at, clock_timestamp()) where id = a.id;
  return jsonb_build_object('outcome', 'review', 'reason', v_review, 'replayed', false);
end $$;

-- the evidence of a submitted text could not be read. Bounded retries with backoff; a definite failure (the provider says no such message on this
-- account, or the answer does not match) goes to review at once, a transient one after 12 failures AND 24 hours. Never a release, never a charge.
create or replace function public.tw4_usage_evidence_failed(p_attempt_id uuid, p_code text, p_definite boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  n int;
  v_next timestamptz;
begin
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{2,59}$' or p_definite is null then
    raise exception 'a short error code and whether it is definite are required' using errcode = '22023';
  end if;
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state <> 'submitted' then
    return jsonb_build_object('outcome', 'skipped', 'state', a.state);   -- settled, reviewed or resolved meanwhile: nothing to record
  end if;
  n := a.evidence_failures + 1;
  -- a 404 right after the send can be the provider not having the new message readable yet: definite only once the text is 15 minutes old
  if p_definite and p_code = 'usage_evidence_http_404' and a.submitted_at > now() - interval '15 minutes' then
    p_definite := false;
  end if;
  if p_definite or (n >= 12 and a.submitted_at < now() - interval '24 hours') then
    update public.studio_sms_usage_attempts
       set state = 'review', review_reason = left('evidence unavailable: ' || p_code, 200), evidence_failures = n, evidence_error_code = p_code, closed_at = null,
           last_reconciled_at = clock_timestamp(), evidence_next_at = null, escalated_at = coalesce(escalated_at, clock_timestamp())
     where id = a.id;
    return jsonb_build_object('outcome', 'review', 'failures', n);
  end if;
  v_next := clock_timestamp() + least(interval '6 hours', interval '5 minutes' * power(2, least(n - 1, 7)));
  update public.studio_sms_usage_attempts set evidence_failures = n, evidence_error_code = p_code, last_reconciled_at = clock_timestamp(), evidence_next_at = v_next where id = a.id;
  return jsonb_build_object('outcome', 'retry', 'failures', n, 'next_at', v_next);
end $$;

-- the reconciler's work list (as 20261201090000 plus the backoff): submitted texts not read in the last 10 minutes and past their retry time, oldest first,
-- only where the attempt's frozen account is its legal business's own subaccount (any other is escalated, never read)
create or replace function public.tw4_usage_due(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('attempt_id', x.id, 'account_sid', x.account_sid, 'provider_sid', x.provider_sid) order by x.last_reconciled_at nulls first, x.submitted_at)
    from (select * from public.studio_sms_usage_attempts y
           where y.state = 'submitted' and y.provider_sid is not null and (y.last_reconciled_at is null or y.last_reconciled_at < now() - interval '10 minutes')
             and (y.evidence_next_at is null or y.evidence_next_at <= now()) and public._tw4ur_account_of(y.legal_entity_id, y.account_sid)
           order by y.last_reconciled_at nulls first, y.submitted_at limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;
comment on function public.tw4_usage_due(int) is 'the reconciler''s work list (20261205090000: backoff and cross-tenant filter)';

-- escalation: open attempts that only a platform admin can resolve are stamped once (escalated_at) so the panel and alerts see them. A text with a dispatch
-- marker and no SID keeps its state (a late SID or callback must still bind), so it is NEVER released here. A submitted text whose account is not its
-- business's subaccount goes to review. Returns how many were newly escalated.
create or replace function public.tw4_usage_escalate(p_run_id uuid, p_limit int default 200)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  a public.studio_sms_usage_attempts;
  n_marked int := 0;
  n_review int := 0;
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  for r in select x.id from public.studio_sms_usage_attempts x
            where x.state = 'submitted' and not public._tw4ur_account_of(x.legal_entity_id, x.account_sid) order by x.legal_entity_id, x.created_at limit v_limit loop
    a := public._tw4us_lock_attempt(r.id);
    if a.state = 'submitted' and not public._tw4ur_account_of(a.legal_entity_id, a.account_sid) then
      update public.studio_sms_usage_attempts set state = 'review', review_reason = 'the subaccount does not belong to the business', closed_at = null,
             escalated_at = coalesce(escalated_at, clock_timestamp())
       where id = a.id;
      n_review := n_review + 1;
    end if;
  end loop;
  perform public._tw4us_write();
  with picked as (
    select x.id from public.studio_sms_usage_attempts x
     where x.escalated_at is null
       and (x.state = 'review' or (x.state in ('submitting', 'unknown') and coalesce(x.submitting_at, x.created_at) < now() - interval '15 minutes')
            or (x.state = 'submitted' and x.submitted_at < now() - interval '7 days'))
     order by x.created_at limit v_limit
     for update skip locked)
  update public.studio_sms_usage_attempts u set escalated_at = clock_timestamp() from picked where u.id = picked.id;
  get diagnostics n_marked = row_count;
  return jsonb_build_object('escalated', n_marked + n_review, 'reviewed', n_review);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- inbound recovery
-- ---------------------------------------------------------------------------------------------------------------
-- the subaccounts to scan (each active or suspended subaccount of a legal business with a linked location), least recently scanned first, with the
-- instant scanning resumes from (the checkpoint, or for a first scan the later of the subaccount's creation and two days ago)
create or replace function public.tw4_inbound_scan_targets(p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- numbers: each linked location's current (not released) sender number on this account; the list is read per number (To=), never the whole account
  return coalesce((select jsonb_agg(jsonb_build_object('account_sid', q.twilio_account_sid, 'legal_entity_id', q.legal_entity_id, 'scanned_through', q.through,
      'numbers', coalesce((select jsonb_agg(distinct l.sender_e164) from public.studio_sms_entity_studios es
                             cross join lateral (select * from public.studio_sms_billed_senders b where b.studio_id = es.studio_id order by b.seq desc limit 1) l
                            where es.legal_entity_id = q.legal_entity_id and l.account_sid = q.twilio_account_sid and l.status <> 'released' and l.sender_e164 is not null), '[]'::jsonb))
      order by q.through)
    from (select t.twilio_account_sid, t.legal_entity_id, coalesce(c.scanned_through, greatest(t.created_at, now() - interval '2 days')) through
            from public.studio_sms_twilio_accounts t
            left join public.studio_sms_inbound_scan_cursors c on c.account_sid = t.twilio_account_sid
           where t.status in ('active', 'suspended') and t.twilio_account_sid is not null
             and exists (select 1 from public.studio_sms_entity_studios es where es.legal_entity_id = t.legal_entity_id)
           order by 3 limit least(greatest(coalesce(p_limit, 50), 1), 200)) q), '[]'::jsonb);
end $$;

-- records one inbound text the webhook missed, from the subaccount's own Message resource, with the SAME rules as the webhook (tw4_inbound_record:
-- D1 ceiling, pilot no-debt, recurring protection, compliance free). Evidence keys: sid, account_sid, direction, to, messaging_service_sid, num_segments,
-- num_media, date_created (ISO), classification ('ordinary' | 'compliance' | 'uncertain', computed by the app from the body, which is never sent here),
-- keyword (true when the body is a STOP/START/HELP keyword), keyword_kind ('stop' | 'start' | 'help') and, for 'stop' only, from (the texter's number).
-- Anything not provably ordinary is recorded as compliance: never charged.
-- Consent fails CLOSED: a recovered opt-out applies the canonical STOP (record_sms_inbound_opt_event, exactly what the webhook does) in the same
-- transaction, so the number is blocked for every DanceFlow send path; a recovered START is never applied (consent is never restored by recovery).
create or replace function public.tw4_inbound_recover(p_run_id uuid, p_account_sid text, p_evidence jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sid text := p_evidence->>'sid';
  v_entity uuid;
  v_studio uuid;
  v_segments int;
  v_media int;
  v_received timestamptz := public._tw4ur_instant(p_evidence->>'date_created');
  v_class_in text := p_evidence->>'classification';
  v_keyword boolean := coalesce(p_evidence->>'keyword', '') = 'true';
  v_kind text := case when coalesce(p_evidence->>'keyword', '') = 'true' and p_evidence->>'keyword_kind' in ('stop', 'start', 'help') then p_evidence->>'keyword_kind' end;
  v_from text := nullif(btrim(coalesce(p_evidence->>'from', '')), '');
  v_applied boolean;
  v_possible boolean := coalesce(p_evidence->>'possible_opt_out', '') = 'true';
  v_basis text;
  v_class text;
  v_seen boolean;
  r jsonb;
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$'
     or v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then
    raise exception 'invalid inbound evidence' using errcode = '22023';
  end if;
  if p_evidence->>'account_sid' is distinct from p_account_sid then
    raise exception 'the evidence is for another account' using errcode = '42501';
  end if;
  if lower(coalesce(p_evidence->>'direction', '')) <> 'inbound' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'not_inbound');
  end if;
  select t.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t where t.twilio_account_sid = p_account_sid and t.status in ('active', 'suspended');
  if v_entity is null then
    raise exception 'not an active subaccount of a legal business' using errcode = '42501';
  end if;
  -- already recorded (by the webhook or an earlier recovery): a replay, whatever the number routes to today (a number may have moved between locations)
  if exists (select 1 from public.studio_sms_inbound_usage u where u.provider_sid = v_sid) then
    if not exists (select 1 from public.studio_sms_inbound_usage u where u.provider_sid = v_sid and u.legal_entity_id = v_entity) then
      raise exception 'this message was recorded for another business' using errcode = '42501';
    end if;
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  -- the number decides (unique per account), exactly as the webhook routes it; an unroutable text is never recorded against a guess: its evidence is kept
  v_studio := public.tw4_inbound_studio_for(p_account_sid, nullif(p_evidence->>'messaging_service_sid', ''), nullif(p_evidence->>'to', ''));
  if v_studio is null then
    insert into public.studio_sms_inbound_unresolved (provider_sid, account_sid, legal_entity_id, run_id, reason, code)
    values (v_sid, p_account_sid, v_entity, p_run_id, 'unrouted', null) on conflict (provider_sid) do nothing;
    return jsonb_build_object('outcome', 'unrouted');
  end if;
  if not exists (select 1 from public.studio_sms_entity_studios es where es.studio_id = v_studio and es.legal_entity_id = v_entity) then
    raise exception 'the receiving location belongs to another business' using errcode = '42501';
  end if;
  if coalesce(p_evidence->>'num_segments', '') ~ '^[0-9]{1,2}$' and (p_evidence->>'num_segments')::int between 1 and 20 then v_segments := (p_evidence->>'num_segments')::int; end if;
  if coalesce(p_evidence->>'num_media', '') ~ '^[0-9]{1,2}$' and (p_evidence->>'num_media')::int between 0 and 10 then v_media := (p_evidence->>'num_media')::int; end if;
  if v_received is not null and (v_received > now() + interval '5 minutes' or v_received < now() - interval '400 days') then
    v_received := null;
  end if;
  v_basis := case when v_keyword then 'keyword'
                  when v_segments is null or v_media is null or v_received is null then 'incomplete'
                  when v_class_in = 'ordinary' then 'ordinary'
                  else 'uncertain' end;
  v_class := case when v_basis = 'ordinary' then 'ordinary' else 'compliance' end;
  v_seen := exists (select 1 from public.sms_webhook_receipts w where w.kind = 'inbound' and w.event_key = v_sid);
  r := public.tw4_inbound_record(v_studio, p_account_sid, v_sid, coalesce(v_segments, 1), coalesce(v_media, 0), v_class, null, coalesce(v_received, now()), 'reconciler');
  if coalesce((r->>'replayed')::boolean, false) then
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  if coalesce((r->>'recorded')::boolean, false) is not true then
    return jsonb_build_object('outcome', 'not_recorded', 'reason', coalesce(r->>'reason', 'unknown'));
  end if;
  -- fail closed on consent: a recovered opt-out is applied (idempotent if the webhook already applied it; the webhook records usage only after a
  -- successful consent change, so a STOP whose consent change failed is recovered here). Not applied, and listed for a person (consent_applied = false):
  -- no usable sender number, or the same number already texted START LATER than this STOP and the webhook processed it (re-blocking would undo a
  -- newer opt-in that Twilio honoured).
  if v_kind = 'stop' then
    if v_from is null or v_from !~ '^\+[1-9][0-9]{9,14}$' then
      v_applied := false;
    elsif v_received is not null and exists (select 1 from public.sms_consent_history h
                                              where h.studio_id = v_studio and h.phone_e164 = v_from and h.event_type = 'inbound_start' and h.changed_at > v_received) then
      v_applied := false;
    else
      perform public.record_sms_inbound_opt_event(v_studio, v_from, 'stop');
      v_applied := true;
    end if;
  end if;
  insert into public.studio_sms_inbound_recoveries (provider_sid, account_sid, legal_entity_id, studio_id, run_id, classification, basis, webhook_seen, consent_applied,
                                                    possible_opt_out, charged_cents)
  values (v_sid, p_account_sid, v_entity, v_studio, p_run_id, v_class, v_basis, v_seen, v_applied, v_possible and v_kind is null, coalesce((r->>'charged_cents')::int, 0));
  return jsonb_build_object('outcome', 'recovered', 'classification', v_class, 'basis', v_basis, 'webhook_seen', v_seen, 'keyword_kind', v_kind, 'consent_applied', v_applied,
                            'charged_cents', coalesce((r->>'charged_cents')::int, 0), 'uncollected_cents', coalesce((r->>'uncollected_cents')::int, 0));
end $$;

-- which of these message SIDs are NOT recorded yet (one call per listed page instead of one per message; read-only)
create or replace function public.tw4_inbound_unrecorded(p_account_sid text, p_sids text[])
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' or p_sids is null or cardinality(p_sids) > 1000 then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(x.sid order by x.sid) from (select distinct unnest(p_sids) sid) x
                    where x.sid ~ '^(SM|MM)[0-9a-fA-F]{32}$' and not exists (select 1 from public.studio_sms_inbound_usage u where u.provider_sid = x.sid)), '[]'::jsonb);
end $$;

-- a listed inbound text the database refused to record (permanently: a 22023 / 42501 answer) is kept as unresolved evidence for a person, so it never
-- blocks its subaccount's checkpoint and is never silently lost
create or replace function public.tw4_inbound_note_unresolved(p_run_id uuid, p_account_sid text, p_provider_sid text, p_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' or p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'
     or p_code is null or p_code !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid unresolved note' using errcode = '22023';
  end if;
  select t.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t where t.twilio_account_sid = p_account_sid and t.status in ('active', 'suspended');
  if v_entity is null then
    raise exception 'not an active subaccount of a legal business' using errcode = '42501';
  end if;
  insert into public.studio_sms_inbound_unresolved (provider_sid, account_sid, legal_entity_id, run_id, reason, code)
  values (p_provider_sid, p_account_sid, v_entity, p_run_id, 'refused', p_code) on conflict (provider_sid) do nothing;
  return jsonb_build_object('noted', true);
end $$;

-- moves a subaccount's checkpoint forward after a COMPLETE scan up to p_through (never later than 5 minutes ago, never backwards)
create or replace function public.tw4_inbound_scan_advance(p_run_id uuid, p_account_sid text, p_through timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_through timestamptz;
begin
  perform public._tw4ur_fence(p_run_id, 'usage_reconcile');
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' or p_through is null or p_through > clock_timestamp() - interval '5 minutes' then
    raise exception 'invalid checkpoint' using errcode = '22023';
  end if;
  select t.legal_entity_id into v_entity from public.studio_sms_twilio_accounts t where t.twilio_account_sid = p_account_sid and t.status in ('active', 'suspended');
  if v_entity is null then
    raise exception 'not an active subaccount of a legal business' using errcode = '42501';
  end if;
  insert into public.studio_sms_inbound_scan_cursors as c (account_sid, legal_entity_id, scanned_through, last_run_id)
  values (p_account_sid, v_entity, p_through, p_run_id)
  on conflict (account_sid) do update set scanned_through = greatest(c.scanned_through, excluded.scanned_through), last_run_id = excluded.last_run_id, updated_at = clock_timestamp()
  returning c.scanned_through into v_through;
  return jsonb_build_object('scanned_through', v_through);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- platform-admin monitoring (identifiers, states, ages and amounts; never a message body or a client's number)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_usage_reconcile_overview(p_actor uuid, p_limit int default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_last_ok timestamptz;
begin
  perform public._tw4c_admin(p_actor);
  select max(r.finished_at) into v_last_ok from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'completed';
  return jsonb_build_object(
    'switch_on', public._tw4us_switch_on(),
    'last_completed_at', v_last_ok,
    -- a schedule that has not completed a run in 30 minutes while billed texting is on is an alert (texts would sit reserved / unsettled)
    'stale', public._tw4us_switch_on() and (v_last_ok is null or v_last_ok < now() - interval '30 minutes'),
    'running', (select jsonb_build_object('run_id', r.id, 'runner', r.runner, 'started_at', r.started_at, 'lease_expires_at', r.lease_expires_at)
                  from public.studio_sms_reconcile_runs r where r.job = 'usage_reconcile' and r.status = 'running'),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('run_id', r.id, 'status', r.status, 'started_at', r.started_at, 'finished_at', r.finished_at,
                                                         'summary', r.summary, 'error', r.error) order by r.started_at desc)
                        from (select * from public.studio_sms_reconcile_runs x where x.job = 'usage_reconcile' order by x.started_at desc limit 10) r), '[]'::jsonb),
    'by_state', coalesce((select jsonb_object_agg(s.state, s.n) from (select state, count(*) n from public.studio_sms_usage_attempts where state not in ('released', 'settled') group by state) s), '{}'::jsonb),
    'stale_reserved', (select count(*) from public.studio_sms_usage_attempts x where x.state = 'reserved' and x.created_at < now() - interval '10 minutes'),
    'evidence_retrying', (select count(*) from public.studio_sms_usage_attempts x where x.state = 'submitted' and x.evidence_failures > 0),
    'escalated_open', (select count(*) from public.studio_sms_usage_attempts x where x.escalated_at is not null and x.state in ('submitting', 'unknown', 'submitted', 'review')),
    'reserved_open_cents', (select coalesce(sum(x.reserved_cents), 0) from public.studio_sms_usage_attempts x where x.state in ('reserved', 'submitting', 'submitted', 'unknown', 'review')),
    'usage_gaps', public._tw4us_reconciliation_gaps(),
    'inbound_gaps', public._tw4in_reconciliation_gaps(),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object(
        'attempt_id', x.id, 'studio_id', x.studio_id, 'legal_entity_id', x.legal_entity_id, 'state', x.state, 'created_at', x.created_at,
        'submitting_at', x.submitting_at, 'escalated_at', x.escalated_at, 'has_provider_message', x.provider_sid is not null, 'reserved_cents', x.reserved_cents,
        'estimated_segments', x.estimated_segments, 'review_reason', x.review_reason, 'submit_error_code', x.submit_error_code,
        'evidence_status', x.evidence_status, 'evidence_error_code', x.evidence_error_code, 'evidence_failures', x.evidence_failures,
        'callback_status', x.callback_status) order by x.escalated_at, x.created_at)
      from (select * from public.studio_sms_usage_attempts y where y.escalated_at is not null and y.state in ('submitting', 'unknown', 'submitted', 'review')
             order by y.escalated_at, y.created_at limit v_limit) x), '[]'::jsonb),
    'inbound', jsonb_build_object(
      'cursors', coalesce((select jsonb_agg(jsonb_build_object('account_sid', c.account_sid, 'legal_entity_id', c.legal_entity_id, 'scanned_through', c.scanned_through,
                                                              'lag_minutes', floor(extract(epoch from (now() - c.scanned_through)) / 60)) order by c.scanned_through)
                            from public.studio_sms_inbound_scan_cursors c), '[]'::jsonb),
      'unscanned_accounts', (select count(*) from public.studio_sms_twilio_accounts t
                              where t.status in ('active', 'suspended') and t.twilio_account_sid is not null
                                and exists (select 1 from public.studio_sms_entity_studios es where es.legal_entity_id = t.legal_entity_id)
                                and not exists (select 1 from public.studio_sms_inbound_scan_cursors c where c.account_sid = t.twilio_account_sid)),
      'recovered_7d', coalesce((select jsonb_object_agg(q.basis, q.n) from (select basis, count(*) n from public.studio_sms_inbound_recoveries where recovered_at >= now() - interval '7 days' group by basis) q), '{}'::jsonb),
      -- a STOP/START/HELP the webhook did not record: its consent effect may NOT have been applied by DanceFlow (never seen, or the webhook stopped after
      -- its receipt). Twilio Advanced Opt-Out still blocks at the carrier. Needs a person.
      'keywords_unseen', coalesce((select jsonb_agg(jsonb_build_object('provider_sid', k.provider_sid, 'studio_id', k.studio_id, 'recovered_at', k.recovered_at, 'webhook_seen', k.webhook_seen, 'consent_applied', k.consent_applied) order by k.recovered_at desc)
                                     from (select * from public.studio_sms_inbound_recoveries x where x.basis = 'keyword' order by x.recovered_at desc limit v_limit) k), '[]'::jsonb),
      -- uncertain texts with an opt-out word: no consent change was made; a person decides
      'possible_opt_outs', coalesce((select jsonb_agg(jsonb_build_object('provider_sid', k.provider_sid, 'studio_id', k.studio_id, 'recovered_at', k.recovered_at) order by k.recovered_at desc)
                                       from (select * from public.studio_sms_inbound_recoveries x where x.possible_opt_out order by x.recovered_at desc limit v_limit) k), '[]'::jsonb),
      'unresolved_7d', coalesce((select jsonb_object_agg(q.reason, q.n) from (select reason, count(*) n from public.studio_sms_inbound_unresolved where noted_at >= now() - interval '7 days' group by reason) q), '{}'::jsonb),
      'unresolved', coalesce((select jsonb_agg(jsonb_build_object('provider_sid', u.provider_sid, 'account_sid', u.account_sid, 'legal_entity_id', u.legal_entity_id, 'reason', u.reason, 'code', u.code, 'noted_at', u.noted_at) order by u.noted_at desc)
                                from (select * from public.studio_sms_inbound_unresolved x order by x.noted_at desc limit v_limit) u), '[]'::jsonb)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges: internal helpers for nobody; every action for the service role only (the overview also checks the actor)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4ur_guard(), public._tw4ur_attempt_event(), public._tw4ur_fence(uuid, text), public._tw4ur_account_of(uuid, text), public._tw4ur_instant(text)
  from public, anon, authenticated, service_role;
revoke all on function public.tw4_reconcile_run_begin(text, text, int), public.tw4_reconcile_run_finish(uuid, text, jsonb, text), public.tw4_usage_release_stale(uuid, int),
  public.tw4_usage_settle(uuid, jsonb), public.tw4_usage_evidence_failed(uuid, text, boolean), public.tw4_usage_due(int), public.tw4_usage_escalate(uuid, int),
  public.tw4_inbound_scan_targets(int), public.tw4_inbound_recover(uuid, text, jsonb), public.tw4_inbound_scan_advance(uuid, text, timestamptz),
  public.tw4_usage_reconcile_overview(uuid, int), public.tw4_inbound_unrecorded(text, text[]), public.tw4_inbound_note_unresolved(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.tw4_reconcile_run_begin(text, text, int), public.tw4_reconcile_run_finish(uuid, text, jsonb, text), public.tw4_usage_release_stale(uuid, int),
  public.tw4_usage_settle(uuid, jsonb), public.tw4_usage_evidence_failed(uuid, text, boolean), public.tw4_usage_due(int), public.tw4_usage_escalate(uuid, int),
  public.tw4_inbound_scan_targets(int), public.tw4_inbound_recover(uuid, text, jsonb), public.tw4_inbound_scan_advance(uuid, text, timestamptz),
  public.tw4_usage_reconcile_overview(uuid, int), public.tw4_inbound_unrecorded(text, text[]), public.tw4_inbound_note_unresolved(uuid, text, text, text)
  to service_role;

commit;
