-- 20270102090000_competition_e2_ballots.sql
--
-- PHASE 10 -- E2: immutable ballots (K0 section 3 ballots/marks, section 4 lock/reopen, section 9 #1; slot 20270102090000).
--
-- New:
--   event_competition_ballots           insert-only (UPDATE/DELETE/TRUNCATE refused); a correction is a new row with
--                                       supersedes_id + correction_reason and version + 1
--   event_competition_marks             insert-only, created in the same transaction as their ballot
--   event_competition_judge_attendance  insert-only present/absent history per (round, judge); K0 O1 "recorded absence"
--   event_competition_ballot_events     append-only audit (fixed kinds, idempotency request ids)
--   RPCs (SECURITY DEFINER, authenticated only, idempotent on a request id):
--     submit_competition_ballot            a judge/chair submits or corrects THEIR OWN ballot (source judge_web)
--     enter_competition_paper_ballot       an assigned scorer or a manager enters a paper ballot on behalf of a named judge
--                                          (source scorer_paper, entered_by recorded)
--     record_competition_judge_attendance  manager or the designated chair records a judge absent / present
--     lock_competition_round_ballots       active -> ballots_locked (manager or designated chair)
--     reopen_competition_round_ballots     ballots_locked -> active (manager, reason, refused once a result is approved)
--     competition_round_ballot_status      lock-readiness board (manager / chair / assigned scorer)
--     competition_judge_ballot_sheet       a judge's own sheet (entries + own current ballot)
--
-- Mark rules (shared with src/lib/competition/ballots/schemes.ts) come only from APPROVED sources or from the K1
-- "Default until decided" column; every provisional rule is tagged with its K1 decision id:
--   ordinal_majority   D-OM-4 no judge ties, D-OM-5 full 1..N ranking per heat
--   proficiency_rating D-PR-3 Bronze/Silver/Gold only, D-PR-5 every entry rated
--   callback_tally     D-CT-1/D-CT-2 mark shape undecided -> ballots refused (COMP_BALLOT_SCHEME_NOT_AVAILABLE)
--   X-5 (scratched entries) are excluded from a heat's expected entries; X-7 ballots are per heat.
--
-- Audit: K0 reserves event_competition_result_events for F2 (not merged). E2 owns the minimal append-only
-- event_competition_ballot_events (K0 kinds ballot_submitted / ballot_corrected / judge_absence_recorded /
-- round_state_changed, plus judge_presence_recorded). F2 may fold it into result_events later.
--

-- Round status: the two E2 edges (active -> ballots_locked, ballots_locked -> active) are written only by the lock /
-- reopen RPCs; a guard trigger requires their audit row in the same transaction. Ballots are accepted only while the
-- round is `active` (a trigger enforces it too); F2's correction path may relax that when it exists.
--
-- Rollback: rollback/20270102090000_competition_e2_ballots_rollback.sql (refuses while any ballot evidence exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_ballots') is not null
     or to_regclass('public.event_competition_marks') is not null
     or to_regclass('public.event_competition_judge_attendance') is not null
     or to_regclass('public.event_competition_ballot_events') is not null
     or to_regclass('public.event_competition_ballot_drafts') is not null then
    raise exception 'E2 preflight: an E2 table already exists.';
  end if;
  if to_regclass('public.event_competition_officials') is null
     or to_regclass('public.event_competition_panel_assignments') is null
     or to_regprocedure('public.competition_is_active_official(uuid)') is null then
    raise exception 'E2 preflight: E1 officials / panel assignments are missing.';
  end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regclass('public.event_competition_heat_entries') is null then
    raise exception 'E2 preflight: 10A / 10D / LAUNCH-SEC-1C-B objects are missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.event_competition_ballots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  -- null = a round-level ballot (callback_tally: exactly T couples across the whole round, K1 D-CT-2)
  heat_id uuid,
  official_id uuid not null,
  -- Ballot FORMAT (independent of scoring method / engine): marks are validated against it. Versioned, open set.
  ballot_format text not null,
  ballot_format_version integer not null,
  version integer not null,
  source text not null,
  submitted_by uuid not null,
  entered_by_official_id uuid,
  supersedes_id uuid,
  correction_reason text,
  submitted_at timestamptz not null default now(),
  transaction_id bigint not null default txid_current(),
  constraint event_competition_ballots_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_ballots_heat_fk
    foreign key (heat_id, event_id) references public.event_competition_heats(id, event_id) on delete cascade,
  constraint event_competition_ballots_official_fk
    foreign key (official_id, event_id) references public.event_competition_officials(id, event_id),
  constraint event_competition_ballots_entered_by_fk
    foreign key (entered_by_official_id, event_id) references public.event_competition_officials(id, event_id),
  constraint event_competition_ballots_supersedes_fk
    foreign key (supersedes_id, event_id) references public.event_competition_ballots(id, event_id),
  constraint event_competition_ballots_source_check check (source in ('judge_web', 'scorer_paper')),
  constraint event_competition_ballots_version_check check (version >= 1),
  -- heat_id is null only for round-scope formats (callback_yes); every per-heat format needs a heat.
  constraint event_competition_ballots_scope_check check ((ballot_format = 'callback_yes') = (heat_id is null)),
  constraint event_competition_ballots_format_check check (ballot_format ~ '^[a-z][a-z0-9_]{1,63}$' and ballot_format_version >= 1),
  constraint event_competition_ballots_chain_check check (
    (supersedes_id is null and version = 1 and correction_reason is null)
    or (supersedes_id is not null and version > 1 and length(btrim(coalesce(correction_reason, ''))) between 1 and 500)
  ),
  constraint event_competition_ballots_entered_by_check check (
    (source = 'judge_web' and entered_by_official_id is null)
    or (source = 'scorer_paper')
  ),
  unique (id, event_id),
  unique (heat_id, official_id, version)
);
-- One root ballot per (heat, judge) and one successor per ballot: the chain can never fork.
create unique index event_competition_ballots_root_idx
  on public.event_competition_ballots(heat_id, official_id) where supersedes_id is null and heat_id is not null;
create unique index event_competition_ballots_round_root_idx
  on public.event_competition_ballots(round_id, official_id) where supersedes_id is null and heat_id is null;
create unique index event_competition_ballots_round_version_idx
  on public.event_competition_ballots(round_id, official_id, version) where heat_id is null;
create unique index event_competition_ballots_successor_idx
  on public.event_competition_ballots(supersedes_id) where supersedes_id is not null;
create index event_competition_ballots_round_idx on public.event_competition_ballots(round_id, heat_id);
create index event_competition_ballots_official_idx on public.event_competition_ballots(official_id);

create table public.event_competition_marks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  ballot_id uuid not null,
  entry_id uuid not null,
  role text,
  mark jsonb not null,
  constraint event_competition_marks_ballot_fk
    foreign key (ballot_id, event_id) references public.event_competition_ballots(id, event_id) on delete cascade,
  constraint event_competition_marks_entry_fk
    foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id) on delete cascade,
  -- Studio marks are per entry (K1 S6 scored_by: entry). Role scoring needs an approved profile first.
  constraint event_competition_marks_role_check check (role is null),
  constraint event_competition_marks_mark_check check (jsonb_typeof(mark) in ('number', 'string', 'boolean'))
);
create unique index event_competition_marks_ballot_entry_idx on public.event_competition_marks(ballot_id, entry_id);
create index event_competition_marks_entry_idx on public.event_competition_marks(entry_id);

create table public.event_competition_judge_attendance (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  official_id uuid not null,
  status text not null,
  reason text,
  recorded_by uuid not null,
  recorded_at timestamptz not null default now(),
  constraint event_competition_judge_attendance_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_judge_attendance_official_fk
    foreign key (official_id, event_id) references public.event_competition_officials(id, event_id),
  constraint event_competition_judge_attendance_status_check check (status in ('absent', 'present')),
  constraint event_competition_judge_attendance_reason_check check (
    (status = 'absent' and length(btrim(coalesce(reason, ''))) between 1 and 500)
    or (status = 'present' and (reason is null or length(reason) <= 500))
  )
);
create index event_competition_judge_attendance_current_idx
  on public.event_competition_judge_attendance(round_id, official_id, seq desc);

