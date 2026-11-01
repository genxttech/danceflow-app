-- D4-2: pricing-integrity MONITOR support (append-only hash-chained run evidence, security-event feed, read-only price digest).
-- NOT APPLIED anywhere; Git only. Independent of 20270204090000 (D4-1 dual control): it reads public.studio_sms_price_list only and does not call tw4_price_verify (the application does).
--
--   * studio_sms_price_monitor_evidence   append-only, hash-chained record of every monitor run, alert delivery attempt and watchdog check. The chain hash is computed by the
--                                         APPLICATION (src/lib/sms/pricing/evidence.ts); the database enforces linkage (seq = head + 1, prev_hash = head hash), serialization
--                                         and immutability (no UPDATE, DELETE or TRUNCATE, ENABLE ALWAYS, also under session_replication_role = replica). A database writer
--                                         can still append forged rows or a superuser can still rewrite history: the chain head published in every alert (an independently
--                                         controlled destination) is what makes that detectable. See docs/twilio/TW-4F_Price_Monitoring_Runbook.md.
--   * studio_sms_price_security_events    append-only security-event feed for the authorization workstream (D4-1): credential compromise/replacement, approver registry change,
--                                         emergency pricing suspension/resume. No API-role privilege; the owner (and SECURITY DEFINER functions owned by it) append rows.
--   * tw4_price_monitor_evidence_append / _list, tw4_price_monitor_events, tw4_price_monitor_digest    the ONLY entry points, service_role only. None of them can write a price
--                                         table. The monitor never calls tw4_price_set / propose / approve / reject.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_price_list') is null then
    raise exception 'price monitor precondition failed: public.studio_sms_price_list is missing';
  end if;
end $$;

create table if not exists public.studio_sms_price_monitor_evidence (
  seq bigint primary key check (seq >= 1),
  run_id uuid not null,
  kind text not null check (kind in ('run', 'delivery', 'watchdog')),
  recorded_at timestamptz not null,
  payload text not null check (char_length(payload) <= 32768),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text not null unique check (entry_hash ~ '^[0-9a-f]{64}$'),
  inserted_at timestamptz not null default clock_timestamp()
);
create index if not exists studio_sms_price_monitor_evidence_kind_seq on public.studio_sms_price_monitor_evidence (kind, seq desc);
revoke all on public.studio_sms_price_monitor_evidence from public, anon, authenticated, service_role;
alter table public.studio_sms_price_monitor_evidence enable row level security;

-- Columns (the authorization workstream reads ONLY seq, kind, subject_user_id, detail; it must never trust occurred_at / recorded_at for any decision):
--   seq              gapless, strictly commit-ordered position, assigned by the _00_fill trigger under an advisory lock (never by the writer)
--   kind             snake_case event kind; interpreted by the application (types.ts EVENT_KINDS)
--   subject_user_id  the user the event is about (nullable); informational
--   detail           small JSON object (<= 8 kB), no secrets
--   occurred_at / recorded_at   database clock at insert, forced by the trigger (a writer cannot backdate); informational only
create table if not exists public.studio_sms_price_security_events (
  seq bigint primary key check (seq >= 1),
  kind text not null check (char_length(kind) between 3 and 60 and kind ~ '^[a-z0-9_]+$'),
  occurred_at timestamptz not null default clock_timestamp(),
  subject_user_id uuid null,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8192),
  recorded_at timestamptz not null default clock_timestamp()
);
comment on column public.studio_sms_price_security_events.seq is 'gapless commit-ordered position assigned by trigger; trust for ordering only';
comment on column public.studio_sms_price_security_events.occurred_at is 'database clock at insert, forced by trigger; informational, never a decision input';
comment on column public.studio_sms_price_security_events.recorded_at is 'database clock at insert, forced by trigger; informational, never a decision input';
revoke all on public.studio_sms_price_security_events from public, anon, authenticated, service_role;
alter table public.studio_sms_price_security_events enable row level security;

create or replace function public._tw4pricemon_immutable()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'price monitor evidence and security events are append-only' using errcode = 'TW043';
end $$;

-- seq / timestamps are assigned here, ENABLE ALWAYS: a gapless commit-ordered seq (the advisory lock is held to commit, so seq order = commit order and a cursor reader cannot skip a late commit)
create or replace function public._tw4pricemon_event_fill()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('tw4_price_security_events'));
  new.seq := coalesce((select max(e.seq) from public.studio_sms_price_security_events e), 0) + 1;
  new.occurred_at := clock_timestamp();
  new.recorded_at := new.occurred_at;
  return new;
end $$;

