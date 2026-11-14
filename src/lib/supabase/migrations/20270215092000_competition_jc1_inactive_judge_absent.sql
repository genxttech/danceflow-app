-- Competition JC1 -- a deactivated judge with no ballot in the round counts as absent (P3 from the CF1 review).
--
-- Before: _compe2_round_judges returns every panel assignment, including officials deactivated after the round
-- started (E1 keeps those assignments as frozen history). _compe2_is_absent only looked at attendance, so a
-- deactivated judge with no ballot stayed in judges_present, appeared in missing_ballots (blocking the ballot
-- lock) and counted towards the K1 X-3 panel minimum / odd rule, even though they can no longer score.
--
-- After: such a judge is absent. Deactivation is already an audited removal (reason + official_deactivated audit row).
--   * A deactivated judge WITH a ballot in the round is unchanged: their ballots still count (history).
--   * Attendance 'present' does not revive a deactivated judge; reactivation (add_competition_official) does.
--   * Only this one stable helper changes. Signature, owner, grants and every caller are unchanged. No data changes.
-- Rollback: rollback/20270215092000_competition_jc1_inactive_judge_absent_rollback.sql (restores the E2 body).

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
                   order by a.seq desc limit 1), false)
      or (exists (select 1 from public.event_competition_officials o
                  where o.id = p_official_id and o.status = 'inactive')
          and not exists (select 1 from public.event_competition_ballots b
                          where b.round_id = p_round_id and b.official_id = p_official_id));
$$;
revoke all on function public._compe2_is_absent(uuid, uuid) from public, anon, authenticated;
