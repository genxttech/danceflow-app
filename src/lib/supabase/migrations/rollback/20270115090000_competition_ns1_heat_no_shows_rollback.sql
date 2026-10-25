-- Rollback for 20270115090000_competition_ns1_heat_no_shows.sql.
-- Refuses while any no-show (or void) row exists: those rows are the audit of why entries were excluded from calculation.
-- Restores the six redefined E2 functions by reversing the single replacement and verifying the md5 pin of the restored text.
-- Order: roll back anything stacked on NS1 first. F2's hook degrades to "no no-shows" once competition_heat_no_show_entries is dropped.

begin;

do $$
declare
  r record;
  v_def text;
  v_old constant text := 'he.status <> ''scratched''';
  v_new constant text := 'he.status <> ''scratched'' and not public.competition_heat_entry_is_no_show(he.id)';
begin
  if exists (select 1 from public.event_competition_heat_no_shows) or exists (select 1 from public.event_competition_heat_no_show_voids) then
    raise exception 'NS1 rollback refused: no-show evidence exists (event_competition_heat_no_shows / _voids are append-only audit).';
  end if;

  for r in select * from (values
    ('public._compe2_round_heats(uuid)', '588b53f7e7662cb0df46554310312426'),
    ('public._compe2_heat_entries(uuid)', '280a98ecd18f3cac6a332312dae4c8f8'),
    ('public._compe2_round_entries(uuid)', '5733a9f338621b983a0b771570ad4833'),
    ('public._compe2_guard_mark_insert()', '007fd7de4aa3dd6ca1ba25962b6f3b61'),
    ('public.competition_round_ballot_status(uuid)', '6ed6628d3da9444ec24d25c36fd1d4c2'),
    ('public.competition_judge_ballot_sheet(uuid)', 'f89262a01859317442be13c8d6be0239')
  ) as t(sig, pin) loop
    v_def := replace(pg_get_functiondef(r.sig::regprocedure), E'\r', '');
    if (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new) <> 1 then
      raise exception 'NS1 rollback refused: % does not hold the NS1 text exactly once (changed since NS1).', r.sig;
    end if;
    v_def := replace(v_def, v_new, v_old);
    if md5(v_def) <> r.pin then
      raise exception 'NS1 rollback refused: restored % does not match the pinned pre-NS1 text.', r.sig;
    end if;
    execute v_def;
  end loop;
end $$;

drop function public.competition_round_no_shows(uuid);
drop function public.void_competition_heat_no_show(uuid, text, uuid);
drop function public.mark_competition_heat_no_show(uuid, text, uuid);
drop function public.competition_heat_no_show_entries(uuid);
drop function public.competition_heat_entry_is_no_show(uuid);
drop table public.event_competition_heat_no_show_voids;
drop table public.event_competition_heat_no_shows;

commit;
