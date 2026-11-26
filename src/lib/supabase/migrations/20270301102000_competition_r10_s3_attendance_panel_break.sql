-- 20270301102000_competition_r10_s3_attendance_panel_break.sql
--
-- COMPETITION R-10 part 3 (S3): judge attendance is re-evaluated against the Studio panel rule at every change, serialized per round, and an
-- absence after start that would leave a panel the lock cannot accept needs explicit confirmation and opens an auditable recovery CASE.
-- DRAFT FOR REVIEW. NOT APPLIED to DEV or PROD. Design: PR 858 sections 5.3, 6 and 14 (findings 5, 8).
--
--   1. New table event_competition_panel_recovery_cases (one open case per round; immutable snapshot; managers read; no direct writes).
--   2. record_competition_judge_attendance gains p_confirm_panel_break boolean default false. The 5-argument function is DROPPED in this file
--      so PostgREST sees one candidate; an older app calling with five named arguments resolves to the new function with the default false.
--      The body is the E2 body plus: a per-round advisory lock, the panel evaluation over the lock's judge set, the confirm refusal
--      (COMP_PANEL_BREAK_CONFIRM_REQUIRED), the case snapshot, and auto-close of an open case when the panel is valid again by any route.
--      Authorization, reason rules, COMP_ABSENCE_HAS_BALLOTS, idempotency and the audit event kinds are unchanged (the ballot_events kind CHECK is
--      not touched: the break is recorded in the audit refs and in the case row).
--   3. Recovery ACTIONS (return to scheduled, withdraw after ballots) are NOT in this file: they need amendments to the O1 status guard and the
--      ballot readers (review findings 2 and 6) and stay design-only in PR 858. A case without an action leaves cancellation as the exit until
--      the recovery slice ships; the case record and snapshot preserve the evidence.
-- Rollback: rollback/20270301102000_competition_r10_s3_attendance_panel_break_rollback.sql (restores the E2 text byte for byte; refuses to drop
-- the table if any case exists: evidence is never destroyed, forward-fix instead).

begin;

do $$
begin
  if to_regprocedure('public.record_competition_judge_attendance(uuid, uuid, text, text, uuid)') is null
     or to_regprocedure('public._comp_r10_panel_check(uuid, uuid)') is null then
    raise exception 'R10-S3-3 preflight: E2 attendance function or R10-S3 readiness (20270301100000) is missing.';
  end if;
  if to_regprocedure('public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean)') is not null
     or to_regclass('public.event_competition_panel_recovery_cases') is not null then
    raise exception 'R10-S3-3 preflight: already applied (roll back or clean up first).';
  end if;
end $$;

create table public.event_competition_panel_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null references public.event_competition_rounds(id) on delete cascade,
  status text not null default 'open',
  opened_by uuid not null,
  opened_at timestamptz not null default now(),
  opened_reason text,
  opened_request_id uuid not null,
  panel_snapshot jsonb not null,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text,
  constraint event_competition_panel_recovery_cases_status_check check (status in ('open', 'resolved_restored')),
  constraint event_competition_panel_recovery_cases_reason_check check (opened_reason is null or length(opened_reason) <= 500),
  constraint event_competition_panel_recovery_cases_resolved_check check ((status = 'open') = (resolved_at is null))
);
create unique index event_competition_panel_recovery_cases_one_open on public.event_competition_panel_recovery_cases(round_id) where status = 'open';
create unique index event_competition_panel_recovery_cases_request on public.event_competition_panel_recovery_cases(opened_request_id);

create function public._comp_r10_guard_recovery_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'COMP_RECOVERY_IMMUTABLE: panel recovery cases cannot be truncated.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.events e where e.id = old.event_id) and exists (select 1 from public.event_competition_rounds r where r.id = old.round_id) then
      raise exception 'COMP_RECOVERY_IMMUTABLE: panel recovery cases cannot be deleted.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status <> 'open' or new.id is distinct from old.id or new.event_id is distinct from old.event_id or new.round_id is distinct from old.round_id
     or new.opened_by is distinct from old.opened_by or new.opened_at is distinct from old.opened_at
     or new.opened_reason is distinct from old.opened_reason or new.opened_request_id is distinct from old.opened_request_id
     or new.panel_snapshot is distinct from old.panel_snapshot then
    raise exception 'COMP_RECOVERY_IMMUTABLE: a panel recovery case can only be resolved once.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._comp_r10_guard_recovery_case() from public, anon, authenticated, service_role;
