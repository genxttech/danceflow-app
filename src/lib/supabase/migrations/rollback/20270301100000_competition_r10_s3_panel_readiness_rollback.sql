-- Rollback of 20270301100000_competition_r10_s3_panel_readiness.sql. Roll back 20270301102000 first (it depends on the helper).
-- Restores the E1 competition_round_panel_status text byte for byte (copied from 20270101090000_competition_e1_officials.sql) and drops the helper.
begin;
do $$
begin
  if to_regprocedure('public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean)') is not null then
    raise exception 'R10-S3 rollback: roll back 20270301102000 first.';
  end if;
end $$;

create or replace function public.competition_round_panel_status(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_min integer := 1;
  v_judges integer;
  v_scorers integer;
  v_chair boolean;
  v_missing text[] := '{}';
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or (auth.uid() is not null and not public.can_manage_event_competition(v_round.event_id)) then
    return jsonb_build_object('ready', false, 'missing', jsonb_build_array('unavailable'));
  end if;
  if (v_round.configuration ->> 'min_panel_judges') ~ '^[0-9]{1,2}$' then
    v_min := greatest(1, (v_round.configuration ->> 'min_panel_judges')::integer);
  end if;
  select count(*) filter (where o.role in ('judge', 'chair') and a.judge_letter is not null),
         count(*) filter (where o.role = 'scorer')
    into v_judges, v_scorers
  from public.event_competition_panel_assignments a
  join public.event_competition_officials o on o.id = a.official_id and o.event_id = a.event_id
  where a.round_id = p_round_id and o.status = 'active'
    and public.verified_email_for_user(o.user_id) is not null
    and public._comp_e1_is_team_member(o.event_id, o.user_id);
  select exists (select 1 from public.event_competition_officials o
                 where o.event_id = v_round.event_id and o.role = 'chair' and o.status = 'active'
                   and public.verified_email_for_user(o.user_id) is not null
                   and public._comp_e1_is_team_member(o.event_id, o.user_id)) into v_chair;
  if v_judges < v_min then v_missing := array_append(v_missing, 'judges'); end if;
  return jsonb_build_object(
    'ready', v_judges >= v_min,
    'judge_count', v_judges,
    'min_judges', v_min,
    'scorer_count', v_scorers,
    'chair_designated', v_chair,
    'missing', to_jsonb(v_missing));
end;
$$;

drop function if exists public._comp_r10_panel_check(uuid, uuid);
commit;
