-- Rollback of 20270301102000_competition_r10_s3_attendance_panel_break.sql.
-- Restores the E2 record_competition_judge_attendance text byte for byte (copied from 20270102090000_competition_e2_ballots.sql) and its grants,
-- then drops the case table ONLY if it is empty: recovery cases are evidence and are never destroyed (forward-fix instead).
begin;
do $$
begin
  if to_regclass('public.event_competition_panel_recovery_cases') is not null then
    if exists (select 1 from public.event_competition_panel_recovery_cases) then
      raise exception 'R10-S3 rollback: panel recovery cases exist; they are evidence and are not dropped. Forward-fix instead.';
    end if;
  end if;
end $$;

drop function if exists public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean);

create function public.record_competition_judge_attendance(
  p_round_id uuid, p_official_id uuid, p_status text, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_ballot_events;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null or coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('absent', 'present') or p_official_id is null then
    raise exception 'COMP_ATTENDANCE_INVALID: status must be absent or present.' using errcode = 'P0001';
  end if;
  if p_status = 'absent' and (v_reason is null or length(v_reason) > 500) then
    raise exception 'COMP_ATTENDANCE_INVALID: an absence needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;
  perform public._compe2_lock_pair(p_round_id, p_official_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;

  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind in ('judge_absence_recorded', 'judge_presence_recorded') and v_prev.actor_user_id = v_uid
       and (v_prev.refs ->> 'fp') is not distinct from md5(p_status || '|' || coalesce(v_reason, ''))
       and v_prev.round_id = p_round_id and v_prev.official_id = p_official_id then
      return jsonb_build_object('replayed', true, 'official_id', p_official_id, 'status', (v_prev.refs ->> 'status'));
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('scheduled', 'active') then
    raise exception 'COMP_BALLOTS_BAD_STATE: attendance can be recorded while the round is scheduled or active (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public._compe2_round_judges(p_round_id) j where j.official_id = p_official_id) then
    raise exception 'COMP_JUDGE_NOT_ASSIGNED: the official is not a judge on this round''s panel.' using errcode = 'P0001';
  end if;
  if p_status = 'absent' and exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id and b.official_id = p_official_id) then
    raise exception 'COMP_ABSENCE_HAS_BALLOTS: the judge already has ballots in this round; they cannot be recorded absent.' using errcode = 'P0001';
  end if;

  insert into public.event_competition_judge_attendance (event_id, round_id, official_id, status, reason, recorded_by)
  values (v_round.event_id, p_round_id, p_official_id, p_status, v_reason, v_uid);
  perform public._compe2_audit(v_round.event_id, p_round_id, null,
    case when p_status = 'absent' then 'judge_absence_recorded' else 'judge_presence_recorded' end,
    v_uid, p_official_id, null, null, null, p_request_id, v_reason, jsonb_build_object('fp', md5(p_status || '|' || coalesce(v_reason, '')), 'status', p_status, 'actor_role', v_role));
  return jsonb_build_object('replayed', false, 'official_id', p_official_id, 'status', p_status);
end;
$$;

revoke all on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid) to authenticated;

drop table if exists public.event_competition_panel_recovery_cases;
drop function if exists public._comp_r10_guard_recovery_case();
commit;
