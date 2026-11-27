-- Rollback for 20270301170000_competition_d_published_order_write_guard.sql (Option D). NOT APPLIED ANYWHERE.
-- Drops the nine triggers and three functions the migration created, recreates the dropped client insert policy of publication snapshots and restores publish_competition_schedule_version to its exact pinned previous text
-- (md5 9a61cd9bcdbe8557d76cd6ec9e72c82c: security invoker, no row lock). No table or grant was changed. No data is touched. Restoring RE-OPENS direct writes to
-- published running orders, the publication race and client-inserted publication snapshot rows.

begin;

drop trigger if exists zz_compd_guard_published_heat on public.event_competition_heats;
drop trigger if exists zz_compd_guard_published_version on public.event_competition_schedule_versions;
drop function if exists public.compd_guard_published_heat();
drop function if exists public.compd_guard_published_version();

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
  if md5(v_def) = v_pre then
    return;
  end if;
  if md5(v_def) <> v_post then
    raise exception 'D rollback refused: % is not the pinned text (md5 %).', v_sig, md5(v_def);
  end if;
  if (length(v_def) - length(replace(v_def, v_new1, ''))) / length(v_new1) <> 1
     or (length(v_def) - length(replace(v_def, v_new2, ''))) / length(v_new2) <> 1 then
    raise exception 'D: % does not hold each fragment exactly once.', v_sig;
  end if;
  v_def := replace(replace(v_def, v_new2, v_old2), v_new1, v_old1);
  if md5(v_def) <> v_pre then
    raise exception 'D: redefined text of % has md5 %.', v_sig, md5(v_def);
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_pre then
    raise exception 'D: installed text of % does not match the pin.', v_sig;
  end if;
end $$;

drop trigger if exists cf1_compd_lock_heat on public.event_competition_heats;
drop trigger if exists cf1_compd_lock_heat_entry on public.event_competition_heat_entries;
drop trigger if exists cf1_compd_lock_heat_dance on public.event_competition_heat_dances;
drop trigger if exists cf1_compd_lock_floor_heat on public.event_competition_floor_heats;
drop trigger if exists cf1_compd_lock_session on public.event_competition_schedule_sessions;
drop trigger if exists cf1_compd_lock_block on public.event_competition_schedule_blocks;
drop trigger if exists cf1_compd_lock_block_contest on public.event_competition_schedule_block_contests;
drop function if exists public.compd_lock_draft_order();
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'event_competition_schedule_publications' and policyname = 'competition_publications_insert') then
    execute $p$create policy competition_publications_insert on public.event_competition_schedule_publications
  for insert to authenticated with check (public.can_manage_event_competition(event_id));
$p$;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_trigger where tgname like '%\_compd\_%' and not tgisinternal)
     or exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'compd\_%')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'event_competition_schedule_publications' and policyname = 'competition_publications_insert')
     or (select p.prosecdef from pg_proc p where p.oid = 'public.publish_competition_schedule_version(uuid)'::regprocedure) then
    raise exception 'D rollback incomplete.';
  end if;
end $$;

commit;