-- The ONLY supported writer of security events: owner-level, called by the SECURITY DEFINER functions of the pricing authorization workstream. No API role can execute it.
create or replace function public._tw4pricemon_emit_event(p_kind text, p_subject uuid, p_detail jsonb)
returns bigint language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare s bigint;
begin
  if p_kind is null or p_kind !~ '^[a-z0-9_]+$' or char_length(p_kind) not between 3 and 60 then
    raise exception 'security event kind is not valid' using errcode = 'TW044';
  end if;
  insert into public.studio_sms_price_security_events (seq, kind, subject_user_id, detail) values (0, p_kind, p_subject, coalesce(p_detail, '{}'::jsonb)) returning seq into s;
  return s;
end $$;

drop trigger if exists studio_sms_price_monitor_evidence_immutable on public.studio_sms_price_monitor_evidence;
create trigger studio_sms_price_monitor_evidence_immutable before update or delete on public.studio_sms_price_monitor_evidence for each row execute function public._tw4pricemon_immutable();
drop trigger if exists studio_sms_price_monitor_evidence_truncate on public.studio_sms_price_monitor_evidence;
create trigger studio_sms_price_monitor_evidence_truncate before truncate on public.studio_sms_price_monitor_evidence for each statement execute function public._tw4pricemon_immutable();
drop trigger if exists studio_sms_price_security_events_immutable on public.studio_sms_price_security_events;
create trigger studio_sms_price_security_events_immutable before update or delete on public.studio_sms_price_security_events for each row execute function public._tw4pricemon_immutable();
drop trigger if exists studio_sms_price_security_events_truncate on public.studio_sms_price_security_events;
create trigger studio_sms_price_security_events_truncate before truncate on public.studio_sms_price_security_events for each statement execute function public._tw4pricemon_immutable();
alter table public.studio_sms_price_monitor_evidence enable always trigger studio_sms_price_monitor_evidence_immutable;
alter table public.studio_sms_price_monitor_evidence enable always trigger studio_sms_price_monitor_evidence_truncate;
drop trigger if exists studio_sms_price_security_events_00_fill on public.studio_sms_price_security_events;
create trigger studio_sms_price_security_events_00_fill before insert on public.studio_sms_price_security_events for each row execute function public._tw4pricemon_event_fill();
alter table public.studio_sms_price_security_events enable always trigger studio_sms_price_security_events_00_fill;
alter table public.studio_sms_price_security_events enable always trigger studio_sms_price_security_events_immutable;
alter table public.studio_sms_price_security_events enable always trigger studio_sms_price_security_events_truncate;

-- Append one evidence row. The caller supplies the hash it computed; the database enforces that the row extends the CURRENT head (seq = head + 1, prev_hash = head hash).
create or replace function public.tw4_price_monitor_evidence_append(p_seq bigint, p_prev_hash text, p_entry_hash text, p_run_id uuid, p_kind text, p_recorded_at timestamptz, p_payload text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  h record;
  genesis constant text := repeat('0', 64);
begin
  -- the recorded time must be close to the database clock: a forged future / past timestamp could keep the watchdog quiet (the watchdog also reads the database's own inserted_at)
  if p_recorded_at is null or abs(extract(epoch from (p_recorded_at - clock_timestamp()))) > 600 then
    return jsonb_build_object('appended', false, 'reason', 'recorded_at_out_of_range');
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_monitor_evidence'));
  select e.seq, e.entry_hash into h from public.studio_sms_price_monitor_evidence e order by e.seq desc limit 1;
  if h.seq is null then
    if p_seq <> 1 or p_prev_hash <> genesis then
      return jsonb_build_object('appended', false, 'reason', 'chain_mismatch', 'head_seq', 0, 'head_hash', genesis);
    end if;
  elsif p_seq <> h.seq + 1 or p_prev_hash <> h.entry_hash then
    return jsonb_build_object('appended', false, 'reason', 'chain_mismatch', 'head_seq', h.seq, 'head_hash', h.entry_hash);
  end if;
  insert into public.studio_sms_price_monitor_evidence (seq, run_id, kind, recorded_at, payload, prev_hash, entry_hash)
    values (p_seq, p_run_id, p_kind, p_recorded_at, p_payload, p_prev_hash, p_entry_hash);
  return jsonb_build_object('appended', true, 'seq', p_seq, 'head_hash', p_entry_hash);
end $$;

-- Newest p_limit rows (returned ascending), for chain verification, plus the head. p_before_seq pages backwards.
create or replace function public.tw4_price_monitor_evidence_list(p_limit integer default 200, p_before_seq bigint default null)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'head_seq', coalesce((select max(seq) from public.studio_sms_price_monitor_evidence), 0),
    'rows', coalesce((select jsonb_agg(to_jsonb(t) order by t.seq) from (
        select e.seq, e.run_id, e.kind, e.recorded_at, e.inserted_at, e.payload, e.prev_hash, e.entry_hash from public.studio_sms_price_monitor_evidence e
         where p_before_seq is null or e.seq < p_before_seq order by e.seq desc limit greatest(1, least(coalesce(p_limit, 200), 1000))) t), '[]'::jsonb));
$$;

-- Security events after a cursor (ascending). Event kinds are interpreted by the application; unknown kinds alert.
create or replace function public.tw4_price_monitor_events(p_after_seq bigint default 0)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'head_seq', coalesce((select max(seq) from public.studio_sms_price_security_events), 0),
    'events', coalesce((select jsonb_agg(to_jsonb(t) order by t.seq) from (
        select s.seq, s.kind, s.occurred_at, s.subject_user_id, s.detail from public.studio_sms_price_security_events s
         where s.seq > coalesce(p_after_seq, 0) order by s.seq limit 500) t), '[]'::jsonb),
    'last_suspension_event', (select to_jsonb(t) from (
        select s.seq, s.kind, s.occurred_at from public.studio_sms_price_security_events s
         where s.kind in ('pricing_suspended', 'pricing_resumed') order by s.seq desc limit 1) t));
