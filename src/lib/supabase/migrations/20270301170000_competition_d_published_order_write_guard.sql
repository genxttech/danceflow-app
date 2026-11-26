-- 20270301170000_competition_d_published_order_write_guard.sql
-- ============================================================================================================================================
-- NOT APPLIED ANYWHERE. DRAFT. Applying this migration to ANY hosted environment (DEV, PROD, staging) needs separate owner approval.
-- ============================================================================================================================================
--
-- Option D (owner conditional approval 2026-11-26, from the R-11 cancel-and-recreate finding): a PUBLISHED running order cannot be re-pointed by
-- direct table writes, including for heats that never ran.
--
-- Gap: event_competition_heats and event_competition_schedule_versions are writable by any event manager through the table API (policy
-- competition_manage, FOR ALL). The existing guards cover only part of a published order: the 10D guards cover heat entries, heat dances, floor
-- heats and heat DELETE; validate_competition_heat_schedule_placement checks only the NEW version and not round_id or heat_number; O1 freezes only
-- heats that have started. A never-run published heat can therefore be moved to another round, renumbered, detached from its version (after which it
-- and its entries are freely editable and it can be deleted), attached through a published numbered floor heat without a version, or removed by a
-- status write; and a published version can be returned to draft by a status write while no heat has run.
--
-- Rule, for every session that is not the owner role (postgres / supabase_admin), i.e. for direct client writes through PostgREST or SQL:
--   HEATS    a heat row is EDITABLE when its schedule version is null or a DRAFT, AND its numbered floor heat is null or belongs to a DRAFT
--            version, as far as the caller can see them (an invisible or unknown reference is NOT editable: fail closed).
--            INSERT: the new row must be editable. DELETE: the old row must be editable. UPDATE that changes a placement column (id, event, round,
--            division, contest, schedule version, floor heat, block, floor, heat number, order, scheduled times, status): old AND new must be
--            editable. Other columns (name, lock fields, configuration, updated_at) are not decided here.
--            A client row that references a numbered floor heat or a schedule block must also carry a schedule version (the foreign key and the
--            placement validator then force it to be that parent's version). Without this, a heat with no version under a DRAFT floor heat was
--            published with the order while its entries and dances stayed directly writable.
--            Publication refuses an order holding such a heat, and this migration refuses to apply while one sits in a published or past order.
--   VERSIONS a client may create a version only as draft/review, may not move a draft/review version into any other status (publication goes through
--            publish_competition_schedule_version), and on a version that left draft/review (published, live, superseded, archived) may change only
--            name and updated_at: no status, publication time, number, base or event change, and no delete.
-- Publication therefore changes: publish_competition_schedule_version becomes SECURITY DEFINER (it already requires can_manage_event_competition and
-- pins search_path), so its status writes are the only way to publish, and it locks the version row FOR UPDATE before validating. The change is a
-- pinned exact-text replacement (pre md5 9a61cd9bcdbe8557d76cd6ec9e72c82c, post md5 0fbbbef9670082fbb3cb2484d966dfa3); grants are unchanged (anon keeps EXECUTE as before and is refused by the
-- function's own manager check).
-- Legitimate writers are unaffected: SECURITY DEFINER lifecycle functions (floor planner on drafts, publication, publication copy, cancel round,
-- day-of heat calls, heat lock, CF1 advancement into the live order, and the future OD-26 audited running-order change, which writes floor heats
-- only) run as the owner role; the remaining SECURITY INVOKER writers (create_competition_schedule_version, apply_competition_heat_plan,
-- change_competition_entry_lifecycle) write drafts or heat-entry status, which this rule permits. Referential actions run as the table owner.
--
-- NOT closed here (reported in the PR): heat entry and heat dance STATUS writes are unchanged (U18 / U18-S own entry status); publication rows are
-- directly insertable; round name / sequence changes can relabel what a published heat shows; heat configuration is not decided; TRUNCATE is not
-- covered by row triggers (versions are granted to API roles; not reachable through PostgREST); advanced-mode schedule items have their own rules.
--
-- Changes: two new functions, two new triggers, one redefined function (publish_competition_schedule_version). No table, policy or grant change.
-- Rollback: rollback/20270301170000_competition_d_published_order_write_guard_rollback.sql (restores the pinned publication text, drops the rest).

begin;

do $$
begin
  if to_regclass('public.event_competition_floor_heats') is null or to_regclass('public.event_competition_schedule_versions') is null
     or to_regprocedure('public.publish_competition_schedule_version(uuid)') is null then
    raise exception 'D preflight: the 10D floor schedule (20261111090000) is missing.';
  end if;
  -- Rows already planted before this guard: never repaired silently.
  if exists (select 1 from public.event_competition_heats h
             join public.event_competition_floor_heats f on f.id = h.floor_heat_id
             join public.event_competition_schedule_versions v on v.id = f.schedule_version_id
             where v.status not in ('draft', 'review') and h.schedule_version_id is distinct from f.schedule_version_id)
     or exists (select 1 from public.event_competition_heats h
             join public.event_competition_schedule_blocks b on b.id = h.schedule_block_id
             join public.event_competition_schedule_versions v on v.id = b.schedule_version_id
             where v.status not in ('draft', 'review') and h.schedule_version_id is distinct from b.schedule_version_id) then
    raise exception 'D preflight: a heat already sits in a published or past running order without belonging to it; review it before applying.';
  end if;
end $$;

-- SECURITY INVOKER on purpose: current_user is the role running the statement (the function owner inside a SECURITY DEFINER writer; authenticated,
-- anon or service_role for a direct client write). Reads run under the caller's RLS, so a reference the caller cannot see counts as not editable.
create function public.compd_guard_published_heat()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_placement constant text[] := array['id', 'event_id', 'round_id', 'division_id', 'contest_id', 'schedule_version_id', 'floor_heat_id',
    'schedule_block_id', 'floor_id', 'floor_label', 'division_dance_id', 'heat_number', 'schedule_sequence', 'scheduled_at', 'estimated_ends_at',
    'duration_seconds', 'status'];
  v_floor_version uuid;
  v_refuse boolean := false;
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if not exists (select 1 from unnest(c_placement) k where (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k)) then
      return new;
    end if;
  end if;
  -- Every referenced version (directly, and through the numbered floor heat) must be a DRAFT. The version row is locked FOR SHARE, so a concurrent
  -- publication is waited for and then seen (the predicate is re-checked): a heat cannot slip into an order while it is being published.
  if tg_op <> 'INSERT' then
    if old.schedule_version_id is not null then
      perform 1 from public.event_competition_schedule_versions v where v.id = old.schedule_version_id and v.status = 'draft' for share;
      if not found then v_refuse := true; end if;
    end if;
    if old.floor_heat_id is not null then
      select f.schedule_version_id into v_floor_version from public.event_competition_floor_heats f where f.id = old.floor_heat_id;
      perform 1 from public.event_competition_schedule_versions v where v.id = v_floor_version and v.status = 'draft' for share;
      if not found then v_refuse := true; end if;
    end if;
    if v_refuse then
      raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: this heat is in a published running order; it cannot be moved, changed or removed by a direct write. Create a new version, or use the lifecycle action.'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.schedule_version_id is null and (new.floor_heat_id is not null or new.schedule_block_id is not null) then
    raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a heat placed in a numbered floor heat or schedule block must carry that running order''s version.'
      using errcode = '42501';
  end if;
  if new.schedule_version_id is not null then
    perform 1 from public.event_competition_schedule_versions v where v.id = new.schedule_version_id and v.status = 'draft' for share;
    if not found then v_refuse := true; end if;
  end if;
  if new.floor_heat_id is not null then
    v_floor_version := null;
    select f.schedule_version_id into v_floor_version from public.event_competition_floor_heats f where f.id = new.floor_heat_id;
    perform 1 from public.event_competition_schedule_versions v where v.id = v_floor_version and v.status = 'draft' for share;
    if not found then v_refuse := true; end if;
  end if;
  if v_refuse then
    raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a heat cannot be placed into a published running order by a direct write.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.compd_guard_published_heat() from public, anon, authenticated, service_role;

create function public.compd_guard_published_version()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'review') then
      raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a running order starts as a draft; it is published through publication.' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status in ('draft', 'review') then
    if tg_op = 'DELETE' then return old; end if;
    if new.status not in ('draft', 'review') then
      raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a running order is published only through publication, not by a direct write.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a published or past running order cannot be deleted.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['name', 'updated_at']) is distinct from (to_jsonb(old) - array['name', 'updated_at']) then
    raise exception 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED: a published or past running order cannot be reopened, replaced or re-dated by a direct write.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.compd_guard_published_version() from public, anon, authenticated, service_role;

