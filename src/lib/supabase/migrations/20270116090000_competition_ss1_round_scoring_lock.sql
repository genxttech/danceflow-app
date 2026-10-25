-- 20270116090000_competition_ss1_round_scoring_lock.sql
--
-- COMPETITION SS1: once a program is locked (10B profile_locked_at, the source of truth for "published"), the scoring-relevant
-- columns of its rounds can never change. REG already freezes the SELECTION columns (division scoring_method_key/version, round
-- scoring_override_key/version) and pins the effective method at lock, and E2 freezes scoring_method/target_advancement_count
-- once a round has STARTED. Neither stops a multi-write "configure" that straddles a publish from rewriting a locked round's
-- legacy scoring_method (which E2 uses to pick the ballot format) or its sequence/type/division/program.
--
-- Adds, with NO existing function redefined (so nothing to md5-pin; the rollback drops exactly these objects):
--   1. guard_competition_round_scoring_lock: BEFORE UPDATE of the frozen columns (below) on rounds;
--   2. guard_competition_round_delete: BEFORE DELETE of a round of a locked program (cascades from a deleted program, division or
--      event are still allowed, as for the REG pins);
--   3. apply_competition_scoring_setup(program, ops): the SS1 configure as ONE transaction (SECURITY INVOKER, RLS applies) that takes
--      the program row FOR SHARE once, re-checks it is an unlocked studio draft and applies a whitelisted list of writes, so a publish
--      can never land between the steps of one configure.
--
-- Frozen columns once the program is locked: scoring_method, sequence_number, round_type, division_id, program_id.
-- Deliberately NOT frozen: target_advancement_count (W4 lets managers set the callback target until the round starts; E2 freezes
-- it then), status/updated_at (E2, O1, F2 lifecycle writers), name, pairing_mode, configuration (10D max_entries_per_heat).
-- Documented allowed writers for the frozen columns: NONE. Every existing writer of event_competition_rounds updates only
-- status/updated_at (E2, O1, F2) or configuration (10D), and INSERTs are untouched (REG pins a late round on insert).
-- The trigger fires for every role, including the table owner and SECURITY DEFINER code (only session_replication_role =
-- replica, used by test fixtures, bypasses it).
--
-- Not covered (documented): programs without a rules profile (never profile-locked); a table owner or hosted `postgres` role can still
-- ALTER/DISABLE the trigger or set session_replication_role; remove_competition_division (10B) still deletes a division, and its rounds
-- with it, while the program is `configured`.
--
-- Race safety (what is and is not guaranteed): within ONE transaction the guarantee is complete. The app now configures through
-- apply_competition_scoring_setup (one transaction), so a configure never straddles a publish. Direct multi-request writers are only
-- protected per statement. The trigger takes FOR SHARE on the program row. publish_competition_program updates that row, so a configure
-- write and a publish serialize: either the round write commits first (and the publish snapshot/pin sees it) or the publish
-- commits first and the round write is refused. READ COMMITTED re-reads the locked row after the wait.

begin;

do $$
begin
  if to_regclass('public.event_competition_program_locks') is null
     or to_regclass('public.competition_scoring_methods') is null then
    raise exception 'SS1 preflight: Phase 10B and REG (20270113090000) must be applied first.';
  end if;
  if to_regprocedure('public.guard_competition_round_scoring_lock()') is not null
     or to_regprocedure('public.guard_competition_round_delete()') is not null
     or to_regprocedure('public.apply_competition_scoring_setup(uuid,jsonb)') is not null then
    raise exception 'SS1 preflight: SS1 round-lock objects already exist.';
  end if;
end $$;

