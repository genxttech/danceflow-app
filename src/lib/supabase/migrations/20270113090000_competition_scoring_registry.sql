-- 20270113090000_competition_scoring_registry.sql
--
-- COMPETITION REG: scoring-method registry (Stage 4 decisions S4-1..S4-7;
-- docs/competition/scoring-method-registry.md, src/lib/competition/scoring/registry.ts).
--
-- Adds, with no silent backfill and no rewrite of any existing row:
--   1. competition_scoring_methods: a global, read-only, versioned registry (key, version, status, source pins,
--      accepted ballot formats, purposes, panel rule, engine id, fixture set). Mirrors registry.ts.
--      Seeded: studio_callback_tally@1 and studio_ordinal_majority@1 (approved), ucwdc_majority_rules@v16.9b
--      (unavailable), proficiency_rating@1 (rejected), ndca_skating and wsdc_relative_placement (unavailable).
--   2. competition_scoring_legacy_map: the EXPLICIT interpretation of the existing 10B/10C.5 scoring_method values
--      (ordinal_majority, callback_tally, proficiency_rating). Read-only; nothing stored is rewritten (S4-7).
--   3. Division-level selection (event_competition_divisions.scoring_method_key/version) and an optional
--      round-level override (event_competition_rounds.scoring_override_key/version). NULL = not selected: the
--      round keeps its current behavior and is read through the legacy map. A guard trigger only lets a draft,
--      unlocked program select an APPROVED method; locked or published programs can never change a selection.
--   4. event_competition_scoring_pins: append-only evidence written at lock (publish) time: the effective method
--      of every round (override, division, legacy map or unmapped) plus the sanctioning declared at that moment.
--   5. events.competition_sanctioning (default 'none'): a disclosure field independent of the scoring method.
--      Only studio/organizer owners and admins can set it, and not once a program of the event is locked.
--   6. competition_round_scoring_effective(round): the single reader. Returns the pin when one exists, otherwise
--      a live read-only resolution (pinned = false) for rounds locked before this migration. Managers only.
--
-- The existing scoring_method columns and their checks are untouched. No existing function is replaced.

begin;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_program_locks') is null then
    raise exception 'REG preflight: Phase 10B must be applied first.';
  end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.can_edit_competition_event_operations(uuid)') is null then
    raise exception 'REG preflight: competition access helpers are missing.';
  end if;
  if to_regclass('public.competition_scoring_methods') is not null
     or to_regclass('public.event_competition_scoring_pins') is not null then
    raise exception 'REG preflight: registry objects already exist.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and ((table_name = 'event_competition_divisions' and column_name in ('scoring_method_key', 'scoring_method_version'))
        or (table_name = 'event_competition_rounds' and column_name in ('scoring_override_key', 'scoring_override_version'))
        or (table_name = 'events' and column_name = 'competition_sanctioning'))
  ) then
    raise exception 'REG preflight: REG columns already exist.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Registry (global, read-only, versioned)
