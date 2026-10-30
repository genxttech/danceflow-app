-- Competition CF1 package A3: results integrity (calculation, approval, exclusion evidence, review).
--
-- Design: docs/competition/callback-to-final-advancement-design.md section 4.6 (a), 4.7, A.3, A.9.1-A.9.5. Contract: docs/competition/cf1-a3-contract.md.
-- Slot 20270120093000, after A1 (20270120085000), A0 (090000), A4a (091000) and A2 (092000); before A5 (094000). SQL before app.
-- GLOBAL results-integrity change: it touches calculate, approve, the E2 ranking-set functions, the F2 evidence builder and the results review
-- for EVERY scored round of every program and discipline. The OD-17 cross-checks stay disabled for live events until release blocker RB1.
--
-- Every function below is redefined by pinned text-replace: the installed pg_get_functiondef text (CRs removed) must match the md5 recorded
-- here (taken from an applied QA chain through A1, never from DEV or PROD), each old anchor must occur exactly once, and the md5 of the
-- result is verified after the redefinition. Any mismatch raises and the transaction rolls back.
--
-- 1. The six E2 ranking-set functions NS1 redefined (+ CX1 for the two readers): next to NS1's
--      and not public.competition_heat_entry_is_no_show(he.id)
--    each gains   and not public._cf1_heat_entry_is_excluded(he.id)
--    so an EXCLUDED couple (4.7) leaves the ranking set, the expected entries of a heat, the callback eligible set, the judge sheet and the
--    ballot status. The heat entry keeps its recorded status (not scratched, not no-show); ballots, marks and ballot events are retained.
--      _compe2_round_heats(uuid)  _compe2_heat_entries(uuid)  _compe2_round_entries(uuid)  _compe2_guard_mark_insert()
--      competition_round_ballot_status(uuid)  competition_judge_ballot_sheet(uuid)
--    _compe2_round_blockers is NOT edited (derived from the helpers). _compf2_no_show_entries / _compf2_heat_entry_no_show stay NS1-only.
-- 2. _compf2_evidence(uuid, text, text): heats[].entryIds gains the same exclusion filter; excludedEntries gains a third branch
--    reason 'excluded' (precedence scratched, then no_show, then excluded; one row per entry). 'entries' (every participant) is unchanged.
--    A round with NO exclusion produces byte-identical canonical JSON and hash (the filter is true for every row, the branch returns no row,
--    no key is added), so every already-calculated version still passes the approve hash check.
-- 3. competition_round_results_review(uuid): additive 'excluded' section (couple, reason kind, reason, requester, co-signer, exclusion id).
-- 4. calculate_competition_round(...): after its replay branch, state check and round FOR UPDATE, the entries of the ranking set are locked
--    FOR SHARE in id order, then _cf1_require_roster_eligible(round, 'calculate') runs as a SEPARATE statement (fresh snapshot).
-- 5. approve_competition_round_result(...): the same two statements, stage 'approve', placed AFTER the certification loop and immediately
--    BEFORE  update public.event_competition_rounds set status = 'approved'  (design A.9.2 / 4.6; an earlier wording said before the 'approved'
--    update of the version, which is not what the text says: the final text puts it after the loop, so entries are locked last).
--    The replay branch returns before either statement, so a replayed request id is not refused by a later eligibility change.
-- Lock order (A.3): calculate = round FOR UPDATE, entries FOR SHARE (id order). approve = round FOR UPDATE, version FOR UPDATE, heats (inside the
-- certification loop through set_competition_heat_lock_state), entries FOR SHARE (id order). No function-level lock_timeout is added.
--
-- Rollback: rollback/20270120093000_competition_cf1_a3_results_integrity_rollback.sql (restores the exact pinned prior texts; refused while any
-- exclusion row exists, because the evidence of such a round would change).

begin;

