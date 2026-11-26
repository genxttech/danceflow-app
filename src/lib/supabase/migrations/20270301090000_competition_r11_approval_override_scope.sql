-- 20270301090000_competition_r11_approval_override_scope.sql
-- ============================================================================================================================================
-- NOT APPLIED ANYWHERE. DRAFT. Applying this migration to ANY hosted environment (DEV, PROD, staging) needs separate owner approval.
-- It has not been run against any database in the form committed here (see docs/competition/governance/audit/R-11-CORRECTION-MIGRATION.md
-- for what was executed and what is PENDING).
-- ============================================================================================================================================
--
-- R-11 security correction (owner ratification R-11 + R-14 items 11-18, 2026-11-24). Closes two Studio/Custom release blockers found by the
-- R-11 verification (docs/competition/governance/audit/R-11-VERIFICATION.md, PR 859):
--
--   RB-11.1  the D3 override reason accepted ONE character ("x"): only `nullif(btrim(reason), '')` and at most 500 characters.
--   RB-11.2  the D3 self-approval override was not limited to INITIAL approval: after open_competition_round_correction a recalculation creates
--            version N+1 which the calculator could self-approve with the same override, and F3 then publishes it.
--
-- Scope: ONE function, public.approve_competition_round_result(uuid, uuid, text, uuid). Nothing else is created, altered, dropped or granted.
-- The function is redefined by exact-fragment replacement of the pinned effective text (the same pinned-md5 method as F2 / A3 / PV-1), so a
-- later divergence of the function fails the migration instead of being overwritten silently:
--     pre-migration text  (post A3 + PV-1) md5 3cf63c3bb00a78142ea2c8e70a8b4a0c
--     post-migration text                  md5 2d178c29177ebf2ec14a46bf510ccc12
-- (md5 of pg_get_functiondef with CRs removed; the pre md5 equals the PV-1 pin; both were also reproduced offline from the migration texts.)
--
-- Behavior after this migration
--   1. INITIAL / CORRECTED is decided from append-only database history, never from a client value or a mutable label:
--        corrected  <=>  the round already has an approval row for ANOTHER version                     (event_competition_result_approvals)
--                   or  an A7 correction cause row                                                      (event_competition_correction_causes)
--                   or  an F2 correction audit event (round_state_changed -> ballots_locked, refs.correction = true) (event_competition_result_events)
--        initial    <=>  none of the three exists.
--      Why these sources and not event_competition_rounds.correction_open / status / the version number: correction_open is derived and CLEARED
--      by the recalculation and by the U66 recovery; round.status moves; a version number > 1 also arises from a plain ballot change before any
--      approval. The three sources above are INSERT-ONLY: each carries protect_competition_history_evidence() (before update or delete, and before
--      truncate; A7 also ENABLE ALWAYS), no API role holds any write privilege, and rows are written only by SECURITY DEFINER lifecycle
--      functions (F2 guards: COMPF2_APPROVAL_WRITER; A7 status-edge trigger). The approve function reads them under the round FOR UPDATE lock that
--      it already holds, which is the same lock open_competition_round_correction and every other approval take, so initial/corrected cannot
--      change between the check and the approval row.
--   2. INITIAL: unchanged D3. A different authorized manager approves normally; the calculator may self-approve only with an override reason
--      that satisfies _cf1_reason_is_substantive (20-500 characters, at least four words, at least three distinct, no placeholder, not one
--      repeated character: the rule A6 already uses) AND, in this function only, at least 12 letters/digits, four words holding one, and three
--      different such words with punctuation and case ignored. Refusal code stays COMP_SECOND_APPROVER_REQUIRED (the app maps it today).
--      The override is audited exactly as before (event kind result_approval_override, actor, version, input hash, calculator, reason, time;
--      approvals row with override_reason); refs.initial = true is added. A normal approval records refs.initial = true or false.
--   3. CORRECTED: the override does not exist. The approval is refused with the NEW code COMP_CORRECTION_APPROVER_REQUIRED (unmapped in the UI until a later app change: it shows the generic "could not be done" text instead of the misleading override hint) when the approver is the calculator of
--      the version OR anyone who opened a correction of the round (A7 opened_by or F2 correction event actor), whatever reason is supplied.
--      An independent authorized manager (neither) approves with no reason, recorded as result_approved with refs.initial = false.
--   4. Unchanged and still before any override logic: manager role / COMP_FORBIDDEN, request-id replay, round state, COMP_RESULT_STALE (latest
--      version and input hash), PV-1 re-verification, and after the audit insert the A3 roster check (COMP_ROSTER_BELOW_MINIMUM etc.).
--      The four absolute no-override protections therefore cannot be reached by any reason string.
--
-- NOT in this migration (reported separately, need their own authorization): revoking service_role EXECUTE on approve/calculate, and a
-- verified-email requirement for the approving manager. See the compatibility assessment in the report document.
--
-- Order: SQL before app; the app needs no change to keep working (COMP_SECOND_APPROVER_REQUIRED, used for the initial path, is already mapped; the new corrected-path code falls back to the generic message). Not applied anywhere.
-- Rollback: rollback/20270301090000_competition_r11_approval_override_scope_rollback.sql (restores the exact pinned pre-migration text, md5 3cf63c3b...).