create table public.event_competition_ballot_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  heat_id uuid,
  kind text not null,
  actor_user_id uuid not null,
  official_id uuid,
  ballot_id uuid,
  from_state text,
  to_state text,
  request_id uuid not null,
  reason text,
  refs jsonb not null default '{}'::jsonb,
  transaction_id bigint not null default txid_current(),
  occurred_at timestamptz not null default now(),
  constraint event_competition_ballot_events_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_ballot_events_kind_check check (kind in (
    'ballot_submitted', 'ballot_corrected', 'judge_absence_recorded', 'judge_presence_recorded', 'round_state_changed')),
  constraint event_competition_ballot_events_reason_check check (reason is null or length(reason) <= 500)
);
-- A request id describes exactly one operation, ever.
create unique index event_competition_ballot_events_request_idx on public.event_competition_ballot_events(request_id);
create index event_competition_ballot_events_round_idx on public.event_competition_ballot_events(round_id, occurred_at);
create index event_competition_ballot_events_txn_idx on public.event_competition_ballot_events(transaction_id, round_id);

-- Mutable per-judge scratch for callback selections across heats (K1 D-CT-2: "save selections across heats").
-- NOT ballot evidence and never engine input: submitting writes the immutable round-level ballot.
create table public.event_competition_ballot_drafts (
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  official_id uuid not null,
  selections jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint event_competition_ballot_drafts_pkey primary key (round_id, official_id),
  constraint event_competition_ballot_drafts_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_ballot_drafts_official_fk
    foreign key (official_id, event_id) references public.event_competition_officials(id, event_id) on delete cascade,
  constraint event_competition_ballot_drafts_shape check (jsonb_typeof(selections) = 'array' and jsonb_array_length(selections) <= 1000)
);

comment on table public.event_competition_ballots is
  'E2: insert-only judge ballots, one per (heat, judge, version). A correction is a new row (supersedes_id + correction_reason). The current ballot is the one nothing supersedes.';
comment on table public.event_competition_marks is
  'E2: insert-only marks of a ballot, validated against the round scoring_method by the submit RPCs. Never UPDATE/DELETE.';

-- ---------------------------------------------------------------------------
-- 2. Immutability and row guards
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['event_competition_ballots', 'event_competition_marks',
                           'event_competition_judge_attendance', 'event_competition_ballot_events'] loop
    execute format('create trigger protect_%1$s_history before update or delete on public.%1$I
                    for each row execute function public.protect_competition_history_evidence()', t);
    execute format('create trigger protect_%1$s_history_truncate before truncate on public.%1$I
                    for each statement execute function public.protect_competition_history_evidence()', t);
  end loop;
end $$;

-- Ballot format registry (SQL mirror of src/lib/competition/ballots/formats.ts). The set is open: a new format is one row
-- here plus a validator; ballots and marks storage do not change. A format is usable only when approved.
create function public._compe2_format_for_scoring(p_scoring text)
returns table(format text, version integer)
language sql
immutable
as $$
  select f.format, f.version from (values
    ('ordinal_majority', 'ordinal_rank', 1),
    ('callback_tally', 'callback_yes', 1),
    ('proficiency_rating', 'three_band', 1)) f(scoring, format, version)
  where f.scoring = p_scoring;
$$;
revoke all on function public._compe2_format_for_scoring(text) from public, anon, authenticated;

-- Owner-approved formats only. three_band@1 (Gold/Silver/Bronze) is NOT approved: ballots in it fail closed.
create function public._compe2_format_approved(p_format text, p_version integer)
returns boolean
language sql
immutable
as $$
  select (p_format, p_version) in (('ordinal_rank', 1), ('callback_yes', 1));
$$;
revoke all on function public._compe2_format_approved(text, integer) from public, anon, authenticated;

-- 'round' = one ballot per judge for the whole round (heat_id null); 'heat' = one per judge and heat.
create function public._compe2_format_scope(p_format text)
returns text
language sql
immutable
as $$
  select case when p_format = 'callback_yes' then 'round' else 'heat' end;
$$;
revoke all on function public._compe2_format_scope(text) from public, anon, authenticated;

-- Ballot insert guard: round active, heat belongs to the round, correction chain is well-formed. Defence in depth for the RPCs.
create function public._compe2_guard_ballot_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_exp_format text;
  v_exp_version integer;
  v_prior public.event_competition_ballots;
begin
  new.transaction_id := txid_current();
  new.submitted_at := now();

  select r.status into v_status
  from public.event_competition_rounds r
  where r.id = new.round_id and r.event_id = new.event_id
  for share;
  if v_status is distinct from 'active' then
    raise exception 'COMP_BALLOT_ROUND_NOT_ACTIVE: ballots are accepted only while the round is active (round status: %).',
      coalesce(v_status, 'missing') using errcode = 'P0001';
  end if;

  if not public._compe2_format_approved(new.ballot_format, new.ballot_format_version) then
    raise exception 'COMP_BALLOT_FORMAT_NOT_APPROVED: ballot format %@% is not approved; ballots fail closed.', new.ballot_format, new.ballot_format_version using errcode = 'P0001';
  end if;
  select f.format, f.version into v_exp_format, v_exp_version
  from public._compe2_format_for_scoring((select r.scoring_method from public.event_competition_rounds r where r.id = new.round_id)) f;
  if (new.ballot_format, new.ballot_format_version) is distinct from (v_exp_format, v_exp_version) then
    raise exception 'COMP_BALLOT_FORMAT_MISMATCH: ballot format %@% is not the format of this round''s scoring method.', new.ballot_format, new.ballot_format_version using errcode = 'P0001';
  end if;
  if new.heat_id is null then
    if public._compe2_format_scope(new.ballot_format) <> 'round' then
      raise exception 'COMP_BALLOT_HEAT_INVALID: only round-level formats take a round-level ballot.' using errcode = 'P0001';
    end if;
  elsif public._compe2_format_scope(new.ballot_format) = 'round'
        or not exists (select 1 from public.event_competition_heats h
                       where h.id = new.heat_id and h.event_id = new.event_id and h.round_id = new.round_id) then
    raise exception 'COMP_BALLOT_HEAT_INVALID: the heat does not belong to the round (callback ballots are round-level).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.event_competition_panel_assignments a
                 where a.round_id = new.round_id and a.official_id = new.official_id and a.event_id = new.event_id
                   and a.judge_letter is not null) then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: the official is not a judge on this round''s panel.' using errcode = 'P0001';
  end if;

  if new.supersedes_id is not null then
    select * into v_prior from public.event_competition_ballots b where b.id = new.supersedes_id and b.event_id = new.event_id;
    if not found or v_prior.heat_id is distinct from new.heat_id or (v_prior.ballot_format, v_prior.ballot_format_version) is distinct from (new.ballot_format, new.ballot_format_version) or v_prior.official_id <> new.official_id
       or v_prior.round_id <> new.round_id or new.version <> v_prior.version + 1 then
      raise exception 'COMP_BALLOT_IMMUTABLE: a correction must supersede the same judge''s latest ballot for the same heat (version + 1).'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._compe2_guard_ballot_insert() from public, anon, authenticated;
create trigger compe2_guard_ballot_insert
  before insert on public.event_competition_ballots
  for each row execute function public._compe2_guard_ballot_insert();

-- Mark insert guard: marks exist only in the transaction that created their ballot, for entries of that ballot's heat.
create function public._compe2_guard_mark_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ballot public.event_competition_ballots;
begin
  select * into v_ballot from public.event_competition_ballots b where b.id = new.ballot_id and b.event_id = new.event_id;
  if not found or v_ballot.transaction_id <> txid_current() then
    raise exception 'COMP_BALLOT_IMMUTABLE: marks can only be written together with their ballot.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.event_competition_heat_entries he
                 where (he.heat_id = v_ballot.heat_id
                        or (v_ballot.heat_id is null and he.heat_id in (select h.heat_id from public._compe2_round_heats(v_ballot.round_id) h)))
                   and he.entry_id = new.entry_id and he.event_id = new.event_id
                   and he.status <> 'scratched') then
    raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: the entry is not on the ballot''s heat.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._compe2_guard_mark_insert() from public, anon, authenticated;