-- ---------------------------------------------------------------------------
create table public.competition_scoring_methods (
  method_key text not null,
  method_version text not null,
  status text not null,
  label text not null,
  source_pins jsonb not null default '[]'::jsonb,
  accepted_ballot_formats text[] not null default '{}',
  result_purposes text[] not null default '{}',
  panel_rule text not null,
  engine_id text,
  fixture_set text,
  status_reason text not null,
  created_at timestamptz not null default now(),
  constraint competition_scoring_methods_pkey primary key (method_key, method_version),
  constraint competition_scoring_methods_key_check check (method_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  constraint competition_scoring_methods_version_check check (length(btrim(method_version)) between 1 and 40),
  constraint competition_scoring_methods_status_check check (status in ('approved', 'draft', 'unavailable', 'rejected')),
  constraint competition_scoring_methods_panel_check check (panel_rule in ('studio_x3', 'ucwdc_unverified', 'none_unverified')),
  constraint competition_scoring_methods_purposes_check
    check (result_purposes <@ array['feedback', 'placement', 'advancement']::text[]),
  constraint competition_scoring_methods_pins_check check (jsonb_typeof(source_pins) = 'array'),
  -- Only an approved method may carry an engine, ballot formats or purposes; everything else is fail-closed by shape.
  constraint competition_scoring_methods_approved_shape_check
    check ((status = 'approved' and engine_id is not null and cardinality(accepted_ballot_formats) > 0
            and cardinality(result_purposes) > 0 and panel_rule = 'studio_x3')
        or (status <> 'approved' and engine_id is null and cardinality(accepted_ballot_formats) = 0
            and cardinality(result_purposes) = 0))
);

alter table public.competition_scoring_methods enable row level security;
create policy competition_scoring_methods_read on public.competition_scoring_methods
  for select to authenticated using (true);
revoke all on public.competition_scoring_methods from public, anon, authenticated, service_role;
grant select on public.competition_scoring_methods to authenticated, service_role;

-- A published version is evidence: fully append-only. Promoting a method (for example UCWDC once Q1-Q5 are closed) is a NEW
-- version row in a reviewed migration; demoting one is an explicit migration that names this trigger.
create or replace function public.protect_competition_scoring_method()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Scoring method versions are append-only; publish a new version instead.' using errcode = '42501';
end;
$$;

create trigger protect_competition_scoring_method
  before update or delete on public.competition_scoring_methods
  for each row execute function public.protect_competition_scoring_method();
create trigger protect_competition_scoring_method_truncate
  before truncate on public.competition_scoring_methods
  for each statement execute function public.protect_competition_scoring_method();

comment on table public.competition_scoring_methods is
  'Versioned scoring-method registry (REG). Mirrors src/lib/competition/scoring/registry.ts. Only approved methods are selectable; draft, unavailable and rejected methods fail closed (COMP_ENGINE_NOT_AVAILABLE).';

insert into public.competition_scoring_methods
  (method_key, method_version, status, label, source_pins, accepted_ballot_formats, result_purposes, panel_rule, engine_id, fixture_set, status_reason)
values
  ('studio_callback_tally', '1', 'approved', 'Studio callback tally', '[]'::jsonb,
   array['callback_yes@1'], array['advancement'], 'studio_x3', 'studio_callback_tally@1',
   'engine-spec-callback-tally.md section 9 (F-CT-*)',
   'Approved Stage 2 (D-CT-1..10) and X-1..X-7. Studio method; carries no sanctioning claim.'),
  ('studio_ordinal_majority', '1', 'approved', 'Studio ordinal majority', '[]'::jsonb,
   array['ordinal_rank@1'], array['placement'], 'studio_x3', 'studio_ordinal_majority@1',
   'engine-spec-ordinal-majority.md section 9 (F-OM-*)',
   'Approved Stage 3 (D-OM-1..5, D-OM-3b) and X-1..X-7. Studio method; carries no sanctioning claim.'),
  ('ucwdc_majority_rules', 'v16.9b', 'unavailable', 'UCWDC Majority Rules',
   '[{"document":"2026-Scoring-Format-v16.9b-1.pdf","sha256":"44290a06d14c308087039bce8d57258629ae103734cce08eb21f41bdb667b02f","note":"Pinned edition; a March 2026 edition is unconfirmed."}]'::jsonb,
   '{}', '{}', 'ucwdc_unverified', null, null,
   'K1-U DRAFT. UNAVAILABLE pending UCWDC Q1-Q5 and independent verification (S4-5). Panel eligibility (Q4) unverified.'),
  ('proficiency_rating', '1', 'rejected', 'Proficiency rating (three-band)', '[]'::jsonb,
   '{}', '{}', 'none_unverified', null, null,
   'REJECTED as a universal studio method (Stage 4 section 1.6). Key kept, not deleted, so existing rows stay fail-closed.'),
  ('ndca_skating', 'unpinned', 'unavailable', 'NDCA Skating System', '[]'::jsonb,
   '{}', '{}', 'none_unverified', null, null, 'No authoritative algorithm source. Placeholder only.'),
  ('wsdc_relative_placement', 'unpinned', 'unavailable', 'WSDC Relative Placement', '[]'::jsonb,
   '{}', '{}', 'none_unverified', null, null, 'No authoritative algorithm source. Placeholder only.');

-- ---------------------------------------------------------------------------
-- 2. Explicit legacy map (interpretation only; nothing stored is rewritten)
-- ---------------------------------------------------------------------------
create table public.competition_scoring_legacy_map (
  legacy_value text primary key,
  method_key text not null,
  method_version text not null,
  constraint competition_scoring_legacy_map_method_fk
    foreign key (method_key, method_version) references public.competition_scoring_methods(method_key, method_version) on delete restrict
);

alter table public.competition_scoring_legacy_map enable row level security;
create policy competition_scoring_legacy_map_read on public.competition_scoring_legacy_map
  for select to authenticated using (true);
revoke all on public.competition_scoring_legacy_map from public, anon, authenticated, service_role;
grant select on public.competition_scoring_legacy_map to authenticated, service_role;

create or replace function public.protect_competition_scoring_legacy_map()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'The legacy scoring map is append-only evidence.' using errcode = '42501';
end;
$$;

create trigger protect_competition_scoring_legacy_map
  before update or delete on public.competition_scoring_legacy_map
  for each row execute function public.protect_competition_scoring_legacy_map();
create trigger protect_competition_scoring_legacy_map_truncate
  before truncate on public.competition_scoring_legacy_map
  for each statement execute function public.protect_competition_scoring_legacy_map();

-- majority_rules, skating, wsdc_callback, relative_placement, custom, none, ... are deliberately NOT mapped: they stay
-- unmapped (fail closed). In particular the legacy majority_rules value is NOT UCWDC Majority Rules.
insert into public.competition_scoring_legacy_map (legacy_value, method_key, method_version) values
  ('ordinal_majority', 'studio_ordinal_majority', '1'),
  ('callback_tally', 'studio_callback_tally', '1'),
  ('proficiency_rating', 'proficiency_rating', '1');

-- ---------------------------------------------------------------------------
-- 3. Division selection and round override (NULL = not selected; no backfill)
-- ---------------------------------------------------------------------------
alter table public.event_competition_divisions
  add column scoring_method_key text,
  add column scoring_method_version text,
  add constraint event_competition_divisions_scoring_pair_check
    check ((scoring_method_key is null) = (scoring_method_version is null)),
  add constraint event_competition_divisions_scoring_method_fk
    foreign key (scoring_method_key, scoring_method_version)
    references public.competition_scoring_methods(method_key, method_version) on delete restrict;

alter table public.event_competition_rounds
  add column scoring_override_key text,
  add column scoring_override_version text,
  add constraint event_competition_rounds_scoring_override_pair_check
    check ((scoring_override_key is null) = (scoring_override_version is null)),
  add constraint event_competition_rounds_scoring_override_fk
    foreign key (scoring_override_key, scoring_override_version)
    references public.competition_scoring_methods(method_key, method_version) on delete restrict;

comment on column public.event_competition_divisions.scoring_method_key is
  'REG: registry method selected for this division (NULL = not selected; the legacy round scoring_method is read through competition_scoring_legacy_map). Changeable only while the program is an unlocked draft, and only to an approved method.';
comment on column public.event_competition_rounds.scoring_override_key is
  'REG: optional round-level override of the division method (for example callback vs final). Same rules as the division selection.';

-- Guard shared by divisions and rounds: only an approved registry method, only on an unlocked draft program.
create or replace function public.guard_competition_scoring_selection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_key text;
  v_old_ver text;
  v_new_key text;
  v_new_ver text;
  v_program record;
  v_method record;
begin
  if tg_table_name = 'event_competition_divisions' then
    v_new_key := new.scoring_method_key; v_new_ver := new.scoring_method_version;
    if tg_op = 'UPDATE' then v_old_key := old.scoring_method_key; v_old_ver := old.scoring_method_version; end if;
  else
    v_new_key := new.scoring_override_key; v_new_ver := new.scoring_override_version;
    if tg_op = 'UPDATE' then v_old_key := old.scoring_override_key; v_old_ver := old.scoring_override_version; end if;
  end if;

  if tg_op = 'INSERT' and v_new_key is null then
    -- A division added to a locked program (add_competition_division) does not inherit its siblings' selection. Refuse it
    -- while any sibling has one, so a locked program can never hold divisions with different, unfixable methods.
    if tg_table_name = 'event_competition_divisions'
       and exists (select 1 from public.event_competition_programs p
                   where p.id = new.program_id and p.event_id = new.event_id and p.profile_locked_at is not null)
       and exists (select 1 from public.event_competition_divisions d
                   where d.program_id = new.program_id and d.scoring_method_key is not null) then
      raise exception 'COMP_METHOD_LOCKED: a division cannot be added to a locked competition whose divisions have a selected scoring method.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and v_new_key is not distinct from v_old_key and v_new_ver is not distinct from v_old_ver then
    return new;
  end if;
  if (v_new_key is null) <> (v_new_ver is null) then
    raise exception 'scoring selection requires both key and version (scoring_pair_check)' using errcode = '23514';
  end if;

  select p.status, p.profile_locked_at into v_program
  from public.event_competition_programs p
  where p.id = new.program_id and p.event_id = new.event_id
  for share of p;
  if not found then
    raise exception 'COMP_PROGRAM_NOT_FOUND: the program of this row does not exist.' using errcode = '23503';
  end if;
  if v_program.profile_locked_at is not null or v_program.status <> 'draft' then
    raise exception 'COMP_METHOD_LOCKED: the scoring method of a published or locked competition cannot be changed (S4-7).'
      using errcode = '42501';
  end if;

  if v_new_key is null then
    return new; -- clearing a selection on a draft is allowed
  end if;

  select m.status, m.engine_id into v_method
  from public.competition_scoring_methods m
  where m.method_key = v_new_key and m.method_version = v_new_ver;
  if not found then
    raise exception 'COMP_METHOD_UNKNOWN: % is not in the registry.', v_new_key || '@' || v_new_ver using errcode = '23503';
  end if;
  if v_method.status <> 'approved' or v_method.engine_id is null then
    raise exception 'COMP_ENGINE_NOT_AVAILABLE: % is % and cannot be selected.', v_new_key || '@' || v_new_ver, v_method.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_competition_scoring_selection() from public, anon, authenticated, service_role;

create trigger guard_competition_scoring_selection
  before insert or update on public.event_competition_divisions
  for each row execute function public.guard_competition_scoring_selection();
create trigger guard_competition_scoring_selection
  before insert or update on public.event_competition_rounds
  for each row execute function public.guard_competition_scoring_selection();

-- ---------------------------------------------------------------------------
-- 5. Sanctioning disclosure (independent of the scoring method)
-- ---------------------------------------------------------------------------
alter table public.events
  add column competition_sanctioning text not null default 'none',
  add constraint events_competition_sanctioning_check
    check (competition_sanctioning in ('none', 'ucwdc', 'ndca', 'wsdc', 'other')),
  add constraint events_competition_sanctioning_type_check
    check (competition_sanctioning = 'none' or event_type = 'competition');

comment on column public.events.competition_sanctioning is
  'REG/S4-2: the sanctioning the ORGANIZER declares for a competition. Default none; DanceFlow does not verify or imply a sanction, and selecting a scoring method never changes it. Set by owners/admins only, and fixed once a program of the event is locked.';

create or replace function public.protect_competition_sanctioning()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.competition_sanctioning <> 'none' and auth.uid() is not null then
      raise exception 'Create the event first; an owner or admin then sets the sanctioning declaration.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.competition_sanctioning is not distinct from old.competition_sanctioning then
    return new;
  end if;
  if auth.uid() is not null and not public.can_edit_competition_event_operations(old.id) then
    raise exception 'Only studio owners and admins, and organizer owners and admins, can change the sanctioning declaration.'
      using errcode = '42501';
  end if;
  perform 1 from public.event_competition_programs p where p.event_id = old.id for share;
  if exists (select 1 from public.event_competition_programs p
             where p.event_id = old.id and (p.profile_locked_at is not null or p.status <> 'draft')) then
    raise exception 'COMP_SANCTIONING_LOCKED: the sanctioning declaration is fixed once a competition is published.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_competition_sanctioning() from public, anon, authenticated, service_role;

create trigger protect_competition_sanctioning
  before insert or update on public.events
  for each row execute function public.protect_competition_sanctioning();

-- ---------------------------------------------------------------------------
-- 4. Pins written at lock time (append-only evidence)
-- ---------------------------------------------------------------------------
create table public.event_competition_scoring_pins (
  round_id uuid not null,
  division_id uuid not null,
  program_id uuid not null,
  event_id uuid not null,
  method_key text,
  method_version text,
  resolution text not null,
  legacy_scoring_method text,
  registry_status text,
  sanctioning text not null,
  pinned_at timestamptz not null default now(),
  constraint event_competition_scoring_pins_pkey primary key (round_id),
  constraint event_competition_scoring_pins_round_fk
    foreign key (round_id, division_id, event_id) references public.event_competition_rounds(id, division_id, event_id) on delete cascade,
  constraint event_competition_scoring_pins_program_fk
    foreign key (program_id, event_id) references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_scoring_pins_method_fk
    foreign key (method_key, method_version) references public.competition_scoring_methods(method_key, method_version) on delete restrict,
  constraint event_competition_scoring_pins_resolution_check
    check (resolution in ('round_override', 'division', 'legacy_map', 'unmapped')),
  constraint event_competition_scoring_pins_shape_check
    check ((resolution = 'unmapped') = (method_key is null) and (method_key is null) = (method_version is null)
           and (method_key is null) = (registry_status is null))
);

alter table public.event_competition_scoring_pins enable row level security;
create policy event_competition_scoring_pins_read on public.event_competition_scoring_pins
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_scoring_pins from public, anon, authenticated, service_role;
grant select on public.event_competition_scoring_pins to authenticated, service_role;

create or replace function public.protect_competition_scoring_pin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The only permitted removal is the cascade of a deleted round (restart or event deletion).
  if tg_op = 'DELETE' and (not exists (select 1 from public.event_competition_rounds r where r.id = old.round_id)
                          or not exists (select 1 from public.event_competition_programs p where p.id = old.program_id)) then
    return old;
  end if;
  raise exception 'Scoring pins are append-only evidence.' using errcode = '42501';
end;
$$;

create trigger protect_competition_scoring_pin
  before update or delete on public.event_competition_scoring_pins
  for each row execute function public.protect_competition_scoring_pin();
create trigger protect_competition_scoring_pin_truncate
  before truncate on public.event_competition_scoring_pins
  for each statement execute function public.protect_competition_scoring_pin();

comment on table public.event_competition_scoring_pins is
  'REG: effective scoring method of each round, frozen when its program is locked (publish). Programs locked before REG have no pins; competition_round_scoring_effective reads them live (pinned = false). Manager-readable only.';

-- Shared resolution (override -> division -> legacy map -> unmapped). Reads only; never writes.
create or replace function public.competition_scoring_resolve(p_round_id uuid)
returns table (
  event_id uuid, program_id uuid, division_id uuid,
  method_key text, method_version text, resolution text, legacy_scoring_method text, registry_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.event_id, r.program_id, r.division_id,
         x.k, x.v,
         case when x.src is null then 'unmapped' else x.src end,
         r.scoring_method,
         m.status
  from public.event_competition_rounds r
  join public.event_competition_divisions d on d.id = r.division_id
  left join lateral (
    select coalesce(r.scoring_override_key, d.scoring_method_key, lm.method_key) as k,
           coalesce(r.scoring_override_version, d.scoring_method_version, lm.method_version) as v,
           case when r.scoring_override_key is not null then 'round_override'
                when d.scoring_method_key is not null then 'division'
                when lm.method_key is not null then 'legacy_map'
                else null end as src
    from (select 1) one
    left join public.competition_scoring_legacy_map lm on lm.legacy_value = r.scoring_method
  ) x on true
  left join public.competition_scoring_methods m on m.method_key = x.k and m.method_version = x.v
  where r.id = p_round_id;
$$;

revoke all on function public.competition_scoring_resolve(uuid) from public, anon, authenticated, service_role;

create or replace function public.pin_competition_round_scoring(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.event_competition_rounds r join public.event_competition_programs p on p.id = r.program_id
                 where r.id = p_round_id and p.profile_locked_at is not null) then
    raise exception 'A scoring pin is written only for a round of a locked program.' using errcode = '42501';
  end if;
  insert into public.event_competition_scoring_pins
    (round_id, division_id, program_id, event_id, method_key, method_version, resolution, legacy_scoring_method, registry_status, sanctioning)
  select p_round_id, s.division_id, s.program_id, s.event_id, s.method_key, s.method_version, s.resolution,
         s.legacy_scoring_method, s.registry_status, e.competition_sanctioning
  from public.competition_scoring_resolve(p_round_id) s
  join public.events e on e.id = s.event_id
  on conflict (round_id) do nothing;
end;
$$;

revoke all on function public.pin_competition_round_scoring(uuid) from public, anon, authenticated, service_role;

-- Pin every round when the program is locked (the publish function sets profile_locked_at; it is not replaced).
create or replace function public.pin_competition_program_scoring()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round uuid;
begin
  for v_round in select r.id from public.event_competition_rounds r where r.program_id = new.id order by r.id loop
    perform public.pin_competition_round_scoring(v_round);
  end loop;
  return null;
end;
$$;

revoke all on function public.pin_competition_program_scoring() from public, anon, authenticated, service_role;

create trigger pin_competition_program_scoring
  after update of profile_locked_at on public.event_competition_programs
  for each row
  when (old.profile_locked_at is null and new.profile_locked_at is not null)
  execute function public.pin_competition_program_scoring();

-- A round added to an already-locked program is pinned on insert (its selection cannot change afterwards).
create or replace function public.pin_competition_late_round()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.event_competition_programs p where p.id = new.program_id and p.profile_locked_at is not null) then
    perform public.pin_competition_round_scoring(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.pin_competition_late_round() from public, anon, authenticated, service_role;

create trigger pin_competition_late_round
  after insert on public.event_competition_rounds
  for each row execute function public.pin_competition_late_round();

-- ---------------------------------------------------------------------------
-- 6. The single reader
-- ---------------------------------------------------------------------------
-- Internal reader for SECURITY DEFINER callers (F2 calculate runs for managers AND assigned scorers, who cannot pass the manager
-- check of the public reader). No caller check: it is not callable by any API role.
create or replace function public.competition_round_scoring_effective_internal(p_round_id uuid)
returns table (
  method_key text, method_version text, resolution text, registry_status text,
  engine_id text, selectable boolean, pinned boolean, sanctioning text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select p.method_key, p.method_version, p.resolution, m.status, m.engine_id,
         (m.status = 'approved' and m.engine_id is not null), true, p.sanctioning
  from public.event_competition_scoring_pins p
  left join public.competition_scoring_methods m on m.method_key = p.method_key and m.method_version = p.method_version
  where p.round_id = p_round_id;
  if found then return; end if;

  return query
  select s.method_key, s.method_version, s.resolution, s.registry_status, m.engine_id,
         false, false, e.competition_sanctioning
  from public.competition_scoring_resolve(p_round_id) s
  join public.events e on e.id = s.event_id
  left join public.competition_scoring_methods m on m.method_key = s.method_key and m.method_version = s.method_version;
end;
$$;

revoke all on function public.competition_round_scoring_effective_internal(uuid) from public, anon, authenticated, service_role;

create or replace function public.competition_round_scoring_effective(p_round_id uuid)
returns table (
  method_key text, method_version text, resolution text, registry_status text,
  engine_id text, selectable boolean, pinned boolean, sanctioning text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  select r.event_id into v_event from public.event_competition_rounds r where r.id = p_round_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'Round not found or not accessible.' using errcode = '42501';
  end if;
  return query select * from public.competition_round_scoring_effective_internal(p_round_id);
end;
$$;

revoke all on function public.competition_round_scoring_effective(uuid) from public, anon;
grant execute on function public.competition_round_scoring_effective(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
