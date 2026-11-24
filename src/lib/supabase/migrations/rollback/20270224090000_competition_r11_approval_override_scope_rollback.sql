-- Rollback for 20270224090000_competition_r11_approval_override_scope.sql (R-11 correction). NOT APPLIED ANYWHERE.
-- Restores the exact pinned pre-migration text of public.approve_competition_round_result(uuid,uuid,text,uuid) (post A3 + PV-1, md5 3cf63c3b...,
-- the text F2 + A3 + PV-1 produce) by reversing the three exact-fragment replacements, and only if the installed text still is the post-migration text
-- (md5 5adf8f1680306964abb688068616b4ce). create or replace keeps owner, SECURITY DEFINER, search_path and the ACL; nothing else is created, altered or dropped.
-- Restoring this text RE-OPENS RB-11.1 and RB-11.2 (one-character override reason; override reachable for corrected result versions).
-- Stored approval rows and audit events written while the migration was live are not touched (an event written under the new text carries an extra
-- refs.initial key; the table schemas are unchanged, so old readers ignore it).
-- Order: R-11 must be rolled back BEFORE any rollback of PV-1 or A3 (their rollbacks pin the pre-R-11 text and refuse otherwise). No app change needed.

begin;

do $$
declare
  v_sig constant text := 'public.approve_competition_round_result(uuid,uuid,text,uuid)';
  v_pre constant text := '3cf63c3bb00a78142ea2c8e70a8b4a0c';
  v_post constant text := '5adf8f1680306964abb688068616b4ce';
  v_old1 constant text := $o$  v_override boolean;
$o$;
  v_new1 constant text := $n$  v_override boolean;
  v_initial boolean;
  v_opener boolean;
$n$;
  v_old2 constant text := $o$  v_override := v_ver.calculated_by = v_uid;
  if v_override and (v_reason is null or length(v_reason) > 500) then
    raise exception 'COMP_SECOND_APPROVER_REQUIRED: a second manager must approve; the calculator may approve only with an override reason (1-500 characters).'
      using errcode = 'P0001';
  end if;
$o$;
  v_new2 constant text := $n$  -- R-11 (owner 2026-11-24): the single-staff override exists for the INITIAL approval of a round only. Initial or corrected comes from append-only
  -- history (an approval of another version, an A7 correction cause, an F2 correction audit event), read under the round lock held since the top.
  v_initial := not exists (select 1 from public.event_competition_result_approvals a
                           join public.event_competition_result_versions pv on pv.id = a.result_version_id and pv.event_id = a.event_id
                           where pv.round_id = p_round_id and a.result_version_id <> v_ver.id)
           and not exists (select 1 from public.event_competition_correction_causes c where c.round_id = p_round_id and c.event_id = v_round.event_id)
           and not exists (select 1 from public.event_competition_result_events e
                           where e.round_id = p_round_id and e.event_id = v_round.event_id and e.kind = 'round_state_changed'
                             and e.to_state = 'ballots_locked' and e.refs ->> 'correction' = 'true');
  v_override := v_ver.calculated_by = v_uid;
  if not v_initial then
    -- A corrected result needs an independent approver: neither its calculator nor anyone who opened a correction of the round. No override.
    v_opener := exists (select 1 from public.event_competition_correction_causes c where c.round_id = p_round_id and c.event_id = v_round.event_id and c.opened_by = v_uid)
             or exists (select 1 from public.event_competition_result_events e
                        where e.round_id = p_round_id and e.event_id = v_round.event_id and e.kind = 'round_state_changed'
                          and e.to_state = 'ballots_locked' and e.refs ->> 'correction' = 'true' and e.actor_user_id = v_uid);
    if v_override or v_opener then
      raise exception 'COMP_CORRECTION_APPROVER_REQUIRED: a corrected result must be approved by an independent manager: not its calculator and not the person who opened the correction. The single-staff override applies to the initial approval only.'
        using errcode = 'P0001';
    end if;
  elsif v_override and (not public._cf1_reason_is_substantive(v_reason)
                        -- review hardening: padding (NBSP, zero-width, punctuation) cannot satisfy the length or word rules; real letters/digits and real words are counted
                        or length(regexp_replace(v_reason, '[^[:alnum:]]', '', 'g')) < 12
                        or (select count(*) from regexp_split_to_table(v_reason, '[[:space:]]+') w where w ~ '[[:alnum:]]') < 4) then
    raise exception 'COMP_SECOND_APPROVER_REQUIRED: a second manager must approve; the calculator may approve an initial result only with a substantive override reason (20-500 characters, at least four words).'
      using errcode = 'P0001';
  end if;
$n$;
  v_old3 constant text := $o$'override', v_override));$o$;
  v_new3 constant text := $n$'override', v_override, 'initial', v_initial));$n$;
  v_def text;
begin
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '');
  if md5(v_def) = v_pre then
    raise notice 'R-11 rollback: % already has the pre-migration text (md5 %); nothing to do.', v_sig, v_pre;
    return;
  end if;
  if md5(v_def) <> v_post then
    raise exception 'R-11 rollback refused: % is not the post-migration text (md5 %, expected %); it changed since the migration.', v_sig, md5(v_def), v_post;
  end if;
  if (length(v_def) - length(replace(v_def, v_new1, ''))) / length(v_new1) <> 1
     or (length(v_def) - length(replace(v_def, v_new2, ''))) / length(v_new2) <> 1
     or (length(v_def) - length(replace(v_def, v_new3, ''))) / length(v_new3) <> 1 then
    raise exception 'R-11 rollback refused: % does not hold each migration fragment exactly once.', v_sig;
  end if;
  v_def := replace(replace(replace(v_def, v_new3, v_old3), v_new2, v_old2), v_new1, v_old1);
  if md5(v_def) <> v_pre then
    raise exception 'R-11 rollback refused: restored % does not match the pinned pre-migration text (md5 %).', v_sig, md5(v_def);
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_pre then
    raise exception 'R-11 rollback: installed text of % does not match the pinned pre-migration md5 after restore.', v_sig;
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'] from pg_proc p where p.oid = v_sig::regprocedure)
     or has_function_privilege('anon', v_sig::regprocedure, 'execute')
     or not has_function_privilege('authenticated', v_sig::regprocedure, 'execute') then
    raise exception 'R-11 rollback: % lost its security definer / search_path / grants during the restore.', v_sig;
  end if;
end $$;

commit;
