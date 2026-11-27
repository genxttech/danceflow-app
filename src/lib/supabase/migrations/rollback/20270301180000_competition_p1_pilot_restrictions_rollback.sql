-- Rollback for 20270301180000_competition_p1_pilot_restrictions.sql. NOT APPLIED ANYWHERE. Removes every P1 trigger, function and index.
-- No data is changed. After it, every operation P1 disabled is available again.
begin;
set local lock_timeout = '5s';

do $$
declare
  r record;
begin
  for r in select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'zz\_compp1\_%' and not t.tgisinternal loop
    execute format('drop trigger %I on public.%I', r.tgname, r.relname);
  end loop;
end $$;

drop function if exists public._compp1_guard_structure(), public._compp1_guard_round(), public._compp1_guard_heat(), public._compp1_guard_heat_dance(), public._compp1_guard_version(),
  public._compp1_guard_ballot(), public._compp1_guard_placement_removal(), public._compp1_guard_entry(), public._compp1_guard_published_name(),
  public._compp1_guard_disabled(), public._compp1_guard_approval(), public._compp1_guard_publication();
drop function if exists public._compp1_require_studio_scoring(uuid), public._compp1_started(uuid);
drop index if exists public.compp1_one_round_per_division, public.compp1_one_heat_per_round, public.compp1_one_dance_per_heat, public.compp1_one_published_order;

commit;
