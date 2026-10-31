-- Rollback for 20270120093000_competition_cf1_a3_results_integrity.sql (CF1 rollback position 3: after A6 and A5, before A2).
-- Restores the exact pinned prior texts of the ten redefined functions by reversing each replacement, verifying that the installed text still is
-- the post-A3 text (md5) and that the restored text matches the pre-A3 md5. Refused while any exclusion row exists: an excluded couple leaves the
-- ranking set and the evidence only through A3's text, so removing it would silently re-rank (and re-hash) a round. Roll forward instead.
-- Order: app first; then A6, A5 (they must not depend on A3); then this file; then A2, A4a, A0, A1.

begin;

do $$
begin
  if to_regclass('public.event_competition_round_exclusions') is not null then
    perform 1 from public.event_competition_round_exclusions limit 1;
    if found then
      raise exception 'CF1-A3 rollback refused: exclusion rows exist (roll forward only).';
    end if;
  end if;
end $$;

create function pg_temp.cf1a3_pin_restore(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_post then
    raise exception 'CF1-A3 rollback refused: % is not the post-A3 text (md5 %, expected %); it changed since A3.', p_sig, md5(v_def), p_post;
  end if;
  for v_i in reverse array_length(p_olds, 1) .. 1 loop
    if (length(v_def) - length(replace(v_def, p_news[v_i], ''))) / length(p_news[v_i]) <> 1 then
      raise exception 'CF1-A3 rollback refused: % does not hold A3 text % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_news[v_i], p_olds[v_i]);
  end loop;
  if md5(v_def) <> p_pre then
    raise exception 'CF1-A3 rollback refused: restored % does not match the pinned pre-A3 text.', p_sig;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_pre then
    raise exception 'CF1-A3 rollback: installed text of % does not match the pinned pre-A3 md5 after restore.', p_sig;
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
    perform pg_temp.cf1a3_pin_restore(r.sig, r.pre, r.post, array[v_old], array[v_new]);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. F2 evidence builder
-- ---------------------------------------------------------------------------
select pg_temp.cf1a3_pin_restore(
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
select pg_temp.cf1a3_pin_restore(
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
select pg_temp.cf1a3_pin_restore(
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
select pg_temp.cf1a3_pin_restore(
  'public.approve_competition_round_result(uuid,uuid,text,uuid)', '0650367be64e3d1b4387a3dbceba3d4a', 'ac33e456925e64665db1ea0547bae18b',
  array[$o$update public.event_competition_rounds set status = 'approved', updated_at = now() where id = p_round_id;$o$],
  array[$n$-- CF1 A3 (OD-17 D, A.3): the last check. Entries of the ranking set FOR SHARE in id order (after the round, version and heat locks of the
  -- certification loop), then the roster check as a separate statement. Raising rolls the whole approval back (version, approval row, events, heats).
  perform 1 from public.event_competition_entries en
  where en.id in (select x from unnest(public._compe2_round_entries(p_round_id)) x)
  order by en.id for share;
  perform public._cf1_require_roster_eligible(p_round_id, 'approve');

  update public.event_competition_rounds set status = 'approved', updated_at = now() where id = p_round_id;$n$]);

drop function pg_temp.cf1a3_pin_restore(text, text, text, text[], text[]);

commit;
