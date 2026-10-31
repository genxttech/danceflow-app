-- Competition CF1 package A0: core callback -> Final advancement.
--
-- Design: docs/competition/callback-to-final-advancement-design.md (rev 21) sections 1-6, 12, A.2, A.3, A.9; contract: docs/competition/cf1-a0-contract.md.
-- Slot 20270120090000, after HL1 (20270119090000) and A1 (20270120085000). LOCAL ONLY until separately authorized; nothing here is applied to a hosted project.
--
-- Adds:  advancement tables (record, entries, heats, revocations), the Final-withdrawal table (written by A6, read here), the capacity
--        event table; preview / apply RPCs, the internal revoke, the reasoned capacity RPC (B1-B7, F1) and the rewritten legacy
--        capacity RPC (always refuses, OD-14 A); the F2 setup guard (T <= capacity); the Final-heat guards (insert, status, identity,
--        entry, dance, single live heat), the publication guard (I6), the Final-start guard, the approval gate (2.4) and the correction
--        trigger (revoke, started / locked / cancelled-Final arms, OD-10).
-- Pins:  complete_competition_round, set_competition_round_heat_capacity(uuid,integer), competition_audit_log, _comp10d_copy_floor_plan,
--        _comp10d_guard_floor_heat, _comp10d_guard_heat_child, validate_competition_heat_schedule_placement; the result-events kind check.
-- Not here (see the contract): the OD-13 correction cause / co-sign / ballot-correction machinery, the P-1 reader inventory.
--
-- Apply order: SQL before app. Rollback: app first, then the rollback file (refused once any advancement / capacity-event / withdrawal row exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight: dependencies, pins (md5 of pg_get_functiondef with CRs removed), anchors that must occur exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_pin record;
  v_anchor_ok boolean;
begin
  if to_regprocedure('public._cf1_is_callback_final(uuid)') is null
     or to_regprocedure('public._cf1_entry_unavailable(uuid)') is null
     or to_regprocedure('public._cf1_count_available_entries(uuid[])') is null
     or to_regprocedure('public._cf1_entry_unavailable_reason(uuid)') is null then
    raise exception 'CF1-A0 preflight: A1 (20270120085000) is missing.';
  end if;
  if to_regprocedure('public._hl1_heat_is_danced(uuid,text)') is null
     or to_regprocedure('public._compo1_lock_event(uuid)') is null
     or to_regprocedure('public._compf2_event(uuid,uuid,uuid,text,uuid,text,text,uuid,text,jsonb)') is null
     or to_regprocedure('public._comp10d_floor_heat_problems(uuid)') is null then
    raise exception 'CF1-A0 preflight: HL1 / O1 / F2 / 10D functions are missing.';
  end if;
  if exists (select 1 from pg_class where relname = 'event_competition_round_advancements' and relnamespace = 'public'::regnamespace)
     or exists (select 1 from pg_trigger where tgname in ('cf1_guard_final_start', 'cf1_guard_round_capacity')) then
    raise exception 'CF1-A0 preflight: CF1 core objects already exist.';
  end if;
  for v_pin in
    select * from (values
      ('public.complete_competition_round(uuid,uuid)',                          'dd0e1cd4c02bb51bbd75471c113a1f9f'),
      ('public.set_competition_round_heat_capacity(uuid,integer)',              '4fbc864079928710917ea67d7968d8bb'),
      ('public.competition_audit_log(uuid,uuid,integer)',                       'd38b87512d066907b37702addc6cd116'),
      ('public._comp10d_copy_floor_plan(uuid,uuid)',                            '8162a7341b7bcd00a141e81392c8c602'),
      ('public._comp10d_guard_floor_heat()',                                    'bd20973caffce985813daadde8be947a'),
      ('public._comp10d_guard_heat_child()',                                    '9bb78230385387a3c6a39e66f2d9f8d0'),
      ('public.validate_competition_heat_schedule_placement()',                 'f2079401a3a92c3289405547d2fe511b')
    ) as t(sig, pin)
  loop
    if to_regprocedure(v_pin.sig) is null then
      raise exception 'CF1-A0 preflight: % is missing.', v_pin.sig;
    end if;
    v_def := replace(pg_get_functiondef(v_pin.sig::regprocedure), E'\r', '');
    if md5(v_def) <> v_pin.pin then
      raise exception 'CF1-A0 preflight: % differs from the pinned text (md5 %, expected %); coordinate before changing it.', v_pin.sig, md5(v_def), v_pin.pin;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Audit kinds (K0 section 8: fixed by the contract).
-- ---------------------------------------------------------------------------
alter table public.event_competition_result_events drop constraint event_competition_result_events_kind_check;
alter table public.event_competition_result_events add constraint event_competition_result_events_kind_check
  check (kind = any (array['round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated',
                           'advancement_applied', 'advancement_revoked']));

-- ---------------------------------------------------------------------------
-- 2. Tables. Insert-only evidence, RLS on, no policies, no grants. NO ACTION foreign keys (event deletion cascades, direct deletes refuse).
-- ---------------------------------------------------------------------------
create table public.event_competition_final_withdrawals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  target_round_id uuid not null,
  entry_id uuid not null,
  seq bigint not null check (seq >= 1),
  kind text not null check (kind in ('withdraw', 'reinstate')),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  requested_by uuid not null,
  cosigned_by uuid not null,
  cosigned_role text not null check (cosigned_role in ('chair', 'manager')),
  request_id uuid not null unique,
  transaction_id bigint not null default txid_current(),
  heat_entry_id uuid,
  prior_heat_entry_status text check (prior_heat_entry_status is null or prior_heat_entry_status in ('scheduled', 'checked_in', 'scratched')),
  at timestamptz not null default now(),
  constraint event_competition_final_withdrawals_seq_key unique (target_round_id, seq),
  constraint event_competition_final_withdrawals_cosign_check check (cosigned_by <> requested_by),
  constraint event_competition_final_withdrawals_round_fk foreign key (target_round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_final_withdrawals_entry_fk foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id),
  constraint event_competition_final_withdrawals_heat_entry_fk foreign key (heat_entry_id) references public.event_competition_heat_entries(id)
);
create index event_competition_final_withdrawals_pair_idx on public.event_competition_final_withdrawals (target_round_id, entry_id, seq desc);

create table public.event_competition_round_advancements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  division_id uuid not null,
  source_round_id uuid not null,
  target_round_id uuid not null,
  generation integer not null check (generation >= 1),
  source_result_version_id uuid not null references public.event_competition_result_versions(id),
  source_input_hash text not null,
  source_trace_hash text not null,
  advanced_count integer not null check (advanced_count >= 1),
  carried_count integer not null default 0 check (carried_count >= 0),
  target_capacity integer not null check (target_capacity between 1 and 100),
  applied_by uuid not null,
  applied_at timestamptz not null default now(),
  request_id uuid not null unique,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_round_advancements_generation_key unique (source_round_id, generation),
  constraint event_competition_round_advancements_id_event_key unique (id, event_id),
  constraint event_competition_round_advancements_source_fk foreign key (source_round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_round_advancements_target_fk foreign key (target_round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_round_advancements_program_fk foreign key (program_id, event_id) references public.event_competition_programs(id, event_id),
  constraint event_competition_round_advancements_carried_check check (carried_count <= advanced_count)
);
create index event_competition_round_advancements_target_idx on public.event_competition_round_advancements (target_round_id);
create index event_competition_round_advancements_event_idx on public.event_competition_round_advancements (event_id);
create index event_competition_round_advancements_tx_idx on public.event_competition_round_advancements (transaction_id);

create table public.event_competition_round_advancement_entries (
  advancement_id uuid not null,
  event_id uuid not null references public.events(id) on delete cascade,
  division_id uuid not null,
  entry_id uuid not null,
  tally jsonb not null default '{}'::jsonb,
  carried_withdrawal_id uuid references public.event_competition_final_withdrawals(id),
  primary key (advancement_id, entry_id),
  constraint event_competition_round_advancement_entries_adv_fk foreign key (advancement_id, event_id) references public.event_competition_round_advancements(id, event_id),
  constraint event_competition_round_advancement_entries_entry_fk foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id)
);

create table public.event_competition_round_advancement_heats (
  advancement_id uuid not null,
  event_id uuid not null references public.events(id) on delete cascade,
  heat_id uuid not null,
  floor_heat_id uuid not null,
  primary key (advancement_id, heat_id),
  constraint event_competition_round_advancement_heats_adv_fk foreign key (advancement_id, event_id) references public.event_competition_round_advancements(id, event_id),
  constraint event_competition_round_advancement_heats_heat_fk foreign key (heat_id, event_id) references public.event_competition_heats(id, event_id),
  constraint event_competition_round_advancement_heats_floor_fk foreign key (floor_heat_id, event_id) references public.event_competition_floor_heats(id, event_id)
);

create table public.event_competition_round_advancement_revocations (
  id uuid primary key default gen_random_uuid(),
  advancement_id uuid not null unique,
  event_id uuid not null references public.events(id) on delete cascade,
  revoked_by uuid not null,
  revoked_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  cause text not null check (cause in ('source_correction_opened')),
  request_id uuid not null unique,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_round_advancement_revocations_adv_fk foreign key (advancement_id, event_id) references public.event_competition_round_advancements(id, event_id)
);
create index event_competition_round_advancement_revocations_tx_idx on public.event_competition_round_advancement_revocations (transaction_id);

create table public.event_competition_round_capacity_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  old_capacity integer not null,
  new_capacity integer not null check (new_capacity between 1 and 100),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  actor uuid not null,
  at timestamptz not null default now(),
  request_id uuid not null unique,
  transaction_id bigint not null default txid_current(),
  exemption text check (exemption is null or exemption = 'f1_raise_to_t'),
  target_t integer,
  callback_round_id uuid,
  callback_round_status text,
  callback_result_version_ids uuid[],
  constraint event_competition_round_capacity_events_round_fk foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id)
);
create index event_competition_round_capacity_events_round_idx on public.event_competition_round_capacity_events (round_id, transaction_id);

do $$
declare
  v_t text;
