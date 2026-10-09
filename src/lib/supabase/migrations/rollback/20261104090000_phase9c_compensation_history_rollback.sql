-- Rollback for 20261104090000_phase9c_compensation_history.sql.
--
-- Removes the Phase 9C objects (save RPC, history table and its guard) and
-- restores the exact pre-9C access model on instructor_compensation_rules:
-- the owner/admin INSERT and UPDATE policies (as defined by
-- 20260715_payroll_prep_v1_data_foundation.sql) and the original table
-- grants for anon / authenticated, and drops the two range checks.
--
-- Compensation history is never destroyed by this file: it refuses to run if
-- any history row exists. Rolling back after history has been written needs a
-- separately reviewed decision about that history. Roll the application back
-- first (the 9C app saves through the RPC and reads the history table).

begin;

do $$
begin
  if to_regclass('public.instructor_compensation_rule_history') is null
     or to_regprocedure('public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)') is null then
    raise exception 'Phase 9C rollback preflight: Phase 9C is not applied.';
  end if;
  if exists (select 1 from public.instructor_compensation_rule_history) then
    raise exception 'Phase 9C rollback refused: compensation rule history exists and must not be dropped without a separate decision.';
  end if;
end
$$;

drop function public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text);
drop table public.instructor_compensation_rule_history;
drop function public.prevent_compensation_rule_history_change();

alter table public.instructor_compensation_rules
  drop constraint instructor_compensation_rules_percentages_check,
  drop constraint instructor_compensation_rules_amounts_check;

grant all on public.instructor_compensation_rules to anon, authenticated;

create policy instructor_compensation_rules_insert
on public.instructor_compensation_rules
for insert to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

create policy instructor_compensation_rules_update
on public.instructor_compensation_rules
for update to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

do $$
begin
  if to_regclass('public.instructor_compensation_rule_history') is not null
     or to_regprocedure('public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)') is not null then
    raise exception 'Phase 9C rollback postflight: Phase 9C objects remain.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules') <> 3 then
    raise exception 'Phase 9C rollback postflight: rule policies are not restored.';
  end if;
end
$$;

commit;