-- zz_ names: fire after the existing guards, so their error codes are unchanged where they already refuse.
create trigger zz_compd_guard_published_heat
  before insert or update or delete on public.event_competition_heats
  for each row execute function public.compd_guard_published_heat();
create trigger zz_compd_guard_published_version
  before insert or update or delete on public.event_competition_schedule_versions
  for each row execute function public.compd_guard_published_version();
alter table public.event_competition_heats enable always trigger zz_compd_guard_published_heat;
alter table public.event_competition_schedule_versions enable always trigger zz_compd_guard_published_version;

-- Publication: SECURITY DEFINER and a row lock before validation (pinned exact-text replacement).
do $$
declare
  v_sig constant text := 'public.publish_competition_schedule_version(uuid)';
  v_pre constant text := '9a61cd9bcdbe8557d76cd6ec9e72c82c';
  v_post constant text := '0fbbbef9670082fbb3cb2484d966dfa3';
  v_old1 constant text := $o$ LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
$o$;
  v_new1 constant text := $n$ LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
$n$;
  v_old2 constant text := $o$    raise exception 'Schedule version was not found or cannot be published.';
  end if;
$o$;
  v_new2 constant text := $n$    raise exception 'Schedule version was not found or cannot be published.';
  end if;
  -- Option D: lock the version row BEFORE validating. A direct heat write holds it FOR SHARE, so publication waits for it and validates what
  -- committed; a later write waits for publication and then sees a version that is no longer a draft.
  perform 1 from public.event_competition_schedule_versions where id = selected_version_id and status in ('draft', 'review') for update;
  if not found then
    raise exception 'Schedule version was not found or cannot be published.';
  end if;
  -- Option D: a heat under one of this order's numbered floor heats or schedule blocks must belong to this order. Otherwise it would go live
  -- with the order while every version-based guard treats it as editable.
  if exists (select 1 from public.event_competition_heats h
             where h.schedule_version_id is distinct from selected_version_id
               and (h.floor_heat_id in (select f.id from public.event_competition_floor_heats f where f.schedule_version_id = selected_version_id)
                    or h.schedule_block_id in (select b.id from public.event_competition_schedule_blocks b where b.schedule_version_id = selected_version_id))) then
    raise exception 'COMPD_ORDER_HEAT_VERSION_MISMATCH: a heat sits in this running order without belonging to it; remove it or place it again before publishing.'
      using errcode = '23514';
  end if;
$n$;
  v_def text;
begin
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '');
  if md5(v_def) = v_post then
    return;
  end if;
  if md5(v_def) <> v_pre then
    raise exception 'D refused: % is not the pinned text (md5 %).', v_sig, md5(v_def);
  end if;
  if (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     or (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 then
    raise exception 'D: % does not hold each fragment exactly once.', v_sig;
  end if;
  v_def := replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  if md5(v_def) <> v_post then
    raise exception 'D: redefined text of % has md5 %.', v_sig, md5(v_def);
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_post then
    raise exception 'D: installed text of % does not match the pin.', v_sig;
  end if;
end $$;

do $$
begin
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.publish_competition_schedule_version(uuid)'::regprocedure)
     or (select count(*) from pg_trigger where tgname in ('zz_compd_guard_published_heat', 'zz_compd_guard_published_version') and not tgisinternal and tgenabled = 'A') <> 2
     or has_function_privilege('authenticated', 'public.compd_guard_published_heat()', 'execute')
     or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('compd_guard_published_heat', 'compd_guard_published_version') and not p.prosecdef) <> 2 then
    raise exception 'D postflight failed.';
  end if;
end $$;

commit;