begin
  foreach v_t in array array[
    'event_competition_final_withdrawals', 'event_competition_round_advancements', 'event_competition_round_advancement_entries',
    'event_competition_round_advancement_heats', 'event_competition_round_advancement_revocations', 'event_competition_round_capacity_events']
  loop
    execute format('alter table public.%I enable row level security', v_t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.protect_competition_history_evidence()',
                   'protect_' || v_t || '_history', v_t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.protect_competition_history_evidence()',
                   'protect_' || v_t || '_htrunc', v_t);
    execute format('alter table public.%I enable always trigger %I', v_t, 'protect_' || v_t || '_history');
    execute format('alter table public.%I enable always trigger %I', v_t, 'protect_' || v_t || '_htrunc');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Small readers and authorizers (definer; no grants except the three authorizers the invoker 10D placement trigger needs).
-- ---------------------------------------------------------------------------
-- The Final round of a callback preliminary round (or null).
create function public._cf1_callback_successor(p_round_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.id
  from public.event_competition_rounds s
  join public.event_competition_programs p on p.id = s.program_id and p.advancement_method = 'promote_callback'
  join public.event_competition_rounds f on f.division_id = s.division_id and f.sequence_number = s.sequence_number + 1 and f.round_type = 'final'
  where s.id = p_round_id and s.round_type = 'preliminary';
$$;

-- The callback preliminary round of a Final (the design section 5 definition, same as _cf1_is_callback_final) or null.
create function public._cf1_callback_source(p_final_round_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
  from public.event_competition_rounds f
  join public.event_competition_rounds s on s.division_id = f.division_id and s.sequence_number = f.sequence_number - 1 and s.round_type = 'preliminary'
  join public.event_competition_programs p on p.id = s.program_id and p.advancement_method = 'promote_callback'
  where f.id = p_final_round_id and f.round_type = 'final';
$$;

create function public._cf1_has_advancement(p_target_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_round_advancements a where a.target_round_id = p_target_round_id);
$$;

-- The active advancement (no revocation row) of a target round, or null.
create function public._cf1_active_advancement(p_target_round_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select a.id
  from public.event_competition_round_advancements a
  where a.target_round_id = p_target_round_id
    and not exists (select 1 from public.event_competition_round_advancement_revocations r where r.advancement_id = a.id)
  order by a.generation desc
  limit 1;
$$;

-- Effective withdrawals of a Final round: the pairs whose highest-seq row is a withdraw. Used by apply, the start guard, A6.
create function public._cf1_withdrawn_entries(p_target_round_id uuid)
returns table(entry_id uuid, withdrawal_id uuid)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select l.entry_id, l.id
  from (
    select distinct on (w.entry_id) w.entry_id, w.id, w.kind
    from public.event_competition_final_withdrawals w
    where w.target_round_id = p_target_round_id
    order by w.entry_id, w.seq desc
  ) l
  where l.kind = 'withdraw';
$$;

-- Authorizers (transaction-bound). Volatile on purpose: each statement takes a fresh snapshot.
create function public._cf1_auth_apply(p_round_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_round_advancements a
                 where a.target_round_id = p_round_id and a.transaction_id = txid_current());
$$;

create function public._cf1_auth_apply_heat(p_heat_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_heats h
                 join public.event_competition_round_advancements a on a.target_round_id = h.round_id
                 where h.id = p_heat_id and a.transaction_id = txid_current());
$$;

-- Floor heats carry no round: authorized by event + live version + append position (design section 5, P3a).
create function public._cf1_auth_apply_floor_heat(p_event_id uuid, p_version_id uuid, p_heat_number integer)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_round_advancements a where a.event_id = p_event_id and a.transaction_id = txid_current())
     and p_version_id is not distinct from public._compo1_live_version(p_event_id)
     and p_heat_number = 1 + coalesce((select max(f.heat_number) from public.event_competition_floor_heats f where f.schedule_version_id = p_version_id), 0);
$$;

create function public._cf1_auth_revoke(p_round_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_round_advancement_revocations r
                 join public.event_competition_round_advancements a on a.id = r.advancement_id
                 where a.target_round_id = p_round_id and r.transaction_id = txid_current());
$$;

create function public._cf1_auth_cancel(p_round_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_round_transition_events e
                 where e.round_id = p_round_id and e.kind = 'round_cancelled' and e.transaction_id = txid_current());
$$;

revoke all on function public._cf1_callback_successor(uuid), public._cf1_callback_source(uuid), public._cf1_has_advancement(uuid),
  public._cf1_active_advancement(uuid), public._cf1_withdrawn_entries(uuid), public._cf1_auth_apply(uuid), public._cf1_auth_apply_heat(uuid),
  public._cf1_auth_apply_floor_heat(uuid, uuid, integer), public._cf1_auth_revoke(uuid), public._cf1_auth_cancel(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public._cf1_auth_apply(uuid), public._cf1_auth_apply_heat(uuid), public._cf1_auth_apply_floor_heat(uuid, uuid, integer)
  to authenticated, service_role;

-- OD-3 reason substance (also used by F1): 20-500 characters, >= 4 words of which >= 3 distinct, not a repeated character/word, not a placeholder.
create function public._cf1_reason_is_substantive(p_reason text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_r text := btrim(coalesce(p_reason, ''));
  v_words text[];
begin
  if length(v_r) < 20 or length(v_r) > 500 then return false; end if;
  if lower(v_r) = any (array['n/a', 'none', 'test', 'testing', 'fix', 'fixed', 'asdf', 'tbd', 'ok']) then return false; end if;
  if v_r ~ '^(.)\1*$' then return false; end if;
  v_words := regexp_split_to_array(lower(v_r), '\s+');
  if array_length(v_words, 1) < 4 then return false; end if;
  if (select count(distinct w) from unnest(v_words) w) < 3 then return false; end if;
  return true;
end;
$$;
revoke all on function public._cf1_reason_is_substantive(text) from public, anon, authenticated, service_role;

-- A4a extension point: the after-state validity of a callback configuration. A0: T must fit the Final's single heat.
create function public._cf1_callback_target_check(p_t integer, p_capacity integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_t is not null and p_t > p_capacity then 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY' else null end;
$$;
revoke all on function public._cf1_callback_target_check(integer, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Capacity: the F2 setup guard, the capacity trigger, the reasoned RPC, the rewritten legacy RPC.
-- ---------------------------------------------------------------------------
-- F2 setup guard (rounds). T edit on the callback round; capacity edit / insert on the successor Final.
create function public.cf1_guard_callback_target_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_cap integer;
  v_t integer;
  v_other record;
begin
  -- Arm 1: NEW is a callback preliminary round with T set and a successor Final.
  if new.round_type = 'preliminary' and new.target_advancement_count is not null
     and (tg_op = 'INSERT' or new.target_advancement_count is distinct from old.target_advancement_count
       or (new.sequence_number, new.round_type) is distinct from (old.sequence_number, old.round_type)) then
    select f.configuration into v_other
    from public.event_competition_rounds f
    join public.event_competition_programs p on p.id = new.program_id and p.advancement_method = 'promote_callback'
    where f.division_id = new.division_id and f.sequence_number = new.sequence_number + 1 and f.round_type = 'final';
    if found then
      v_cap := coalesce(nullif(v_other.configuration->>'max_entries_per_heat', '')::integer, 8);
      v_code := public._cf1_callback_target_check(new.target_advancement_count, v_cap);
      if v_code is not null then
        raise exception '%: the callback target (%) does not fit the Final''s capacity (%).', v_code, new.target_advancement_count, v_cap using errcode = 'P0001';
      end if;
    end if;
  end if;
  -- Arm 2/3: NEW is a Final whose capacity is written (insert, or the max_entries_per_heat key changes).
  if new.round_type = 'final'
     and (tg_op = 'INSERT' or (new.configuration->'max_entries_per_heat') is distinct from (old.configuration->'max_entries_per_heat')
          or (new.sequence_number, new.round_type) is distinct from (old.sequence_number, old.round_type)) then
    select s.target_advancement_count into v_t
    from public.event_competition_rounds s
    join public.event_competition_programs p on p.id = s.program_id and p.advancement_method = 'promote_callback'
    where s.division_id = new.division_id and s.sequence_number = new.sequence_number - 1 and s.round_type = 'preliminary';
    if found and v_t is not null then
      v_cap := coalesce(nullif(new.configuration->>'max_entries_per_heat', '')::integer, 8);
      v_code := public._cf1_callback_target_check(v_t, v_cap);
      if v_code is not null then
        raise exception '%: the callback target (%) does not fit the Final''s capacity (%).', v_code, v_t, v_cap using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_guard_callback_target_capacity() from public, anon, authenticated, service_role;
create trigger cf1_guard_callback_target_capacity
  before insert or update of target_advancement_count, configuration, sequence_number, round_type on public.event_competition_rounds
  for each row execute function public.cf1_guard_callback_target_capacity();
alter table public.event_competition_rounds enable always trigger cf1_guard_callback_target_capacity;

-- F2 publish / program-lock arm.
create function public.cf1_guard_callback_target_program_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r record;
  v_cap integer;
  v_code text;
begin
  if old.profile_locked_at is not null or new.profile_locked_at is null or new.advancement_method is distinct from 'promote_callback' then
    return new;
  end if;
  for v_r in
    select s.id, s.target_advancement_count as t, f.configuration as fcfg
    from public.event_competition_rounds s
    join public.event_competition_rounds f on f.division_id = s.division_id and f.sequence_number = s.sequence_number + 1 and f.round_type = 'final'
    where s.program_id = new.id and s.round_type = 'preliminary' and s.target_advancement_count is not null
    order by s.division_id, s.sequence_number
  loop
    v_cap := coalesce(nullif(v_r.fcfg->>'max_entries_per_heat', '')::integer, 8);
    v_code := public._cf1_callback_target_check(v_r.t, v_cap);
    if v_code is not null then
      raise exception '%: callback round % has target % but its Final holds %; fix it before publishing.', v_code, v_r.id, v_r.t, v_cap using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.cf1_guard_callback_target_program_lock() from public, anon, authenticated, service_role;
create trigger cf1_guard_callback_target_program_lock
  before update of profile_locked_at on public.event_competition_programs
  for each row execute function public.cf1_guard_callback_target_program_lock();
alter table public.event_competition_programs enable always trigger cf1_guard_callback_target_program_lock;

-- Capacity trigger: the only writer of max_entries_per_heat is the reasoned RPC (a capacity-event row of this transaction).
create function public.cf1_guard_round_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new text := new.configuration->>'max_entries_per_heat';
begin
  if tg_op = 'INSERT' then
    -- A capacity-event row references the round, so none can exist before the insert: the key must be absent (default 8 applies).
    if (new.configuration ? 'max_entries_per_heat') then
      raise exception 'COMP_CAPACITY_DIRECT_WRITE: a round is created without a capacity; set it afterwards with a recorded reason.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (new.configuration->'max_entries_per_heat') is not distinct from (old.configuration->'max_entries_per_heat') then
    return new;
  end if;
  if not exists (select 1 from public.event_competition_round_capacity_events e
                 where e.round_id = new.id and e.transaction_id = txid_current() and e.new_capacity::text = v_new) then
    raise exception 'COMP_CAPACITY_DIRECT_WRITE: the capacity of a round changes only through set_competition_round_heat_capacity with a recorded reason.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_guard_round_capacity() from public, anon, authenticated, service_role;
create trigger cf1_guard_round_capacity
  before insert or update of configuration on public.event_competition_rounds
  for each row execute function public.cf1_guard_round_capacity();
alter table public.event_competition_rounds enable always trigger cf1_guard_round_capacity;

-- Legacy 2-argument RPC: fail closed for every round (OD-14 A). Changes nothing, writes nothing.
create or replace function public.set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'COMP_CAPACITY_REASON_REQUIRED: a capacity change needs a recorded reason; use set_competition_round_heat_capacity(round, capacity, reason, request id).'
    using errcode = 'P0001';
end;
$$;

create function public.set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_cb public.event_competition_rounds;
  v_prev public.event_competition_round_capacity_events;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old integer;
  v_t integer;
  v_frozen boolean := false;
  v_exempt text := null;
  v_code text;
  v_ids uuid[];
  v_tie boolean;
begin
  if v_uid is null then
    raise exception 'COMP_CAPACITY_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or not public.can_manage_event_competition(v_round.event_id) or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_CAPACITY_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason = '' then
    raise exception 'COMP_CAPACITY_REASON_REQUIRED: a capacity change needs a recorded reason.' using errcode = 'P0001';
  end if;
  perform public._compo1_lock_event(v_round.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_round_capacity_events e where e.request_id = p_request_id;
  if found then
    if v_prev.round_id = p_round_id and v_prev.actor = v_uid and v_prev.new_capacity = p_capacity then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'old_capacity', v_prev.old_capacity, 'new_capacity', v_prev.new_capacity, 'exemption', v_prev.exemption);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if p_capacity is null or p_capacity < 1 or p_capacity > 100 then
    raise exception 'COMP_CAPACITY_RANGE: choose between 1 and 100 entries per scoring heat.' using errcode = 'P0001';
  end if;
  if not public._cf1_reason_is_substantive(v_reason) then
    raise exception 'COMP_CAPACITY_REASON_WEAK: the reason must be 20-500 characters, at least 4 words, not a placeholder.' using errcode = 'P0001';
  end if;
  -- B1
  if v_round.status not in ('draft', 'scheduled') then
    raise exception 'COMP_CAPACITY_ROUND_STATE: the capacity cannot change once the round has started (round is %).', v_round.status using errcode = 'P0001';
  end if;
  -- B2
  if exists (select 1 from public.event_competition_heats h
             where h.round_id = p_round_id and h.status <> 'cancelled' and (h.status in ('staging', 'active', 'complete') or h.lock_state <> 'open')) then
    raise exception 'COMP_CAPACITY_HEAT_STATE: a heat of this round has started or is locked.' using errcode = 'P0001';
  end if;
  -- B3
  if exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id) then
    raise exception 'COMP_CAPACITY_BALLOTS: the round already has ballots.' using errcode = 'P0001';
  end if;
  -- B4
  if public._cf1_active_advancement(p_round_id) is not null then
    raise exception 'COMP_CAPACITY_ADVANCED: the Final was generated from a callback result; correct the callback to change it.' using errcode = 'P0001';
  end if;
  v_old := coalesce(nullif(v_round.configuration->>'max_entries_per_heat', '')::integer, 8);

  -- B5 / F1 / B6: the callback round whose successor this is.
  select * into v_cb from public.event_competition_rounds c where c.id = public._cf1_callback_source(p_round_id);
  if found then
    v_t := v_cb.target_advancement_count;
    v_frozen := v_cb.status not in ('draft', 'scheduled', 'active')
                or exists (select 1 from public.event_competition_ballots b where b.round_id = v_cb.id)
                or exists (select 1 from public.event_competition_result_versions rv where rv.round_id = v_cb.id);
    if v_frozen then
      -- F1: raise to exactly T, only when capacity < T, the callback is before approval and no blocked-tie version exists.
      if v_t is not null and v_old < v_t then
        v_tie := exists (select 1 from public.event_competition_result_versions rv
                         join public.event_competition_result_rows rr on rr.result_version_id = rv.id
                         where rv.round_id = v_cb.id and rr.advanced is null);
        if p_capacity <> v_t or v_t > 100 then
          raise exception 'COMP_CAPACITY_F1_NOT_EXACT_T: the only capacity change allowed now is a raise to exactly the callback target (%).', v_t using errcode = 'P0001';
        elsif v_cb.status in ('approved', 'published', 'complete', 'cancelled') then
          raise exception 'COMP_CAPACITY_F1_CALLBACK_STATE: the callback result is %; use the correction path.', v_cb.status using errcode = 'P0001';
        elsif v_tie then
          raise exception 'COMP_CAPACITY_F1_BLOCKED_TIE: a tie over the Final''s capacity is blocking this callback; capacity cannot be raised to dissolve it.' using errcode = 'P0001';
        end if;
        v_exempt := 'f1_raise_to_t';
      else
        raise exception 'COMP_CAPACITY_CALLBACK_FROZEN: the callback round has ballots or a result; the Final''s capacity is frozen.' using errcode = 'P0001';
      end if;
    end if;
    v_code := public._cf1_callback_target_check(v_t, p_capacity);
    if v_code is not null then
      raise exception '%: the callback target (%) does not fit capacity %.', v_code, v_t, p_capacity using errcode = 'P0001';
    end if;
    select coalesce(array_agg(rv.id order by rv.version), '{}') into v_ids from public.event_competition_result_versions rv where rv.round_id = v_cb.id;
  end if;

  insert into public.event_competition_round_capacity_events
    (event_id, round_id, old_capacity, new_capacity, reason, actor, request_id, exemption, target_t, callback_round_id, callback_round_status, callback_result_version_ids)
  values (v_round.event_id, p_round_id, v_old, p_capacity, v_reason, v_uid, p_request_id, v_exempt, v_t, v_cb.id, v_cb.status, v_ids);
  update public.event_competition_rounds
  set configuration = jsonb_set(coalesce(configuration, '{}'::jsonb), '{max_entries_per_heat}', to_jsonb(p_capacity))
  where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'old_capacity', v_old, 'new_capacity', p_capacity, 'exemption', v_exempt);
end;
$$;
revoke all on function public.set_competition_round_heat_capacity(uuid, integer, text, uuid) from public, anon, service_role;
grant execute on function public.set_competition_round_heat_capacity(uuid, integer, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Final-heat guards (design section 5). Each is a no-op for a round that is not a callback Final.
-- ---------------------------------------------------------------------------
create function public.cf1_guard_final_heat_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._cf1_has_advancement(new.round_id) then
    if not public._cf1_auth_apply(new.round_id) then
      raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_WRITER: a heat of an advanced Final is created only by apply_competition_round_advancement.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.schedule_version_id is null and public._cf1_is_callback_final(new.round_id) then
    raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_WRITER: a heat of a callback Final must be placed in a schedule version.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function public.cf1_guard_final_heat_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status = 'cancelled' then
    -- I4: a cancelled heat of an advanced Final is never revived. Decided without a lock whenever an advancement is visible.
    if public._cf1_has_advancement(old.round_id) then
      raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_REVIVE: a cancelled heat of an advanced Final cannot be revived.' using errcode = 'P0001';
    end if;
    if public._cf1_is_callback_final(old.round_id) then
      select r.status into v_status from public.event_competition_rounds r where r.id = old.round_id;
      if v_status in ('draft', 'scheduled') then
        begin
          perform 1 from public.event_competition_rounds r where r.id = old.round_id for share nowait;
        exception when lock_not_available then
          raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: the round is being changed; try again.' using errcode = '55P03';
        end;
        if public._cf1_has_advancement(old.round_id) then
          raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_REVIVE: a cancelled heat of an advanced Final cannot be revived.' using errcode = 'P0001';
        end if;
      end if;
    end if;
    return new;
  end if;
  if new.status = 'cancelled' and public._cf1_has_advancement(old.round_id)
     and not (public._cf1_auth_revoke(old.round_id) or public._cf1_auth_cancel(old.round_id)) then
    raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_CANCEL: a heat of an advanced Final is cancelled only by the correction path or by cancelling the round.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function public.cf1_guard_final_heat_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (old.round_id, old.division_id, old.event_id, old.contest_id, old.schedule_version_id, old.floor_heat_id, old.schedule_block_id)
     is not distinct from
     (new.round_id, new.division_id, new.event_id, new.contest_id, new.schedule_version_id, new.floor_heat_id, new.schedule_block_id) then
    return new;
  end if;
  if (public._cf1_has_advancement(old.round_id) and not public._cf1_auth_apply(old.round_id))
     or (public._cf1_has_advancement(new.round_id) and not public._cf1_auth_apply(new.round_id)) then
    raise exception 'COMP_ADVANCEMENT_FINAL_HEAT_IDENTITY: a heat of an advanced Final cannot change round, division, version, floor heat or block.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function public.cf1_guard_final_heat_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round uuid;
  v_old_round uuid;
begin
  if tg_op = 'UPDATE' and old.heat_id = new.heat_id and old.entry_id = new.entry_id then
    return new;
  end if;
  select h.round_id into v_round from public.event_competition_heats h where h.id = new.heat_id;
  if v_round is not null and (public._cf1_has_advancement(v_round) or public._cf1_is_callback_final(v_round)) then
    if not public._cf1_auth_apply(v_round)
       or not exists (select 1 from public.event_competition_round_advancement_entries ae
                      join public.event_competition_round_advancements a on a.id = ae.advancement_id
                      where a.target_round_id = v_round and a.transaction_id = txid_current()
                        and ae.entry_id = new.entry_id and ae.carried_withdrawal_id is null) then
      raise exception 'COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: the roster of a callback Final is written only by apply_competition_round_advancement, from the advanced list.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.heat_id is distinct from new.heat_id then
    select h.round_id into v_old_round from public.event_competition_heats h where h.id = old.heat_id;
    if v_old_round is not null and (public._cf1_has_advancement(v_old_round) or public._cf1_is_callback_final(v_old_round))
       and not public._cf1_auth_apply(v_old_round) then
      raise exception 'COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: a roster row of a callback Final cannot be moved out.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create function public.cf1_guard_final_heat_dance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_heat uuid := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  v_round uuid;
begin
  if tg_op = 'UPDATE' and old.heat_id = new.heat_id and old.dance_id is not distinct from new.dance_id then
    if (old.status, old.sequence_number, old.dance_key) is not distinct from (new.status, new.sequence_number, new.dance_key) then
      return new;
    end if;
    -- status / order / key of a dance slot of an advanced Final heat: apply, the correction path or a round cancel only
    select h.round_id into v_round from public.event_competition_heats h where h.id = v_heat;
    if v_round is not null and public._cf1_has_advancement(v_round)
       and not (public._cf1_auth_apply(v_round) or public._cf1_auth_revoke(v_round) or public._cf1_auth_cancel(v_round)) then
      raise exception 'COMP_ADVANCEMENT_FINAL_DANCE_WRITER: the dances of an advanced Final heat are changed only by apply_competition_round_advancement or the correction path.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and (not exists (select 1 from public.events e where e.id = old.event_id)
                           or not exists (select 1 from public.event_competition_heats h where h.id = old.heat_id)) then
    return old;
  end if;
  select h.round_id into v_round from public.event_competition_heats h where h.id = v_heat;
  if v_round is not null and public._cf1_has_advancement(v_round) and not public._cf1_auth_apply(v_round) then
    raise exception 'COMP_ADVANCEMENT_FINAL_DANCE_WRITER: the dances of an advanced Final heat are written only by apply_competition_round_advancement.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Deferred backstop for I1 (heat rows only; it does not serialize).
create function public.cf1_check_final_single_live_heat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public._cf1_has_advancement(new.round_id)
     and (select count(*) from public.event_competition_heats h
          where h.round_id = new.round_id and h.status <> 'cancelled'
            and h.schedule_version_id is not distinct from public._compo1_live_version(new.event_id)
            and h.schedule_version_id is not null) > 1 then
    raise exception 'COMP_ADVANCEMENT_FINAL_MULTIPLE_HEATS: an advanced Final has more than one heat in the running order.' using errcode = '23514';
  end if;
  return null;
end;
$$;

create function public.cf1_check_one_active_advancement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.event_competition_round_advancements a
      where a.source_round_id = new.source_round_id
        and not exists (select 1 from public.event_competition_round_advancement_revocations r where r.advancement_id = a.id)) > 1 then
    raise exception 'COMP_ADVANCEMENT_ALREADY_APPLIED: a round has at most one active advancement.' using errcode = '23514';
  end if;
  return null;
end;
$$;

-- Publication-time invariant (I6): the transition into published / live is validated whichever path made it.
create function public.cf1_guard_publish_final_heats()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r uuid;
  v_active integer;
  v_adv uuid;
begin
  if new.status not in ('published', 'live') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  if not exists (select 1 from public.event_competition_round_advancements a where a.event_id = new.event_id) then
    return new;
  end if;
  perform public._compo1_lock_event(new.event_id);
  for v_r in
    select distinct a.target_round_id
    from public.event_competition_round_advancements a
    join public.event_competition_rounds r on r.id = a.target_round_id
    where a.event_id = new.event_id and r.status <> 'cancelled'
    order by 1
  loop
    select count(*) into v_active from public.event_competition_round_advancements a
    where a.target_round_id = v_r and not exists (select 1 from public.event_competition_round_advancement_revocations rv where rv.advancement_id = a.id);
    if v_active > 1 then
      raise exception 'COMP_ADVANCEMENT_PUBLISH_INCONSISTENT: a Final has more than one active advancement.' using errcode = '23514';
    end if;
    if v_active = 0 then
      if exists (select 1 from public.event_competition_heats h where h.round_id = v_r and h.schedule_version_id = new.id and h.status <> 'cancelled') then
        raise exception 'COMP_ADVANCEMENT_PUBLISH_FINAL_HEAT: this version holds a Final heat that no advancement owns.' using errcode = '23514';
      end if;
      continue;
    end if;
    v_adv := public._cf1_active_advancement(v_r);
    if not exists (select 1 from public.event_competition_round_advancement_heats l where l.advancement_id = v_adv)
       or exists (select 1 from public.event_competition_round_advancement_heats l
                  join public.event_competition_heats h on h.id = l.heat_id where l.advancement_id = v_adv and h.status = 'cancelled') then
      raise exception 'COMP_ADVANCEMENT_PUBLISH_INCONSISTENT: the active advancement of a Final has no live heat.' using errcode = '23514';
    end if;
    if exists (select 1 from public.event_competition_heats h
               where h.round_id = v_r and h.schedule_version_id = new.id and h.status <> 'cancelled'
                 and not exists (select 1 from public.event_competition_round_advancement_heats l where l.advancement_id = v_adv and l.heat_id = h.id)) then
      raise exception 'COMP_ADVANCEMENT_PUBLISH_FINAL_HEAT: this version holds a Final heat that the active advancement does not own.' using errcode = '23514';
    end if;
    if exists (select 1 from public.event_competition_round_advancement_heats l
               join public.event_competition_heats h on h.id = l.heat_id
               where l.advancement_id = v_adv and h.schedule_version_id is distinct from new.id) then
      raise exception 'COMP_ADVANCEMENT_PUBLISH_FROZEN: the running order holds a generated Final; only the version that holds it can be published.' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

-- Final start: an active advancement, a complete and eligible roster, at least two couples (OD-15 A).
create function public.cf1_guard_final_start()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_adv uuid;
  v_expected uuid[];
  v_roster uuid[];
  v_missing uuid[];
  v_extra uuid[];
  v_dup integer;
  v_heats integer;
  v_bad jsonb;
  v_dance_n integer;
  v_dance_key text;
  v_src_n integer;
  v_src_key text;
begin
  if not (old.status = 'scheduled' and new.status = 'active') then
    return new;
  end if;
  v_adv := public._cf1_active_advancement(new.id);
  if not public._cf1_is_callback_final(new.id) then
    -- An advanced Final whose callback definition changed afterwards (sequence, type, advancement method) must not start unchecked.
    if v_adv is not null then
      raise exception 'COMP_ADVANCEMENT_ROSTER_STALE: this Final has an advancement but is no longer the Final of a callback round; correct the setup or revoke the advancement.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if v_adv is null then
    raise exception 'COMP_ADVANCEMENT_NOT_APPLIED: this Final is built from the callback result; advance the callback first.' using errcode = 'P0001';
  end if;
  begin
    perform 1 from public.event_competition_heats h where h.round_id = new.id order by h.id for share nowait;
    perform 1 from public.event_competition_heat_entries he
      where he.heat_id in (select h.id from public.event_competition_heats h where h.round_id = new.id) order by he.id for share;
    perform 1 from public.event_competition_entries e
      where e.id in (select he.entry_id from public.event_competition_heat_entries he
                     where he.heat_id in (select h.id from public.event_competition_heats h where h.round_id = new.id)
                     union select ae.entry_id from public.event_competition_round_advancement_entries ae where ae.advancement_id = v_adv)
      order by e.id for share;
  exception when lock_not_available or deadlock_detected then
    raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: a Final heat or one of its couples is being changed; the round was not started. Try again.' using errcode = '55P03';
  end;
  -- Revalidate in fresh statements (they see what committed while a lock waited).
  select count(*) into v_heats from public.event_competition_heats h
  where h.round_id = new.id and h.status <> 'cancelled' and h.schedule_version_id is not distinct from public._compo1_live_version(new.event_id);
  select coalesce(array_agg(he.entry_id order by he.entry_id), '{}') into v_roster
  from public.event_competition_heat_entries he
  join public.event_competition_heats h on h.id = he.heat_id
  where h.round_id = new.id and h.status <> 'cancelled' and h.schedule_version_id is not distinct from public._compo1_live_version(new.event_id) and he.status <> 'scratched';
  select coalesce(array_agg(ae.entry_id order by ae.entry_id), '{}') into v_expected
  from public.event_competition_round_advancement_entries ae
  where ae.advancement_id = v_adv and ae.entry_id not in (select w.entry_id from public._cf1_withdrawn_entries(new.id) w);
  select count(*) into v_dup from (select 1 from unnest(v_roster) x group by x having count(*) > 1) d;
  select coalesce(array_agg(x), '{}') into v_missing from unnest(v_expected) x where x <> all (v_roster);
  select coalesce(array_agg(distinct x), '{}') into v_extra from unnest(v_roster) x where x <> all (v_expected);
  if v_heats <> 1 or v_dup > 0 or cardinality(v_missing) > 0 or cardinality(v_extra) > 0 then
    raise exception 'COMP_ADVANCEMENT_ROSTER_INCOMPLETE: the Final roster is not the advanced list minus recorded withdrawals.'
      using errcode = 'P0001', detail = jsonb_build_object('heats', v_heats, 'duplicates', v_dup, 'missing', to_jsonb(v_missing), 'extra', to_jsonb(v_extra))::text;
  end if;
  select jsonb_agg(jsonb_build_object('entry_id', e.id, 'reason', coalesce(public._cf1_entry_unavailable_reason(e.id),
           case when (e.event_id, e.program_id, e.division_id) is distinct from (r.event_id, r.program_id, r.division_id) then 'wrong_scope' end)))
    into v_bad
  from public.event_competition_entries e
  cross join public.event_competition_rounds r
  where r.id = new.id and e.id = any (v_roster)
    and (public._cf1_entry_unavailable(e.id) or (e.event_id, e.program_id, e.division_id) is distinct from (r.event_id, r.program_id, r.division_id));
  if v_bad is not null then
    raise exception 'COMP_ADVANCEMENT_ROSTER_STALE: a couple on the Final roster is no longer eligible.' using errcode = 'P0001', detail = jsonb_build_object('entries', v_bad)::text;
  end if;
  if public._cf1_count_available_entries(v_roster) < 2 then
    raise exception 'COMP_ADVANCEMENT_BELOW_MINIMUM: a callback Final needs at least two eligible couples to start.' using errcode = 'P0001';
  end if;
  -- Exactly one non-cancelled dance on the single live Final heat, and it is the callback round's dance.
  select count(*), min(hd.dance_key) into v_dance_n, v_dance_key
  from public.event_competition_heat_dances hd
  join public.event_competition_heats h on h.id = hd.heat_id
  where h.round_id = new.id and h.status <> 'cancelled' and h.schedule_version_id is not distinct from public._compo1_live_version(new.event_id)
    and hd.status <> 'cancelled';
  select count(distinct hd.dance_key), min(hd.dance_key) into v_src_n, v_src_key
  from public.event_competition_heat_dances hd
  join public.event_competition_heats h on h.id = hd.heat_id
  where h.round_id = public._cf1_callback_source(new.id) and h.status <> 'cancelled' and hd.status <> 'cancelled';
  if v_dance_n <> 1 or v_src_n <> 1 or v_dance_key is distinct from v_src_key then
    raise exception 'COMP_ADVANCEMENT_FINAL_DANCE: the Final heat must hold exactly one dance, the callback round''s dance.'
      using errcode = 'P0001', detail = jsonb_build_object('final_dances', v_dance_n, 'source_dances', v_src_n)::text;
  end if;
  return new;
end;
$$;

-- 2.4 approval gate: a callback result with an undecided row (a tie over capacity) cannot be approved.
create function public.cf1_guard_advancement_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (old.status = 'calculated' and new.status = 'approved') then
    return new;
  end if;
  if new.engine_key like '%callback_tally%'
     and exists (select 1 from public.event_competition_rounds r
                 join public.event_competition_programs p on p.id = r.program_id
                 where r.id = new.round_id and r.round_type = 'preliminary' and p.advancement_method = 'promote_callback')
     and exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = new.id and rr.advanced is null) then
    raise exception 'COMP_ADVANCEMENT_BLOCKED: this callback result is blocked (a tie over the Final''s capacity); it cannot be approved.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Revoke (internal) and the correction trigger.
-- ---------------------------------------------------------------------------
create function public._cf1_revoke_advancement(p_source_round_id uuid, p_reason text, p_cause text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.event_competition_round_advancements;
  v_id uuid;
  v_actor uuid;
  v_heats uuid[];
  v_corr uuid;
begin
  select * into v_a from public.event_competition_round_advancements a
  where a.source_round_id = p_source_round_id
    and not exists (select 1 from public.event_competition_round_advancement_revocations r where r.advancement_id = a.id)
  order by a.generation desc limit 1;
  if not found then
    return null;
  end if;
  begin
    select coalesce(array_agg(h.id order by h.id), '{}') into v_heats from (
      select h2.id from public.event_competition_heats h2 where h2.round_id = v_a.target_round_id and h2.status <> 'cancelled' order by h2.id for update nowait) h;
  exception when lock_not_available then
    raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: a Final heat is being changed; the correction was not opened. Try again.' using errcode = '55P03';
  end;
  v_actor := coalesce(auth.uid(), v_a.applied_by);
  select e.request_id into v_corr from public.event_competition_result_events e
  where e.round_id = p_source_round_id and e.transaction_id = txid_current() and e.kind = 'round_state_changed' and e.to_state = 'ballots_locked'
  order by e.occurred_at desc limit 1;
  insert into public.event_competition_round_advancement_revocations (advancement_id, event_id, revoked_by, reason, cause, request_id)
  values (v_a.id, v_a.event_id, v_actor, left(coalesce(nullif(btrim(p_reason), ''), 'correction opened'), 500), p_cause, gen_random_uuid())
  returning id into v_id;
  update public.event_competition_heats set status = 'cancelled', updated_at = now()
  where id = any (v_heats);
  perform public._compf2_event(v_a.event_id, p_source_round_id, v_a.source_result_version_id, 'advancement_revoked', v_actor, null, null, gen_random_uuid(),
    left(nullif(btrim(p_reason), ''), 500),
    jsonb_build_object('advancement_id', v_a.id, 'generation', v_a.generation, 'source_result_version_id', v_a.source_result_version_id,
                       'entry_count', v_a.advanced_count, 'heat_ids', to_jsonb(v_heats), 'request_id', v_corr, 'cause', p_cause));
  return v_id;
end;
$$;

create function public.cf1_guard_advancement_correction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_final public.event_competition_rounds;
  v_adv uuid;
  v_roster uuid[];
  v_ver uuid;
  v_reason text;
begin
  if not (new.status = 'ballots_locked' and new.correction_open and old.status in ('calculated', 'approved', 'published')) then
    return new;
  end if;
  select * into v_final from public.event_competition_rounds f where f.id = public._cf1_callback_successor(new.id);
  if not found then
    return new;
  end if;
  -- OD-10 (cancelled Final): refused with or without an advancement; a cancelled Final is never revived.
  if v_final.status = 'cancelled' then
    raise exception 'COMP_ADVANCEMENT_FINAL_CANCELLED: the Final round was cancelled; correct the callback result before cancelling a Final.' using errcode = 'P0001';
  end if;
  v_adv := public._cf1_active_advancement(v_final.id);
  if v_adv is not null then
    if old.status = 'published' then
      raise exception 'COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3: a published callback result needs the publication withdrawal workflow (F3) before it can be corrected.' using errcode = 'P0001';
    end if;
    if v_final.status not in ('draft', 'scheduled')
       or exists (select 1 from public.event_competition_heats h where h.round_id = v_final.id and h.status in ('staging', 'active', 'complete')) then
      raise exception 'COMP_ADVANCEMENT_FINAL_STARTED: the Final has started; the callback result can no longer be corrected.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_heats h where h.round_id = v_final.id and h.status <> 'cancelled' and h.lock_state <> 'open') then
      raise exception 'COMP_ADVANCEMENT_FINAL_LOCKED: a Final heat is locked; reopen it before correcting the callback result.' using errcode = 'P0001';
    end if;
  end if;
  -- Recovery pre-check (4.5): an unavailable couple with no recorded withdrawal makes the correction a dead end.
  if v_adv is not null then
    select coalesce(array_agg(ae.entry_id), '{}') into v_roster from public.event_competition_round_advancement_entries ae
    where ae.advancement_id = v_adv and ae.carried_withdrawal_id is null;
  else
    select rv.id into v_ver from public.event_competition_result_versions rv where rv.round_id = new.id order by rv.version desc limit 1;
    select coalesce(array_agg(rr.entry_id), '{}') into v_roster from public.event_competition_result_rows rr where rr.result_version_id = v_ver and rr.advanced is true;
  end if;
  if exists (select 1 from unnest(v_roster) x(entry_id)
             where public._cf1_entry_unavailable(x.entry_id)
               and x.entry_id not in (select w.entry_id from public._cf1_withdrawn_entries(v_final.id) w)) then
    raise exception 'COMP_ADVANCEMENT_CORRECTION_UNRECOVERABLE: a couple on the roster is no longer eligible; withdraw the couple from the Final first, or revert their eligibility.' using errcode = 'P0001';
  end if;
  if v_adv is not null then
    select e.reason into v_reason from public.event_competition_result_events e
    where e.round_id = new.id and e.transaction_id = txid_current() and e.kind = 'round_state_changed' and e.to_state = 'ballots_locked'
    order by e.occurred_at desc limit 1;
    perform public._cf1_revoke_advancement(new.id, v_reason, 'source_correction_opened');
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Preview and apply.
-- ---------------------------------------------------------------------------
create function public.competition_round_advancement_preview(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_src public.event_competition_rounds;
  v_tgt public.event_competition_rounds;
  v_ver public.event_competition_result_versions;
  v_prog public.event_competition_programs;
  v_blockers jsonb := '[]'::jsonb;
  v_live uuid;
  v_active uuid;
  v_last public.event_competition_round_advancements;
  v_n integer;
  v_c integer;
  v_cap integer;
  v_bad jsonb;
  v_state text;
  v_dances integer;
begin
  if v_uid is null or public._compe2_round_role(p_round_id) is distinct from 'manager' or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_src from public.event_competition_rounds r where r.id = p_round_id;
  select * into v_prog from public.event_competition_programs p where p.id = v_src.program_id;
  if v_src.round_type <> 'preliminary' or v_prog.advancement_method <> 'promote_callback' then
    return jsonb_build_object('state', 'not_applicable', 'blockers', '[]'::jsonb);
  end if;
  select * into v_tgt from public.event_competition_rounds f where f.id = public._cf1_callback_successor(p_round_id);
  select * into v_last from public.event_competition_round_advancements a where a.source_round_id = p_round_id order by a.generation desc limit 1;
  if found then
    v_active := public._cf1_active_advancement(v_tgt.id);
    if v_active is not null then
      return jsonb_build_object('state', 'applied', 'blockers', '[]'::jsonb, 'advancement_id', v_active, 'generation', v_last.generation,
        'target_round_id', v_tgt.id,
        'heat_ids', (select coalesce(jsonb_agg(l.heat_id), '[]'::jsonb) from public.event_competition_round_advancement_heats l where l.advancement_id = v_active),
        'entries', (select coalesce(jsonb_agg(jsonb_build_object('entry_id', ae.entry_id, 'carried', ae.carried_withdrawal_id is not null)), '[]'::jsonb)
                    from public.event_competition_round_advancement_entries ae where ae.advancement_id = v_active));
    end if;
  end if;
  if v_src.status not in ('approved', 'published') then
    v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_SOURCE_STATE', 'detail', jsonb_build_object('status', v_src.status));
  end if;
  select * into v_ver from public.event_competition_result_versions rv where rv.round_id = p_round_id and rv.status = 'approved' order by rv.version desc limit 1;
  if v_ver.id is null then
    v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_SOURCE_STATE', 'detail', jsonb_build_object('reason', 'no_approved_version'));
  else
    if v_ver.input_hash is distinct from public._compf2_input_hash(p_round_id, v_ver.engine_key, v_ver.engine_version) then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_RESULT_STALE');
    end if;
    if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is null) then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_BLOCKED');
    end if;
  end if;
  if v_tgt.id is null or v_tgt.status not in ('draft', 'scheduled') then
    v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_TARGET_ROUND_STATE', 'detail', jsonb_build_object('status', v_tgt.status));
  else
    v_live := public._compo1_live_version(v_src.event_id);
    if v_live is null then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_NO_LIVE_VERSION');
    elsif not exists (select 1 from public.event_competition_floor_heats f where f.schedule_version_id = v_live) then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_FINAL_PLACEMENT_MODE');
    end if;
    if exists (select 1 from public.event_competition_heats h where h.round_id = v_tgt.id and h.status <> 'cancelled'
               and (h.schedule_version_id is null or h.schedule_version_id = v_live)) then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_FINAL_HEATS_PRESENT');
    end if;
    v_cap := coalesce(nullif(v_tgt.configuration->>'max_entries_per_heat', '')::integer, 8);
  end if;
  select count(distinct hd.dance_key) into v_dances from public.event_competition_heat_dances hd
  join public.event_competition_heats h on h.id = hd.heat_id
  where h.round_id = p_round_id and h.status <> 'cancelled' and hd.status <> 'cancelled';
  if v_dances <> 1 then
    v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_MULTI_DANCE', 'detail', jsonb_build_object('dances', v_dances));
  end if;
  if v_ver.id is not null and v_tgt.id is not null then
    select count(*) filter (where true), count(*) filter (where w.entry_id is not null) into v_n, v_c
    from public.event_competition_result_rows rr
    left join public._cf1_withdrawn_entries(v_tgt.id) w on w.entry_id = rr.entry_id
    where rr.result_version_id = v_ver.id and rr.advanced is true;
    if v_n - v_c < 1 or (v_n - v_c < 2 and public._cf1_is_callback_final(v_tgt.id)) then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_BELOW_MINIMUM', 'detail', jsonb_build_object('roster', v_n - v_c));
    end if;
    if v_cap is not null and v_n - v_c > v_cap then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_OVER_CAPACITY', 'detail', jsonb_build_object('roster', v_n - v_c, 'capacity', v_cap));
    end if;
    select jsonb_agg(jsonb_build_object('entry_id', rr.entry_id, 'reason', public._cf1_entry_unavailable_reason(rr.entry_id))) into v_bad
    from public.event_competition_result_rows rr
    where rr.result_version_id = v_ver.id and rr.advanced is true and public._cf1_entry_unavailable(rr.entry_id)
      and rr.entry_id not in (select w.entry_id from public._cf1_withdrawn_entries(v_tgt.id) w);
    if v_bad is not null then
      v_blockers := v_blockers || jsonb_build_object('code', 'COMP_ADVANCEMENT_ENTRY_UNAVAILABLE', 'detail', jsonb_build_object('entries', v_bad));
    end if;
  end if;
  v_state := case when jsonb_array_length(v_blockers) = 0 then 'ready'
                  when v_last.id is not null then 'revoked'
                  else 'blocked' end;
  return jsonb_build_object('state', v_state, 'blockers', v_blockers, 'target_round_id', v_tgt.id, 'target_capacity', v_cap,
    'result_version_id', v_ver.id, 'generation', coalesce(v_last.generation, 0),
    'advanced_entries', (select coalesce(jsonb_agg(rr.entry_id order by rr.entry_id), '[]'::jsonb) from public.event_competition_result_rows rr
                         where rr.result_version_id = v_ver.id and rr.advanced is true),
    'carried_withdrawals', (select coalesce(jsonb_agg(jsonb_build_object('entry_id', w.entry_id, 'withdrawal_id', w.withdrawal_id)), '[]'::jsonb)
                            from public._cf1_withdrawn_entries(v_tgt.id) w));
end;
$$;
revoke all on function public.competition_round_advancement_preview(uuid) from public, anon, service_role;
grant execute on function public.competition_round_advancement_preview(uuid) to authenticated;

create function public.apply_competition_round_advancement(p_round_id uuid, p_result_version_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_src public.event_competition_rounds;
  v_tgt public.event_competition_rounds;
  v_prog public.event_competition_programs;
  v_div public.event_competition_divisions;
  v_ver public.event_competition_result_versions;
  v_prev public.event_competition_round_advancements;
  v_live uuid;
  v_live_floor public.event_competition_floor_heats;
  v_adv uuid;
  v_gen integer;
  v_cap integer;
  v_ids uuid[];
  v_roster uuid[];
  v_carried jsonb;
  v_n integer;
  v_c integer;
  v_bad jsonb;
  v_dances integer;
  v_floor uuid;
  v_floor_number integer;
  v_heat uuid;
  v_heat_number integer;
  v_src_heat public.event_competition_heats;
  v_problem record;
begin
  if v_uid is null or p_round_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public._compe2_round_role(p_round_id) is distinct from 'manager' or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null or p_result_version_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id and a result version are required.' using errcode = 'P0001';
  end if;
  begin
    select * into v_src from public.event_competition_rounds r where r.id = p_round_id;
    perform public._compo1_lock_event(v_src.event_id);
    select * into v_src from public.event_competition_rounds r where r.id = p_round_id for update;
    select * into v_tgt from public.event_competition_rounds f where f.id = public._cf1_callback_successor(p_round_id);
    if v_tgt.id is not null then
      select * into v_tgt from public.event_competition_rounds f where f.id = v_tgt.id for update;
    end if;

    -- Replay (before any state check).
    select * into v_prev from public.event_competition_round_advancements a where a.request_id = p_request_id;
    if found then
      if v_prev.source_round_id = p_round_id and v_prev.applied_by = v_uid and v_prev.source_result_version_id = p_result_version_id then
        if exists (select 1 from public.event_competition_round_advancement_revocations rv where rv.advancement_id = v_prev.id) then
          raise exception 'COMP_ADVANCEMENT_REVOKED: this request was applied and has since been revoked; use a new request id to advance again.' using errcode = 'P0001';
        end if;
        return jsonb_build_object('replayed', true, 'advancement_id', v_prev.id, 'generation', v_prev.generation,
          'heat_id', (select l.heat_id from public.event_competition_round_advancement_heats l where l.advancement_id = v_prev.id limit 1),
          'floor_heat_id', (select l.floor_heat_id from public.event_competition_round_advancement_heats l where l.advancement_id = v_prev.id limit 1),
          'entry_count', v_prev.advanced_count - v_prev.carried_count, 'carried', v_prev.carried_count);
      end if;
      raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_result_events e where e.request_id = p_request_id) then
      raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
    end if;

    -- 2: the source round.
    select * into v_prog from public.event_competition_programs p where p.id = v_src.program_id;
    if v_src.status not in ('approved', 'published') or v_src.round_type <> 'preliminary' or v_prog.advancement_method <> 'promote_callback' or v_tgt.id is null then
      raise exception 'COMP_ADVANCEMENT_SOURCE_STATE: only an approved callback round with a Final can advance (round is %).', v_src.status using errcode = 'P0001';
    end if;
    if public._cf1_active_advancement(v_tgt.id) is not null then
      raise exception 'COMP_ADVANCEMENT_ALREADY_APPLIED: this callback result has already been advanced.' using errcode = 'P0001';
    end if;
    -- 3: the latest approved version, not stale.
    select * into v_ver from public.event_competition_result_versions rv where rv.id = p_result_version_id and rv.round_id = p_round_id for update;
    if not found or v_ver.status <> 'approved'
       or v_ver.version <> (select max(rv.version) from public.event_competition_result_versions rv where rv.round_id = p_round_id and rv.status = 'approved')
       or v_ver.engine_key not like '%callback_tally%' then
      raise exception 'COMP_RESULT_STALE: this is not the latest approved callback result version.' using errcode = 'P0001';
    end if;
    if v_ver.input_hash is distinct from public._compf2_input_hash(p_round_id, v_ver.engine_key, v_ver.engine_version) then
      raise exception 'COMP_RESULT_STALE: the ballots changed after this calculation; recalculate before advancing.' using errcode = 'P0001';
    end if;
    -- 4: no undecided row.
    if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is null) then
      raise exception 'COMP_ADVANCEMENT_BLOCKED: this callback result is blocked (a tie over the Final''s capacity).' using errcode = 'P0001';
    end if;
    -- 5: the Final round, the live version, placement mode, existing heats.
    if v_tgt.status not in ('draft', 'scheduled') or v_tgt.round_type <> 'final' or (v_tgt.event_id, v_tgt.program_id, v_tgt.division_id) is distinct from (v_src.event_id, v_src.program_id, v_src.division_id) then
      raise exception 'COMP_ADVANCEMENT_TARGET_ROUND_STATE: the Final is already running, finished or cancelled (round is %).', v_tgt.status using errcode = 'P0001';
    end if;
    v_live := public._compo1_live_version(v_src.event_id);
    if v_live is null then
      raise exception 'COMP_ADVANCEMENT_NO_LIVE_VERSION: no schedule has been published; publish the running order before advancing.' using errcode = 'P0001';
    end if;
    perform 1 from public.event_competition_schedule_versions sv where sv.id = v_live for key share;
    select * into v_live_floor from public.event_competition_floor_heats f where f.schedule_version_id = v_live order by f.heat_number desc limit 1;
    if v_live_floor.id is null then
      raise exception 'COMP_ADVANCEMENT_FINAL_PLACEMENT_MODE: the published schedule is time-block based; a Final cannot be added automatically.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_heats h where h.round_id = v_tgt.id and h.status <> 'cancelled'
               and (h.schedule_version_id is null or h.schedule_version_id = v_live)) then
      raise exception 'COMP_ADVANCEMENT_FINAL_HEATS_PRESENT: a Final heat already exists; an existing heat cannot be reused.' using errcode = 'P0001';
    end if;
    select count(distinct hd.dance_key) into v_dances from public.event_competition_heat_dances hd
    join public.event_competition_heats h on h.id = hd.heat_id
    where h.round_id = p_round_id and h.status <> 'cancelled' and hd.status <> 'cancelled';
    if v_dances <> 1 then
      raise exception 'COMP_ADVANCEMENT_MULTI_DANCE: the callback round must have exactly one dance (found %).', v_dances using errcode = 'P0001';
    end if;
    -- 6: counts, capacity.
    select coalesce(array_agg(rr.entry_id order by rr.entry_id), '{}') into v_ids from public.event_competition_result_rows rr
    where rr.result_version_id = v_ver.id and rr.advanced is true;
    v_n := cardinality(v_ids);
    select coalesce(jsonb_agg(jsonb_build_object('entry_id', w.entry_id, 'withdrawal_id', w.withdrawal_id)), '[]'::jsonb), count(*)
      into v_carried, v_c from public._cf1_withdrawn_entries(v_tgt.id) w where w.entry_id = any (v_ids);
    v_cap := coalesce(nullif(v_tgt.configuration->>'max_entries_per_heat', '')::integer, 8);
    if v_n - v_c < 1 then
      raise exception 'COMP_ADVANCEMENT_BELOW_MINIMUM: no couple would be on the Final.' using errcode = 'P0001';
    end if;
    if v_n - v_c > v_cap then
      raise exception 'COMP_ADVANCEMENT_OVER_CAPACITY: % couples do not fit a Final heat of %.', v_n - v_c, v_cap using errcode = 'P0001';
    end if;
    -- 7: lock the roster entries (id order, unfiltered), then revalidate in a fresh statement.
    select coalesce(array_agg(x order by x), '{}') into v_roster from unnest(v_ids) x where x not in (select w.entry_id from public._cf1_withdrawn_entries(v_tgt.id) w);
    perform 1 from public.event_competition_entries e where e.id = any (v_roster) order by e.id for share;
    select jsonb_agg(jsonb_build_object('entry_id', e.id, 'reason', coalesce(public._cf1_entry_unavailable_reason(e.id), 'wrong_scope'))) into v_bad
    from public.event_competition_entries e
    where e.id = any (v_roster)
      and (public._cf1_entry_unavailable(e.id) or (e.event_id, e.program_id, e.division_id) is distinct from (v_src.event_id, v_src.program_id, v_src.division_id));
    if v_bad is not null then
      raise exception 'COMP_ADVANCEMENT_ENTRY_UNAVAILABLE: an advanced couple is no longer eligible.' using errcode = 'P0001', detail = jsonb_build_object('entries', v_bad)::text;
    end if;
    if public._cf1_is_callback_final(v_tgt.id) and public._cf1_count_available_entries(v_roster) < 2 then
      raise exception 'COMP_ADVANCEMENT_BELOW_MINIMUM: a callback Final needs at least two eligible couples.' using errcode = 'P0001';
    end if;

    -- Writes. The advancement row is the A-apply authorizer for everything below.
    select coalesce(max(a.generation), 0) + 1 into v_gen from public.event_competition_round_advancements a where a.source_round_id = p_round_id;
    insert into public.event_competition_round_advancements
      (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id, source_input_hash, source_trace_hash,
       advanced_count, carried_count, target_capacity, applied_by, request_id)
    values (v_src.event_id, v_src.program_id, v_src.division_id, p_round_id, v_tgt.id, v_gen, v_ver.id, v_ver.input_hash, v_ver.trace_hash,
            v_n, v_c, v_cap, v_uid, p_request_id)
    returning id into v_adv;
    insert into public.event_competition_round_advancement_entries (advancement_id, event_id, division_id, entry_id, tally, carried_withdrawal_id)
    select v_adv, v_src.event_id, v_src.division_id, rr.entry_id, rr.output, w.withdrawal_id
    from public.event_competition_result_rows rr
    left join public._cf1_withdrawn_entries(v_tgt.id) w on w.entry_id = rr.entry_id
    where rr.result_version_id = v_ver.id and rr.advanced is true;

    select * into v_div from public.event_competition_divisions d where d.id = v_src.division_id;
    select coalesce(max(f.heat_number), 0) + 1 into v_floor_number from public.event_competition_floor_heats f where f.schedule_version_id = v_live;
    insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number, floor_id)
    values (v_src.event_id, v_live, v_floor_number, v_live_floor.floor_id)
    returning id into v_floor;
    select coalesce(max(h.heat_number), 0) + 1 into v_heat_number from public.event_competition_heats h where h.round_id = v_tgt.id;
    select h.* into v_src_heat from public.event_competition_heats h
    where h.round_id = p_round_id and h.status <> 'cancelled' order by h.heat_number, h.id limit 1;
    insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, name, contest_id, schedule_version_id, floor_heat_id, status, division_dance_id)
    values (v_src.event_id, v_src.division_id, v_tgt.id, v_heat_number, v_tgt.name, v_div.contest_id, v_live, v_floor, 'scheduled', v_src_heat.division_dance_id)
    returning id into v_heat;
    insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number, duration_seconds)
    select hd.event_id, v_heat, hd.dance_id, hd.dance_key, hd.dance_label, 1, hd.duration_seconds
    from public.event_competition_heat_dances hd
    where hd.heat_id = v_src_heat.id and hd.status <> 'cancelled' order by hd.sequence_number limit 1;
    -- OD-7: numeric entry numbers ascending, then non-numeric (C collation), then unnumbered; entry id breaks ties.
    insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
    select v_src.event_id, v_src.division_id, v_heat, o.id,
           (row_number() over (order by o.grp, o.num, o.txt collate "C", o.id))::integer
    from (
      select e.id,
             case when n.v ~ '^[0-9]+$' then 0 when n.v is not null then 1 else 2 end as grp,
             case when n.v ~ '^[0-9]+$' then n.v::numeric end as num,
             case when n.v is not null and n.v !~ '^[0-9]+$' then n.v end as txt
      from public.event_competition_entries e
      cross join lateral (select nullif(btrim(e.entry_number), '') as v) n
      where e.id = any (v_roster)
    ) o;
    insert into public.event_competition_round_advancement_heats (advancement_id, event_id, heat_id, floor_heat_id)
    values (v_adv, v_src.event_id, v_heat, v_floor);

    for v_problem in select * from public._comp10d_floor_heat_problems(v_floor) loop
      if v_problem.problem = 'competitor_conflict' then
        raise exception 'COMP_ADVANCEMENT_FINAL_COMPETITOR_CONFLICT: two advanced couples share a dancer; resolve it through the correction path.' using errcode = 'P0001', detail = v_problem.detail;
      end if;
      raise exception 'COMP_ADVANCEMENT_FLOOR_HEAT_PROBLEM: %', v_problem.problem using errcode = 'P0001', detail = v_problem.detail;
    end loop;

    perform public._compf2_event(v_src.event_id, p_round_id, v_ver.id, 'advancement_applied', v_uid, null, null, p_request_id, null,
      jsonb_build_object('advancement_id', v_adv, 'generation', v_gen, 'source_result_version_id', v_ver.id, 'entry_count', v_n - v_c,
        'heat_ids', jsonb_build_array(v_heat), 'request_id', p_request_id, 'path', 'create', 'floor_heat_id', v_floor, 'floor_heat_number', v_floor_number,
        'carried_withdrawals', v_carried));
    return jsonb_build_object('replayed', false, 'advancement_id', v_adv, 'generation', v_gen, 'heat_id', v_heat, 'floor_heat_id', v_floor,
      'entry_count', v_n - v_c, 'carried', v_c);
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: someone changed this round or schedule at the same moment; nothing was changed. Try again.' using errcode = '55P03';
  end;
