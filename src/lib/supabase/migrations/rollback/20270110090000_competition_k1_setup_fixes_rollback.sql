-- Rollback for 20270110090000_competition_k1_setup_fixes.sql
--
-- Restores the exact Phase 10B add_competition_division body. Refuses (changing nothing) unless the
-- live body is the K1 body, so a later redefinition is never overwritten. Roll the application back
-- first only if it depends on the K1 behaviour (it does not call anything new). Rows already created
-- by the K1 function keep their ordinal_majority Final: it is a valid value and is not rewritten.

begin;

do $pin$
declare
  v_count integer;
  v_md5 text;
begin
  select count(*), min(md5(p.prosrc)) into v_count, v_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'add_competition_division';
  if v_count <> 1 then
    raise exception 'K1 rollback preflight: expected exactly one public.add_competition_division, found %', v_count;
  end if;
  if v_md5 not in ('d503110a8f8b94109e0c2da46f2ddd08', 'b29d4ddc26c0cfe50279a54209f9c6f1') then
    raise exception 'K1 rollback refused: public.add_competition_division is not the K1 definition (md5 %)', v_md5;
  end if;
end
$pin$;

create or replace function public.add_competition_division(
  target_contest_id uuid,
  division_name text,
  skill_label text default null,
  age_label text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_contest record;
  v_program_status text;
  v_template uuid;
  v_new uuid;
  v_name text := btrim(coalesce(division_name, ''));
  v_sort integer;
  v_scoring text;
begin
  select c.id, c.event_id, c.program_id into v_contest from public.event_competition_contests c where c.id = target_contest_id;
  if v_contest.id is null or not public.can_manage_event_competition(v_contest.event_id) then
    raise exception 'Category was not found or cannot be managed.' using errcode = '42501';
  end if;
  select status, scoring_method into v_program_status, v_scoring from public.event_competition_programs where id = v_contest.program_id;
  if v_program_status not in ('draft', 'configured') then
    raise exception 'Divisions cannot be added once the competition is running.';
  end if;
  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'A division name of 1 to 200 characters is required.';
  end if;
  if exists (select 1 from public.event_competition_divisions d where d.contest_id = target_contest_id and lower(d.name) = lower(v_name)) then
    raise exception 'This category already has a division named %.', v_name;
  end if;

  select d.id into v_template from public.event_competition_divisions d
  where d.contest_id = target_contest_id order by d.sort_order, d.created_at limit 1;
  select coalesce(max(d.sort_order), 0) + 10 into v_sort from public.event_competition_divisions d where d.contest_id = target_contest_id;

  insert into public.event_competition_divisions (event_id, program_id, contest_id, name, skill_label, age_label, sort_order)
  values (v_contest.event_id, v_contest.program_id, target_contest_id, v_name,
          nullif(btrim(coalesce(skill_label, '')), ''), nullif(btrim(coalesce(age_label, '')), ''), v_sort)
  returning id into v_new;

  if v_template is not null then
    insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number,
                                                 target_advancement_count, scoring_method, pairing_mode, score_roles_separately,
                                                 minimum_panel_size, chief_judge_tiebreak)
    select event_id, program_id, v_new, name, round_type, sequence_number, target_advancement_count, scoring_method,
           pairing_mode, score_roles_separately, minimum_panel_size, chief_judge_tiebreak
    from public.event_competition_rounds where division_id = v_template;
    insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, active, sort_order)
    select event_id, program_id, v_new, dance_id, entry_fee, currency, required, active, sort_order
    from public.event_competition_division_dances where division_id = v_template;
  else
    insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
    values (v_contest.event_id, v_contest.program_id, v_new, 'Final', 'final', 1,
            case when v_scoring in ('ordinal_majority', 'proficiency_rating') then v_scoring else 'none' end);
  end if;
  return v_new;
end;
$$;

revoke all on function public.add_competition_division(uuid, text, text, text) from public, anon;
grant execute on function public.add_competition_division(uuid, text, text, text) to authenticated, service_role;

do $post$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'add_competition_division';
  if v_md5 not in ('38b617071133dabf87c3ac8249adde42', 'ba42ef12e5af6092d9c76949953f6b8d') then
    raise exception 'K1 rollback postflight: restored body does not match the 10B definition (md5 %)', v_md5;
  end if;
end
$post$;

commit;
