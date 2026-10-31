-- Rollback for 20270120095000_competition_cf1_a6_withdrawal.sql (CF1 package A6): the FIRST CF1 rollback (A6, A5, A3, A2, A4a, A0, A1; CF1 before HL1).
-- ROLL-FORWARD ONLY once a Final-withdrawal row or a withdrawal request row exists: those rows are evidence.
-- Drops the guard, the four RPCs, the helpers and the request table. It leaves A0's withdrawal table (and A0's apply, which reads it) untouched.

begin;

set local lock_timeout = '5s';

lock table public.event_competition_final_withdrawals, public.event_competition_final_withdrawal_requests in access exclusive mode;

do $$
declare
  v_names constant text[] := array[
    'withdraw_advanced_entry_from_final', 'reinstate_withdrawn_entry_to_final', 'cosign_final_withdrawal_request', 'competition_final_withdrawal_state',
    '_cf1_a6_request', '_cf1_a6_can_manage', '_cf1_a6_live_requests', '_cf1_a6_is_stale', '_cf1_a6_precheck', '_cf1_a6_pair_state', '_cf1_a6_current_roster', '_cf1_a6_on_roster', '_cf1_a6_active_heat',
    'cf1_guard_withdrawn_heat_entry'];
  v_user text;
begin
  if exists (select 1 from public.event_competition_final_withdrawals) or exists (select 1 from public.event_competition_final_withdrawal_requests) then
    raise exception 'CF1-A6 rollback refused: Final-withdrawal / request rows exist (append-only evidence); roll forward.';
  end if;
  select string_agg(distinct p.oid::regprocedure::text, ', ') into v_user
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.proname <> all (v_names)
    and (exists (select 1 from unnest(v_names) f where p.prosrc like '%' || f || '%')
         or p.prosrc like '%event_competition_final_withdrawal_requests%');
  if v_user is not null then
    raise exception 'CF1-A6 rollback refused: still referenced by % (roll back the dependent package first).', v_user;
  end if;
  if exists (select 1 from pg_constraint c
             where c.confrelid = 'public.event_competition_final_withdrawal_requests'::regclass
               and c.conrelid <> 'public.event_competition_final_withdrawal_requests'::regclass) then
    raise exception 'CF1-A6 rollback refused: another table references the request table.';
  end if;
end $$;

drop trigger cf1_guard_withdrawn_heat_entry on public.event_competition_heat_entries;

drop function public.withdraw_advanced_entry_from_final(uuid, uuid, text, uuid);
drop function public.reinstate_withdrawn_entry_to_final(uuid, uuid, text, uuid);
drop function public.cosign_final_withdrawal_request(uuid);
drop function public.competition_final_withdrawal_state(uuid);
drop function public._cf1_a6_request(text, uuid, uuid, text, uuid);
drop function public._cf1_a6_live_requests(uuid);
drop function public._cf1_a6_is_stale(uuid, uuid, integer);
drop function public._cf1_a6_can_manage(uuid, uuid);
drop function public._cf1_a6_precheck(text, uuid, uuid);
drop function public.cf1_guard_withdrawn_heat_entry();
drop function public._cf1_a6_on_roster(uuid, uuid);
drop function public._cf1_a6_current_roster(uuid);
drop function public._cf1_a6_active_heat(uuid);
drop function public._cf1_a6_pair_state(uuid, uuid);

drop table public.event_competition_final_withdrawal_requests;

commit;
