-- GC-S1B B1 -- group-class series generation + atomic materialization,
-- live-Postgres regression suite.
--
-- Proves: the deterministic finite generator (weekly, multi-weekday, interval,
-- partial first week, end date, count, caps, validation); PostgreSQL's native
-- DST behavior (pinned, not re-implemented) and the preview DST flag; stable
-- pre-skip indices and skip handling; atomic series + occurrence + policy
-- materialization with defaults copied; all-or-nothing rollback on every
-- failure class; client_request_id idempotency (replay, conflict, retry after
-- rollback); broad-staff-only authority with tenant isolation; grants,
-- security modes and search_path; standalone class creation and legacy Events
-- untouched. One transaction, rolled back at the end. Run via
-- `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261014090000 (GC-S1A) and 20261015090000 (this migration) are applied.
--
-- Deterministic UUID block (...0000-0000-0000-0000-000000fNXXXX):
--   f0 studios, f1 auth.users/profiles, f2 instructors, f3 rooms, f6 request ids.

begin;

create table public.t_gcsb1_log (n serial, msg text);
grant all on public.t_gcsb1_log to public;
grant usage on sequence public.t_gcsb1_log_n_seq to public;
create function public.t_gcsb1_pass(p text) returns void language sql as $$ insert into public.t_gcsb1_log (msg) values (p) $$;
grant execute on function public.t_gcsb1_pass(text) to public;

-- expect a statement to fail with an error containing p_like
create function public.t_gcsb1_expect(p_sql text, p_like text, p_label text)
returns void language plpgsql as $$
declare v_failed boolean := false; v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_failed := true; v_err := sqlerrm;
  end;
  if not v_failed then
    raise exception 'FAIL %: expected an error containing [%], statement succeeded', p_label, p_like;
  end if;
  if position(lower(p_like) in lower(v_err)) = 0 then
    raise exception 'FAIL %: expected error containing [%], got [%]', p_label, p_like, v_err;
  end if;
  perform public.t_gcsb1_pass(p_label);
end;
$$;
grant execute on function public.t_gcsb1_expect(text, text, text) to anon, authenticated;

-- RLS-independent row counts for the no-residue checks
create function public.t_gcsb1_counts() returns text language sql stable security definer set search_path = 'public' as $x$
  select (select count(*) from public.group_class_series)::text || '/' || (select count(*) from public.appointments)::text || '/' || (select count(*) from public.group_class_enrollment_policies)::text
$x$;
grant execute on function public.t_gcsb1_counts() to public;

-- compact generator probes (as migration owner)
create function public.t_gcsb1_dates(p_tz text, p_weekdays smallint[], p_interval int, p_starts date, p_ends date, p_count int, p_time time, p_dur int default 60)
returns text language sql stable as $$
  select string_agg(local_date::text, ',' order by occurrence_index)
  from public._gcsb1_generate_series_occurrences(p_tz, p_weekdays, p_interval, p_starts, p_ends, p_count, p_time, p_dur)
$$;
create function public.t_gcsb1_utc(p_tz text, p_weekdays smallint[], p_interval int, p_starts date, p_ends date, p_count int, p_time time, p_dur int default 60)
returns text language sql stable as $$
  select string_agg(to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), ',' order by occurrence_index)
  from public._gcsb1_generate_series_occurrences(p_tz, p_weekdays, p_interval, p_starts, p_ends, p_count, p_time, p_dur)
$$;

create function public.t_gcsb1_assert(p_label text, p_got text, p_expected text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FAIL %: expected [%], got [%]', p_label, p_expected, p_got;
  end if;
  perform public.t_gcsb1_pass(p_label);
end;
$$;

-- ============================================================================
-- 0. Pre-flight snapshot (legacy Events + appointments + series must be unchanged at the end)
-- ============================================================================
create temp table t_gcsb1_snap as
select
  (select count(*) from public.group_class_series) as series_n,
  (select count(*) from public.appointments) as appts_n,
  (select count(*) from public.group_class_enrollment_policies) as policies_n,
  (select count(*) from public.events) as events_n,
  (select count(*) from public.event_sessions) as event_sessions_n,
  (select count(*) from public.event_registrations) as event_regs_n;

-- ============================================================================
-- 1. GENERATION (pure, as migration owner)
-- ============================================================================
select public.t_gcsb1_assert('T-gcsb1-gen-weekly-count',
  public.t_gcsb1_dates('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 6, time '18:30'),
  '2027-01-12,2027-01-19,2027-01-26,2027-02-02,2027-02-09,2027-02-16');
select public.t_gcsb1_assert('T-gcsb1-gen-multi-weekday-sorted-deduped',
  public.t_gcsb1_dates('America/New_York', array[6, 4, 4]::smallint[], 1, date '2027-01-14', null, 6, time '18:30'),
  '2027-01-14,2027-01-16,2027-01-21,2027-01-23,2027-01-28,2027-01-30');
select public.t_gcsb1_assert('T-gcsb1-gen-partial-first-week-drops-earlier-dates',
  public.t_gcsb1_dates('America/New_York', array[1, 3, 5]::smallint[], 1, date '2027-01-13', null, 4, time '18:30'),
  '2027-01-13,2027-01-15,2027-01-18,2027-01-20');
select public.t_gcsb1_assert('T-gcsb1-gen-interval-2-weeks',
  public.t_gcsb1_dates('America/New_York', array[2]::smallint[], 2, date '2027-01-12', null, 4, time '18:30'),
  '2027-01-12,2027-01-26,2027-02-09,2027-02-23');
select public.t_gcsb1_assert('T-gcsb1-gen-interval-2-multi-weekday-partial-week',
  public.t_gcsb1_dates('America/New_York', array[1, 4]::smallint[], 2, date '2027-01-14', null, 4, time '18:30'),
  '2027-01-14,2027-01-25,2027-01-28,2027-02-08');
select public.t_gcsb1_assert('T-gcsb1-gen-ends-on-inclusive',
  public.t_gcsb1_dates('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-02-02', null, time '18:30'),
  '2027-01-12,2027-01-19,2027-01-26,2027-02-02');
select public.t_gcsb1_assert('T-gcsb1-gen-ends-on-exclusive-of-later-dates',
  public.t_gcsb1_dates('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-02-01', null, time '18:30'),
  '2027-01-12,2027-01-19,2027-01-26');
select public.t_gcsb1_assert('T-gcsb1-gen-single-day-end-equals-start',
  public.t_gcsb1_dates('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-01-12', null, time '18:30'),
  '2027-01-12');

do $$
declare v_rows int; v_idx text; v_asc boolean;
begin
  -- 104-cap: exactly 104 by count is allowed; 105 is rejected
  select count(*) into v_rows from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 104, time '18:30', 60);
  perform public.t_gcsb1_assert('T-gcsb1-gen-cap-104-allowed', v_rows::text, '104');

  -- deterministic ordering/indexing: 1..n contiguous, dates strictly ascending, repeat call identical
  select string_agg(occurrence_index::text, ',' order by occurrence_index) into v_idx
    from public._gcsb1_generate_series_occurrences('America/New_York', array[1, 3]::smallint[], 1, date '2027-01-11', null, 8, time '18:30', 60);
  perform public.t_gcsb1_assert('T-gcsb1-gen-indices-contiguous-from-1', v_idx, '1,2,3,4,5,6,7,8');
  select bool_and(local_date > lag_d) into v_asc from (
    select local_date, lag(local_date) over (order by occurrence_index) lag_d
    from public._gcsb1_generate_series_occurrences('America/New_York', array[1, 3]::smallint[], 1, date '2027-01-11', null, 8, time '18:30', 60)
  ) x where lag_d is not null;
  perform public.t_gcsb1_assert('T-gcsb1-gen-dates-strictly-ascending', v_asc::text, 'true');
  perform public.t_gcsb1_assert('T-gcsb1-gen-deterministic-repeat',
    public.t_gcsb1_utc('America/New_York', array[1, 3]::smallint[], 1, date '2027-01-11', null, 8, time '18:30'),
    public.t_gcsb1_utc('America/New_York', array[3, 1]::smallint[], 1, date '2027-01-11', null, 8, time '18:30'));
end $$;

select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 105, time '18:30', 60)$$, 'GCSB1_OCCURRENCE_CAP_EXCEEDED', 'T-gcsb1-gen-cap-105-by-count-rejected');
-- end-date mode: weekly for 730 days is 105 dates -> cap; 700 days is 101 dates -> ok
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-01-12' + 730, null, time '18:30', 60)$$, 'GCSB1_OCCURRENCE_CAP_EXCEEDED', 'T-gcsb1-gen-cap-by-end-date');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-01-12' + 731, null, time '18:30', 60)$$, 'within two years', 'T-gcsb1-gen-horizon-over-730-days');
do $$ begin
  perform public.t_gcsb1_assert('T-gcsb1-gen-end-date-700-days-ok',
    (select count(*)::text from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-01-12' + 700, null, time '18:30', 60)), '101');
end $$;

select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'at least one weekday', 'T-gcsb1-gen-reject-empty-weekdays');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[8]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'at least one weekday', 'T-gcsb1-gen-reject-weekday-8');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 0, date '2027-01-12', null, 4, time '18:30', 60)$$, 'interval', 'T-gcsb1-gen-reject-interval-0');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 53, date '2027-01-12', null, 4, time '18:30', 60)$$, 'interval', 'T-gcsb1-gen-reject-interval-53');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, null, time '18:30', 60)$$, 'either an end date or a number', 'T-gcsb1-gen-reject-no-end-rule');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-03-01', 4, time '18:30', 60)$$, 'either an end date or a number', 'T-gcsb1-gen-reject-both-end-rules');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 0, time '18:30', 60)$$, 'at least 1', 'T-gcsb1-gen-reject-count-0');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', date '2027-01-01', null, time '18:30', 60)$$, 'on or after', 'T-gcsb1-gen-reject-end-before-start');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 4)$$, '5 minutes and 12 hours', 'T-gcsb1-gen-reject-duration-4');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('Mars/Phobos', array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'GCSB1_INVALID_TIMEZONE', 'T-gcsb1-gen-reject-timezone');
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('America/New_York', array[1]::smallint[], 1, date '2027-01-12', date '2027-01-13', null, time '18:30', 60)$$, 'no classes', 'T-gcsb1-gen-reject-empty-schedule');

-- ============================================================================
-- 2. DST: PostgreSQL's native behavior, pinned (PostgreSQL 17.x observed in DEV)
-- ============================================================================
-- normal wall time (EST, UTC-5)
select public.t_gcsb1_assert('T-gcsb1-dst-normal-utc',
  public.t_gcsb1_utc('America/New_York', array[2]::smallint[], 1, date '2027-01-12', null, 1, time '18:30'), '2027-01-12T23:30');
-- spring-forward gap (2027-03-14 is a Sunday): 02:30 does not exist -> offset BEFORE the gap -> lands 03:30 EDT
select public.t_gcsb1_assert('T-gcsb1-dst-spring-gap-utc',
  public.t_gcsb1_utc('America/New_York', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '02:30'), '2027-03-14T07:30');
select public.t_gcsb1_assert('T-gcsb1-dst-spring-gap-flagged',
  (select dst_note from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '02:30', 60)), 'nonexistent_adjusted');
select public.t_gcsb1_assert('T-gcsb1-dst-spring-gap-roundtrip-wall-time',
  (select (starts_at at time zone 'America/New_York')::text from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '02:30', 60)), '2027-03-14 03:30:00');
-- fall-back ambiguity (2027-11-07 is a Sunday): 01:30 happens twice -> the LATER (standard time) occurrence
select public.t_gcsb1_assert('T-gcsb1-dst-fall-ambiguous-utc-later-occurrence',
  public.t_gcsb1_utc('America/New_York', array[7]::smallint[], 1, date '2027-11-07', null, 1, time '01:30'), '2027-11-07T06:30');
select public.t_gcsb1_assert('T-gcsb1-dst-fall-ambiguous-flagged',
  (select dst_note from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-11-07', null, 1, time '01:30', 60)), 'ambiguous_later_selected');
select public.t_gcsb1_assert('T-gcsb1-dst-fall-ambiguous-roundtrip-wall-time',
  (select (starts_at at time zone 'America/New_York')::text from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-11-07', null, 1, time '01:30', 60)), '2027-11-07 01:30:00');
-- ordinary class times on DST-change days are not flagged and keep their wall time
select public.t_gcsb1_assert('T-gcsb1-dst-change-day-normal-time-not-flagged',
  (select coalesce(dst_note, 'none') from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '09:00', 60)), 'none');
select public.t_gcsb1_assert('T-gcsb1-dst-fall-day-0200-not-flagged',
  (select coalesce(dst_note, 'none') from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-11-07', null, 1, time '02:00', 60)), 'none');
-- wall-clock time is stable across the transition (UTC shifts, local time does not)
select public.t_gcsb1_assert('T-gcsb1-dst-wall-clock-stable-across-spring-forward',
  public.t_gcsb1_utc('America/New_York', array[7]::smallint[], 1, date '2027-03-07', null, 3, time '18:00'),
  '2027-03-07T23:00,2027-03-14T22:00,2027-03-21T22:00');
select public.t_gcsb1_assert('T-gcsb1-dst-wall-clock-stable-across-fall-back',
  public.t_gcsb1_utc('America/New_York', array[7]::smallint[], 1, date '2027-10-31', null, 3, time '18:00'),
  '2027-10-31T22:00,2027-11-07T23:00,2027-11-14T23:00');
-- duration is elapsed time: a 120-minute class starting 01:30 EST ends 04:30 EDT on spring-forward day
select public.t_gcsb1_assert('T-gcsb1-dst-duration-is-elapsed-time',
  (select (ends_at at time zone 'America/New_York')::text from public._gcsb1_generate_series_occurrences('America/New_York', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '01:30', 120)), '2027-03-14 04:30:00');
-- other zones behave the same way (gap -> offset before the gap; ambiguity -> later occurrence)
select public.t_gcsb1_assert('T-gcsb1-dst-la-spring-gap-utc',
  public.t_gcsb1_utc('America/Los_Angeles', array[7]::smallint[], 1, date '2027-03-14', null, 1, time '02:30'), '2027-03-14T10:30');
select public.t_gcsb1_assert('T-gcsb1-dst-la-fall-ambiguous-utc',
  public.t_gcsb1_utc('America/Los_Angeles', array[7]::smallint[], 1, date '2027-11-07', null, 1, time '01:30'), '2027-11-07T09:30');
select public.t_gcsb1_assert('T-gcsb1-dst-london-spring-gap-utc',
  public.t_gcsb1_utc('Europe/London', array[7]::smallint[], 1, date '2027-03-28', null, 1, time '01:30'), '2027-03-28T01:30');
select public.t_gcsb1_assert('T-gcsb1-dst-london-fall-ambiguous-utc',
  public.t_gcsb1_utc('Europe/London', array[7]::smallint[], 1, date '2027-10-31', null, 1, time '01:30'), '2027-10-31T01:30');
select public.t_gcsb1_assert('T-gcsb1-dst-sydney-fall-ambiguous-utc',
  public.t_gcsb1_utc('Australia/Sydney', array[7]::smallint[], 1, date '2027-04-04', null, 1, time '02:30'), '2027-04-03T16:30');

-- ============================================================================
-- FIXTURES (as migration owner)
-- ============================================================================
insert into public.studios (id, name, slug, timezone) values
  ('00000000-0000-0000-0000-000000f00001', 'GC-S1B Harness Studio A', 't-gcsb1-studio-a', 'America/New_York'),
  ('00000000-0000-0000-0000-000000f00002', 'GC-S1B Harness Studio B', 't-gcsb1-studio-b', 'America/Los_Angeles');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f10001', 't-gcsb1-owner-a@example.test'),
  ('00000000-0000-0000-0000-000000f10002', 't-gcsb1-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000f10003', 't-gcsb1-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-000000f10004', 't-gcsb1-instructor-a@example.test'),
  ('00000000-0000-0000-0000-000000f10005', 't-gcsb1-unrelated@example.test'),
  ('00000000-0000-0000-0000-000000f10006', 't-gcsb1-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000f10007', 't-gcsb1-platform-admin@example.test'),
  ('00000000-0000-0000-0000-000000f10008', 't-gcsb1-noassign@example.test'),
  ('00000000-0000-0000-0000-000000f10009', 't-gcsb1-instructor-b@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f10001', 't-gcsb1-owner-a@example.test', null),
  ('00000000-0000-0000-0000-000000f10002', 't-gcsb1-admin-a@example.test', null),
  ('00000000-0000-0000-0000-000000f10003', 't-gcsb1-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-000000f10004', 't-gcsb1-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-000000f10005', 't-gcsb1-unrelated@example.test', null),
  ('00000000-0000-0000-0000-000000f10006', 't-gcsb1-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000f10007', 't-gcsb1-platform-admin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-000000f10008', 't-gcsb1-noassign@example.test', null),
  ('00000000-0000-0000-0000-000000f10009', 't-gcsb1-instructor-b@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f10001', '00000000-0000-0000-0000-000000f00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f10002', '00000000-0000-0000-0000-000000f00001', 'studio_admin', true),
  ('00000000-0000-0000-0000-000000f10003', '00000000-0000-0000-0000-000000f00001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000f10004', '00000000-0000-0000-0000-000000f00001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f10006', '00000000-0000-0000-0000-000000f00002', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f10008', '00000000-0000-0000-0000-000000f00001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f10009', '00000000-0000-0000-0000-000000f00002', 'instructor', true);
-- f10005: no role anywhere (negative control).

-- The plan seat gate caps instructors per studio; disabled for this transaction only.
alter table public.instructors disable trigger user;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-000000f20001', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f10004', 'Assignable', 'Instructor', true, true),
  ('00000000-0000-0000-0000-000000f20002', '00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-000000f10008', 'NoAssign', 'Instructor', true, false),
  ('00000000-0000-0000-0000-000000f20003', '00000000-0000-0000-0000-000000f00002', '00000000-0000-0000-0000-000000f10009', 'StudioB', 'Instructor', true, true);
alter table public.instructors enable trigger user;

insert into public.rooms (id, studio_id, name) values
  ('00000000-0000-0000-0000-000000f30001', '00000000-0000-0000-0000-000000f00001', 'T-gcsb1 Room A'),
  ('00000000-0000-0000-0000-000000f30002', '00000000-0000-0000-0000-000000f00002', 'T-gcsb1 Room B');

-- ============================================================================
-- 3. PREVIEW (read-only) + create + materialization, as studio owner A
-- ============================================================================
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_rows int; v_before int; v_after int; r record;
begin
  select count(*) into v_before from public.appointments;
  select count(*) into v_rows from public.preview_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001', p_title => 'Salsa 1',
    p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001',
    p_location_name => '  Main Floor ', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[],
    p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6,
    p_local_start_time => time '18:30', p_duration_minutes => 60);
  perform public.t_gcsb1_assert('T-gcsb1-preview-returns-all-occurrences', v_rows::text, '6');
  select count(*) into v_after from public.appointments;
  perform public.t_gcsb1_assert('T-gcsb1-preview-writes-nothing', (v_after - v_before)::text || '/' || (select count(*) from public.group_class_series)::text, '0/0');

  select * into r from public.preview_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001', p_title => 'Salsa 1',
    p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001',
    p_location_name => '  Main Floor ', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[],
    p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6,
    p_local_start_time => time '18:30', p_duration_minutes => 60) order by occurrence_index limit 1;
  perform public.t_gcsb1_assert('T-gcsb1-preview-row-shape',
    r.occurrence_index || '|' || r.local_date || '|' || to_char(r.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' || to_char(r.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')
      || '|' || r.instructor_id || '|' || r.room_id || '|' || r.location_name || '|' || r.roster_capacity || '|' || coalesce(r.dst_note, 'none'),
    '1|2027-01-12|2027-01-12T23:30|2027-01-13T00:30|00000000-0000-0000-0000-000000f20001|00000000-0000-0000-0000-000000f30001|Main Floor|12|none');
end $$;

-- preview validates instructor / room / capacity with structured errors
select public.t_gcsb1_expect($$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 't', '00000000-0000-0000-0000-000000f20002', null, null, null, array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'GCSB1_INSTRUCTOR_UNASSIGNABLE', 'T-gcsb1-preview-reject-unassignable-instructor');
select public.t_gcsb1_expect($$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 't', '00000000-0000-0000-0000-000000f20003', null, null, null, array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'GCSB1_INSTRUCTOR_UNASSIGNABLE', 'T-gcsb1-preview-reject-other-studio-instructor');
select public.t_gcsb1_expect($$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 't', null, '00000000-0000-0000-0000-000000f30002', null, null, array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'GCSB1_ROOM_INVALID', 'T-gcsb1-preview-reject-other-studio-room');
select public.t_gcsb1_expect($$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 't', null, null, null, 0, array[2]::smallint[], 1, date '2027-01-12', null, 4, time '18:30', 60)$$, 'GCSB1_INVALID_DEFINITION', 'T-gcsb1-preview-reject-capacity-0');

-- create: weekly+multi-weekday, skip {2,4}, policy defaults, location/capacity
do $$
declare
  v_res jsonb; v_series uuid; v_n int; r record; v_idx text;
begin
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001',
    p_client_request_id => '00000000-0000-0000-0000-000000f60001',
    p_title => '  Salsa 1  ', p_description => 'Beginner series',
    p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001',
    p_location_name => ' Main Floor ', p_roster_capacity => 12,
    p_weekdays => array[4, 2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12',
    p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60,
    p_skip_indices => array[2, 4, 2],
    p_publicly_discoverable => true, p_self_enrollment_allowed => true,
    p_accepted_funding_types => array['membership', 'package'], p_direct_payment_amount => null);
  v_series := (v_res ->> 'series_id')::uuid;
  perform public.t_gcsb1_assert('T-gcsb1-create-returns-counts-and-replay-false', (v_res ->> 'materialized_count') || '/' || (v_res ->> 'replay'), '4/false');

  -- series row
  select * into r from public.group_class_series where id = v_series;
  perform public.t_gcsb1_assert('T-gcsb1-create-series-row',
    r.title || '|' || r.timezone || '|' || array_to_string(r.weekdays, ',') || '|' || r.interval_weeks || '|' || r.starts_on || '|' || coalesce(r.ends_on::text, 'null') || '|' || r.occurrence_count
      || '|' || r.local_start_time || '|' || r.duration_minutes || '|' || r.default_instructor_id || '|' || r.default_room_id || '|' || r.default_location_name || '|' || r.default_roster_capacity
      || '|' || r.status || '|' || r.created_by || '|' || r.client_request_id,
    'Salsa 1|America/New_York|2,4|1|2027-01-12|null|6|18:30:00|60|00000000-0000-0000-0000-000000f20001|00000000-0000-0000-0000-000000f30001|Main Floor|12|active|00000000-0000-0000-0000-000000f10001|00000000-0000-0000-0000-000000f60001');

  -- occurrences: stable pre-skip indices, gaps retained (2 and 4 skipped), duplicates in the skip list tolerated
  select string_agg(series_occurrence_index::text, ',' order by series_occurrence_index) into v_idx
    from public.appointments where group_class_series_id = v_series;
  perform public.t_gcsb1_assert('T-gcsb1-skip-indices-stable-gaps-retained', v_idx, '1,3,5,6');
  -- dates: idx1 Tue 01-12, idx3 Tue 01-19, idx5 Tue 01-26, idx6 Thu 01-28 (idx2 Thu 01-14 and idx4 Thu 01-21 skipped)
  perform public.t_gcsb1_assert('T-gcsb1-skip-materialized-dates',
    (select string_agg((starts_at at time zone 'America/New_York')::date::text, ',' order by series_occurrence_index) from public.appointments where group_class_series_id = v_series),
    '2027-01-12,2027-01-19,2027-01-26,2027-01-28');

  -- canonical group_class shape + copied defaults + original start
  select count(*) into v_n from public.appointments a
   where a.group_class_series_id = v_series
     and a.appointment_type = 'group_class' and a.client_id is null and a.status = 'scheduled'
     and a.studio_id = '00000000-0000-0000-0000-000000f00001'
     and a.title = 'Salsa 1' and a.instructor_id = '00000000-0000-0000-0000-000000f20001'
     and a.room_id = '00000000-0000-0000-0000-000000f30001' and a.location_name = 'Main Floor' and a.roster_capacity = 12
     and a.occurrence_original_start = a.starts_at and a.ends_at = a.starts_at + interval '60 minutes'
     and a.created_by = '00000000-0000-0000-0000-000000f10001'
     and a.client_package_id is null and a.client_membership_id is null and a.price_amount is null
     and cardinality(a.series_overridden_fields) = 0;
  perform public.t_gcsb1_assert('T-gcsb1-create-occurrence-canonical-shape-and-defaults', v_n::text, '4');

  -- one policy row per materialized occurrence with the series defaults
  select count(*) into v_n from public.group_class_enrollment_policies p
   join public.appointments a on a.id = p.appointment_id
   where a.group_class_series_id = v_series and p.studio_id = a.studio_id
     and p.publicly_discoverable and p.self_enrollment_allowed
     and p.accepted_funding_types = array['membership', 'package'] and p.direct_payment_amount is null;
  perform public.t_gcsb1_assert('T-gcsb1-create-policy-row-per-occurrence', v_n::text, '4');
  perform public.t_gcsb1_assert('T-gcsb1-create-no-extra-policy-rows',
    (select count(*)::text from public.group_class_enrollment_policies p join public.appointments a on a.id = p.appointment_id where a.group_class_series_id = v_series), '4');

  -- preview/create generator equivalence (same inputs -> same instants for the non-skipped indices)
  perform public.t_gcsb1_assert('T-gcsb1-preview-create-equivalence',
    (select string_agg(to_char(p.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') , ',' order by p.occurrence_index)
       from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 'Salsa 1', null, null, null, null, array[4, 2]::smallint[], 1, date '2027-01-12', null, 6, time '18:30', 60) p
      where p.occurrence_index in (1, 3, 5, 6)),
    (select string_agg(to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), ',' order by a.series_occurrence_index) from public.appointments a where a.group_class_series_id = v_series));
end $$;

-- skip validation
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60010', p_title => 'x', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-02-02', p_ends_on => null, p_occurrence_count => 4, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[0])$$, 'GCSB1_INVALID_SKIP', 'T-gcsb1-skip-reject-index-0');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60011', p_title => 'x', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-02-02', p_ends_on => null, p_occurrence_count => 4, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[5])$$, 'GCSB1_INVALID_SKIP', 'T-gcsb1-skip-reject-index-beyond-count');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60012', p_title => 'x', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-02-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[1, 2, 3])$$, 'GCSB1_NO_OCCURRENCES', 'T-gcsb1-skip-reject-all-skipped');

-- direct-payment amount is carried as dormant data only
do $$
declare v_res jsonb;
begin
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60002',
    p_title => 'Dormant pay', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null,
    p_weekdays => array[3]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-02-03', p_ends_on => null, p_occurrence_count => 2,
    p_local_start_time => time '10:00', p_duration_minutes => 45,
    p_accepted_funding_types => array['direct_payment'], p_direct_payment_amount => 25);
  perform public.t_gcsb1_assert('T-gcsb1-policy-direct-payment-amount-dormant-copy',
    (select count(*)::text from public.group_class_enrollment_policies p join public.appointments a on a.id = p.appointment_id
      where a.group_class_series_id = (v_res ->> 'series_id')::uuid and p.direct_payment_amount = 25 and not p.publicly_discoverable and not p.self_enrollment_allowed), '2');
end $$;

-- ============================================================================
-- 4. ATOMICITY: every failure leaves no series / appointment / policy behind
-- ============================================================================
reset role;
create temp table t_gcsb1_state as select public.t_gcsb1_counts() as c;
grant all on t_gcsb1_state to public;

do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);
  set local role authenticated;
end $$;

select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60020', p_title => 'bad instr', p_description => null, p_instructor_id => '00000000-0000-0000-0000-000000f20002', p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_INSTRUCTOR_UNASSIGNABLE', 'T-gcsb1-atomic-bad-instructor-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60021', p_title => 'bad room', p_description => null, p_instructor_id => null, p_room_id => '00000000-0000-0000-0000-000000f30002', p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_ROOM_INVALID', 'T-gcsb1-atomic-bad-room-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60022', p_title => 'bad policy', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60, p_publicly_discoverable => true)$$, 'GCSB1_POLICY_INVALID', 'T-gcsb1-atomic-invalid-policy-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60023', p_title => 'bad policy 2', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60, p_accepted_funding_types => array['direct_payment'])$$, 'GCSB1_POLICY_INVALID', 'T-gcsb1-atomic-direct-payment-without-amount-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60024', p_title => 'bad cap', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => 0, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_INVALID_DEFINITION', 'T-gcsb1-atomic-bad-capacity-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60025', p_title => '   ', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_INVALID_DEFINITION', 'T-gcsb1-atomic-blank-title-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60026', p_title => 'bad rec', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 105, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_OCCURRENCE_CAP_EXCEEDED', 'T-gcsb1-atomic-cap-exceeded-rejected');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60027', p_title => 'bad rec', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-03-02', p_ends_on => null, p_occurrence_count => 3, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_INVALID_RECURRENCE', 'T-gcsb1-atomic-invalid-recurrence-rejected');

do $$
begin
  perform public.t_gcsb1_assert('T-gcsb1-atomic-no-residue-after-validation-failures',
    public.t_gcsb1_counts(), (select c from t_gcsb1_state));
end $$;

-- Forced failure AFTER the series row and some occurrences were already inserted:
-- a temporary trigger (rolled back with the script) fails the 3rd occurrence insert.
reset role;
create function public.t_gcsb1_force_fail_appt() returns trigger language plpgsql as $$
begin
  if new.title = 'FORCE-APPT-FAIL' and new.series_occurrence_index = 3 then
    raise exception 'forced occurrence failure';
  end if;
  return new;
end;
$$;
create trigger t_gcsb1_force_fail_appt before insert on public.appointments for each row execute function public.t_gcsb1_force_fail_appt();
create function public.t_gcsb1_force_fail_policy() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.appointments a where a.id = new.appointment_id and a.title = 'FORCE-POLICY-FAIL') then
    raise exception 'forced policy failure';
  end if;
  return new;
end;
$$;
create trigger t_gcsb1_force_fail_policy before insert on public.group_class_enrollment_policies for each row execute function public.t_gcsb1_force_fail_policy();

do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);
  set local role authenticated;
end $$;

select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60030', p_title => 'FORCE-APPT-FAIL', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-04-06', p_ends_on => null, p_occurrence_count => 5, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'forced occurrence failure', 'T-gcsb1-atomic-forced-occurrence-failure-raises');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60031', p_title => 'FORCE-POLICY-FAIL', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-04-06', p_ends_on => null, p_occurrence_count => 5, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'forced policy failure', 'T-gcsb1-atomic-forced-policy-failure-raises');

do $$
begin
  perform public.t_gcsb1_assert('T-gcsb1-atomic-no-residue-after-forced-failures',
    public.t_gcsb1_counts(), (select c from t_gcsb1_state));
  perform public.t_gcsb1_assert('T-gcsb1-atomic-forced-failure-request-ids-not-consumed',
    (select count(*)::text from public.group_class_series where client_request_id in ('00000000-0000-0000-0000-000000f60030', '00000000-0000-0000-0000-000000f60031')), '0');
end $$;

reset role;
drop trigger t_gcsb1_force_fail_appt on public.appointments;
drop trigger t_gcsb1_force_fail_policy on public.group_class_enrollment_policies;
-- the state baseline above was captured before the first successful creations of this section? No:
-- it was taken AFTER section 3's creations, so equality above proves failures added nothing.

-- ============================================================================
-- 5. IDEMPOTENCY
-- ============================================================================
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);
  set local role authenticated;
end $$;

do $$
declare
  v_first jsonb; v_replay jsonb; v_series_n_before bigint; v_appt_n_before bigint; v_pol_n_before bigint;
begin
  -- identical replay of the section-3 request returns the existing series, no new rows
  select count(*), (select count(*) from public.appointments), (select count(*) from public.group_class_enrollment_policies)
    into v_series_n_before, v_appt_n_before, v_pol_n_before from public.group_class_series;
  v_replay := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001',
    p_title => 'Salsa 1', p_description => 'Beginner series',
    p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001',
    p_location_name => 'Main Floor', p_roster_capacity => 12,
    p_weekdays => array[2, 4]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12',
    p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60,
    p_skip_indices => array[4, 2],
    p_publicly_discoverable => true, p_self_enrollment_allowed => true,
    p_accepted_funding_types => array['membership', 'package']);
  perform public.t_gcsb1_assert('T-gcsb1-idem-identical-replay-returns-existing',
    (v_replay ->> 'replay') || '/' || (v_replay ->> 'materialized_count') || '/' ||
    ((v_replay ->> 'series_id')::uuid = (select id from public.group_class_series where client_request_id = '00000000-0000-0000-0000-000000f60001')),
    'true/4/true');
  perform public.t_gcsb1_assert('T-gcsb1-idem-replay-creates-no-rows',
    ((select count(*) from public.group_class_series) - v_series_n_before)::text || '/' || ((select count(*) from public.appointments) - v_appt_n_before)::text || '/' || ((select count(*) from public.group_class_enrollment_policies) - v_pol_n_before)::text,
    '0/0/0');
end $$;

-- same request id, materially different definition => structured conflict (each defining field)
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001', p_title => 'Salsa 1 CHANGED', p_description => 'Beginner series', p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001', p_location_name => 'Main Floor', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[2, 4], p_publicly_discoverable => true, p_self_enrollment_allowed => true, p_accepted_funding_types => array['membership', 'package'])$$, 'GCSB1_IDEMPOTENCY_CONFLICT', 'T-gcsb1-idem-conflict-different-title');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001', p_title => 'Salsa 1', p_description => 'Beginner series', p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001', p_location_name => 'Main Floor', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[3], p_publicly_discoverable => true, p_self_enrollment_allowed => true, p_accepted_funding_types => array['membership', 'package'])$$, 'GCSB1_IDEMPOTENCY_CONFLICT', 'T-gcsb1-idem-conflict-different-skip-set');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001', p_title => 'Salsa 1', p_description => 'Beginner series', p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001', p_location_name => 'Main Floor', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60, p_publicly_discoverable => true, p_self_enrollment_allowed => true, p_accepted_funding_types => array['membership', 'package'])$$, 'GCSB1_IDEMPOTENCY_CONFLICT', 'T-gcsb1-idem-conflict-missing-skip-set');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001', p_title => 'Salsa 1', p_description => 'Beginner series', p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001', p_location_name => 'Main Floor', p_roster_capacity => 12, p_weekdays => array[2, 5]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[2, 4], p_publicly_discoverable => true, p_self_enrollment_allowed => true, p_accepted_funding_types => array['membership', 'package'])$$, 'GCSB1_IDEMPOTENCY_CONFLICT', 'T-gcsb1-idem-conflict-different-weekdays');
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60001', p_title => 'Salsa 1', p_description => 'Beginner series', p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => '00000000-0000-0000-0000-000000f30001', p_location_name => 'Main Floor', p_roster_capacity => 12, p_weekdays => array[2, 4]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-12', p_ends_on => null, p_occurrence_count => 6, p_local_start_time => time '18:30', p_duration_minutes => 60, p_skip_indices => array[2, 4], p_publicly_discoverable => true, p_self_enrollment_allowed => false, p_accepted_funding_types => array['membership', 'package'])$$, 'GCSB1_IDEMPOTENCY_CONFLICT', 'T-gcsb1-idem-conflict-different-policy-default');

-- retry after a fully rolled-back failure: the same request id succeeds (and is not a replay)
select public.t_gcsb1_expect($$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60040', p_title => 'Retry', p_description => null, p_instructor_id => '00000000-0000-0000-0000-000000f20002', p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-05-04', p_ends_on => null, p_occurrence_count => 2, p_local_start_time => time '18:30', p_duration_minutes => 60)$$, 'GCSB1_INSTRUCTOR_UNASSIGNABLE', 'T-gcsb1-idem-first-attempt-fails');
do $$
declare v_res jsonb;
begin
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => '00000000-0000-0000-0000-000000f60040',
    p_title => 'Retry', p_description => null, p_instructor_id => '00000000-0000-0000-0000-000000f20001', p_room_id => null, p_location_name => null, p_roster_capacity => null,
    p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-05-04', p_ends_on => null, p_occurrence_count => 2,
    p_local_start_time => time '18:30', p_duration_minutes => 60);
  perform public.t_gcsb1_assert('T-gcsb1-idem-retry-after-rollback-succeeds', (v_res ->> 'replay') || '/' || (v_res ->> 'materialized_count'), 'false/2');
end $$;

-- the same request id in another studio is independent (per-studio key), and the unique index backstop exists
reset role;
do $$
declare v_def text;
begin
  select indexdef into v_def from pg_indexes where schemaname = 'public' and indexname = 'uq_group_class_series_client_request';
  perform public.t_gcsb1_assert('T-gcsb1-idem-unique-index-definition',
    (v_def like '%UNIQUE%' and v_def like '%(studio_id, client_request_id)%' and v_def like '%client_request_id IS NOT NULL%')::text, 'true');
end $$;
select public.t_gcsb1_expect($$insert into public.group_class_series (studio_id, title, timezone, weekdays, starts_on, occurrence_count, local_start_time, duration_minutes, client_request_id)
  values ('00000000-0000-0000-0000-000000f00001', 'dup', 'UTC', array[2]::smallint[], date '2027-06-01', 2, time '10:00', 60, '00000000-0000-0000-0000-000000f60001')$$,
  'uq_group_class_series_client_request', 'T-gcsb1-idem-unique-index-blocks-duplicate-key');

do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10006')::text, true);
  set local role authenticated;
end $$;
do $$
declare v_res jsonb;
begin
  v_res := public.create_group_class_series(
    p_studio_id => '00000000-0000-0000-0000-000000f00002', p_client_request_id => '00000000-0000-0000-0000-000000f60001',
    p_title => 'Studio B own series', p_description => null, p_instructor_id => '00000000-0000-0000-0000-000000f20003', p_room_id => '00000000-0000-0000-0000-000000f30002', p_location_name => null, p_roster_capacity => null,
    p_weekdays => array[1]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-01-11', p_ends_on => null, p_occurrence_count => 2,
    p_local_start_time => time '18:30', p_duration_minutes => 60);
  perform public.t_gcsb1_assert('T-gcsb1-idem-request-id-is-per-studio', (v_res ->> 'replay'), 'false');
  -- Studio B's timezone (America/Los_Angeles) is read authoritatively: 18:30 PST = 02:30Z next day
  perform public.t_gcsb1_assert('T-gcsb1-create-uses-studio-timezone-authoritatively',
    (select to_char(min(starts_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') from public.appointments where group_class_series_id = (v_res ->> 'series_id')::uuid), '2027-01-12T02:30');
end $$;
reset role;

-- ============================================================================
-- 6. AUTHORITY
-- ============================================================================
do $$
declare
  r record;
  v_res jsonb;
  v_call text := $c$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => %L::uuid, p_title => 'Authz', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-07-06', p_ends_on => null, p_occurrence_count => 2, p_local_start_time => time '18:30', p_duration_minutes => 60)$c$;
  v_preview text := $c$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 'Authz', null, null, null, null, array[2]::smallint[], 1, date '2027-07-06', null, 2, time '18:30', 60)$c$;
begin
  -- permitted: admin, front desk, platform admin (any studio)
  for r in select * from (values
    ('admin-a', '00000000-0000-0000-0000-000000f10002'::uuid, '00000000-0000-0000-0000-000000f60051'::uuid),
    ('front-desk-a', '00000000-0000-0000-0000-000000f10003'::uuid, '00000000-0000-0000-0000-000000f60052'::uuid),
    ('platform-admin', '00000000-0000-0000-0000-000000f10007'::uuid, '00000000-0000-0000-0000-000000f60053'::uuid)
  ) as t(label, uid, req)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid)::text, true);
    set local role authenticated;
    execute format(v_call, r.req) into v_res;
    reset role;
    perform public.t_gcsb1_assert('T-gcsb1-authz-permitted-' || r.label, (v_res ->> 'materialized_count'), '2');
  end loop;
end $$;

do $$
declare
  r record;
  v_call text := $c$select public.create_group_class_series(p_studio_id => '00000000-0000-0000-0000-000000f00001', p_client_request_id => %L::uuid, p_title => 'Authz', p_description => null, p_instructor_id => null, p_room_id => null, p_location_name => null, p_roster_capacity => null, p_weekdays => array[2]::smallint[], p_interval_weeks => 1, p_starts_on => date '2027-07-06', p_ends_on => null, p_occurrence_count => 2, p_local_start_time => time '18:30', p_duration_minutes => 60)$c$;
  v_preview text := $c$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 'Authz', null, null, null, null, array[2]::smallint[], 1, date '2027-07-06', null, 2, time '18:30', 60)$c$;
begin
  -- refused: instructor (role at the studio), unrelated user, owner of ANOTHER studio
  for r in select * from (values
    ('instructor-a', '00000000-0000-0000-0000-000000f10004'::uuid, '00000000-0000-0000-0000-000000f60061'::uuid),
    ('unrelated', '00000000-0000-0000-0000-000000f10005'::uuid, '00000000-0000-0000-0000-000000f60062'::uuid),
    ('owner-b-cross-studio', '00000000-0000-0000-0000-000000f10006'::uuid, '00000000-0000-0000-0000-000000f60063'::uuid)
  ) as t(label, uid, req)
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid)::text, true);
    set local role authenticated;
    perform public.t_gcsb1_expect(format(v_call, r.req), 'GCSB1_UNAUTHORIZED', 'T-gcsb1-authz-create-refused-' || r.label);
    perform public.t_gcsb1_expect(v_preview, 'GCSB1_UNAUTHORIZED', 'T-gcsb1-authz-preview-refused-' || r.label);
    reset role;
  end loop;

  perform public.t_gcsb1_assert('T-gcsb1-authz-refusals-created-nothing',
    (select count(*)::text from public.group_class_series where client_request_id in (
      '00000000-0000-0000-0000-000000f60061', '00000000-0000-0000-0000-000000f60062', '00000000-0000-0000-0000-000000f60063')), '0');
end $$;

-- anon has no EXECUTE at all
do $$ begin set local role anon; end $$;
select public.t_gcsb1_expect($$select * from public.preview_group_class_series('00000000-0000-0000-0000-000000f00001', 'x', null, null, null, null, array[2]::smallint[], 1, date '2027-07-06', null, 2, time '18:30', 60)$$, 'permission denied', 'T-gcsb1-authz-anon-cannot-preview');
reset role;

-- ============================================================================
-- 7. Grants, security modes, search_path
-- ============================================================================
do $$
declare r record; v_sig text;
begin
  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg, p.proacl::text as acl
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_gcsb1_series_dates', '_gcsb1_generate_series_occurrences', 'preview_group_class_series', 'create_group_class_series')
  loop
    if coalesce(r.cfg, '') not like '%search_path=public%' then
      raise exception 'FAIL T-gcsb1-fn-search-path: %', r.proname;
    end if;
    if r.proname in ('preview_group_class_series', 'create_group_class_series') then
      if not r.prosecdef then raise exception 'FAIL T-gcsb1-fn-must-be-definer: %', r.proname; end if;
      if not has_function_privilege('authenticated', r.oid, 'EXECUTE') then raise exception 'FAIL T-gcsb1-fn-authenticated-execute: %', r.proname; end if;
      if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('service_role', r.oid, 'EXECUTE')
         or exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = r.oid), acldefault('f', (select proowner from pg_proc where oid = r.oid)))) a where a.grantee = 0) then
        raise exception 'FAIL T-gcsb1-fn-public-anon-service-role-execute: %', r.proname;
      end if;
    else
      if r.prosecdef then raise exception 'FAIL T-gcsb1-internal-fn-must-be-invoker: %', r.proname; end if;
      if has_function_privilege('authenticated', r.oid, 'EXECUTE') or has_function_privilege('anon', r.oid, 'EXECUTE')
         or has_function_privilege('service_role', r.oid, 'EXECUTE') then
        raise exception 'FAIL T-gcsb1-internal-fn-must-have-no-grants: %', r.proname;
      end if;
    end if;
    perform public.t_gcsb1_pass('T-gcsb1-fn-security-' || r.proname);
  end loop;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('_gcsb1_series_dates', '_gcsb1_generate_series_occurrences', 'preview_group_class_series', 'create_group_class_series')) <> 4 then
    raise exception 'FAIL T-gcsb1-fn-count';
  end if;
end $$;

-- the authenticated role cannot call the internal generator directly
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f10001')::text, true);
  set local role authenticated;
end $$;
select public.t_gcsb1_expect($$select * from public._gcsb1_generate_series_occurrences('UTC', array[2]::smallint[], 1, date '2027-01-12', null, 2, time '10:00', 60)$$, 'permission denied', 'T-gcsb1-internal-generator-not-callable-by-authenticated');

-- ============================================================================
-- 8. Standalone class creation unaffected + S1A guard still protects occurrences
-- ============================================================================
do $$
declare v_id uuid;
begin
  v_id := public.create_group_class_appointment(
    '00000000-0000-0000-0000-000000f00001', null, null, 'Standalone', now() + interval '40 days', now() + interval '40 days 1 hour');
  perform public.t_gcsb1_assert('T-gcsb1-standalone-class-create-unchanged',
    (select (a.group_class_series_id is null and a.series_occurrence_index is null and a.occurrence_original_start is null and a.client_id is null and a.appointment_type = 'group_class')::text
       from public.appointments a where a.id = v_id), 'true');
end $$;
select public.t_gcsb1_expect($$update public.appointments set series_occurrence_index = 99 where group_class_series_id is not null$$, 'series workflow', 'T-gcsb1-s1a-guard-still-blocks-direct-index-change');
reset role;

-- ============================================================================
-- 9. No legacy interaction; report; roll back
-- ============================================================================
do $$
declare s record;
begin
  select * into s from t_gcsb1_snap;
  perform public.t_gcsb1_assert('T-gcsb1-no-legacy-events-mutation',
    (select count(*) from public.events)::text || '/' || (select count(*) from public.event_sessions)::text || '/' || (select count(*) from public.event_registrations)::text,
    s.events_n::text || '/' || s.event_sessions_n::text || '/' || s.event_regs_n::text);
end $$;

select count(*) as passes, string_agg(msg, E'\n' order by n) as detail from public.t_gcsb1_log;

rollback;