create trigger compe2_guard_mark_insert
  before insert on public.event_competition_marks
  for each row execute function public._compe2_guard_mark_insert();

-- Round status: the two E2 edges are written only by the lock/reopen RPCs (audit row in the same transaction).
create function public._compe2_guard_round_lock_edges()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status = 'active' and new.status = 'ballots_locked')
     or (old.status = 'ballots_locked' and new.status = 'active') then
    if not exists (
      select 1 from public.event_competition_ballot_events e
      where e.round_id = old.id and e.event_id = old.event_id and e.kind = 'round_state_changed'
        and e.from_state = old.status and e.to_state = new.status
        and e.transaction_id = txid_current()
    ) then
      raise exception 'COMP_ROUND_LOCK_WRITER: % -> % is written only by the lock / reopen ballots functions.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._compe2_guard_round_lock_edges() from public, anon, authenticated;
create trigger compe2_guard_round_lock_edges
  before update of status on public.event_competition_rounds
  for each row execute function public._compe2_guard_round_lock_edges();

-- Once a round has started, its scoring method and callback target are frozen (ballots were validated against them).
create function public._compe2_guard_round_config()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status not in ('draft', 'scheduled')
     and (new.scoring_method is distinct from old.scoring_method
          or new.target_advancement_count is distinct from old.target_advancement_count) then
    raise exception 'COMP_ROUND_CONFIG_FROZEN: scoring method and callback target cannot change once the round has started (status: %).', old.status
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._compe2_guard_round_config() from public, anon, authenticated;
create trigger compe2_guard_round_config
  before update of scoring_method, target_advancement_count on public.event_competition_rounds
  for each row execute function public._compe2_guard_round_config();

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no API grants)
-- ---------------------------------------------------------------------------
-- Heats a ballot can cover: the round's non-cancelled heats in a published/live schedule version with an entry to mark.
create function public._compe2_round_heats(p_round_id uuid)
returns table(heat_id uuid, heat_number integer, lock_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select h.id, h.heat_number, h.lock_state
  from public.event_competition_heats h
  where h.round_id = p_round_id
    and h.status <> 'cancelled'
    and exists (select 1 from public.event_competition_schedule_versions v
                where v.id = h.schedule_version_id and v.event_id = h.event_id and v.status in ('published', 'live'))
    and exists (select 1 from public.event_competition_heat_entries he where he.heat_id = h.id and he.status <> 'scratched')
  order by h.heat_number;
$$;
revoke all on function public._compe2_round_heats(uuid) from public, anon, authenticated;

create function public._compe2_heat_entries(p_heat_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(he.entry_id order by he.entry_id), '{}'::uuid[])
  from public.event_competition_heat_entries he
  where he.heat_id = p_heat_id and he.status <> 'scratched';
$$;
revoke all on function public._compe2_heat_entries(uuid) from public, anon, authenticated;

-- Panel judges: assignments carrying a judge letter (judge or chair officials).
create function public._compe2_round_judges(p_round_id uuid)
returns table(official_id uuid, judge_letter text, user_id uuid, official_status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, a.judge_letter, o.user_id, o.status
  from public.event_competition_panel_assignments a
  join public.event_competition_officials o on o.id = a.official_id and o.event_id = a.event_id
  where a.round_id = p_round_id and a.judge_letter is not null
  order by a.judge_letter;
$$;
revoke all on function public._compe2_round_judges(uuid) from public, anon, authenticated;

create function public._compe2_is_absent(p_round_id uuid, p_official_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select a.status = 'absent'
                   from public.event_competition_judge_attendance a
                   where a.round_id = p_round_id and a.official_id = p_official_id
                   order by a.seq desc limit 1), false);
$$;
revoke all on function public._compe2_is_absent(uuid, uuid) from public, anon, authenticated;

-- Mark validation, mirrored by src/lib/competition/ballots/schemes.ts (first error in the same order).
-- Returns the normalized marks: [{entry_id, value}] in entry order.
create function public._compe2_validate_marks(p_format text, p_expected uuid[], p_marks jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_n integer := coalesce(array_length(p_expected, 1), 0);
  v_el jsonb;
  v_entry uuid;
  v_val jsonb;
  v_seen jsonb := '{}'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_ordinals integer[] := '{}';
  v_num numeric;
  v_id uuid;
begin
  if p_format = 'callback_yes' then
    raise exception 'COMP_BALLOT_HEAT_INVALID: callback ballots are round-level; they are validated by _compe2_validate_callback.' using errcode = 'P0001';
  end if;
  if p_format is distinct from 'ordinal_rank' and p_format is distinct from 'three_band' then
    raise exception 'COMP_BALLOT_SCORING_METHOD_UNSUPPORTED: no validator for ballot format "%".', coalesce(p_format, 'null')
      using errcode = 'P0001';
  end if;
  if v_n = 0 then
    raise exception 'COMP_BALLOT_NO_ENTRIES: the heat has no entries to mark.' using errcode = 'P0001';
  end if;
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) > 1000 then
    raise exception 'COMP_BALLOT_INCOMPLETE: marks must be a list of {entry_id, value}.' using errcode = 'P0001';
  end if;

  for v_el in select * from jsonb_array_elements(p_marks) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: each mark must be an object.' using errcode = 'P0001';
    end if;
    if v_el ? 'role' and jsonb_typeof(v_el -> 'role') <> 'null' then
      raise exception 'COMP_BALLOT_ROLE_NOT_ALLOWED: studio marks are per entry, not per role.' using errcode = 'P0001';
    end if;
    begin
      v_entry := (v_el ->> 'entry_id')::uuid;
    exception when others then
      v_entry := null;
    end;
    if v_entry is null or not (v_entry = any (p_expected)) then
      raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: entry % is not on this heat.', coalesce(v_el ->> 'entry_id', 'null') using errcode = 'P0001';
    end if;
    if v_seen ? v_entry::text then
      raise exception 'COMP_BALLOT_DUPLICATE_MARK: more than one mark for entry %.', v_entry using errcode = 'P0001';
    end if;
    v_seen := v_seen || jsonb_build_object(v_entry::text, coalesce(v_el -> 'value', 'null'::jsonb));
  end loop;

  foreach v_id in array p_expected loop
    if not (v_seen ? v_id::text) then
      raise exception 'COMP_BALLOT_INCOMPLETE: entry % has no mark (every entry on the heat needs one; K1 %).', v_id,
        case when p_format = 'ordinal_rank' then 'D-OM-5' else 'D-PR-5' end using errcode = 'P0001';
    end if;
  end loop;

  if p_format = 'ordinal_rank' then
    foreach v_id in array p_expected loop
      v_val := v_seen -> v_id::text;
      if jsonb_typeof(v_val) <> 'number' then
        raise exception 'COMP_BALLOT_MARK_OUT_OF_RANGE: rank for entry % must be a whole number from 1 to % (K1 D-OM-5).', v_id, v_n using errcode = 'P0001';
      end if;
      v_num := (v_val #>> '{}')::numeric;
      if v_num <> trunc(v_num) or v_num < 1 or v_num > v_n then
        raise exception 'COMP_BALLOT_MARK_OUT_OF_RANGE: rank for entry % must be a whole number from 1 to % (K1 D-OM-5).', v_id, v_n using errcode = 'P0001';
      end if;
      v_ordinals := v_ordinals || v_num::integer;
    end loop;
    if (select count(distinct x) from unnest(v_ordinals) x) <> v_n then
      raise exception 'COMP_BALLOT_JUDGE_TIE: two entries share a rank (K1 D-OM-4: judge ties are rejected).' using errcode = 'P0001';
    end if;
  else
    foreach v_id in array p_expected loop
      v_val := v_seen -> v_id::text;
      if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') not in ('Bronze', 'Silver', 'Gold') then
        raise exception 'COMP_BALLOT_MARK_NOT_IN_SCALE: rating for entry % must be exactly Bronze, Silver or Gold (K1 D-PR-3).', v_id using errcode = 'P0001';
      end if;
    end loop;
  end if;

  foreach v_id in array p_expected loop
    v_val := v_seen -> v_id::text;
    if p_format = 'ordinal_rank' then
      v_val := to_jsonb(((v_val #>> '{}')::numeric)::integer);
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('entry_id', v_id, 'value', v_val));
  end loop;
  return v_out;
end;
$$;
revoke all on function public._compe2_validate_marks(text, uuid[], jsonb) from public, anon, authenticated;

-- Eligible couples of a callback round: entries of its ballot heats that are not scratched (K1 X-5; no no-show state exists yet).
create function public._compe2_round_entries(p_round_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct he.entry_id), '{}'::uuid[])
  from public.event_competition_heat_entries he
  where he.heat_id in (select h.heat_id from public._compe2_round_heats(p_round_id) h) and he.status <> 'scratched';
$$;
revoke all on function public._compe2_round_entries(uuid) from public, anon, authenticated;

-- Panel-size rule per scoring method (owner Stage 4: X-3 applies to STUDIO methods only). Any method not listed here has an
-- unknown panel rule and fails closed at lock (known = false). Other sanctioning bodies will add their own rows.
create function public._compe2_panel_rule(p_scoring text)
returns table(known boolean, min_judges integer, odd_required boolean)
language sql
immutable
as $$
  select r.known, r.min_judges, r.odd_required from (values
    ('ordinal_majority', true, 3, true),
    ('callback_tally', true, 3, true),
    ('proficiency_rating', true, 1, false)) r(scoring, known, min_judges, odd_required)
  where r.scoring = p_scoring
  union all
  select false, null::integer, null::boolean where p_scoring not in ('ordinal_majority', 'callback_tally', 'proficiency_rating') or p_scoring is null;
$$;
revoke all on function public._compe2_panel_rule(text) from public, anon, authenticated;

-- Callback rules (owner-approved D-CT-1/D-CT-2/D-CT-5): a mark is "yes" only; exactly T eligible couples across the whole
-- round; T = target_advancement_count must be set and smaller than the eligible count.
-- p_marks: [{entry_id, value: true}]. Returns normalized [{entry_id, value:true}] in entry order.
create function public._compe2_validate_callback(p_target integer, p_eligible uuid[], p_marks jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_el jsonb;
  v_entry uuid;
  v_seen uuid[] := '{}';
begin
  if p_target is null or p_target < 1 then
    raise exception 'COMP_CALLBACK_TARGET_UNSET: the round has no callback target (T); the organizer must set it first.' using errcode = 'P0001';
  end if;
  if p_target >= coalesce(array_length(p_eligible, 1), 0) then
    raise exception 'COMP_CALLBACK_NOT_DANCED: T is not smaller than the eligible couples, so the round is not danced and takes no callback ballot (D-CT-5).' using errcode = 'P0001';
  end if;
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) > 1000 then
    raise exception 'COMP_BALLOT_INCOMPLETE: marks must be a list of {entry_id, value}.' using errcode = 'P0001';
  end if;
  for v_el in select * from jsonb_array_elements(p_marks) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: each mark must be an object.' using errcode = 'P0001';
    end if;
    if v_el ? 'role' and jsonb_typeof(v_el -> 'role') <> 'null' then
      raise exception 'COMP_BALLOT_ROLE_NOT_ALLOWED: studio marks are per entry, not per role.' using errcode = 'P0001';
    end if;
    begin
      v_entry := (v_el ->> 'entry_id')::uuid;
    exception when others then
      v_entry := null;
    end;
    if v_entry is null or not (v_entry = any (p_eligible)) then
      raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: entry % is not an eligible couple of this round.', coalesce(v_el ->> 'entry_id', 'null') using errcode = 'P0001';
    end if;
    if v_el -> 'value' is distinct from 'true'::jsonb then
      raise exception 'COMP_BALLOT_MARK_NOT_IN_SCALE: a callback mark is yes only (D-CT-1).' using errcode = 'P0001';
    end if;
    if v_entry = any (v_seen) then
      raise exception 'COMP_BALLOT_DUPLICATE_MARK: more than one mark for entry %.', v_entry using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_entry;
  end loop;
  if coalesce(array_length(v_seen, 1), 0) <> p_target then
    raise exception 'COMP_CALLBACK_COUNT: select exactly % couples across the round (you selected %).', p_target, coalesce(array_length(v_seen, 1), 0) using errcode = 'P0001';
  end if;
  return (select jsonb_agg(jsonb_build_object('entry_id', x, 'value', true) order by x) from unnest(v_seen) x);
end;
$$;
revoke all on function public._compe2_validate_callback(integer, uuid[], jsonb) from public, anon, authenticated;

create function public._compe2_audit(
  p_event_id uuid, p_round_id uuid, p_heat_id uuid, p_kind text, p_actor uuid, p_official_id uuid, p_ballot_id uuid,
  p_from text, p_to text, p_request_id uuid, p_reason text, p_refs jsonb
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.event_competition_ballot_events
    (event_id, round_id, heat_id, kind, actor_user_id, official_id, ballot_id, from_state, to_state, request_id, reason, refs)
  values (p_event_id, p_round_id, p_heat_id, p_kind, p_actor, p_official_id, p_ballot_id, p_from, p_to, p_request_id,
          p_reason, coalesce(p_refs, '{}'::jsonb));
$$;
revoke all on function public._compe2_audit(uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, uuid, text, jsonb) from public, anon, authenticated;

create function public._compe2_lock_pair(p_round_id uuid, p_official_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('compe2:' || p_round_id::text || ':' || coalesce(p_official_id::text, ''), 0));
$$;
revoke all on function public._compe2_lock_pair(uuid, uuid) from public, anon, authenticated;

-- The caller's relation to a round: 'manager' | 'chair' | 'scorer' | null. Never trusts a caller-supplied identity.
create function public._compe2_round_role(p_round_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid;
begin
  if v_uid is null or p_round_id is null then
    return null;
  end if;
  select r.event_id into v_event from public.event_competition_rounds r where r.id = p_round_id;
  if v_event is null then
    return null;
  end if;
  if public.can_manage_event_competition(v_event) then
    return 'manager';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    return null;
  end if;
  if exists (select 1 from public.event_competition_officials o
             where o.event_id = v_event and o.user_id = v_uid and o.role = 'chair' and o.status = 'active') then
    return 'chair';
  end if;
  if exists (select 1 from public.event_competition_officials o
             join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
             where o.event_id = v_event and o.user_id = v_uid and o.role = 'scorer' and o.status = 'active' and a.round_id = p_round_id) then
    return 'scorer';
  end if;
  return null;
end;
$$;
revoke all on function public._compe2_round_role(uuid) from public, anon, authenticated;


-- Lock blockers for a round (shared by the status board and the lock RPC).
create function public._compe2_round_blockers(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_scoring text;
  v_format text;
  v_format_version integer;
  v_stale jsonb;
  v_not_danced boolean;
  v_heats jsonb;
  v_open jsonb;
  v_missing jsonb;
  v_judges integer;
  v_present integer;
  v_min integer;
  v_odd boolean;
  v_known boolean;
  v_panel_ok boolean;
begin
  select r.scoring_method into v_scoring from public.event_competition_rounds r where r.id = p_round_id;
  select f.format, f.version into v_format, v_format_version from public._compe2_format_for_scoring(v_scoring) f;
  select coalesce(jsonb_agg(h.heat_id order by h.heat_number), '[]'::jsonb) into v_heats from public._compe2_round_heats(p_round_id) h;
  select coalesce(jsonb_agg(h.heat_id order by h.heat_number), '[]'::jsonb) into v_open
  from public._compe2_round_heats(p_round_id) h where h.lock_state = 'open';
  select count(*), count(*) filter (where not public._compe2_is_absent(p_round_id, j.official_id))
    into v_judges, v_present from public._compe2_round_judges(p_round_id) j;
  if public._compe2_format_scope(v_format) = 'round' then
    -- One current round-level ballot per present judge (K1 D-CT-2), not one per heat.
    select coalesce(jsonb_agg(jsonb_build_object('official_id', j.official_id, 'judge_letter', j.judge_letter, 'heat_id', null)
                              order by j.judge_letter), '[]'::jsonb)
      into v_missing
    from public._compe2_round_judges(p_round_id) j
    where not public._compe2_is_absent(p_round_id, j.official_id)
      and not exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id and b.heat_id is null and b.official_id = j.official_id);
  else
    select coalesce(jsonb_agg(jsonb_build_object('official_id', j.official_id, 'judge_letter', j.judge_letter, 'heat_id', h.heat_id)
                              order by j.judge_letter, h.heat_number), '[]'::jsonb)
      into v_missing
    from public._compe2_round_judges(p_round_id) j
    cross join public._compe2_round_heats(p_round_id) h
    where not public._compe2_is_absent(p_round_id, j.official_id)
      and not exists (select 1 from public.event_competition_ballots b where b.heat_id = h.heat_id and b.official_id = j.official_id);
  end if;
  -- Current ballots must still match the round as it is now (format, entries still on the heat, exactly T for callback).
  -- A callback round whose T is no longer below the eligible couples is not danced (D-CT-5): its ballots are void, not stale.
  v_not_danced := public._compe2_format_scope(v_format) = 'round'
    and (select r.target_advancement_count from public.event_competition_rounds r where r.id = p_round_id) >= coalesce(array_length(public._compe2_round_entries(p_round_id), 1), 0);
  select coalesce(jsonb_agg(b.id), '[]'::jsonb) into v_stale
  from public.event_competition_ballots b
  where b.round_id = p_round_id
    and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)
    and (
      (b.ballot_format, b.ballot_format_version) is distinct from (v_format, v_format_version)
      or (b.heat_id is not null and b.heat_id in (select h.heat_id from public._compe2_round_heats(p_round_id) h) and (
            (select count(*) from public.event_competition_marks m where m.ballot_id = b.id) <> coalesce(array_length(public._compe2_heat_entries(b.heat_id), 1), 0)
            or exists (select 1 from public.event_competition_marks m where m.ballot_id = b.id and not (m.entry_id = any (public._compe2_heat_entries(b.heat_id))))))
      or (b.heat_id is null and not v_not_danced and (
            (select count(*) from public.event_competition_marks m where m.ballot_id = b.id) is distinct from (select r.target_advancement_count from public.event_competition_rounds r where r.id = p_round_id)
            or exists (select 1 from public.event_competition_marks m where m.ballot_id = b.id and not (m.entry_id = any (public._compe2_round_entries(p_round_id))))))
    );
  -- K1 X-3 (owner-approved): ordinal and callback need >= 3 judges and an odd panel; proficiency needs >= 1.
  -- X-4: an absent judge leaves the effective panel (the attendance record is the audited removal; E1 freezes assignments).
  select pr.min_judges, pr.odd_required, pr.known into v_min, v_odd, v_known from public._compe2_panel_rule(v_scoring) pr;
  v_panel_ok := coalesce(v_known, false) and v_present >= v_min and (not v_odd or v_present % 2 = 1);
  return jsonb_build_object(
    'heats', v_heats, 'heats_not_locked', v_open, 'missing_ballots', v_missing,
    'judges', v_judges, 'judges_present', v_present,
    'panel_min', v_min, 'panel_odd_required', v_odd, 'panel_rule_known', coalesce(v_known, false), 'panel_ok', v_panel_ok, 'stale_ballots', v_stale, 'callback_not_danced', coalesce(v_not_danced, false),
    'ready', (jsonb_array_length(v_heats) > 0 and jsonb_array_length(v_open) = 0 and jsonb_array_length(v_missing) = 0 and jsonb_array_length(v_stale) = 0 and not coalesce(v_not_danced, false) and v_panel_ok));
end;
$$;
revoke all on function public._compe2_round_blockers(uuid) from public, anon, authenticated;

-- Shared insert path for judge_web and scorer_paper ballots (authorization is done by the callers).
create function public._compe2_insert_ballot(
  p_actor uuid, p_round_id uuid, p_heat_id uuid, p_official_id uuid, p_source text, p_entered_by uuid,
  p_marks jsonb, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_prior public.event_competition_ballots;
  v_prev public.event_competition_ballot_events;
  v_expected uuid[];
  v_marks jsonb;
  v_ballot public.event_competition_ballots;
  v_version integer := 1;
  v_format text;
  v_format_version integer;
  v_fp text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  perform public._compe2_lock_pair(p_round_id, p_official_id);

  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;

  v_fp := md5(coalesce(p_marks::text, '') || '|' || coalesce(v_reason, '') || '|' || p_source);
  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind in ('ballot_submitted', 'ballot_corrected') and v_prev.actor_user_id = p_actor
       and (v_prev.refs ->> 'fp') is not distinct from v_fp
       and v_prev.round_id = p_round_id and v_prev.heat_id is not distinct from p_heat_id and v_prev.official_id = p_official_id then
      return jsonb_build_object('replayed', true, 'ballot_id', v_prev.ballot_id, 'version', (v_prev.refs ->> 'version')::integer);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'active' then
    raise exception 'COMP_BALLOT_ROUND_NOT_ACTIVE: ballots are accepted only while the round is active (round status: %).', v_round.status
      using errcode = 'P0001';
  end if;
  select f.format, f.version into v_format, v_format_version from public._compe2_format_for_scoring(v_round.scoring_method) f;
  if v_format is null then
    raise exception 'COMP_BALLOT_SCORING_METHOD_UNSUPPORTED: no ballot format for scoring method "%".', v_round.scoring_method using errcode = 'P0001';
  end if;
  if not public._compe2_format_approved(v_format, v_format_version) then
    raise exception 'COMP_BALLOT_FORMAT_NOT_APPROVED: ballot format %@% is not approved yet; ballots fail closed.', v_format, v_format_version using errcode = 'P0001';
  end if;
  if public._compe2_format_scope(v_format) = 'round' then
    if p_heat_id is not null then
      raise exception 'COMP_BALLOT_HEAT_INVALID: callback ballots are round-level; do not name a heat.' using errcode = 'P0001';
    end if;
  elsif p_heat_id is null or not exists (select 1 from public._compe2_round_heats(p_round_id) h where h.heat_id = p_heat_id) then
    raise exception 'COMP_BALLOT_HEAT_INVALID: the heat is not a ballot heat of this round.' using errcode = 'P0001';
  end if;
  if public._compe2_is_absent(p_round_id, p_official_id) then
    raise exception 'COMP_BALLOT_JUDGE_ABSENT: the judge is recorded absent for this round; record them present first.' using errcode = 'P0001';
  end if;

  if public._compe2_format_scope(v_format) = 'round' then
    v_marks := public._compe2_validate_callback(v_round.target_advancement_count, public._compe2_round_entries(p_round_id), p_marks);
  else
    v_expected := public._compe2_heat_entries(p_heat_id);
    v_marks := public._compe2_validate_marks(v_format, v_expected, p_marks);
  end if;

  select b.* into v_prior
  from public.event_competition_ballots b
  where b.official_id = p_official_id
    and ((p_heat_id is not null and b.heat_id = p_heat_id) or (p_heat_id is null and b.heat_id is null and b.round_id = p_round_id))
    and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)
  order by b.version desc limit 1;
  if found then
    if v_reason is null then
      raise exception 'COMP_BALLOT_CORRECTION_REASON_REQUIRED: a ballot already exists for this heat; a correction needs a reason.' using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception 'COMP_BALLOT_CORRECTION_REASON_REQUIRED: the reason must be at most 500 characters.' using errcode = 'P0001';
    end if;
    v_version := v_prior.version + 1;
  else
    v_reason := null;
  end if;

  begin
    insert into public.event_competition_ballots
      (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, entered_by_official_id, supersedes_id, correction_reason)
    values (v_round.event_id, p_round_id, p_heat_id, p_official_id, v_format, v_format_version, v_version, p_source, p_actor, p_entered_by,
            case when v_prior.id is null then null else v_prior.id end, v_reason)
    returning * into v_ballot;
  exception when unique_violation then
    raise exception 'COMP_BALLOT_CONFLICT: another ballot was just recorded for this judge and heat; reload and retry.' using errcode = 'P0001';
  end;

  insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark)
  select v_round.event_id, v_ballot.id, (m ->> 'entry_id')::uuid, m -> 'value'
  from jsonb_array_elements(v_marks) m;

  perform public._compe2_audit(v_round.event_id, p_round_id, p_heat_id,
    case when v_version = 1 then 'ballot_submitted' else 'ballot_corrected' end,
    p_actor, p_official_id, v_ballot.id, null, null, p_request_id, v_reason,
    jsonb_build_object('fp', v_fp, 'version', v_version, 'ballot_format', v_format || '@' || v_format_version, 'source', p_source, 'entered_by_official_id', p_entered_by, 'marks', jsonb_array_length(v_marks)));

  return jsonb_build_object('replayed', false, 'ballot_id', v_ballot.id, 'version', v_version, 'source', p_source);
end;
$$;
revoke all on function public._compe2_insert_ballot(uuid, uuid, uuid, uuid, text, uuid, jsonb, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS and grants (K0 reader matrix: manager all; judge own; assigned scorer all in assigned rounds; nobody else)
-- ---------------------------------------------------------------------------
alter table public.event_competition_ballots enable row level security;
alter table public.event_competition_marks enable row level security;
alter table public.event_competition_judge_attendance enable row level security;
alter table public.event_competition_ballot_events enable row level security;
alter table public.event_competition_ballot_drafts enable row level security;

create function public.competition_is_round_scorer(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public._compe2_round_role(p_round_id) = 'scorer';
$$;
revoke all on function public.competition_is_round_scorer(uuid) from public, anon;
grant execute on function public.competition_is_round_scorer(uuid) to authenticated;

create policy competition_ballots_manager_read on public.event_competition_ballots
  for select to authenticated using (public.can_manage_event_competition(event_id));
create policy competition_ballots_own_read on public.event_competition_ballots
  for select to authenticated using (public.competition_is_active_official(official_id));
create policy competition_ballots_scorer_read on public.event_competition_ballots
  for select to authenticated using (public.competition_is_round_scorer(round_id));

-- Marks follow their ballot's visibility: the sub-select runs under the ballots policies above.
create policy competition_marks_read on public.event_competition_marks
  for select to authenticated
  using (exists (select 1 from public.event_competition_ballots b where b.id = event_competition_marks.ballot_id and b.event_id = event_competition_marks.event_id));

create policy competition_attendance_manager_read on public.event_competition_judge_attendance
  for select to authenticated using (public.can_manage_event_competition(event_id));
create policy competition_attendance_own_read on public.event_competition_judge_attendance
  for select to authenticated using (public.competition_is_active_official(official_id));
create policy competition_attendance_scorer_read on public.event_competition_judge_attendance
  for select to authenticated using (public.competition_is_round_scorer(round_id));

create policy competition_ballot_events_manager_read on public.event_competition_ballot_events
  for select to authenticated using (public.can_manage_event_competition(event_id));

-- A judge reads only their own draft; nobody (managers included) writes it except through save_competition_callback_draft.
create policy competition_ballot_drafts_own_read on public.event_competition_ballot_drafts
  for select to authenticated using (public.competition_is_active_official(official_id));
create policy competition_ballot_drafts_manager_read on public.event_competition_ballot_drafts
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_ballot_drafts from public, anon, authenticated, service_role;
grant select on public.event_competition_ballot_drafts to authenticated;

revoke all on public.event_competition_ballots from public, anon, authenticated, service_role;
revoke all on public.event_competition_marks from public, anon, authenticated, service_role;
revoke all on public.event_competition_judge_attendance from public, anon, authenticated, service_role;
revoke all on public.event_competition_ballot_events from public, anon, authenticated, service_role;
grant select on public.event_competition_ballots to authenticated, service_role;
grant select on public.event_competition_marks to authenticated, service_role;
grant select on public.event_competition_judge_attendance to authenticated, service_role;
grant select on public.event_competition_ballot_events to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Judge and scorer submit RPCs
-- ---------------------------------------------------------------------------
create function public.submit_competition_ballot(
  p_round_id uuid, p_heat_id uuid, p_marks jsonb, p_request_id uuid, p_correction_reason text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_official uuid;
begin
  if v_uid is null or p_round_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select r.event_id into v_event from public.event_competition_rounds r where r.id = p_round_id;
  if v_event is null or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  -- The judge is derived from the session, never supplied: own panel assignment only.
  select o.id into v_official
  from public.event_competition_officials o
  join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
  where o.event_id = v_event and o.user_id = v_uid and o.status = 'active' and o.role in ('judge', 'chair')
    and a.round_id = p_round_id and a.judge_letter is not null;
  if v_official is null then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: you are not a judge on this round''s panel.' using errcode = '42501';
  end if;
  return public._compe2_insert_ballot(v_uid, p_round_id, p_heat_id, v_official, 'judge_web', null, p_marks, p_correction_reason, p_request_id);
end;
$$;

create function public.enter_competition_paper_ballot(
  p_round_id uuid, p_heat_id uuid, p_official_id uuid, p_marks jsonb, p_request_id uuid, p_correction_reason text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_role text;
  v_scorer uuid;
begin
  if v_uid is null or p_round_id is null or p_official_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select r.event_id into v_event from public.event_competition_rounds r where r.id = p_round_id;
  v_role := public._compe2_round_role(p_round_id);
  if v_event is null or coalesce(v_role, '') not in ('manager', 'scorer') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if v_role = 'scorer' then
    select o.id into v_scorer from public.event_competition_officials o
    where o.event_id = v_event and o.user_id = v_uid and o.role = 'scorer' and o.status = 'active';
  end if;
  -- The named judge must be on this round's panel (same event by construction).
  if not exists (select 1 from public._compe2_round_judges(p_round_id) j where j.official_id = p_official_id and j.official_status = 'active') then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: the named official is not an active judge on this round''s panel.' using errcode = 'P0001';
  end if;
  return public._compe2_insert_ballot(v_uid, p_round_id, p_heat_id, p_official_id, 'scorer_paper', v_scorer, p_marks, p_correction_reason, p_request_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Attendance, lock, reopen
-- ---------------------------------------------------------------------------
-- A callback judge saves selections across heats while the round is active. Mutable, own, never engine input.
create function public.save_competition_callback_draft(p_round_id uuid, p_entry_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_official uuid;
  v_eligible uuid[];
  v_ids uuid[];
begin
  if v_uid is null or p_round_id is null or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  select o.id into v_official
  from public.event_competition_officials o
  join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
  where o.event_id = v_round.event_id and o.user_id = v_uid and o.status = 'active' and o.role in ('judge', 'chair')
    and a.round_id = p_round_id and a.judge_letter is not null;
  if v_round.id is null or v_official is null then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: you are not a judge on this round''s panel.' using errcode = '42501';
  end if;
  if not exists (select 1 from public._compe2_format_for_scoring(v_round.scoring_method) f where f.format = 'callback_yes') then
    raise exception 'COMP_BALLOT_HEAT_INVALID: drafts exist only for callback rounds.' using errcode = 'P0001';
  end if;
  perform public._compe2_lock_pair(p_round_id, v_official);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;
  if v_round.status <> 'active' then
    raise exception 'COMP_BALLOT_ROUND_NOT_ACTIVE: drafts are accepted only while the round is active (round status: %).', v_round.status using errcode = 'P0001';
  end if;
  v_eligible := public._compe2_round_entries(p_round_id);
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_entry_ids, '{}')) x;
  if exists (select 1 from unnest(v_ids) x where not (x = any (v_eligible))) then
    raise exception 'COMP_BALLOT_UNKNOWN_ENTRY: a selected couple is not an eligible couple of this round.' using errcode = 'P0001';
  end if;
  insert into public.event_competition_ballot_drafts (event_id, round_id, official_id, selections)
  values (v_round.event_id, p_round_id, v_official, to_jsonb(v_ids))
  on conflict (round_id, official_id) do update set selections = excluded.selections, updated_at = now();
  return jsonb_build_object('saved', true, 'selected', coalesce(array_length(v_ids, 1), 0), 'target', v_round.target_advancement_count);
end;
$$;

create function public.record_competition_judge_attendance(
  p_round_id uuid, p_official_id uuid, p_status text, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_ballot_events;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null or coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('absent', 'present') or p_official_id is null then
    raise exception 'COMP_ATTENDANCE_INVALID: status must be absent or present.' using errcode = 'P0001';
  end if;
  if p_status = 'absent' and (v_reason is null or length(v_reason) > 500) then
    raise exception 'COMP_ATTENDANCE_INVALID: an absence needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;
  perform public._compe2_lock_pair(p_round_id, p_official_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;

  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind in ('judge_absence_recorded', 'judge_presence_recorded') and v_prev.actor_user_id = v_uid
       and (v_prev.refs ->> 'fp') is not distinct from md5(p_status || '|' || coalesce(v_reason, ''))
       and v_prev.round_id = p_round_id and v_prev.official_id = p_official_id then
      return jsonb_build_object('replayed', true, 'official_id', p_official_id, 'status', (v_prev.refs ->> 'status'));
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('scheduled', 'active') then
    raise exception 'COMP_BALLOTS_BAD_STATE: attendance can be recorded while the round is scheduled or active (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public._compe2_round_judges(p_round_id) j where j.official_id = p_official_id) then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: the official is not a judge on this round''s panel.' using errcode = 'P0001';
  end if;
  if p_status = 'absent' and exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id and b.official_id = p_official_id) then
    raise exception 'COMP_ABSENCE_HAS_BALLOTS: the judge already has ballots in this round; they cannot be recorded absent.' using errcode = 'P0001';
  end if;

  insert into public.event_competition_judge_attendance (event_id, round_id, official_id, status, reason, recorded_by)
  values (v_round.event_id, p_round_id, p_official_id, p_status, v_reason, v_uid);
  perform public._compe2_audit(v_round.event_id, p_round_id, null,
    case when p_status = 'absent' then 'judge_absence_recorded' else 'judge_presence_recorded' end,
    v_uid, p_official_id, null, null, null, p_request_id, v_reason, jsonb_build_object('fp', md5(p_status || '|' || coalesce(v_reason, '')), 'status', p_status, 'actor_role', v_role));
  return jsonb_build_object('replayed', false, 'official_id', p_official_id, 'status', p_status);
end;
$$;

create function public.lock_competition_round_ballots(p_round_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_ballot_events;
  v_block jsonb;
  v_absent jsonb;
begin
  if v_uid is null or coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  -- FOR UPDATE waits for every in-flight submit (they hold FOR SHARE); the readiness check below then sees them.
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.to_state = 'ballots_locked' and v_prev.round_id = p_round_id and v_prev.actor_user_id = v_uid then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', 'ballots_locked');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'active' then
    raise exception 'COMP_BALLOTS_BAD_STATE: only an active round can lock its ballots (round is %).', v_round.status using errcode = 'P0001';
  end if;
  perform 1 from public.event_competition_heat_entries he
   where he.heat_id in (select h.heat_id from public._compe2_round_heats(p_round_id) h) for share;
  v_block := public._compe2_round_blockers(p_round_id);
  if (v_block ->> 'callback_not_danced')::boolean then
    raise exception 'COMP_CALLBACK_NOT_DANCED: T is no longer below the eligible couples, so this round is not danced and takes no callback ballots (D-CT-5).' using errcode = 'P0001', detail = v_block::text;
  end if;
  if jsonb_array_length(v_block -> 'heats') = 0 then
    raise exception 'COMP_BALLOTS_INCOMPLETE: the round has no heat to ballot.' using errcode = 'P0001', detail = v_block::text;
  end if;
  if (v_block ->> 'judges_present')::integer = 0 then
    raise exception 'COMP_BALLOTS_INCOMPLETE: no judge is present on the panel.' using errcode = 'P0001', detail = v_block::text;
  end if;
  if not (v_block ->> 'panel_ok')::boolean then
    raise exception 'COMP_PANEL_SIZE: the present panel (% judges) does not meet the rule for this scoring method (at least % judges; odd panel required: %; K1 X-3/X-4).',
      v_block ->> 'judges_present', v_block ->> 'panel_min', v_block ->> 'panel_odd_required' using errcode = 'P0001', detail = v_block::text;
  end if;
  if jsonb_array_length(v_block -> 'stale_ballots') > 0 then
    raise exception 'COMP_BALLOTS_STALE: % current ballot(s) no longer match the round (an entry was scratched, T or the format changed); correct them first.',
      jsonb_array_length(v_block -> 'stale_ballots') using errcode = 'P0001', detail = v_block::text;
  end if;
  if jsonb_array_length(v_block -> 'missing_ballots') > 0 then
    raise exception 'COMP_BALLOTS_INCOMPLETE: % ballot(s) are missing (every assigned judge needs a ballot for every heat, or a recorded absence).',
      jsonb_array_length(v_block -> 'missing_ballots') using errcode = 'P0001', detail = v_block::text;
  end if;
  if jsonb_array_length(v_block -> 'heats_not_locked') > 0 then
    raise exception 'COMP_BALLOTS_HEATS_NOT_LOCKED: every heat of the round must be locked first.' using errcode = 'P0001', detail = v_block::text;
  end if;

  select coalesce(jsonb_agg(j.official_id), '[]'::jsonb) into v_absent
  from public._compe2_round_judges(p_round_id) j where public._compe2_is_absent(p_round_id, j.official_id);

  perform public._compe2_audit(v_round.event_id, p_round_id, null, 'round_state_changed', v_uid, null, null, 'active', 'ballots_locked',
    p_request_id, null, jsonb_build_object('actor_role', v_role, 'heats', v_block -> 'heats', 'judges', v_block -> 'judges', 'absent_official_ids', v_absent));
  update public.event_competition_rounds set status = 'ballots_locked', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'ballots_locked', 'absent_official_ids', v_absent);
end;
$$;

create function public.reopen_competition_round_ballots(p_round_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_ballot_events;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_blocked boolean := false;
begin
  if v_uid is null or v_role is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'COMP_RESULT_REASON_REQUIRED: reopening ballots needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.to_state = 'active' and v_prev.round_id = p_round_id and v_prev.actor_user_id = v_uid then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', 'active');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'ballots_locked' then
    raise exception 'COMP_BALLOTS_BAD_STATE: only a round with locked ballots can be reopened (round is %).', v_round.status using errcode = 'P0001';
  end if;

  -- F2 (result versions) and F3 (publications) do not exist yet: guard on existence, fail closed if their shape is unknown.
  begin
    if to_regclass('public.event_competition_result_versions') is not null then
      execute 'select exists (select 1 from public.event_competition_result_versions v where v.round_id = $1 and v.status in (''approved'', ''published''))'
        into v_blocked using p_round_id;
      if v_blocked then
        raise exception 'COMP_REOPEN_RESULT_APPROVED: a result version of this round is approved; use the correction path.' using errcode = 'P0001';
      end if;
    end if;
    if to_regclass('public.event_competition_result_publications') is not null then
      execute 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1)'
        into v_blocked using p_round_id;
      if v_blocked then
        raise exception 'COMP_REOPEN_RESULT_APPROVED: this round has a publication; use the correction path.' using errcode = 'P0001';
      end if;
    end if;
  exception
    when undefined_column or undefined_table then
      raise exception 'COMP_REOPEN_RESULT_APPROVED: result state could not be verified; reopening is refused.' using errcode = 'P0001';
  end;

  perform public._compe2_audit(v_round.event_id, p_round_id, null, 'round_state_changed', v_uid, null, null, 'ballots_locked', 'active',
    p_request_id, v_reason, jsonb_build_object('actor_role', v_role));
  update public.event_competition_rounds set status = 'active', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'active');
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reads
-- ---------------------------------------------------------------------------
-- Lock-readiness board: manager, designated chair or assigned scorer.
create function public.competition_round_ballot_status(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
begin
  if v_role is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  return jsonb_build_object(
    'viewer_role', v_role,
    'round', jsonb_build_object('id', v_round.id, 'name', v_round.name, 'status', v_round.status, 'scoring_method', v_round.scoring_method),
    'scheme_available', coalesce((select public._compe2_format_approved(f.format, f.version) from public._compe2_format_for_scoring(v_round.scoring_method) f), false),
    'ballot_format', (select f.format || '@' || f.version from public._compe2_format_for_scoring(v_round.scoring_method) f),
    'callback_target', case when v_round.scoring_method = 'callback_tally' then v_round.target_advancement_count end,
    'callback_entries', case when v_round.scoring_method = 'callback_tally' then coalesce((
      select jsonb_agg(jsonb_build_object('entry_id', e.id, 'entry_number', e.entry_number, 'display_name', e.display_name) order by e.entry_number, e.id)
      from public.event_competition_entries e where e.id = any (public._compe2_round_entries(p_round_id))), '[]'::jsonb) end,
    'heats', coalesce((
      select jsonb_agg(jsonb_build_object('heat_id', h.heat_id, 'heat_number', h.heat_number, 'lock_state', h.lock_state,
                                          'entry_count', coalesce(array_length(public._compe2_heat_entries(h.heat_id), 1), 0),
                                          'entries', coalesce((
                                            select jsonb_agg(jsonb_build_object('entry_id', e.id, 'entry_number', e.entry_number, 'display_name', e.display_name)
                                                             order by he.floor_order, e.entry_number, e.id)
                                            from public.event_competition_heat_entries he
                                            join public.event_competition_entries e on e.id = he.entry_id and e.event_id = he.event_id
                                            where he.heat_id = h.heat_id and he.status <> 'scratched'), '[]'::jsonb))
                       order by h.heat_number)
      from public._compe2_round_heats(p_round_id) h), '[]'::jsonb),
    'judges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'official_id', j.official_id, 'judge_letter', j.judge_letter, 'official_status', j.official_status,
        'name', coalesce(nullif(btrim(p.full_name), ''), 'Judge ' || j.judge_letter),
        'absent', public._compe2_is_absent(p_round_id, j.official_id),
        'ballots', coalesce((
          select jsonb_agg(jsonb_build_object('heat_id', b.heat_id, 'ballot_id', b.id, 'version', b.version, 'source', b.source,
                                              'submitted_at', b.submitted_at) order by b.heat_id nulls first)
          from public.event_competition_ballots b
          where b.official_id = j.official_id and b.round_id = p_round_id
            and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)), '[]'::jsonb))
        order by j.judge_letter)
      from public._compe2_round_judges(p_round_id) j
      left join public.profiles p on p.id = j.user_id), '[]'::jsonb),
    'blockers', public._compe2_round_blockers(p_round_id));
end;
$$;

-- A judge's own sheet: entries of every ballot heat plus their own current ballot (marks only for the caller).
create function public.competition_judge_ballot_sheet(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_official uuid;
  v_letter text;
begin
  if v_uid is null or p_round_id is null or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  select o.id, a.judge_letter into v_official, v_letter
  from public.event_competition_officials o
  join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
  where o.event_id = v_round.event_id and o.user_id = v_uid and o.status = 'active' and o.role in ('judge', 'chair')
    and a.round_id = p_round_id and a.judge_letter is not null;
  if v_official is null then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: you are not a judge on this round''s panel.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'round', jsonb_build_object('id', v_round.id, 'name', v_round.name, 'status', v_round.status, 'scoring_method', v_round.scoring_method),
    'judge_letter', v_letter,
    'absent', public._compe2_is_absent(p_round_id, v_official),
    'scheme_available', coalesce((select public._compe2_format_approved(f.format, f.version) from public._compe2_format_for_scoring(v_round.scoring_method) f), false),
    'ballot_format', (select f.format || '@' || f.version from public._compe2_format_for_scoring(v_round.scoring_method) f),
    'callback', case when v_round.scoring_method = 'callback_tally' then jsonb_build_object(
      'target', v_round.target_advancement_count,
      'eligible', coalesce(array_length(public._compe2_round_entries(p_round_id), 1), 0),
      'draft', coalesce((select d.selections from public.event_competition_ballot_drafts d where d.round_id = p_round_id and d.official_id = v_official), '[]'::jsonb),
      'ballot', (select jsonb_build_object('ballot_id', b.id, 'version', b.version, 'source', b.source, 'submitted_at', b.submitted_at,
                   'marks', coalesce((select jsonb_object_agg(m.entry_id::text, m.mark) from public.event_competition_marks m where m.ballot_id = b.id), '{}'::jsonb))
                 from public.event_competition_ballots b
                 where b.round_id = p_round_id and b.heat_id is null and b.official_id = v_official
                   and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id))) end,
    'heats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'heat_id', h.heat_id, 'heat_number', h.heat_number,
        'entries', coalesce((
          select jsonb_agg(jsonb_build_object('entry_id', e.id, 'entry_number', e.entry_number, 'display_name', e.display_name)
                           order by he.floor_order, e.entry_number, e.id)
          from public.event_competition_heat_entries he
          join public.event_competition_entries e on e.id = he.entry_id and e.event_id = he.event_id
          where he.heat_id = h.heat_id and he.status <> 'scratched'), '[]'::jsonb),
        'ballot', (
          select jsonb_build_object('ballot_id', b.id, 'version', b.version, 'source', b.source, 'submitted_at', b.submitted_at,
            'marks', coalesce((select jsonb_object_agg(m.entry_id::text, m.mark) from public.event_competition_marks m where m.ballot_id = b.id), '{}'::jsonb))
          from public.event_competition_ballots b
          where b.heat_id = h.heat_id and b.official_id = v_official
            and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id))
      ) order by h.heat_number)
      from public._compe2_round_heats(p_round_id) h), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants (authenticated only; never anon)