$$;

-- Read-only digest of the whole price list (every row, active or not): detects a change even if the verifier were neutered.
create or replace function public.tw4_price_monitor_digest()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with g as (
    select t.tgname::text as name, t.tgenabled::text as enabled
      from pg_trigger t
     where not t.tgisinternal
       and t.tgname in ('studio_sms_price_monitor_evidence_immutable', 'studio_sms_price_monitor_evidence_truncate', 'studio_sms_price_security_events_immutable', 'studio_sms_price_security_events_truncate',
                        'studio_sms_price_security_events_00_fill', 'studio_sms_price_list_00_activation', 'studio_sms_price_list_00_truncate', 'studio_sms_price_change_requests_guard', 'studio_sms_price_change_requests_truncate')
  )
  select jsonb_build_object(
    'guards', (select coalesce(jsonb_object_agg(name, enabled), '{}'::jsonb) from g),
    'guards_bad', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from g where enabled <> 'A'),
    'guards_ok', (select count(*) filter (where name like 'studio_sms_price_monitor_%' or name like 'studio_sms_price_security_events_%') = 5 and count(*) filter (where enabled <> 'A') = 0 from g),
    'rows', (select count(*) from public.studio_sms_price_list),
    'active_rows', (select count(*) from public.studio_sms_price_list where active),
    'digest', encode(sha256(convert_to(coalesce((select string_agg(concat_ws('|', p.id, p.kind, p.customer_price_cents, p.provider_cost_cents, p.description, p.active, p.created_by, p.created_at), E'\n' order by p.id)
                                                   from public.studio_sms_price_list p), ''), 'UTF8')), 'hex'),
    'checked_at', clock_timestamp());
$$;

-- Pricing-side contract (informational ONLY): is monitoring expected, and is it up? A monitoring outage must NEVER authorize a financial change and the emergency freeze must not
-- depend on this function; the pricing functions decide on their own and may at most use this to REFUSE or to warn. 'never' = the monitor was never activated (not expected).
create or replace function public.tw4_price_monitor_status(p_max_age_seconds integer default 2700)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with l as (select max(e.inserted_at) as at from public.studio_sms_price_monitor_evidence e where e.kind = 'run')
  select jsonb_build_object(
    'state', case when l.at is null then 'never' when extract(epoch from (clock_timestamp() - l.at)) > greatest(coalesce(p_max_age_seconds, 2700), 0) then 'stale' else 'ok' end,
    'monitoring_expected', l.at is not null,
    'last_run_inserted_at', l.at,
    'age_seconds', case when l.at is null then null else extract(epoch from (clock_timestamp() - l.at)) end,
    'max_age_seconds', greatest(coalesce(p_max_age_seconds, 2700), 0),
    'informational_only', true,
    'checked_at', clock_timestamp())
  from l;
$$;

revoke all on function public._tw4pricemon_immutable(), public._tw4pricemon_event_fill(), public._tw4pricemon_emit_event(text, uuid, jsonb), public.tw4_price_monitor_status(integer) from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_monitor_status(integer) to service_role;
revoke all on function public.tw4_price_monitor_evidence_append(bigint, text, text, uuid, text, timestamptz, text), public.tw4_price_monitor_evidence_list(integer, bigint),
  public.tw4_price_monitor_events(bigint), public.tw4_price_monitor_digest() from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_monitor_evidence_append(bigint, text, text, uuid, text, timestamptz, text), public.tw4_price_monitor_evidence_list(integer, bigint),
  public.tw4_price_monitor_events(bigint), public.tw4_price_monitor_digest() to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.tw4_price_monitor_digest()', 'execute') or has_function_privilege('authenticated', 'public.tw4_price_monitor_events(bigint)', 'execute')
     or not has_function_privilege('service_role', 'public.tw4_price_monitor_evidence_append(bigint,text,text,uuid,text,timestamptz,text)', 'execute')
     or has_table_privilege('service_role', 'public.studio_sms_price_monitor_evidence', 'insert') or has_table_privilege('service_role', 'public.studio_sms_price_security_events', 'insert') then
    raise exception 'price monitor postcondition failed: unexpected grants';
  end if;
end $$;

commit;
