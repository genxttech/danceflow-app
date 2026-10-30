-- Rollback for 20270120094000_competition_cf1_a5_exclusion_action.sql.
-- ROLL-FORWARD ONLY once an exclusion row exists: those rows are the audit of why couples were taken out of a ranking.
-- Order: position 2 of the CF1 rollbacks (A6 first; then this; then A3, A2, A4a, A0, A1). CF1 as a whole rolls back before HL1.
-- It also refuses while any other function still calls an A5 function (a later package was not rolled back first).

begin;

-- Blocks an in-flight writer so the emptiness check below cannot be overtaken by a commit before the drop.
lock table public.event_competition_round_exclusions in access exclusive mode;

do $$
declare
  v_names constant text[] := array[
    'request_round_exclusion', 'cosign_round_exclusion', 'request_round_exclusion_reversal', 'cosign_round_exclusion_reversal',
    'competition_round_exclusions', '_cf1_a5_require_no_publication', '_cf1_a5_entry_heat_entries', '_cf1_a5_entry_danced',
    '_cf1_a5_effective', '_cf1_a5_filed_replacement_ballot', '_cf1_a5_result', '_cf1_a5_guard_replacement_ballot_filer'];
  v_user text;
begin
  if exists (select 1 from public.event_competition_round_exclusions) then
    raise exception 'CF1-A5 rollback refused: exclusion rows exist (event_competition_round_exclusions is append-only audit); roll forward.';
  end if;
  select string_agg(distinct p.oid::regprocedure::text, ', ') into v_user
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.proname <> all (v_names)
    and exists (select 1 from unnest(v_names) f where p.prosrc ~ ('\m' || f || '\M'));
  if v_user is not null then
    raise exception 'CF1-A5 rollback refused: still referenced by % (roll back the later CF1 packages first).', v_user;
  end if;
end $$;

drop trigger cf1_a5_guard_replacement_ballot_filer on public.event_competition_ballots;
drop function public._cf1_a5_guard_replacement_ballot_filer();
drop function public.competition_round_exclusions(uuid);
drop function public.cosign_round_exclusion_reversal(uuid, uuid);
drop function public.request_round_exclusion_reversal(uuid, uuid, text, uuid);
drop function public.cosign_round_exclusion(uuid, uuid);
drop function public.request_round_exclusion(uuid, uuid, text, text, uuid);
drop function public._cf1_a5_result(public.event_competition_round_exclusions, boolean);
drop function public._cf1_a5_filed_replacement_ballot(uuid, uuid);
drop function public._cf1_a5_effective(uuid, uuid);
drop function public._cf1_a5_entry_danced(uuid, uuid);
drop function public._cf1_a5_entry_heat_entries(uuid, uuid);
drop function public._cf1_a5_require_no_publication(uuid);

commit;