create trigger comp_r10_guard_recovery_case_row before update or delete on public.event_competition_panel_recovery_cases
  for each row execute function public._comp_r10_guard_recovery_case();
create trigger comp_r10_guard_recovery_case_truncate before truncate on public.event_competition_panel_recovery_cases
  for each statement execute function public._comp_r10_guard_recovery_case();
alter table public.event_competition_panel_recovery_cases enable always trigger comp_r10_guard_recovery_case_row;
alter table public.event_competition_panel_recovery_cases enable always trigger comp_r10_guard_recovery_case_truncate;

alter table public.event_competition_panel_recovery_cases enable row level security;
create policy competition_panel_recovery_manager_read on public.event_competition_panel_recovery_cases
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_panel_recovery_cases from public, anon, authenticated, service_role;
grant select on public.event_competition_panel_recovery_cases to authenticated, service_role;

drop function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid);

create function public.record_competition_judge_attendance(
  p_round_id uuid, p_official_id uuid, p_status text, p_reason text, p_request_id uuid, p_confirm_panel_break boolean default false
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
  v_fp text;
  v_after jsonb;
  v_case uuid;
  v_case_opened boolean := false;
  v_case_closed boolean := false;
  v_before jsonb;
  v_break_confirmed boolean := false;
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
  -- R10-S3: the fingerprint carries the confirm flag only when true, so a replay of an older request keeps its fingerprint.
  v_fp := md5(p_status || '|' || coalesce(v_reason, '') || case when coalesce(p_confirm_panel_break, false) then '|confirm' else '' end);
  perform public._compe2_lock_pair(p_round_id, p_official_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for share;

  select * into v_prev from public.event_competition_ballot_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind in ('judge_absence_recorded', 'judge_presence_recorded') and v_prev.actor_user_id = v_uid
       and (v_prev.refs ->> 'fp') is not distinct from v_fp
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

  -- R10-S3: serialize attendance changes of one round (two individually acceptable absences must not jointly break the panel unnoticed).
  -- Lock order shared with the official-status trigger below: the official row first, then the per-round advisory lock.
  perform 1 from public.event_competition_officials o where o.id = p_official_id for share;
  perform pg_advisory_xact_lock(hashtextextended('comp_r10_panel:' || p_round_id::text, 0));
  select c.id into v_case from public.event_competition_panel_recovery_cases c where c.round_id = p_round_id and c.status = 'open';
  v_before := public._comp_r10_panel_check(p_round_id, null);
  insert into public.event_competition_judge_attendance (event_id, round_id, official_id, status, reason, recorded_by)
  values (v_round.event_id, p_round_id, p_official_id, p_status, v_reason, v_uid);
  if v_round.status = 'active' then
    -- Evaluate the REAL resulting panel (after the insert) through the same helpers the lock uses, so any definition of _compe2_is_absent
    -- (for example JC1: a deactivated judge without a ballot counts as absent) is honored. A refusal rolls the insert back.
    v_after := public._comp_r10_panel_check(p_round_id, null);
    -- Confirmation is required for the change that strands the round (a valid panel becoming invalid). Later changes on an already invalid
    -- panel are recorded and audited without a second confirmation. An invalid panel on a started round always has an open case.
    if (v_after ->> 'known')::boolean and not (v_after ->> 'rule_ok')::boolean then
      if (v_before ->> 'rule_ok')::boolean and not coalesce(p_confirm_panel_break, false) then
        raise exception 'COMP_PANEL_BREAK_CONFIRM_REQUIRED: recording this change leaves % present judge(s); this scoring method needs at least % and an odd panel, so the round could not lock its ballots. Confirm to record it and keep a panel recovery case.',
          v_after ->> 'present', v_after ->> 'rule_min' using errcode = 'P0001', detail = v_after::text;
      end if;
      v_break_confirmed := (v_before ->> 'rule_ok')::boolean;
      if v_case is null then
        insert into public.event_competition_panel_recovery_cases (event_id, round_id, opened_by, opened_reason, opened_request_id, panel_snapshot)
        values (v_round.event_id, p_round_id, v_uid, v_reason, p_request_id,
                jsonb_build_object('after', v_after, 'official_id', p_official_id, 'change', p_status,
                  'judges', coalesce((select jsonb_agg(jsonb_build_object('official_id', j.official_id, 'letter', j.judge_letter,
                                        'absent', public._compe2_is_absent(p_round_id, j.official_id)) order by j.judge_letter)
                                      from public._compe2_round_judges(p_round_id) j), '[]'::jsonb)))
        returning id into v_case;
        v_case_opened := true;
      end if;
    end if;
  end if;
  perform public._compe2_audit(v_round.event_id, p_round_id, null,
    case when p_status = 'absent' then 'judge_absence_recorded' else 'judge_presence_recorded' end,
    v_uid, p_official_id, null, null, null, p_request_id, v_reason, jsonb_build_object('fp', v_fp, 'status', p_status, 'actor_role', v_role, 'panel_break_confirmed', v_break_confirmed, 'recovery_case_opened', v_case_opened,
                       'recovery_case_id', case when v_case_opened then v_case end));
  -- Any attendance change that makes the panel valid again closes an open case, by any route.
  if v_case is not null and not v_case_opened and (public._comp_r10_panel_check(p_round_id, null) ->> 'rule_ok')::boolean then
    update public.event_competition_panel_recovery_cases
       set status = 'resolved_restored', resolved_by = v_uid, resolved_at = now(), resolution = 'panel valid again after an attendance change'
     where id = v_case;
    v_case_closed := true;
  end if;
  return jsonb_build_object('replayed', false, 'official_id', p_official_id, 'status', p_status,
                            'recovery_case_opened', v_case_opened, 'recovery_case_closed', v_case_closed);
end;
$$;

revoke all on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean) from public, anon;
grant execute on function public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean) to authenticated;

