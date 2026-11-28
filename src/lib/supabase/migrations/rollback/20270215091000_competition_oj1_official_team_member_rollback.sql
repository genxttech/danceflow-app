-- Rollback for 20270215091000_competition_oj1_official_team_member.sql (OJ-1 E2 team-member condition).
-- Restores the exact pinned pre-OJ-1 texts of the five functions by reversing each fragment replacement, after verifying that the installed
-- text still is the post-OJ-1 text (md5). Order: app first (the app does not depend on this file), then this file.

begin;

create function pg_temp.oj1_pin_restore(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_post then
    raise exception 'OJ-1 rollback refused: % is not the post-OJ-1 text (md5 %, expected %); it changed since OJ-1.', p_sig, md5(v_def), p_post;
  end if;
  for v_i in reverse array_length(p_olds, 1) .. 1 loop
    if (length(v_def) - length(replace(v_def, p_news[v_i], ''))) / length(p_news[v_i]) <> 1 then
      raise exception 'OJ-1 rollback refused: % does not hold OJ-1 text % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_news[v_i], p_olds[v_i]);
  end loop;
  if md5(v_def) <> p_pre then
    raise exception 'OJ-1 rollback refused: restored % does not match the pinned pre-OJ-1 text.', p_sig;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_pre then
    raise exception 'OJ-1 rollback: installed text of % does not match the pinned pre-OJ-1 md5 after restore.', p_sig;
  end if;
end $$;

select pg_temp.oj1_pin_restore('public._compe2_round_role(uuid)', '4a8ec9b0e3515519a637bceb02ed09f0', 'a7d7a235d9522a073312807df3ff11f9',
  array[$o$o.role = 'chair' and o.status = 'active') then$o$,
        $o$o.role = 'scorer' and o.status = 'active' and a.round_id = p_round_id) then$o$],
  array[$n$o.role = 'chair' and o.status = 'active'
               and public._comp_e1_is_team_member(o.event_id, o.user_id)) then$n$,
        $n$o.role = 'scorer' and o.status = 'active' and a.round_id = p_round_id
               and public._comp_e1_is_team_member(o.event_id, o.user_id)) then$n$]);

select pg_temp.oj1_pin_restore('public.submit_competition_ballot(uuid,uuid,jsonb,uuid,text)', '0431bca511e02c46d70969d728cd9f02', '0df585c22f7680da7c83b35ec5230d29',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_restore('public.save_competition_callback_draft(uuid,uuid[])', '21ec33c3ab9188944d5db27bf3b2c79f', '781193f0b3e19cdb964fe98cfc7e524d',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_restore('public.competition_judge_ballot_sheet(uuid)', '2506cb2f466d1738fb1a8f298e805b5f', '8e129175282c88ed3590e3d162fbb47c',
  array[$o$o.status = 'active' and o.role in ('judge', 'chair')$o$],
  array[$n$o.status = 'active' and o.role in ('judge', 'chair') and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

select pg_temp.oj1_pin_restore('public.competition_round_no_shows(uuid)', 'e4caefe9a8c78c7d198ae91c4f395700', 'd235ea7e04836a4d1c84170279c6ffe4',
  array[$o$o.user_id = v_uid and o.status = 'active'$o$],
  array[$n$o.user_id = v_uid and o.status = 'active' and public._comp_e1_is_team_member(o.event_id, o.user_id)$n$]);

drop function pg_temp.oj1_pin_restore(text, text, text, text[], text[]);

commit;
