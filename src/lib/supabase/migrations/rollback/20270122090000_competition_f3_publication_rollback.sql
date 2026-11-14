-- Rollback for 20270122090000_competition_f3_publication.sql. App first (hide the publish / withdraw controls), then this file.
-- Refuses once any publication row or any F3 audit row exists: publication is evidence and is rolled forward, never deleted.
begin;

do $$
begin
  if to_regclass('public.event_competition_result_publications') is null then
    raise exception 'F3 rollback: F3 is not installed.';
  end if;
  lock table public.event_competition_result_publications in access exclusive mode;
  if exists (select 1 from public.event_competition_result_publications) then
    raise exception 'F3 rollback refused: publication rows exist (evidence); roll forward instead.';
  end if;
  if exists (select 1 from public.event_competition_result_events where kind in ('result_published', 'result_superseded', 'result_withdrawn')) then
    raise exception 'F3 rollback refused: F3 audit rows exist; roll forward instead.';
  end if;
end $$;

-- Restore the two CF1 consumers to their pre-F3 text.
do $$
declare
  v_def text;
  v_new constant text := E'    if old.status = ''published'' then\n      raise exception ''COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3';
  v_old constant text := E'    if old.status = ''published'' and (public._compf3_current_publication(new.id) is not null or not exists (select 1 from public.event_competition_result_publications pz where pz.round_id = new.id)) then\n      raise exception ''COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3';
begin
  v_def := replace(pg_get_functiondef('public.cf1_guard_advancement_correction()'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'F3 rollback: A0 correction guard does not contain the F3 anchor exactly once.';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;
do $$
declare
  v_def text;
  v_new constant text := 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1)';
  v_old constant text := 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1 and p.withdrawn_at is null and p.superseded_by is null)';
begin
  v_def := replace(pg_get_functiondef('public._a5_cf1_require_no_publication(uuid)'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'F3 rollback: A5 publication check does not contain the F3 anchor exactly once.';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

drop function public.competition_my_results(uuid);
drop function public.competition_event_results_public(uuid);
drop function public.competition_round_results_public(uuid);
drop function public.competition_round_publications(uuid);
drop function public.withdraw_competition_round_result(uuid, uuid, text, uuid);
drop function public.publish_competition_round_result(uuid, uuid, text, uuid);
drop trigger compf3_guard_round_status on public.event_competition_rounds;
drop function public._compf3_guard_round_status();
drop table public.event_competition_result_publications;
drop function public._compf3_viewer_entries(uuid, uuid);
drop function public._compf3_payload(uuid, uuid[], boolean);
drop function public._compf3_live(uuid);
drop function public._compf3_current_publication(uuid);
drop function public._compf3_guard_publication_update();
drop function public._compf3_guard_publication_insert();

alter table public.event_competition_result_events drop constraint event_competition_result_events_kind_check;
alter table public.event_competition_result_events add constraint event_competition_result_events_kind_check
  check (kind = any (array['round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated',
                           'advancement_applied', 'advancement_revoked']));

commit;