end;
$$;
revoke all on function public.apply_competition_round_advancement(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.apply_competition_round_advancement(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Triggers (the functions above). ENABLE ALWAYS so they fire under session_replication_role = replica.
-- ---------------------------------------------------------------------------
revoke all on function public.cf1_guard_final_heat_insert(), public.cf1_guard_final_heat_status(), public.cf1_guard_final_heat_identity(),
  public.cf1_guard_final_heat_entry(), public.cf1_guard_final_heat_dance(), public.cf1_check_final_single_live_heat(),
  public.cf1_check_one_active_advancement(), public.cf1_guard_publish_final_heats(), public.cf1_guard_final_start(),
  public.cf1_guard_advancement_approval(), public._cf1_revoke_advancement(uuid, text, text), public.cf1_guard_advancement_correction()
  from public, anon, authenticated, service_role;

create trigger cf1_guard_final_heat_insert before insert on public.event_competition_heats
  for each row execute function public.cf1_guard_final_heat_insert();
create trigger cf1_guard_final_heat_status before update of status on public.event_competition_heats
  for each row execute function public.cf1_guard_final_heat_status();
create trigger cf1_guard_final_heat_identity
  before update of round_id, division_id, event_id, contest_id, schedule_version_id, floor_heat_id, schedule_block_id on public.event_competition_heats
  for each row execute function public.cf1_guard_final_heat_identity();
create trigger cf1_guard_final_heat_entry before insert or update of heat_id, entry_id on public.event_competition_heat_entries
  for each row execute function public.cf1_guard_final_heat_entry();
create trigger cf1_guard_final_heat_dance before insert or update of heat_id, dance_id, status, sequence_number, dance_key or delete on public.event_competition_heat_dances
  for each row execute function public.cf1_guard_final_heat_dance();
create constraint trigger cf1_check_final_single_live_heat after insert or update of status, schedule_version_id, round_id on public.event_competition_heats
  deferrable initially deferred for each row execute function public.cf1_check_final_single_live_heat();
create constraint trigger cf1_check_one_active_advancement after insert on public.event_competition_round_advancements
  deferrable initially deferred for each row execute function public.cf1_check_one_active_advancement();
create trigger cf1_guard_publish_final_heats before insert or update of status on public.event_competition_schedule_versions
  for each row execute function public.cf1_guard_publish_final_heats();
create trigger cf1_guard_final_start before update of status on public.event_competition_rounds
  for each row when (old.status = 'scheduled' and new.status = 'active') execute function public.cf1_guard_final_start();
create trigger cf1_guard_advancement_approval before update of status on public.event_competition_result_versions
  for each row when (old.status = 'calculated' and new.status = 'approved') execute function public.cf1_guard_advancement_approval();
create trigger cf1_guard_advancement_correction after update of status on public.event_competition_rounds
  for each row when (new.status = 'ballots_locked' and new.correction_open) execute function public.cf1_guard_advancement_correction();

alter table public.event_competition_heats enable always trigger cf1_check_final_single_live_heat;
alter table public.event_competition_round_advancements enable always trigger cf1_check_one_active_advancement;
alter table public.event_competition_heats enable always trigger cf1_guard_final_heat_insert;
alter table public.event_competition_heats enable always trigger cf1_guard_final_heat_status;
alter table public.event_competition_heats enable always trigger cf1_guard_final_heat_identity;
alter table public.event_competition_heat_entries enable always trigger cf1_guard_final_heat_entry;
alter table public.event_competition_heat_dances enable always trigger cf1_guard_final_heat_dance;
alter table public.event_competition_schedule_versions enable always trigger cf1_guard_publish_final_heats;
alter table public.event_competition_rounds enable always trigger cf1_guard_final_start;
alter table public.event_competition_result_versions enable always trigger cf1_guard_advancement_approval;
alter table public.event_competition_rounds enable always trigger cf1_guard_advancement_correction;

-- ---------------------------------------------------------------------------
-- 9. Pinned redefinitions (text-replace on the installed bodies; anchors must occur exactly once).
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_anchor text;
  v_new text;
  procedure_sig text;
  v_count integer;
begin
  -- complete_competition_round: pass when an active advancement of this approved version exists.
  v_def := replace(pg_get_functiondef('public.complete_competition_round(uuid,uuid)'::regprocedure), E'\r', '');
  v_anchor := $q$  if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is true) then$q$;
  v_new := $q$  if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is true)
     and not exists (select 1 from public.event_competition_round_advancements a
                     where a.source_round_id = p_round_id and a.source_result_version_id = v_ver.id
                       and not exists (select 1 from public.event_competition_round_advancement_revocations rv where rv.advancement_id = a.id)) then$q$;
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'CF1-A0: complete_competition_round anchor occurs % times', v_count; end if;
  execute replace(v_def, v_anchor, v_new);

  -- competition_audit_log: capacity events branch.
  v_def := replace(pg_get_functiondef('public.competition_audit_log(uuid,uuid,integer)'::regprocedure), E'\r', '');
  v_anchor := E'    '' || v_o1 || ''\n  ) u';
  v_new := E'    '' || v_o1 || ''\n    union all\n    select c.at, ''''capacity'''', ''''capacity_changed'''', c.actor, c.round_id, null::text, null::text, c.reason,\n           jsonb_build_object(''''old_capacity'''', c.old_capacity, ''''new_capacity'''', c.new_capacity, ''''exemption'''', c.exemption, ''''target_t'''', c.target_t), c.id\n    from public.event_competition_round_capacity_events c\n    where c.event_id = $1 and ($2 is null or c.round_id = $2)\n  ) u';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'CF1-A0: competition_audit_log anchor occurs % times', v_count; end if;
  execute replace(v_def, v_anchor, v_new);

  -- 10D floor-heat guard: the floor-heat INSERT of apply (event + live version + append).
  v_def := replace(pg_get_functiondef('public._comp10d_guard_floor_heat()'::regprocedure), E'\r', '');
  v_anchor := $q$  if tg_op in ('INSERT', 'UPDATE') and not public._comp10d_version_editable(new.event_id, new.schedule_version_id) then$q$;
  v_new := $q$  if tg_op in ('INSERT', 'UPDATE') and not public._comp10d_version_editable(new.event_id, new.schedule_version_id)
     and not (tg_op = 'INSERT' and public._cf1_auth_apply_floor_heat(new.event_id, new.schedule_version_id, new.heat_number)) then$q$;
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'CF1-A0: _comp10d_guard_floor_heat anchor occurs % times', v_count; end if;
  execute replace(v_def, v_anchor, v_new);

  -- 10D child guard: the first (new-heat) published-version check passes under A-apply (the old-heat check below it is unchanged).
  v_def := replace(pg_get_functiondef('public._comp10d_guard_heat_child()'::regprocedure), E'\r', '');
  v_anchor := E'\n  if v_version is not null and not public._comp10d_version_editable(v_event, v_version) then';
  v_new := E'\n  if v_version is not null and not public._comp10d_version_editable(v_event, v_version) and not public._cf1_auth_apply_heat(v_heat_id) then';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'CF1-A0: _comp10d_guard_heat_child anchor occurs % times', v_count; end if;
  execute replace(v_def, v_anchor, v_new);

  -- 10D placement validator: a non-draft version passes under A-apply.
  v_def := replace(pg_get_functiondef('public.validate_competition_heat_schedule_placement()'::regprocedure), E'\r', '');
  v_anchor := $q$  if version_status is distinct from 'draft' then$q$;
  v_new := $q$  if version_status is distinct from 'draft' and not public._cf1_auth_apply(new.round_id) then$q$;
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'CF1-A0: validate_competition_heat_schedule_placement anchor occurs % times', v_count; end if;
  execute replace(v_def, v_anchor, v_new);