-- ---------------------------------------------------------------------------
revoke all on function public.save_competition_callback_draft(uuid, uuid[]) from public, anon;
revoke all on function public.submit_competition_ballot(uuid, uuid, jsonb, uuid, text) from public, anon;
revoke all on function public.enter_competition_paper_ballot(uuid, uuid, uuid, jsonb, uuid, text) from public, anon;
revoke all on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid) from public, anon;
revoke all on function public.lock_competition_round_ballots(uuid, uuid) from public, anon;
revoke all on function public.reopen_competition_round_ballots(uuid, text, uuid) from public, anon;
revoke all on function public.competition_round_ballot_status(uuid) from public, anon;
revoke all on function public.competition_judge_ballot_sheet(uuid) from public, anon;
grant execute on function public.save_competition_callback_draft(uuid, uuid[]) to authenticated;
grant execute on function public.submit_competition_ballot(uuid, uuid, jsonb, uuid, text) to authenticated;
grant execute on function public.enter_competition_paper_ballot(uuid, uuid, uuid, jsonb, uuid, text) to authenticated;
grant execute on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.lock_competition_round_ballots(uuid, uuid) to authenticated;
grant execute on function public.reopen_competition_round_ballots(uuid, text, uuid) to authenticated;
grant execute on function public.competition_round_ballot_status(uuid) to authenticated;
grant execute on function public.competition_judge_ballot_sheet(uuid) to authenticated;

commit;