create or replace function public.guard_competition_round_scoring_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_locked timestamptz;
begin
  if new.scoring_method is not distinct from old.scoring_method
     and new.sequence_number is not distinct from old.sequence_number
     and new.round_type is not distinct from old.round_type
     and new.division_id is not distinct from old.division_id
     and new.program_id is not distinct from old.program_id then
    return new;
  end if;

  -- Serialize against publish (which updates this row) and re-read the committed lock state.
  -- Lock the old and the new program (id order, so two movers cannot deadlock) and refuse if either is locked: a round may not
  -- leave a locked program, nor be moved INTO one (that would add an unpinned round after publish).
  select max(p.profile_locked_at) into v_locked
  from (select p2.profile_locked_at
        from public.event_competition_programs p2
        where p2.id in (old.program_id, new.program_id)
        order by p2.id
        for share) p;

  if v_locked is not null then
    raise exception 'COMP_ROUND_SCORING_LOCKED: the scoring method, order, type and division of a round in a published competition cannot change (S4-7).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_competition_round_scoring_lock() from public, anon, authenticated, service_role;

create or replace function public.guard_competition_round_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $
begin
  -- Cascades from a deleted event, program or division are allowed (restart, event deletion, 10B division removal).
  if not exists (select 1 from public.events e where e.id = old.event_id)
     or not exists (select 1 from public.event_competition_programs p where p.id = old.program_id)
     or not exists (select 1 from public.event_competition_divisions d where d.id = old.division_id) then
    return old;
  end if;
  perform 1 from public.event_competition_programs p where p.id = old.program_id and p.profile_locked_at is not null for share;
  if found then
    raise exception 'COMP_ROUND_SCORING_LOCKED: a round of a published competition cannot be deleted (S4-7).' using errcode = '42501';
  end if;
  return old;
end;
$;

revoke all on function public.guard_competition_round_delete() from public, anon, authenticated, service_role;

create trigger guard_competition_round_delete
  before delete on public.event_competition_rounds
  for each row execute function public.guard_competition_round_delete();

create trigger guard_competition_round_scoring_lock
  before update of scoring_method, sequence_number, round_type, division_id, program_id on public.event_competition_rounds
  for each row execute function public.guard_competition_round_scoring_lock();

comment on function public.guard_competition_round_scoring_lock() is
  'SS1: refuses changes to scoring_method, sequence_number, round_type, division_id and program_id of a round whose program is profile-locked. No allowed writers.';