do $$
begin
  if to_regprocedure('public._cf1_require_roster_eligible(uuid,text)') is null
     or to_regprocedure('public._cf1_heat_entry_is_excluded(uuid)') is null
     or to_regprocedure('public._cf1_excluded_entries(uuid)') is null
     or to_regclass('public.event_competition_round_exclusions') is null then
    raise exception 'CF1-A3 preflight: A1 (20270120085000) is missing.';
  end if;
  if to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is null
     or to_regprocedure('public._compf2_evidence(uuid,text,text)') is null
     or to_regprocedure('public.competition_round_results_review(uuid)') is null
     or to_regprocedure('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)') is null
     or to_regprocedure('public.approve_competition_round_result(uuid,uuid,text,uuid)') is null then
    raise exception 'CF1-A3 preflight: NS1 / F2 objects are missing.';
  end if;
  if position('_cf1_heat_entry_is_excluded' in pg_get_functiondef('public._compe2_round_heats(uuid)'::regprocedure)) > 0
     or position('_cf1_require_roster_eligible' in pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure)) > 0 then
    raise exception 'CF1-A3 preflight: A3 appears to be applied already (roll back or clean up a partial earlier run first).';
  end if;
end $$;

-- Pinned text-replace helper (session-local). Raises unless the installed text matches the pin, every old text occurs exactly once, and the
-- redefined text matches the expected md5.
create function pg_temp.cf1a3_pin_replace(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_pre then
    raise exception 'CF1-A3 preflight: % differs from the pinned text (md5 %, expected %); coordinate before changing it.', p_sig, md5(v_def), p_pre;
  end if;
  for v_i in 1 .. array_length(p_olds, 1) loop
    if (length(v_def) - length(replace(v_def, p_olds[v_i], ''))) / length(p_olds[v_i]) <> 1 then
      raise exception 'CF1-A3 preflight: % does not contain anchor % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_olds[v_i], p_news[v_i]);
  end loop;
  if md5(v_def) <> p_post then
    raise exception 'CF1-A3: redefined text of % has md5 % (expected %).', p_sig, md5(v_def), p_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_post then
    raise exception 'CF1-A3: installed text of % does not match the expected post-A3 md5 after redefinition.', p_sig;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The six E2 ranking-set functions
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_old constant text := 'and not public.competition_heat_entry_is_no_show(he.id)';
  v_new constant text := 'and not public.competition_heat_entry_is_no_show(he.id) and not public._cf1_heat_entry_is_excluded(he.id)';
begin
  for r in select * from (values
    ('public._compe2_round_heats(uuid)', '1e75e888142ed1727eb6b2d6c8c0a906', '7a5a1563a9450e2ec3b807a69737f9f4'),
    ('public._compe2_heat_entries(uuid)', 'f275ced91a3b319aaf0835f67bfe174d', 'fdcb8728dde030c8d9772fdaf2963524'),
    ('public._compe2_round_entries(uuid)', 'f0da6935a3dcc04320f7636da6655a3b', '64859bac497c22fd7472b9e7ae6fc986'),
    ('public._compe2_guard_mark_insert()', '786bdf3604fa36e5f8328ecc0d5385ad', '055adcc12d8f903a7570c93008f303a9'),
    ('public.competition_round_ballot_status(uuid)', 'a3f5226acc9a40cdedd83d9c0a0fee24', '7d3bebe922fed33604666009d3a593a5'),
    ('public.competition_judge_ballot_sheet(uuid)', '21cd3df42b8789e3b1baade47a0231d0', '2506cb2f466d1738fb1a8f298e805b5f')
  ) as t(sig, pre, post) loop
    perform pg_temp.cf1a3_pin_replace(r.sig, r.pre, r.post, array[v_old], array[v_new]);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. F2 evidence builder
-- ---------------------------------------------------------------------------
select pg_temp.cf1a3_pin_replace(
  'public._compf2_evidence(uuid,text,text)', '2b1c9a22be4a4c4a4e5ba43adee37306', '415a823b4a689cae26b8a20187af58e7',
  array[
    'and not public._compf2_heat_entry_no_show(he.id)',
    $o$h2)))) u), '[]'::jsonb),$o$
  ],
  array[
    'and not public._compf2_heat_entry_no_show(he.id) and not public._cf1_heat_entry_is_excluded(he.id)',
    $n$h2)))
                                       union all
                                       -- CF1 A3 (4.7): a couple excluded with a reason (kept: heat entries, ballots, marks), after scratched and no-show.
                                       select ex.entry_id, 'excluded'::text
                                       from public._cf1_excluded_entries(r.id) ex
                                       where ex.entry_id <> all (public._compf2_no_show_entries(r.id))
                                         and exists (select 1 from public.event_competition_heat_entries he
                                                     where he.entry_id = ex.entry_id and he.status <> 'scratched'
                                                       and he.heat_id in (select h.heat_id from public._compf2_round_all_heats(r.id) h))) u), '[]'::jsonb),$n$
  ]);