end $$;

-- _comp10d_copy_floor_plan (full replacement of the pinned body): skip heats of a Final that has any advancement row, omit and
-- renumber floor heats that lose all their scoring heats, and pre-lock the callback and Final rounds FOR KEY SHARE in canonical order.
create or replace function public._comp10d_copy_floor_plan(p_source_version_id uuid, p_new_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_floor record;
  v_heat record;
  v_new_floor uuid;
  v_new_heat uuid;
  v_event uuid;
  v_omitted integer := 0;
begin
  select event_id into v_event from public.event_competition_schedule_versions
  where id = p_new_version_id and status = 'draft'
    and event_id = (select event_id from public.event_competition_schedule_versions where id = p_source_version_id);
  if v_event is null or not (public.can_manage_event_competition(v_event) or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'COMP10D_NOT_FOUND: schedule versions were not found or cannot be managed.';
  end if;
  -- CF1: the rounds an advancement connects, in the canonical (division_id, sequence_number) order, before any heat is read.
  perform 1 from public.event_competition_rounds r
  where r.event_id = v_event
    and (public._cf1_callback_successor(r.id) is not null or public._cf1_callback_source(r.id) is not null)
  order by r.division_id, r.sequence_number, r.id
  for key share;
  for v_floor in
    select * from public.event_competition_floor_heats where schedule_version_id = p_source_version_id order by heat_number
  loop
    if exists (select 1 from public.event_competition_heats h where h.floor_heat_id = v_floor.id and h.status <> 'cancelled')
       and not exists (select 1 from public.event_competition_heats h
                       where h.floor_heat_id = v_floor.id and h.status <> 'cancelled'
                         and not exists (select 1 from public.event_competition_round_advancements a where a.target_round_id = h.round_id)) then
      v_omitted := v_omitted + 1;
      continue;
    end if;
    insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number, floor_id, planned_start_at, planned_duration_seconds, notes)
    values (v_floor.event_id, p_new_version_id, v_floor.heat_number - v_omitted, v_floor.floor_id, v_floor.planned_start_at, v_floor.planned_duration_seconds, v_floor.notes)
    returning id into v_new_floor;
    for v_heat in
      select * from public.event_competition_heats h
      where h.floor_heat_id = v_floor.id and h.status <> 'cancelled'
        and not exists (select 1 from public.event_competition_round_advancements a where a.target_round_id = h.round_id)
      order by h.created_at, h.id
    loop
      insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, name, contest_id, schedule_version_id, floor_heat_id, status, configuration)
      values (v_heat.event_id, v_heat.division_id, v_heat.round_id, v_heat.heat_number, v_heat.name, v_heat.contest_id, p_new_version_id, v_new_floor, 'scheduled', v_heat.configuration)
      returning id into v_new_heat;
      insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number, duration_seconds)
      select event_id, v_new_heat, dance_id, dance_key, dance_label, sequence_number, duration_seconds
      from public.event_competition_heat_dances where heat_id = v_heat.id and status <> 'cancelled';
      insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
      select he.event_id, he.division_id, v_new_heat, he.entry_id, he.floor_order
      from public.event_competition_heat_entries he
      join public.event_competition_entries e on e.id = he.entry_id
      where he.heat_id = v_heat.id and he.status <> 'scratched'
        and e.status = 'confirmed' and e.eligibility_status <> 'ineligible';
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9b. The pinned functions keep their original owner, which can differ from the role applying this migration (e.g. postgres vs
-- supabase_admin). They call the _cf1_* readers/authorizers below, which are revoked from everyone: grant the owners explicitly.
-- ---------------------------------------------------------------------------
do $own$
declare
  v_owner name;