-- ---------------------------------------------------------------------------
-- The SS1 configure as one transaction
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: RLS and the REG guard run as the caller. The app plans the ops (studioSetup.ts); this function re-checks
-- everything that matters in the database: caller may manage the event, the program is an unlocked studio draft (row locked FOR
-- SHARE for the whole transaction, so a publish waits for it or is seen by it), every referenced row belongs to the program, only
-- whitelisted columns are written, and a legacy scoring value must be one that the REG legacy map interprets as an APPROVED method
-- with an engine. A selection of any other method is refused by the REG guard trigger.
create or replace function public.apply_competition_scoring_setup(p_program_id uuid, p_ops jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $
declare
  v_prog record;
  v_op jsonb;
  v_patch jsonb;
  v_rows integer;
  v_applied integer := 0;
  v_legacy text;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 or jsonb_array_length(p_ops) > 500 then
    raise exception 'COMP_SCORING_OPS_INVALID: provide between 1 and 500 scoring changes.' using errcode = '22023';
  end if;

  select p.id, p.event_id, p.status, p.profile_locked_at, p.rules_profile_key into v_prog
  from public.event_competition_programs p
  where p.id = p_program_id
  for share;
  if not found or not public.can_manage_event_competition(v_prog.event_id) then
    raise exception 'Competition not found or not accessible.' using errcode = '42501';
  end if;
  if v_prog.profile_locked_at is not null or v_prog.status <> 'draft' then
    raise exception 'COMP_METHOD_LOCKED: the scoring of a published competition cannot be changed (S4-7).' using errcode = '42501';
  end if;
  if v_prog.rules_profile_key is distinct from 'studio_simple' then
    raise exception 'COMP_SCORING_NOT_STUDIO: studio scoring applies to studio competitions created with the setup wizard.' using errcode = '42501';
  end if;

  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_patch := coalesce(v_op -> 'patch', v_op -> 'row', '{}'::jsonb);
    if jsonb_typeof(v_patch) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_patch) k
                  where k <> all (array['sequence_number', 'scoring_method', 'scoring_override_key', 'scoring_override_version',
                                        'name', 'round_type', 'pairing_mode'])) then
      raise exception 'COMP_SCORING_OPS_INVALID: unsupported column in a scoring change.' using errcode = '22023';
    end if;
    if v_patch ? 'scoring_method' then
      v_legacy := v_patch ->> 'scoring_method';
      if not exists (select 1 from public.competition_scoring_legacy_map lm
                     join public.competition_scoring_methods m on m.method_key = lm.method_key and m.method_version = lm.method_version
                     where lm.legacy_value = v_legacy and m.status = 'approved' and m.engine_id is not null) then
        raise exception 'COMP_ENGINE_NOT_AVAILABLE: % is not a scoring value of an approved method.', coalesce(v_legacy, 'null') using errcode = '42501';
      end if;
    end if;

    case v_op ->> 'op'
      when 'set_division_selection' then
        update public.event_competition_divisions d
        set scoring_method_key = v_op ->> 'key', scoring_method_version = v_op ->> 'version'
        where d.id = (v_op ->> 'division_id')::uuid and d.program_id = p_program_id and d.event_id = v_prog.event_id;
      when 'update_round' then
        update public.event_competition_rounds r
        set sequence_number = case when v_patch ? 'sequence_number' then (v_patch ->> 'sequence_number')::integer else r.sequence_number end,
            scoring_method = case when v_patch ? 'scoring_method' then v_patch ->> 'scoring_method' else r.scoring_method end,
            scoring_override_key = case when v_patch ? 'scoring_override_key' then v_patch ->> 'scoring_override_key' else r.scoring_override_key end,
            scoring_override_version = case when v_patch ? 'scoring_override_version' then v_patch ->> 'scoring_override_version' else r.scoring_override_version end,
            updated_at = now()
        where r.id = (v_op ->> 'round_id')::uuid and r.program_id = p_program_id and r.event_id = v_prog.event_id;
      when 'insert_round' then
        if not exists (select 1 from public.event_competition_divisions d
                       where d.id = (v_op ->> 'division_id')::uuid and d.program_id = p_program_id and d.event_id = v_prog.event_id) then
          raise exception 'COMP_SCORING_OPS_INVALID: division is not part of this competition.' using errcode = '22023';
        end if;
        insert into public.event_competition_rounds
          (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method, pairing_mode,
           scoring_override_key, scoring_override_version)
        values (v_prog.event_id, p_program_id, (v_op ->> 'division_id')::uuid, v_patch ->> 'name', v_patch ->> 'round_type',
                (v_patch ->> 'sequence_number')::integer, v_patch ->> 'scoring_method', v_patch ->> 'pairing_mode',
                v_patch ->> 'scoring_override_key', v_patch ->> 'scoring_override_version');
      else
        raise exception 'COMP_SCORING_OPS_INVALID: unknown scoring change.' using errcode = '22023';
    end case;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'COMP_SCORING_OPS_INVALID: a scoring change did not apply (row not found or not permitted).' using errcode = '42501';
    end if;
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end;
$;

revoke all on function public.apply_competition_scoring_setup(uuid, jsonb) from public, anon;
grant execute on function public.apply_competition_scoring_setup(uuid, jsonb) to authenticated;

comment on function public.apply_competition_scoring_setup(uuid, jsonb) is
  'SS1: applies a planned studio scoring setup (division selections, round updates, round inserts) in one transaction on an unlocked studio draft program. SECURITY INVOKER; the program row is held FOR SHARE so publish serializes with it.';

notify pgrst, 'reload schema';

commit;
