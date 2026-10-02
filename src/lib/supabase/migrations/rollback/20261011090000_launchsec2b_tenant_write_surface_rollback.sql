-- 20261011090000_launchsec2b_tenant_write_surface_rollback.sql
--
-- Reviewed rollback for LAUNCH-SEC-2B. NEVER run automatically.
--
-- WARNING: this REOPENS #5 (cross-studio job postings) and #8 (renter control
-- of floor-rental price/payment fields) everywhere, and #4 (anon/authenticated
-- access to package deduction errors) in an environment that started in
-- STATE A. Run only with explicit authorization.
--
-- Order for a full 2B rollback: roll the application back FIRST, then run
-- this file. (2B has no application changes that depend on the schema.)
--
-- Environment-exact: the forward migration recorded which reviewed starting
-- state this environment was in (comment on the #4 SELECT policy):
--   STATE A (DEV):  RLS disabled before 2B -> RLS disabled again.
--   STATE B (PROD): RLS enabled before 2B  -> RLS stays enabled.
-- Grants are restored to the identical pre-2B ACL in both states. Indexes
-- were never touched. Anything unexpected fails closed.

begin;

do $$
declare
  v_comment text;
  v_state text;
begin
  select obj_description(p.oid, 'pg_policy') into v_comment
  from pg_policy p
  where p.polrelid = 'public.appointment_package_deduction_errors'::regclass
    and p.polname = 'Platform admins and studio finance staff read deduction errors';

  v_state := case v_comment
    when 'LAUNCH-SEC-2B starting state A' then 'A'
    when 'LAUNCH-SEC-2B starting state B' then 'B'
  end;

  if v_state is null then
    raise exception 'LAUNCH-SEC-2B rollback: recorded starting state missing or unrecognized (%)', v_comment;
  end if;

  if to_regprocedure('public._guard_appointments_floor_rental_financial_fields()') is null
     or not exists (select 1 from pg_trigger where tgrelid = 'public.appointments'::regclass
                    and tgname = 'appointments_00_guard_floor_rental_financial_fields')
     or not exists (select 1 from pg_policy where polrelid = 'public.studio_job_postings'::regclass
                    and polname = 'Studio admins can manage their own job postings')
     or exists (select 1 from pg_policy where polrelid = 'public.studio_job_postings'::regclass
                and polname = 'Job posting creators can manage their postings')
     or (select string_agg(polname, ',' order by polname) from pg_policy
          where polrelid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'Platform admins and studio finance staff read deduction errors,Platform admins can resolve package deduction errors'
     or not (select relrowsecurity from pg_class where oid = 'public.appointment_package_deduction_errors'::regclass) then
    raise exception 'LAUNCH-SEC-2B rollback: 2B state is not present exactly';
  end if;

  perform set_config('launchsec2b.starting_state', v_state, true);
end $$;

-- #8
drop trigger appointments_00_guard_floor_rental_financial_fields on public.appointments;
drop function public._guard_appointments_floor_rental_financial_fields();

-- #5
drop policy "Studio admins can manage their own job postings" on public.studio_job_postings;

create policy "Job posting creators can manage their postings"
on public.studio_job_postings
for all
to authenticated
using (auth.uid() = created_by)
with check (auth.uid() = created_by);

-- #4
drop policy "Platform admins and studio finance staff read deduction errors"
  on public.appointment_package_deduction_errors;
drop policy "Platform admins can resolve package deduction errors"
  on public.appointment_package_deduction_errors;

grant all on table public.appointment_package_deduction_errors to anon;
grant all on table public.appointment_package_deduction_errors to authenticated;

do $$
begin
  if current_setting('launchsec2b.starting_state') = 'A' then
    alter table public.appointment_package_deduction_errors disable row level security;
  end if;
end $$;

-- Must restore the exact reviewed pre-2B state of THIS environment.
do $$
declare
  v_state text := current_setting('launchsec2b.starting_state');
begin
  if (select relrowsecurity from pg_class where oid = 'public.appointment_package_deduction_errors'::regclass)
       is distinct from (v_state = 'B')
     or (select md5(string_agg(pg_get_indexdef(indexrelid), ';' order by pg_get_indexdef(indexrelid)))
          from pg_index where indrelid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from (case v_state when 'A' then '699a1961938a3dbaf4e5687ccc87320d' else '3ff99f880e7e2454b1effe12bda7dcde' end)
     or (select string_agg(x::text, ',' order by x::text) from pg_class c, unnest(c.relacl) x
          where c.oid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres'
     or exists (select 1 from pg_policy where polrelid = 'public.appointment_package_deduction_errors'::regclass)
     or (select md5(string_agg(polname || ':' || polcmd::text || ':' || md5(coalesce(pg_get_expr(polqual, polrelid), '')) || ':' || md5(coalesce(pg_get_expr(polwithcheck, polrelid), '')), ',' order by polname))
          from pg_policy where polrelid = 'public.studio_job_postings'::regclass)
        is distinct from 'e84cb125de4f85be441e6c5779c375ce'
     or (select md5(string_agg(tgname || ':' || pg_get_triggerdef(oid) || ':' || tgenabled::text, ',' order by tgname))
          from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
        is distinct from 'd9f05cdb52590e6f8a65291bd208b7fe' then
    raise exception 'LAUNCH-SEC-2B rollback: restored state does not match the reviewed pre-2B state %', v_state;
  end if;
end $$;

commit;
