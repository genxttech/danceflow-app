-- Competition CF1 A2: eligibility and refund cross-check at ballot locking (OD-17 D, stage `lock`; OD-15 A minimum, callback Finals only).
--
-- Redefines lock_competition_round_ballots(uuid, uuid) by ONE pinned text-replace on the installed post-HL1 body: a single block is inserted
-- before the `select coalesce(jsonb_agg(j.official_id) ... into v_absent` statement, i.e.
--   * AFTER the replay branch (a replayed request id is never refused by a later eligibility change, U69),
--   * AFTER the state check, the heat and heat-entry FOR SHARE and every readiness check (so stale / missing / not-danced ballots keep
--     their existing, more specific errors and their order), and
--   * BEFORE the audit insert and the status write.
-- The block (design 4.6, lock order of A.3: round FOR UPDATE, heats, heat entries, then entries last):
--   1. entries of the round's ranking set (_compe2_round_entries) FOR SHARE, in id order;
--   2. a SEPARATE statement: _cf1_require_roster_eligible(round, 'lock') (A1) -> COMP_ROSTER_ENTRY_UNAVAILABLE and, for a callback Final
--      only, COMP_ROSTER_BELOW_MINIMUM (both P0001, permanent). The helper reads the entries, registrations and orders in a fresh
--      statement after the entry locks are held.
-- Nothing else changes: same signature, owner, SECURITY DEFINER, search_path, grants (create or replace keeps them). No function-level
-- lock_timeout is set. A deadlock with change_competition_entry_lifecycle (entry then heat entries) is resolved by Postgres as one
-- 40P01 victim; the caller retries (design A.3).
--
-- Pin: md5 of the installed definition with CRs removed (the CRLF function-body gotcha of 10D) must equal the post-HL1 value taken from an
-- applied chain on the QA Postgres, and the anchor must occur exactly once. The post-replace md5 is verified too.
--
-- Apply order: after A1 (20270120085000) and before the CF1 core (20270120090000 and the A0/A3 slots as listed in design A.9.1), SQL before the app.
-- Rollback: rollback/20270120092000_competition_cf1_a2_lock_check_rollback.sql restores the post-HL1 text exactly (md5 6e4175342d51ffe274d70ce413bae8c3)
-- and must run BEFORE HL1's rollback (HL1's rollback pins the pre-HL1 text).

begin;

do $$
declare
  v_def text;
  v_new text;
  v_anchor constant text := E'  select coalesce(jsonb_agg(j.official_id), ''[]''::jsonb) into v_absent';
  v_block constant text :=
    E'  -- CF1 A2 (OD-17 D, stage lock; OD-15 A for callback Finals): entries of the ranking set last in the lock order (A.3), then the check in a fresh statement.\n' ||
    E'  perform 1 from public.event_competition_entries ce where ce.id = any (public._compe2_round_entries(p_round_id)) order by ce.id for share;\n' ||
    E'  perform public._cf1_require_roster_eligible(p_round_id, ''lock'');\n\n';
  v_pre constant text := '6e4175342d51ffe274d70ce413bae8c3';
  v_post constant text := 'c4ba327df7943d559ab52ccd07d20ea0';
begin
  if to_regprocedure('public.lock_competition_round_ballots(uuid,uuid)') is null
     or to_regprocedure('public._hl1_heat_is_danced(uuid,text)') is null
     or to_regprocedure('public._compe2_round_entries(uuid)') is null then
    raise exception 'CF1-A2 preflight: E2 / HL1 functions are missing.';
  end if;
  if to_regprocedure('public._cf1_require_roster_eligible(uuid,text)') is null then
    raise exception 'CF1-A2 preflight: A1 (20270120085000) is not applied.';
  end if;
  v_def := replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '');
  if position('CF1 A2' in v_def) > 0 then
    raise exception 'CF1-A2 preflight: lock_competition_round_ballots already carries the A2 block.';
  end if;
  if md5(v_def) <> v_pre then
    raise exception 'CF1-A2 preflight: lock_competition_round_ballots differs from the pinned post-HL1 text (md5 %); coordinate before changing it.', md5(v_def);
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'CF1-A2 preflight: lock_competition_round_ballots does not contain the insertion anchor exactly once.';
  end if;
  v_new := replace(v_def, v_anchor, v_block || v_anchor);
  if md5(v_new) <> v_post then
    raise exception 'CF1-A2: the replaced text does not match the expected post-A2 md5 (got %).', md5(v_new);
  end if;
  execute v_new;
  if md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '')) <> v_post then
    raise exception 'CF1-A2: the installed text does not match the expected post-A2 md5.';
  end if;
end $$;

commit;
