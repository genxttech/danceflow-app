-- Rollback of JC1: restore the E2 definition of _compe2_is_absent (attendance only).
create or replace function public._compe2_is_absent(p_round_id uuid, p_official_id uuid)
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