-- Attendance is not the only way presence changes: deactivating or reactivating an official after a round has started changes the panel the
-- lock sees (JC1 counts a deactivated judge without a ballot as absent). The change is never blocked (revoking an official must stay
-- possible); every active round whose panel it leaves failing the size / parity rule gets an auditable recovery case, and a case closes when the
-- panel is valid again. Not covered: a judge with some ballots who becomes inactive stays counted (no case), and ballot reopen does not re-evaluate.
create function public._comp_r10_official_status_panel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_chk jsonb;
  v_case uuid;
  v_actor uuid;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  v_actor := coalesce(auth.uid(), case when new.status = 'inactive' then new.deactivated_by end, new.user_id);
  for r in
    select distinct rd.id, rd.event_id
    from public.event_competition_panel_assignments a
    join public.event_competition_rounds rd on rd.id = a.round_id
    where a.official_id = new.id and a.judge_letter is not null and rd.status = 'active'
    order by rd.id
  loop
    -- Serialize with lock / cancel (round FOR UPDATE) and re-check: a round that left active gets no case. Order: official, round, advisory.
    perform 1 from public.event_competition_rounds rr where rr.id = r.id and rr.status = 'active' for share;
    if not found then
      continue;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('comp_r10_panel:' || r.id::text, 0));
    v_chk := public._comp_r10_panel_check(r.id, null);
    select c.id into v_case from public.event_competition_panel_recovery_cases c where c.round_id = r.id and c.status = 'open';
    if (v_chk ->> 'known')::boolean and not (v_chk ->> 'rule_ok')::boolean and v_case is null then
      insert into public.event_competition_panel_recovery_cases (event_id, round_id, opened_by, opened_reason, opened_request_id, panel_snapshot)
      values (r.event_id, r.id, v_actor, 'official status changed to ' || new.status, gen_random_uuid(),
              jsonb_build_object('after', v_chk, 'official_id', new.id, 'change', 'official_' || new.status,
                'judges', coalesce((select jsonb_agg(jsonb_build_object('official_id', j.official_id, 'letter', j.judge_letter,
                                      'absent', public._compe2_is_absent(r.id, j.official_id)) order by j.judge_letter)
                                    from public._compe2_round_judges(r.id) j), '[]'::jsonb)));
    elsif v_case is not null and (v_chk ->> 'rule_ok')::boolean then
      update public.event_competition_panel_recovery_cases
         set status = 'resolved_restored', resolved_by = v_actor, resolved_at = now(), resolution = 'panel valid again after an official status change'
       where id = v_case;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public._comp_r10_official_status_panel() from public, anon, authenticated, service_role;
create trigger compr10_official_status_panel after update of status on public.event_competition_officials
  for each row execute function public._comp_r10_official_status_panel();
alter table public.event_competition_officials enable always trigger compr10_official_status_panel;

comment on table public.event_competition_panel_recovery_cases is
  'R10-S3: panel recovery cases opened when a confirmed absence after start leaves a panel the ballot lock cannot accept. Manager read; written only by record_competition_judge_attendance and the official-status trigger.';

commit;