-- ---------------------------------------------------------------------------
-- 3. Results review: additive 'excluded' section
-- ---------------------------------------------------------------------------
select pg_temp.cf1a3_pin_replace(
  'public.competition_round_results_review(uuid)', 'c842be1dafce548cd279f1d2d6f6f1d0', 'c9d747907caad0a88b75da1c53862f43',
  array[$o$'blockers', public._compe2_round_blockers(p_round_id));$o$],
  array[$n$'blockers', public._compe2_round_blockers(p_round_id),
    -- CF1 A3 (4.7): couples currently excluded from the ranking set, with the recorded reason (never silently omitted, never a no-show).
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_id', x.entry_id, 'entry_number', e.entry_number, 'display_name', e.display_name,
        'exclusion_id', x.exclusion_id, 'decision_id', x.decision_id, 'seq', x.seq, 'state', 'excluded',
        'reason_kind', x.reason_kind, 'reason', x.reason,
        'requested_by', rq.actor, 'requested_by_role', rq.actor_role, 'requested_at', rq.at,
        'requested_by_name', coalesce(nullif(btrim(rp.full_name), ''), 'A manager'),
        'cosigned_by', cs.actor, 'cosigned_by_role', cs.actor_role, 'cosigned_at', cs.at,
        'cosigned_by_name', coalesce(nullif(btrim(cp.full_name), ''), 'A manager'))
        order by e.entry_number, x.entry_id)
      from public._cf1_excluded_entries(p_round_id) x
      join public.event_competition_entries e on e.id = x.entry_id and e.event_id = v_round.event_id
      left join public.event_competition_round_exclusions cs on cs.id = x.exclusion_id
      left join public.event_competition_round_exclusions rq on rq.id = x.decision_id
      left join public.profiles cp on cp.id = cs.actor
      left join public.profiles rp on rp.id = rq.actor), '[]'::jsonb));$n$]);

-- ---------------------------------------------------------------------------
-- 4. calculate_competition_round: OD-17 D, stage 'calculate' (after replay branch + state check, before the engine/evidence work)
-- ---------------------------------------------------------------------------
select pg_temp.cf1a3_pin_replace(
  'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'ddaa45cbb518f7592f5ca6dd0ba00176', 'bc3cc4397e740444a4d4a53d93b499cc',
  array['-- Method must be approved and pinned; anything else fails closed.'],
  array[$n$-- CF1 A3 (OD-17 D, A.3): entries of the ranking set FOR SHARE in id order (after the round FOR UPDATE), then the roster check as a
  -- separate statement so it reads a fresh snapshot after the locks. Placed after the replay branch: a replayed request is never refused here.
  perform 1 from public.event_competition_entries en
  where en.id in (select x from unnest(public._compe2_round_entries(p_round_id)) x)
  order by en.id for share;
  perform public._cf1_require_roster_eligible(p_round_id, 'calculate');

  -- Method must be approved and pinned; anything else fails closed.$n$]);

-- ---------------------------------------------------------------------------
-- 5. approve_competition_round_result: OD-17 D, stage 'approve' (after the certification loop, before the 'approved' status write)
-- ---------------------------------------------------------------------------
select pg_temp.cf1a3_pin_replace(
  'public.approve_competition_round_result(uuid,uuid,text,uuid)', '0650367be64e3d1b4387a3dbceba3d4a', 'ac33e456925e64665db1ea0547bae18b',
  array[$o$update public.event_competition_rounds set status = 'approved', updated_at = now() where id = p_round_id;$o$],
  array[$n$-- CF1 A3 (OD-17 D, A.3): the last check. Entries of the ranking set FOR SHARE in id order (after the round, version and heat locks of the
  -- certification loop), then the roster check as a separate statement. Raising rolls the whole approval back (version, approval row, events, heats).
  perform 1 from public.event_competition_entries en
  where en.id in (select x from unnest(public._compe2_round_entries(p_round_id)) x)
  order by en.id for share;
  perform public._cf1_require_roster_eligible(p_round_id, 'approve');

  update public.event_competition_rounds set status = 'approved', updated_at = now() where id = p_round_id;$n$]);

drop function pg_temp.cf1a3_pin_replace(text, text, text, text[], text[]);

commit;