begin;

do $$
declare
  v_sig constant text := 'public.approve_competition_round_result(uuid,uuid,text,uuid)';
  v_pre constant text := '3cf63c3bb00a78142ea2c8e70a8b4a0c';
  v_post constant text := '2d178c29177ebf2ec14a46bf510ccc12';
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
                        -- review hardening: padding (NBSP, zero-width, punctuation) cannot satisfy the length or word rules. Only letters and digits count:
                        -- at least 12 of them, at least four words holding one, and at least three DIFFERENT such words (punctuation and case ignored).
                        or length(regexp_replace(v_reason, '[^[:alnum:]]', '', 'g')) < 12
                        or (select count(*) from regexp_split_to_table(v_reason, '[[:space:]]+') w where w ~ '[[:alnum:]]') < 4
                        or (select count(distinct lower(regexp_replace(w, '[^[:alnum:]]', '', 'g')))
                              from regexp_split_to_table(v_reason, '[[:space:]]+') w where w ~ '[[:alnum:]]') < 3) then
    raise exception 'COMP_SECOND_APPROVER_REQUIRED: a second manager must approve; the calculator may approve an initial result only with a substantive override reason (20-500 characters, at least four words, three of them different).'
      using errcode = 'P0001';
  end if;
$n$;
  v_old3 constant text := $o$'override', v_override));$o$;
  v_new3 constant text := $n$'override', v_override, 'initial', v_initial));$n$;
  v_def text;
begin
  -- Preflight: the objects this text reads must exist (a hard requirement: fail closed instead of approving without the history check).
  if to_regclass('public.event_competition_result_approvals') is null
     or to_regclass('public.event_competition_result_events') is null
     or to_regclass('public.event_competition_correction_causes') is null
     or to_regprocedure('public._cf1_reason_is_substantive(text)') is null then
    raise exception 'R-11 preflight: F2 results lifecycle, CF1 A7 correction causes (20270120095500) or CF1 _cf1_reason_is_substantive (20270120090000) is missing.';
  end if;
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '');
  if md5(v_def) = v_post then
    raise notice 'R-11: % already has the post-migration text (md5 %); nothing to do.', v_sig, v_post;
    return;
  end if;
  if md5(v_def) <> v_pre then
    raise exception 'R-11: % is not the pinned post-PV-1 text (md5 %, expected %); coordinate before changing it.', v_sig, md5(v_def), v_pre;
  end if;
  if (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     or (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1
     or (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1 then
    raise exception 'R-11: % does not contain each anchor exactly once.', v_sig;
  end if;
  v_def := replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  if md5(v_def) <> v_post then
    raise exception 'R-11: redefined text of % has md5 % (expected %).', v_sig, md5(v_def), v_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_post then
    raise exception 'R-11: installed text of % does not match the expected post-migration md5.', v_sig;
  end if;
  -- create or replace keeps owner, security definer, search_path and the ACL (public/anon revoked, authenticated granted); verify, do not assume.
  if not (select p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'] from pg_proc p where p.oid = v_sig::regprocedure)
     or has_function_privilege('anon', v_sig::regprocedure, 'execute')
     or not has_function_privilege('authenticated', v_sig::regprocedure, 'execute') then
    raise exception 'R-11: % lost its security definer / search_path / grants during the redefinition.', v_sig;
  end if;
end $$;

commit;