begin
  for v_owner in
    select distinct pg_get_userbyid(p.proowner) from pg_proc p
    where p.oid in ('public._comp10d_copy_floor_plan(uuid,uuid)'::regprocedure, 'public._comp10d_guard_floor_heat()'::regprocedure,
                    'public._comp10d_guard_heat_child()'::regprocedure, 'public.validate_competition_heat_schedule_placement()'::regprocedure,
                    'public.complete_competition_round(uuid,uuid)'::regprocedure, 'public.competition_audit_log(uuid,uuid,integer)'::regprocedure,
                    'public.set_competition_round_heat_capacity(uuid,integer)'::regprocedure)
  loop
    if v_owner::text <> current_user then
      execute format('grant execute on function public._cf1_callback_successor(uuid), public._cf1_callback_source(uuid), public._cf1_auth_apply(uuid), public._cf1_auth_apply_heat(uuid), public._cf1_auth_apply_floor_heat(uuid, uuid, integer) to %I', v_owner);
    end if;
  end loop;
end $own$;

-- ---------------------------------------------------------------------------
-- 10. Postflight.
-- ---------------------------------------------------------------------------
do $$
declare
  v_t text;
begin
  foreach v_t in array array[
    'cf1_guard_final_heat_insert', 'cf1_guard_final_heat_status', 'cf1_guard_final_heat_identity', 'cf1_guard_final_heat_entry',
    'cf1_guard_final_heat_dance', 'cf1_guard_publish_final_heats', 'cf1_guard_final_start', 'cf1_guard_advancement_approval',
    'cf1_guard_advancement_correction', 'cf1_guard_round_capacity', 'cf1_guard_callback_target_capacity', 'cf1_guard_callback_target_program_lock',
    'cf1_check_final_single_live_heat', 'cf1_check_one_active_advancement']
  loop
    if not exists (select 1 from pg_trigger t where t.tgname = v_t and not t.tgisinternal and t.tgenabled = 'A') then
      raise exception 'CF1-A0 postflight: trigger % is missing or not ENABLE ALWAYS.', v_t;
    end if;
  end loop;
  foreach v_t in array array[
    'event_competition_round_advancements', 'event_competition_round_advancement_entries', 'event_competition_round_advancement_heats',
    'event_competition_round_advancement_revocations', 'event_competition_final_withdrawals', 'event_competition_round_capacity_events']
  loop
    if exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name = v_t and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))
       or has_table_privilege('anon', ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('authenticated', ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('service_role', ('public.' || v_t)::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception 'CF1-A0 postflight: table % has a grant.', v_t;
    end if;
  end loop;
  foreach v_t in array array[
    'public.apply_competition_round_advancement(uuid,uuid,uuid)', 'public.competition_round_advancement_preview(uuid)',
    'public.set_competition_round_heat_capacity(uuid,integer,text,uuid)']
  loop
    if has_function_privilege('anon', v_t, 'EXECUTE') or has_function_privilege('service_role', v_t, 'EXECUTE') or not has_function_privilege('authenticated', v_t, 'EXECUTE') then
      raise exception 'CF1-A0 postflight: % must be executable by authenticated only.', v_t;
    end if;
  end loop;
end $$;

commit;
