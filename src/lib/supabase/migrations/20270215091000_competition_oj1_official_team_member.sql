-- 20270215091000_competition_oj1_official_team_member.sql
-- OJ-1 (owner decision 2026-11-10), security review P2 fix: "revoked or ended assignments lose access immediately".
--
-- E1's own authority (my_competition_judging_assignments, competition_is_active_official, competition_round_panel_status) requires the official
-- to still be a team member of the event's studio or organizer (_comp_e1_is_team_member). E2's round role and the judge-facing ballot functions
-- checked only an active official row, so an official removed from the team (whose official row is not deactivated) kept chair/scorer/judge
-- access. This file adds the SAME E1 condition to those checks. No new rule: the E1 helper is reused unchanged.
--
-- Redefined by exact-fragment insert, md5 pinned before and after (as F2/HL1/A3/PV-1):
--   _compe2_round_role(uuid)                                   chair and scorer branches
--   submit_competition_ballot(uuid,uuid,jsonb,uuid,text)       own panel assignment
--   save_competition_callback_draft(uuid,uuid[])               own panel assignment
--   competition_judge_ballot_sheet(uuid)                       own panel assignment
--   competition_round_no_shows(uuid)                           panel judge reader
-- Managers (can_manage_event_competition) are unchanged.
-- Rollback: rollback/20270215091000_competition_oj1_official_team_member_rollback.sql. Order: SQL before app (the app does not depend on it).

begin;

create function pg_temp.oj1_pin_replace(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_pre then
    raise exception 'OJ-1 preflight: % differs from the pinned text (md5 %, expected %); coordinate before changing it.', p_sig, md5(v_def), p_pre;
  end if;
  for v_i in 1 .. array_length(p_olds, 1) loop
    if (length(v_def) - length(replace(v_def, p_olds[v_i], ''))) / length(p_olds[v_i]) <> 1 then
      raise exception 'OJ-1 preflight: % does not contain anchor % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_olds[v_i], p_news[v_i]);
  end loop;
  if md5(v_def) <> p_post then
    raise exception 'OJ-1: redefined text of % has md5 % (expected %).', p_sig, md5(v_def), p_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_post then
    raise exception 'OJ-1: installed text of % does not match the expected post-OJ-1 md5.', p_sig;
  end if;
end $$;

do $$
begin
  if to_regprocedure('public._comp_e1_is_team_member(uuid,uuid)') is null then
    raise exception 'OJ-1 preflight: E1 team-member helper is missing.';
  end if;
end $$;

select pg_temp.oj1_pin_replace('public._compe2_round_role(uuid)', '4a8ec9b0e3515519a637bceb02ed09f0', 'a7d7a235d9522a073312807df3ff11f9',
  array[$o$o.role = 'chair' and o.status = 'active') then$o$,
        $o$o.role = 'scorer' and o.status = 'active' and a.round_id = p_round_id) then$o$],
  array[$n$o.role = 'chair' and o.status = 'active'
               and public._comp_e1_is_team_member(o.event_id, o.user_id)) then$n$,
        $n$o.role = 'scorer' and o.status = 'active' and a.round_id = p_round_id
               and public._comp_e1_is_team_member(o.event_id, o.user_id)) then$n$]);

select pg_temp.oj1_pin_replace('public.submit_competition_ballot(uuid,uuid,jsonb,uuid,text)', '0431bca511e02c46d70969d728cd9f02', '0df585c22f7680da7c83b35ec5230d29',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_replace('public.save_competition_callback_draft(uuid,uuid[])', '21ec33c3ab9188944d5db27bf3b2c79f', '781193f0b3e19cdb964fe98cfc7e524d',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_replace('public.competition_judge_ballot_sheet(uuid)', '2506cb2f466d1738fb1a8f298e805b5f', '8e129175282c88ed3590e3d162fbb47c',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_replace('public.competition_round_no_shows(uuid)', 'e4caefe9a8c78c7d198ae91c4f395700', 'd235ea7e04836a4d1c84170279c6ffe4',
  array[$o$o.user_id = v_uid and o.status = 'active'$o$],
  array[$n$o.user_id = v_uid and o.status = 'active' and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

drop function pg_temp.oj1_pin_replace(text, text, text, text[], text[]);

commit;
