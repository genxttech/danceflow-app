-- 20261107090000_phase10a_competition_foundation_reconcile.sql
--
-- PHASE 10 -- 10A: Competition Foundation Reconciliation.
--
-- The June-2026 Competition OS foundation (20260620_* .. 20260622_*) is deployed on DEV
-- and PROD, but parts of it were never captured in the repository, and it has known
-- integrity defects. This migration reconciles and hardens it. It does NOT add any new
-- competition capability (no competitors, officials, ballots, scoring or results).
--
-- Read-only comparison before authoring (2026-10-09): DEV and PROD are identical for all
-- 41 competition tables (columns, constraints, indexes, policies, triggers, RLS, ACLs) and
-- all 34 competition functions (bodies, SECURITY DEFINER, search_path, ACLs). None of the
-- 2026-06 files appear in supabase_migrations.schema_migrations on either database (they
-- were applied by hand). PROD holds no competition data beyond the global seeds
-- (3 configuration templates, 6 WSDC tier rules).
--
-- Section A -- CAPTURED EXISTING OBJECTS (deployed on DEV and PROD, absent from the repo).
--   Created only when absent, with the exact deployed definitions. Existing objects and
--   their data are never rewritten. The rollback never removes these objects.
--     tables  event_competition_schedule_versions / _floors / _sessions / _blocks /
--             _block_contests (+ constraints, indexes, RLS, policies, triggers, grants,
--             comments)
--     funcs   create_competition_schedule_version(uuid, text, uuid)
--             validate_competition_schedule_item()   (replaced by the B6 fix below)
--
-- Section B -- NEW 10A HARDENING (reverted by the rollback file).
--   B1  Public registration catalog policies. competition_contests_public_registration_read
--       compared r.contest_id = r.id (never true: anonymous visitors could not see any
--       contest) and competition_divisions_public_registration_read compared
--       r.contest_id = r.contest_id (always true: open divisions of ANY event, including
--       draft/private events, were readable whenever any public event had open
--       registration). All four catalog policies are rewritten fully qualified and
--       explicitly scoped to the row's own event, published + public/unlisted +
--       registration_required, mirroring what the service-role checkout accepts.
--   B2  event_competition_entry_changes becomes append-only evidence: the authenticated
--       INSERT policy is dropped, write privileges are revoked from anon, authenticated
--       and service_role, UPDATE / DELETE / TRUNCATE are refused by trigger (DELETE is
--       allowed only as the cascade of a deleted event), and the audit trigger runs
--       SECURITY DEFINER so history is produced only by entry mutations. The entry_id and
--       performed_by FKs (ON DELETE SET NULL, which rewrote evidence) are dropped; the ids
--       stay as plain values. This also fixes two deployed defects: deleting an entry
--       always failed because its own audit row referenced the deleted entry, and deleting
--       an event with entries always failed because the cascade wrote audit rows for the
--       deleted event (the audit trigger now skips that cascade; the event's history is
--       removed with it).
--   B3  Heat lock override. The session GUC app.competition_heat_override let any
--       transaction that set it rewrite locked/certified heats and their entries/dances.
--       It is no longer honoured. set_competition_heat_lock_state(uuid, text, text) is a
--       role-checked SECURITY DEFINER RPC that records an append-only
--       event_competition_heat_lock_events row (actor, reason, from/to state, transaction);
--       the heat trigger accepts a locked-heat update only when that row exists for the
--       same heat, from/to state and transaction, and only lock columns change.
--       Reopening a locked heat requires a
--       reason; certified heats still cannot be reopened. Locked heat entries/dances
--       cannot be changed at all (no legitimate path used the bypass).
--   B4  can_manage_event_competition(uuid): the events.created_by branch is removed (the
--       application guard never granted creator-only access; a creator who lost their
--       studio/organizer role kept full database authority). Anonymous EXECUTE is revoked.
--   B5  Grant posture of competition SECURITY DEFINER functions: anonymous EXECUTE revoked
--       from apply_competition_configuration_template and restart_event_competition_setup;
--       default_competition_registration_rule (no authorization check -- anyone could
--       create a registration rule for any contest) and the definer trigger functions are
--       no longer executable by anon/authenticated. restart_event_competition_setup gets
--       search_path = public, pg_temp.
--   B6  validate_competition_schedule_item(): the deployed trigger read new.session_id on
--       every schedule table, but only _blocks has that column, so every insert/update/
--       delete of a schedule session or block contest failed ("record new has no field
--       session_id"). It now reads session_id only where it exists, and lets the cascade
--       of a deleted schedule version through. Behaviour is otherwise unchanged.
--   B7  create_competition_generation_run, create_competition_heat_plan_run and
--       publish_competition_schedule_version call digest() unqualified, but pgcrypto lives
--       in the extensions schema, so every heat-plan run and schedule publication failed
--       ("function digest(bytea, unknown) does not exist"). Their pinned search_path gains
--       extensions (bodies unchanged).

begin;

-- ---------------------------------------------------------------------------
-- Preflight: exact reviewed pre-state (LF-normalised bodies; PROD stores CRLF)
-- ---------------------------------------------------------------------------
do $$
declare
  v_expected jsonb := jsonb_build_object(
    'audit_competition_entry_change()', '93bfe9c01797421a4c7315183505c38d',
    'protect_locked_competition_heat()', '0b4a5061cdee9da37cbf25cacab8e05d',
    'protect_locked_competition_heat_children()', 'ca203897c7f2a954317e96fae279e533',
    'set_competition_heat_lock_state(selected_heat_id uuid, selected_state text)', '4d6eb01fd4168ec20a7d49b11f2be1c0',
    'can_manage_event_competition(target_event_id uuid)', '64c046569d9bbb183ca514643595e3a7',
    'apply_competition_configuration_template(target_event_id uuid, selected_template_key text)', '2151aed6c09c93c8300558fb856391a2',
    'restart_event_competition_setup(target_event_id uuid, confirmation_text text)', '82dd257a7638258779c4febf82d8e665',
    'default_competition_registration_rule(target_contest_id uuid)', '104b6f4071eae004e80eee9e72c33502',
    'create_default_competition_registration_rule()', '54f1b2a89967be46dcfd99bc5235b815',
    'sync_competition_entries_from_registration()', 'fabd4052257f261e300ccc1f191c4cdb',
    'sync_competition_registration_cart_from_order()', '2b35c78252cd886caee8d901fb73837b'
  );
  v_key text;
  v_actual text;
  v_policy_md5 text;
begin
  for v_key in select jsonb_object_keys(v_expected) loop
    select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = v_key;
    if v_actual is distinct from v_expected->>v_key then
      raise exception 'Phase 10A preflight: % body is % (expected %); re-review before applying.',
        v_key, coalesce(v_actual, 'missing'), v_expected->>v_key;
    end if;
  end loop;

  -- Captured schedule objects: either absent (fresh database) or exactly as reviewed.
  if to_regprocedure('public.validate_competition_schedule_item()') is not null then
    select md5(replace(prosrc, E'\r\n', E'\n')) into v_actual
    from pg_proc where oid = 'public.validate_competition_schedule_item()'::regprocedure;
    if v_actual <> '12e32eea6529b5fef6fceabbf0e0e1cd' then
      raise exception 'Phase 10A preflight: validate_competition_schedule_item() body % is unexpected.', v_actual;
    end if;
  end if;
  if to_regprocedure('public.create_competition_schedule_version(uuid, text, uuid)') is not null then
    select md5(replace(prosrc, E'\r\n', E'\n')) into v_actual
    from pg_proc where oid = 'public.create_competition_schedule_version(uuid, text, uuid)'::regprocedure;
    if v_actual <> 'd8b91e2db9b24119e6b485ed26941c86' then
      raise exception 'Phase 10A preflight: create_competition_schedule_version body % is unexpected.', v_actual;
    end if;
  end if;
  if to_regclass('public.event_competition_schedule_versions') is not null then
    select md5(string_agg(c.relname || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
             || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' order by c.relname, a.attnum))
    into v_actual
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relname in ('event_competition_schedule_versions', 'event_competition_schedule_floors',
      'event_competition_schedule_sessions', 'event_competition_schedule_blocks',
      'event_competition_schedule_block_contests');
    if v_actual <> '7c92337b5cf95b2a8f2de1b76eaaf3d7' then
      raise exception 'Phase 10A preflight: captured schedule table columns fingerprint % is unexpected.', v_actual;
    end if;
  end if;

  -- Public catalog policies: still the reviewed (defective) definitions.
  for v_key, v_actual in
    select * from (values
      ('event_competition_contests.competition_contests_public_registration_read', '3ed9e4942c58943f43ba236ca772cf08'),
      ('event_competition_divisions.competition_divisions_public_registration_read', 'c7b082d7a0c78932141b3da717e39ae3'),
      ('event_competition_dances.competition_dances_public_registration_read', '3a6a5b4daf22f466597735943751e581'),
      ('event_competition_division_dances.competition_division_dances_public_registration_read', 'cbf7db4f647a5265d763d843067477df'),
      ('event_competition_entry_changes.competition_history_insert', 'e070aca9432ca6fed68f64ff28db5543')
    ) as expected(policy_key, policy_md5)
  loop
    select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_policy_md5
    from pg_policies
    where schemaname = 'public' and tablename || '.' || policyname = v_key;
    if v_policy_md5 is distinct from v_actual then
      raise exception 'Phase 10A preflight: policy % is % (expected %).', v_key, coalesce(v_policy_md5, 'missing'), v_actual;
    end if;
  end loop;

  if to_regclass('public.event_competition_heat_lock_events') is not null then
    raise exception 'Phase 10A preflight: event_competition_heat_lock_events already exists.';
  end if;

  if exists (
    select 1 from pg_proc
    where oid in ('public.create_competition_generation_run(uuid, uuid, text, uuid)'::regprocedure,
                  'public.create_competition_heat_plan_run(uuid, uuid, text, text, jsonb)'::regprocedure,
                  'public.publish_competition_schedule_version(uuid)'::regprocedure)
      and proconfig is distinct from array['search_path=public, pg_temp']
  ) then
    raise exception 'Phase 10A preflight: digest caller search_path is not the reviewed public, pg_temp.';
  end if;
end $$;

-- ===========================================================================
-- Section A -- CAPTURED EXISTING OBJECTS (exact deployed definitions; create if absent)
-- ===========================================================================

create table if not exists public.event_competition_schedule_versions (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  version_number integer not null,
  name text not null,
  status text not null default 'draft'::text,
  based_on_version_id uuid,
  notes text,
  published_at timestamp with time zone,
  published_by uuid,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint event_competition_schedule_versions_pkey primary key (id),
  constraint event_competition_schedule_versions_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_competition_schedule_versions_based_on_version_id_fkey
    foreign key (based_on_version_id) references public.event_competition_schedule_versions(id) on delete set null,
  constraint event_competition_schedule_versions_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  constraint event_competition_schedule_versions_published_by_fkey
    foreign key (published_by) references auth.users(id) on delete set null,
  constraint event_competition_schedule_versions_event_id_version_number_key unique (event_id, version_number),
  constraint event_competition_schedule_versions_id_event_id_key unique (id, event_id),
  constraint event_competition_schedule_versions_name_check
    check (((length(btrim(name)) >= 1) and (length(btrim(name)) <= 160))),
  constraint event_competition_schedule_versions_number_check check ((version_number > 0)),
  constraint event_competition_schedule_versions_status_check
    check ((status = any (array['draft'::text, 'review'::text, 'published'::text, 'live'::text, 'superseded'::text, 'archived'::text]))),
  constraint event_competition_schedule_versions_publication_check
    check ((((status = any (array['published'::text, 'live'::text, 'superseded'::text])) and (published_at is not null))
      or (status = any (array['draft'::text, 'review'::text, 'archived'::text]))))
);
create index if not exists event_competition_schedule_versions_event_idx
  on public.event_competition_schedule_versions using btree (event_id, version_number desc);
create unique index if not exists event_competition_schedule_one_live_idx
  on public.event_competition_schedule_versions using btree (event_id) where (status = 'live'::text);

create table if not exists public.event_competition_schedule_floors (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  name text not null,
  location_label text,
  capacity integer not null default 1,
  active boolean not null default true,
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint event_competition_schedule_floors_pkey primary key (id),
  constraint event_competition_schedule_floors_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_competition_schedule_floors_event_id_name_key unique (event_id, name),
  constraint event_competition_schedule_floors_id_event_id_key unique (id, event_id),
  constraint event_competition_schedule_floors_capacity_check check ((capacity > 0)),
  constraint event_competition_schedule_floors_name_check
    check (((length(btrim(name)) >= 1) and (length(btrim(name)) <= 120)))
);

create table if not exists public.event_competition_schedule_sessions (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  schedule_version_id uuid not null,
  name text not null,
  session_date date not null,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  status text not null default 'draft'::text,
  sort_order integer not null default 0,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint event_competition_schedule_sessions_pkey primary key (id),
  constraint event_competition_schedule_sessions_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_competition_schedule_sessions_version_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete cascade,
  constraint event_competition_schedule_sessions_id_event_id_key unique (id, event_id),
  constraint event_competition_schedule_se_id_schedule_version_id_event__key unique (id, schedule_version_id, event_id),
  constraint event_competition_schedule_sessions_name_check
    check (((length(btrim(name)) >= 1) and (length(btrim(name)) <= 160))),
  constraint event_competition_schedule_sessions_status_check
    check ((status = any (array['draft'::text, 'scheduled'::text, 'active'::text, 'complete'::text, 'cancelled'::text]))),
  constraint event_competition_schedule_sessions_time_check check ((ends_at > starts_at))
);
create index if not exists event_competition_schedule_sessions_version_idx
  on public.event_competition_schedule_sessions using btree (schedule_version_id, starts_at, sort_order);

create table if not exists public.event_competition_schedule_blocks (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  schedule_version_id uuid not null,
  session_id uuid not null,
  floor_id uuid,
  floor_name_snapshot text,
  floor_capacity_snapshot integer,
  name text not null,
  block_type text not null,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  status text not null default 'draft'::text,
  locked boolean not null default false,
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint event_competition_schedule_blocks_pkey primary key (id),
  constraint event_competition_schedule_blocks_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_competition_schedule_blocks_version_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete cascade,
  constraint event_competition_schedule_blocks_session_fk
    foreign key (session_id, schedule_version_id, event_id)
    references public.event_competition_schedule_sessions(id, schedule_version_id, event_id) on delete cascade,
  constraint event_competition_schedule_blocks_floor_fk
    foreign key (floor_id, event_id)
    references public.event_competition_schedule_floors(id, event_id) on delete restrict,
  constraint event_competition_schedule_blocks_id_event_id_key unique (id, event_id),
  constraint event_competition_schedule_bl_id_schedule_version_id_event__key unique (id, schedule_version_id, event_id),
  constraint event_competition_schedule_blocks_floor_capacity_check
    check (((floor_capacity_snapshot is null) or (floor_capacity_snapshot > 0))),
  constraint event_competition_schedule_blocks_name_check
    check (((length(btrim(name)) >= 1) and (length(btrim(name)) <= 180))),
  constraint event_competition_schedule_blocks_status_check
    check ((status = any (array['draft'::text, 'scheduled'::text, 'active'::text, 'complete'::text, 'cancelled'::text]))),
  constraint event_competition_schedule_blocks_time_check check ((ends_at > starts_at)),
  constraint event_competition_schedule_blocks_type_check
    check ((block_type = any (array['competition'::text, 'awards'::text, 'break'::text, 'meal'::text, 'showcase'::text,
      'workshop'::text, 'practice'::text, 'registration'::text, 'other'::text])))
);
create index if not exists event_competition_schedule_blocks_floor_idx
  on public.event_competition_schedule_blocks using btree (floor_id, starts_at) where (floor_id is not null);
create index if not exists event_competition_schedule_blocks_session_idx
  on public.event_competition_schedule_blocks using btree (session_id, starts_at, sort_order);

create table if not exists public.event_competition_schedule_block_contests (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  schedule_version_id uuid not null,
  block_id uuid not null,
  contest_id uuid not null,
  planned_round_type text,
  sort_order integer not null default 0,
  constraints jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint event_competition_schedule_block_contests_pkey primary key (id),
  constraint event_competition_schedule_block_contests_event_id_fkey
    foreign key (event_id) references public.events(id) on delete cascade,
  constraint event_competition_schedule_block_contests_block_fk
    foreign key (block_id, schedule_version_id, event_id)
    references public.event_competition_schedule_blocks(id, schedule_version_id, event_id) on delete cascade,
  constraint event_competition_schedule_block_contests_contest_fk
    foreign key (contest_id, event_id)
    references public.event_competition_contests(id, event_id) on delete cascade,
  constraint event_competition_schedule_bl_block_id_contest_id_planned_r_key
    unique (block_id, contest_id, planned_round_type),
  constraint event_competition_schedule_block_contests_round_check
    check (((planned_round_type is null) or (planned_round_type = any (array['qualifying'::text, 'preliminary'::text,
      'quarterfinal'::text, 'semifinal'::text, 'final'::text, 'proficiency'::text, 'feedback'::text, 'exhibition'::text,
      'all'::text, 'custom'::text]))))
);
create index if not exists event_competition_schedule_block_contests_block_idx
  on public.event_competition_schedule_block_contests using btree (block_id, sort_order, created_at);
create index if not exists event_competition_schedule_block_contests_contest_idx
  on public.event_competition_schedule_block_contests using btree (contest_id);
create unique index if not exists event_competition_schedule_block_contests_scope_uidx
  on public.event_competition_schedule_block_contests using btree (block_id, contest_id, coalesce(planned_round_type, 'all'::text));

-- Deployed body, captured verbatim (only created when absent).
do $capture$
begin
  if to_regprocedure('public.validate_competition_schedule_item()') is null then
    execute $fn$
create function public.validate_competition_schedule_item()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $body$
declare
  item_event_id uuid;
  item_version_id uuid;
  item_session_id uuid;
  session_start timestamptz;
  session_end timestamptz;
  version_status text;
  selected_floor_name text;
  selected_floor_capacity integer;
begin
  item_event_id := coalesce(new.event_id, old.event_id);
  item_version_id := coalesce(new.schedule_version_id, old.schedule_version_id);
  item_session_id := coalesce(new.session_id, old.session_id);

  select status into version_status
  from public.event_competition_schedule_versions
  where id = item_version_id and event_id = item_event_id;

  if version_status is distinct from 'draft' then
    raise exception 'Only draft schedule versions may be edited.';
  end if;

  if tg_table_name = 'event_competition_schedule_blocks' and tg_op <> 'DELETE' then
    select starts_at, ends_at into session_start, session_end
    from public.event_competition_schedule_sessions
    where id = item_session_id and schedule_version_id = item_version_id and event_id = item_event_id;

    if new.starts_at < session_start or new.ends_at > session_end then
      raise exception 'Schedule block must be contained within its session.';
    end if;

    if new.floor_id is not null then
      select name, capacity into selected_floor_name, selected_floor_capacity
      from public.event_competition_schedule_floors
      where id = new.floor_id and event_id = item_event_id;
      new.floor_name_snapshot := selected_floor_name;
      new.floor_capacity_snapshot := selected_floor_capacity;
    else
      new.floor_name_snapshot := null;
      new.floor_capacity_snapshot := null;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$body$
$fn$;
  end if;

  if to_regprocedure('public.create_competition_schedule_version(uuid, text, uuid)') is null then
    execute $fn$
create function public.create_competition_schedule_version(
  selected_event_id uuid,
  selected_name text default null::text,
  source_version_id uuid default null::uuid
)
returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $body$
declare
  next_number integer;
  new_version_id uuid;
  source_session record;
  source_block record;
  new_session_id uuid;
  new_block_id uuid;
begin
  if not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Not authorized to manage this competition.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text));
  select coalesce(max(version_number), 0) + 1 into next_number
  from public.event_competition_schedule_versions where event_id = selected_event_id;

  if source_version_id is not null and not exists (
    select 1 from public.event_competition_schedule_versions
    where id = source_version_id and event_id = selected_event_id
  ) then
    raise exception 'Source schedule version does not belong to this event.';
  end if;

  insert into public.event_competition_schedule_versions (
    event_id, version_number, name, based_on_version_id, created_by
  ) values (
    selected_event_id,
    next_number,
    coalesce(nullif(btrim(selected_name), ''), 'Schedule v' || next_number),
    source_version_id,
    auth.uid()
  ) returning id into new_version_id;

  if source_version_id is not null then
    for source_session in
      select * from public.event_competition_schedule_sessions
      where schedule_version_id = source_version_id order by starts_at, sort_order
    loop
      insert into public.event_competition_schedule_sessions (
        event_id, schedule_version_id, name, session_date, starts_at, ends_at, sort_order, notes
      ) values (
        selected_event_id, new_version_id, source_session.name, source_session.session_date,
        source_session.starts_at, source_session.ends_at, source_session.sort_order, source_session.notes
      ) returning id into new_session_id;

      for source_block in
        select * from public.event_competition_schedule_blocks
        where session_id = source_session.id order by starts_at, sort_order
      loop
        insert into public.event_competition_schedule_blocks (
          event_id, schedule_version_id, session_id, floor_id, name, block_type,
          starts_at, ends_at, sort_order, configuration
        ) values (
          selected_event_id, new_version_id, new_session_id, source_block.floor_id,
          source_block.name, source_block.block_type, source_block.starts_at, source_block.ends_at,
          source_block.sort_order, source_block.configuration
        ) returning id into new_block_id;

        insert into public.event_competition_schedule_block_contests (
          event_id, schedule_version_id, block_id, contest_id, planned_round_type, sort_order, constraints
        )
        select selected_event_id, new_version_id, new_block_id, contest_id,
          planned_round_type, sort_order, constraints
        from public.event_competition_schedule_block_contests
        where block_id = source_block.id;
      end loop;
    end loop;
  end if;

  return new_version_id;
end;
$body$
$fn$;
  end if;
end $capture$;

-- Triggers and policies, created only when absent (deployed names and definitions).
do $capture$
declare
  v_table text;
begin
  foreach v_table in array array[
    'event_competition_schedule_versions', 'event_competition_schedule_floors',
    'event_competition_schedule_sessions', 'event_competition_schedule_blocks',
    'event_competition_schedule_block_contests'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table and policyname = 'competition_manage') then
      execute format('create policy competition_manage on public.%I as permissive for all to authenticated using (public.can_manage_event_competition(event_id)) with check (public.can_manage_event_competition(event_id))', v_table);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', v_table)::regclass and tgname = 'set_event_competition_updated_at') then
      execute format('create trigger set_event_competition_updated_at before update on public.%I for each row execute function public.set_event_competition_updated_at()', v_table);
    end if;
    execute format('grant all on public.%I to anon, authenticated, service_role', v_table);
  end loop;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_schedule_sessions'::regclass and tgname = 'validate_competition_schedule_session') then
    create trigger validate_competition_schedule_session
      before insert or delete or update on public.event_competition_schedule_sessions
      for each row execute function public.validate_competition_schedule_item();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_schedule_blocks'::regclass and tgname = 'validate_competition_schedule_block') then
    create trigger validate_competition_schedule_block
      before insert or delete or update on public.event_competition_schedule_blocks
      for each row execute function public.validate_competition_schedule_item();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_schedule_block_contests'::regclass and tgname = 'validate_competition_schedule_assignment') then
    create trigger validate_competition_schedule_assignment
      before insert or delete or update on public.event_competition_schedule_block_contests
      for each row execute function public.validate_competition_schedule_item();
  end if;
end $capture$;

comment on table public.event_competition_schedule_versions is
  'Versioned tentative, published, and live schedules. Published versions are immutable.';
comment on table public.event_competition_schedule_blocks is
  'Organizer-defined time windows that later heat-generation runs populate without rewriting the framework.';

-- ===========================================================================
-- Section B -- NEW 10A HARDENING
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- B1. Public registration catalog: event-scoped, fully qualified
-- ---------------------------------------------------------------------------
drop policy if exists competition_contests_public_registration_read on public.event_competition_contests;
create policy competition_contests_public_registration_read on public.event_competition_contests
  for select to public using (
    event_competition_contests.status = 'open'
    and exists (
      select 1
      from public.event_competition_contest_registration_rules r
      join public.event_competition_programs p
        on p.id = event_competition_contests.program_id
       and p.event_id = event_competition_contests.event_id
      join public.events e on e.id = event_competition_contests.event_id
      where r.contest_id = event_competition_contests.id
        and r.event_id = event_competition_contests.event_id
        and r.registration_open
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy if exists competition_divisions_public_registration_read on public.event_competition_divisions;
create policy competition_divisions_public_registration_read on public.event_competition_divisions
  for select to public using (
    event_competition_divisions.status = 'open'
    and exists (
      select 1
      from public.event_competition_contest_registration_rules r
      join public.event_competition_contests c
        on c.id = r.contest_id
       and c.event_id = r.event_id
      join public.event_competition_programs p
        on p.id = event_competition_divisions.program_id
       and p.event_id = event_competition_divisions.event_id
      join public.events e on e.id = event_competition_divisions.event_id
      where r.contest_id = event_competition_divisions.contest_id
        and r.event_id = event_competition_divisions.event_id
        and r.registration_open
        and c.status = 'open'
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy if exists competition_dances_public_registration_read on public.event_competition_dances;
create policy competition_dances_public_registration_read on public.event_competition_dances
  for select to public using (
    event_competition_dances.active
    and exists (
      select 1
      from public.event_competition_programs p
      join public.events e on e.id = event_competition_dances.event_id
      where p.id = event_competition_dances.program_id
        and p.event_id = event_competition_dances.event_id
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

drop policy if exists competition_division_dances_public_registration_read on public.event_competition_division_dances;
create policy competition_division_dances_public_registration_read on public.event_competition_division_dances
  for select to public using (
    event_competition_division_dances.active
    and exists (
      select 1
      from public.event_competition_divisions d
      join public.event_competition_contest_registration_rules r
        on r.contest_id = d.contest_id
       and r.event_id = d.event_id
      join public.event_competition_contests c
        on c.id = d.contest_id
       and c.event_id = d.event_id
      join public.event_competition_programs p
        on p.id = d.program_id
       and p.event_id = d.event_id
      join public.events e on e.id = d.event_id
      where d.id = event_competition_division_dances.division_id
        and d.event_id = event_competition_division_dances.event_id
        and d.status = 'open'
        and r.registration_open
        and c.status = 'open'
        and p.status in ('configured', 'active')
        and e.status = 'published'
        and e.visibility in ('public', 'unlisted')
        and e.registration_required
    )
  );

-- ---------------------------------------------------------------------------
-- B2. Append-only competition history evidence
-- ---------------------------------------------------------------------------
create or replace function public.protect_competition_history_evidence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% is append-only evidence and cannot be truncated.', tg_table_name
      using errcode = '42501';
  end if;
  -- The only permitted removal is the cascade of a deleted event.
  if tg_op = 'DELETE' and not exists (select 1 from public.events e where e.id = old.event_id) then
    return old;
  end if;
  raise exception '% is append-only evidence; % is not allowed.', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

revoke all on function public.protect_competition_history_evidence() from public, anon, authenticated;

alter table public.event_competition_entry_changes
  drop constraint if exists event_competition_entry_changes_entry_id_fkey;
alter table public.event_competition_entry_changes
  drop constraint if exists event_competition_entry_changes_performed_by_fkey;

drop policy if exists competition_history_insert on public.event_competition_entry_changes;
revoke all on public.event_competition_entry_changes from public, anon, authenticated, service_role;
grant select on public.event_competition_entry_changes to authenticated, service_role;

drop trigger if exists protect_competition_entry_change_history on public.event_competition_entry_changes;
create trigger protect_competition_entry_change_history
  before update or delete on public.event_competition_entry_changes
  for each row execute function public.protect_competition_history_evidence();
drop trigger if exists protect_competition_entry_change_history_truncate on public.event_competition_entry_changes;
create trigger protect_competition_entry_change_history_truncate
  before truncate on public.event_competition_entry_changes
  for each statement execute function public.protect_competition_history_evidence();

-- History rows are written only by this trigger function. Body as deployed, plus: when the
-- entry is deleted by the cascade of its deleted event, no row is written (the event's whole
-- history is being cascaded away; the old row could not reference the deleted event).
create or replace function public.audit_competition_entry_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_type text;
  selected_reason text;
  selected_fee_handling text;
begin
  selected_reason := nullif(current_setting('app.competition_entry_change_reason', true), '');
  selected_fee_handling := coalesce(nullif(current_setting('app.competition_entry_fee_handling', true), ''), 'not_applicable');

  if tg_op = 'DELETE' then
    if not exists (select 1 from public.events e where e.id = old.event_id) then
      return old;
    end if;
    selected_type := coalesce(nullif(current_setting('app.competition_entry_change_type', true), ''), 'delete_error');
    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling, previous_state, performed_by
    ) values (
      old.event_id, old.id, selected_type, selected_reason, selected_fee_handling, to_jsonb(old), auth.uid()
    );
    return old;
  end if;

  if new.status is distinct from old.status
    or new.division_id is distinct from old.division_id
    or new.program_id is distinct from old.program_id
    or new.eligibility_status is distinct from old.eligibility_status
    or new.late_entry is distinct from old.late_entry then
    selected_type := nullif(current_setting('app.competition_entry_change_type', true), '');
    if selected_type is null then
      selected_type := case
        when new.status = 'scratched' then 'scratch'
        when new.status = 'withdrawn' then 'withdraw'
        when new.division_id is distinct from old.division_id or new.program_id is distinct from old.program_id then 'move_entry'
        when new.eligibility_status is distinct from old.eligibility_status then 'eligibility_change'
        when new.late_entry and not old.late_entry then 'late_entry'
        else 'status_change'
      end;
    end if;

    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling,
      previous_state, resulting_state, performed_by
    ) values (
      new.event_id, new.id, selected_type, selected_reason, selected_fee_handling,
      to_jsonb(old), to_jsonb(new), auth.uid()
    );
  end if;
  return new;
end;
$$;
revoke all on function public.audit_competition_entry_change() from public, anon, authenticated;

comment on table public.event_competition_entry_changes is
  'Append-only attributed history distinguishing scratch, withdrawal, erroneous deletion, late entry, and movement. Written only by the audit_competition_entry_change trigger; entry_id and performed_by are plain values that survive deletion.';

-- ---------------------------------------------------------------------------
-- B3. Heat lock: role-checked, audited override (no session GUC bypass)
-- ---------------------------------------------------------------------------
create table public.event_competition_heat_lock_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  heat_id uuid not null,
  from_state text not null,
  to_state text not null,
  reason text,
  performed_by uuid,
  performed_at timestamptz not null default now(),
  transaction_id bigint not null default txid_current(),
  constraint event_competition_heat_lock_events_state_check
    check (from_state in ('open', 'locked', 'certified') and to_state in ('open', 'locked', 'certified'))
);

create index event_competition_heat_lock_events_heat_idx
  on public.event_competition_heat_lock_events(heat_id, performed_at desc);
create index event_competition_heat_lock_events_txn_idx
  on public.event_competition_heat_lock_events(transaction_id, heat_id);

alter table public.event_competition_heat_lock_events enable row level security;
create policy competition_heat_lock_events_read on public.event_competition_heat_lock_events
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_heat_lock_events from public, anon, authenticated, service_role;
grant select on public.event_competition_heat_lock_events to authenticated, service_role;

create trigger protect_competition_heat_lock_event_history
  before update or delete on public.event_competition_heat_lock_events
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_competition_heat_lock_event_history_truncate
  before truncate on public.event_competition_heat_lock_events
  for each statement execute function public.protect_competition_history_evidence();

comment on table public.event_competition_heat_lock_events is
  'Append-only audit of heat lock-state changes made through set_competition_heat_lock_state. A row for the same heat, target state and transaction is the only authorization for changing a locked or certified heat.';

create or replace function public.protect_locked_competition_heat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.lock_state in ('locked', 'certified') then
    -- Only the exact recorded transition, in the recording transaction, touching nothing
    -- but the lock columns.
    if tg_op = 'UPDATE'
      and (to_jsonb(new) - array['lock_state', 'locked_at', 'locked_by', 'certified_at', 'certified_by', 'updated_at'])
        = (to_jsonb(old) - array['lock_state', 'locked_at', 'locked_by', 'certified_at', 'certified_by', 'updated_at'])
      and exists (
        select 1
        from public.event_competition_heat_lock_events le
        where le.heat_id = old.id
          and le.event_id = old.event_id
          and le.from_state = old.lock_state
          and le.to_state = new.lock_state
          and le.transaction_id = txid_current()
      ) then
      return new;
    end if;
    raise exception 'Locked or certified heats require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_locked_competition_heat() from public, anon, authenticated;

create or replace function public.protect_locked_competition_heat_children()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_heat_id uuid;
  selected_lock_state text;
begin
  selected_heat_id := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  select lock_state into selected_lock_state
  from public.event_competition_heats where id = selected_heat_id;
  if selected_lock_state in ('locked', 'certified') then
    raise exception 'Locked or certified heat details require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop function if exists public.set_competition_heat_lock_state(uuid, text);

create function public.set_competition_heat_lock_state(
  selected_heat_id uuid,
  selected_state text,
  selected_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  heat_event_id uuid;
  current_state text;
begin
  if selected_state is null or selected_state not in ('open', 'locked', 'certified') then
    raise exception 'Invalid heat lock state.';
  end if;
  if actor_id is null then
    raise exception 'Heat was not found or cannot be managed.';
  end if;

  select event_id, lock_state into heat_event_id, current_state
  from public.event_competition_heats where id = selected_heat_id
  for update;
  if heat_event_id is null or not public.can_manage_event_competition(heat_event_id) then
    raise exception 'Heat was not found or cannot be managed.';
  end if;
  if current_state = 'certified' and selected_state <> 'certified' then
    raise exception 'Certified heats require a formal correction workflow and cannot be reopened directly.';
  end if;
  if current_state = 'locked' and selected_state = 'open' and nullif(btrim(coalesce(selected_reason, '')), '') is null then
    raise exception 'A reason is required to reopen a locked heat.';
  end if;

  insert into public.event_competition_heat_lock_events (
    event_id, heat_id, from_state, to_state, reason, performed_by
  ) values (
    heat_event_id, selected_heat_id, current_state, selected_state,
    nullif(btrim(coalesce(selected_reason, '')), ''), actor_id
  );

  update public.event_competition_heats
  set
    lock_state = selected_state,
    locked_at = case when selected_state in ('locked', 'certified') then coalesce(locked_at, now()) else null end,
    locked_by = case when selected_state in ('locked', 'certified') then coalesce(locked_by, actor_id) else null end,
    certified_at = case when selected_state = 'certified' then now() else null end,
    certified_by = case when selected_state = 'certified' then actor_id else null end,
    updated_at = now()
  where id = selected_heat_id;
end;
$$;

revoke all on function public.set_competition_heat_lock_state(uuid, text, text) from public, anon;
grant execute on function public.set_competition_heat_lock_state(uuid, text, text) to authenticated, service_role;

comment on function public.set_competition_heat_lock_state(uuid, text, text) is
  'Role-checked heat lock transition. Records an append-only lock event (actor, reason, states, transaction) that authorizes the locked-heat update in the same transaction.';

-- ---------------------------------------------------------------------------
-- B4. can_manage_event_competition: no creator-only authority, no anon EXECUTE
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_event_competition(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.platform_role = 'platform_admin'
        )
        or exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = e.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin')
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.organizer_id = e.organizer_id
            and ou.user_id = auth.uid()
            and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
        )
      )
  );
$$;

revoke all on function public.can_manage_event_competition(uuid) from public, anon;
grant execute on function public.can_manage_event_competition(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- B5. SECURITY DEFINER grant posture
-- ---------------------------------------------------------------------------
revoke all on function public.apply_competition_configuration_template(uuid, text) from public, anon;
grant execute on function public.apply_competition_configuration_template(uuid, text) to authenticated, service_role;

revoke all on function public.restart_event_competition_setup(uuid, text) from public, anon;
grant execute on function public.restart_event_competition_setup(uuid, text) to authenticated, service_role;
alter function public.restart_event_competition_setup(uuid, text) set search_path = public, pg_temp;

revoke all on function public.default_competition_registration_rule(uuid) from public, anon, authenticated;
revoke all on function public.create_default_competition_registration_rule() from public, anon, authenticated;
revoke all on function public.sync_competition_entries_from_registration() from public, anon, authenticated;
revoke all on function public.sync_competition_registration_cart_from_order() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- B6. Schedule item validation fix (session_id only exists on blocks)
-- ---------------------------------------------------------------------------
create or replace function public.validate_competition_schedule_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  item_event_id uuid;
  item_version_id uuid;
  item_session_id uuid;
  session_start timestamptz;
  session_end timestamptz;
  version_status text;
  selected_floor_name text;
  selected_floor_capacity integer;
begin
  item_event_id := coalesce(new.event_id, old.event_id);
  item_version_id := coalesce(new.schedule_version_id, old.schedule_version_id);

  select status into version_status
  from public.event_competition_schedule_versions
  where id = item_version_id and event_id = item_event_id;

  -- Cascade from a deleted schedule version: nothing left to protect.
  if tg_op = 'DELETE' and version_status is null then
    return old;
  end if;

  if version_status is distinct from 'draft' then
    raise exception 'Only draft schedule versions may be edited.';
  end if;

  if tg_table_name = 'event_competition_schedule_blocks' and tg_op <> 'DELETE' then
    item_session_id := new.session_id;
    select starts_at, ends_at into session_start, session_end
    from public.event_competition_schedule_sessions
    where id = item_session_id and schedule_version_id = item_version_id and event_id = item_event_id;

    if new.starts_at < session_start or new.ends_at > session_end then
      raise exception 'Schedule block must be contained within its session.';
    end if;

    if new.floor_id is not null then
      select name, capacity into selected_floor_name, selected_floor_capacity
      from public.event_competition_schedule_floors
      where id = new.floor_id and event_id = item_event_id;
      new.floor_name_snapshot := selected_floor_name;
      new.floor_capacity_snapshot := selected_floor_capacity;
    else
      new.floor_name_snapshot := null;
      new.floor_capacity_snapshot := null;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- B7. digest() lives in the extensions schema (pgcrypto); these invoker functions call it
--     unqualified under search_path = public, pg_temp and so always failed.
-- ---------------------------------------------------------------------------
alter function public.create_competition_generation_run(uuid, uuid, text, uuid)
  set search_path = public, extensions, pg_temp;
alter function public.create_competition_heat_plan_run(uuid, uuid, text, text, jsonb)
  set search_path = public, extensions, pg_temp;
alter function public.publish_competition_schedule_version(uuid)
  set search_path = public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public'
             and tablename = 'event_competition_entry_changes' and cmd <> 'SELECT') then
    raise exception 'Phase 10A postflight: entry history still has a write policy.';
  end if;
  if has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'INSERT')
     or has_table_privilege('anon', 'public.event_competition_entry_changes', 'INSERT')
     or has_table_privilege('service_role', 'public.event_competition_entry_changes', 'INSERT') then
    raise exception 'Phase 10A postflight: entry history is still directly insertable.';
  end if;
  if has_function_privilege('anon', 'public.can_manage_event_competition(uuid)', 'EXECUTE') then
    raise exception 'Phase 10A postflight: anon can still execute can_manage_event_competition.';
  end if;
  if exists (select 1 from pg_proc where prosrc ilike '%competition_heat_override%') then
    raise exception 'Phase 10A postflight: a function still honours app.competition_heat_override.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
