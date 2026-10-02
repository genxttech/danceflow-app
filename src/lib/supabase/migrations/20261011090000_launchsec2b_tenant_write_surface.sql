-- 20261011090000_launchsec2b_tenant_write_surface.sql
--
-- LAUNCH-SEC-2B: tenant write-surface closure (#4, #5, #8).
--
-- #4 appointment_package_deduction_errors (internal diagnostics).
--    Writers: only the SECURITY DEFINER (postgres-owned) package-deduction
--    triggers. Readers: the platform admin pages (read + resolve, tenant
--    client) and the studio appointment hard-delete history check (tenant
--    client, platform admin / studio_owner / studio_admin / front_desk). The
--    table has no FK, so that check must keep seeing the rows or hard deletes
--    would orphan them.
--    Two reviewed starting states are accepted, nothing else:
--      STATE A (DEV):  RLS disabled, zero policies, 3 indexes.
--      STATE B (PROD): RLS enabled,  zero policies, 4 indexes (one redundant
--                      duplicate of the unresolved index; left untouched).
--    Everything else is pinned identically for both. Both converge to:
--    RLS enabled; anon has no privileges; authenticated keeps only SELECT and
--    UPDATE, scoped by policy to platform admins (read + resolve) and to the
--    studio financial roles of the row's studio (read). The starting state is
--    recorded as the comment of the new SELECT policy so the rollback can
--    restore exactly the state of the environment it runs in.
--    DEV: security closure + parity. PROD: parity/functional restoration of
--    the blocked legitimate readers while staying fail-closed.
--
-- #5 studio_job_postings. Writes required only auth.uid() = created_by, with
--    no authority over studio_id, so anyone could publish a posting as any
--    studio. The creator-owns-posting rule is kept and now also requires the
--    roles the product exposes Now Hiring to (studio_owner/studio_admin of
--    that studio, or a platform admin), on both the old and the new row, so
--    studio_id cannot be moved outside the caller's authority. Public read of
--    published postings is unchanged.
--
-- #8 floor-space rentals on appointments. A portal renter (and any other
--    caller without studio financial authority) could change price_amount /
--    payment_status after booking, which drive checkout and "paid". Guard
--    trigger (SECURITY INVOKER, current_user-based, PAY-DC-4A pattern), firing
--    before every other BEFORE trigger. For anon/authenticated callers who are
--    not a platform admin or an active studio_owner/studio_admin/front_desk of
--    the row's studio (the canManageAppointmentPayments set), on
--    floor_space_rental rows:
--      INSERT: must be born payment_status 'unpaid' with price_amount > 0 and
--              no package/membership link (the renter-entered fee is kept:
--              product decision, server-set pricing is a later decision);
--      UPDATE: id, studio_id, client_id, created_by, appointment_type,
--              price_amount, payment_status, billing_type, billing_note,
--              client_package_id, client_membership_id are immutable.
--    Other fields (status for cancellation, notes, schedule) are unchanged.
--    service_role (checkout, webhook, admin paths) and postgres pass.
--
-- Must be applied to BOTH DEV and PROD.

begin;

-- >>> LAUNCH-SEC-2B PRECONDITIONS
do $$
declare
  v_rls boolean;
  v_idx text;
  v_state text;
begin
  if to_regprocedure('public._guard_appointments_floor_rental_financial_fields()') is not null
     or exists (select 1 from pg_trigger where tgname = 'appointments_00_guard_floor_rental_financial_fields')
     or exists (select 1 from pg_policy where polrelid = 'public.appointment_package_deduction_errors'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.studio_job_postings'::regclass
                and polname = 'Studio admins can manage their own job postings') then
    raise exception 'LAUNCH-SEC-2B: partial 2B state present';
  end if;

  -- #4: exactly one of the two reviewed starting states.
  select c.relrowsecurity into v_rls
  from pg_class c where c.oid = 'public.appointment_package_deduction_errors'::regclass;

  select md5(string_agg(pg_get_indexdef(indexrelid), ';' order by pg_get_indexdef(indexrelid))) into v_idx
  from pg_index where indrelid = 'public.appointment_package_deduction_errors'::regclass;

  v_state := case
    when v_rls = false and v_idx = '699a1961938a3dbaf4e5687ccc87320d' then 'A'
    when v_rls = true  and v_idx = '3ff99f880e7e2454b1effe12bda7dcde' then 'B'
  end;

  if v_state is null then
    raise exception 'LAUNCH-SEC-2B: appointment_package_deduction_errors is in neither reviewed starting state (rls=%, idx=%)', v_rls, v_idx;
  end if;

  if (select relforcerowsecurity or pg_get_userbyid(relowner) <> 'postgres'
      from pg_class where oid = 'public.appointment_package_deduction_errors'::regclass)
     or (select string_agg(x::text, ',' order by x::text) from pg_class c, unnest(c.relacl) x
          where c.oid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres'
     or (select md5(string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull::text, ',' order by attnum))
          from pg_attribute where attrelid = 'public.appointment_package_deduction_errors'::regclass and attnum > 0 and not attisdropped)
        is distinct from 'eaa51f470d96b3d3c4ab7fcc9ae63eb6'
     or (select md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname))
          from pg_constraint where conrelid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'c2fbcb983a5464c55662546a9e71b3fa'
     or exists (select 1 from pg_trigger where tgrelid = 'public.appointment_package_deduction_errors'::regclass and not tgisinternal)
     or obj_description('public.appointment_package_deduction_errors'::regclass, 'pg_class') is not null
     or (select md5(string_agg(p.oid::regprocedure::text || ':' || p.prosecdef || ':' || pg_get_userbyid(p.proowner) || ':' || md5(replace(p.prosrc, E'\r', '')), ',' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?appointment_package_deduction_errors\y')
        is distinct from '26e94c2b4cc100f9b336fd1c25c6a173' then
    raise exception 'LAUNCH-SEC-2B: appointment_package_deduction_errors is not the reviewed definition';
  end if;

  -- #5
  if not (select relrowsecurity from pg_class where oid = 'public.studio_job_postings'::regclass)
     or (select md5(string_agg(polname || ':' || polcmd::text || ':' || md5(coalesce(pg_get_expr(polqual, polrelid), '')) || ':' || md5(coalesce(pg_get_expr(polwithcheck, polrelid), '')), ',' order by polname))
          from pg_policy where polrelid = 'public.studio_job_postings'::regclass)
        is distinct from 'e84cb125de4f85be441e6c5779c375ce'
     or not exists (select 1 from pg_policy where polrelid = 'public.studio_job_postings'::regclass
                    and polname = 'Job posting creators can manage their postings'
                    and polroles = array['authenticated'::regrole::oid]) then
    raise exception 'LAUNCH-SEC-2B: studio_job_postings policies are not the reviewed definitions';
  end if;

  -- #8
  if (select md5(string_agg(polname || ':' || polcmd::text || ':' || md5(coalesce(pg_get_expr(polqual, polrelid), '')) || ':' || md5(coalesce(pg_get_expr(polwithcheck, polrelid), '')), ',' order by polname))
       from pg_policy where polrelid = 'public.appointments'::regclass)
       is distinct from '5946b926a6831cdf4186ae720aa03f4d'
     or (select md5(string_agg(tgname || ':' || pg_get_triggerdef(oid) || ':' || tgenabled::text, ',' order by tgname))
          from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
        is distinct from 'd9f05cdb52590e6f8a65291bd208b7fe'
     or (select md5(string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attname))
          from pg_attribute where attrelid = 'public.appointments'::regclass and attnum > 0 and not attisdropped
            and attname in ('id', 'studio_id', 'client_id', 'created_by', 'appointment_type', 'price_amount',
                            'payment_status', 'billing_type', 'billing_note', 'client_package_id', 'client_membership_id'))
        is distinct from '6f33300e4355a3018cafade01e2fb391' then
    raise exception 'LAUNCH-SEC-2B: appointments policies/triggers/columns are not the reviewed definitions';
  end if;

  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                 where t.typname = 'appointment_type' and e.enumlabel = 'floor_space_rental')
     or (select format_type(atttypid, atttypmod) from pg_attribute
          where attrelid = 'public.profiles'::regclass and attname = 'platform_role') is distinct from 'text' then
    raise exception 'LAUNCH-SEC-2B: authority dependencies are not the reviewed definitions';
  end if;

  perform set_config('launchsec2b.starting_state', v_state, true);
end $$;
-- <<< LAUNCH-SEC-2B PRECONDITIONS

-- ============================================================================
-- #4 appointment_package_deduction_errors
-- ============================================================================
alter table public.appointment_package_deduction_errors enable row level security;

revoke all on table public.appointment_package_deduction_errors from anon;
revoke insert, delete, truncate, references, trigger, maintain
  on table public.appointment_package_deduction_errors from authenticated;

create policy "Platform admins and studio finance staff read deduction errors"
on public.appointment_package_deduction_errors
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_package_deduction_errors.studio_id
      and usr.active = true
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::public.app_role[])
  )
);

create policy "Platform admins can resolve package deduction errors"
on public.appointment_package_deduction_errors
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
);

-- Record the reviewed starting state for an environment-exact rollback.
do $$
begin
  execute format(
    'comment on policy %I on public.appointment_package_deduction_errors is %L',
    'Platform admins and studio finance staff read deduction errors',
    'LAUNCH-SEC-2B starting state ' || current_setting('launchsec2b.starting_state')
  );
end $$;

-- ============================================================================
-- #5 studio_job_postings
-- ============================================================================
drop policy "Job posting creators can manage their postings" on public.studio_job_postings;

create policy "Studio admins can manage their own job postings"
on public.studio_job_postings
for all
to authenticated
using (
  auth.uid() = created_by
  and (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.platform_role = 'platform_admin'
    )
    or exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = studio_job_postings.studio_id
        and usr.active = true
        and usr.role = any (array['studio_owner', 'studio_admin']::public.app_role[])
    )
  )
)
with check (
  auth.uid() = created_by
  and (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.platform_role = 'platform_admin'
    )
    or exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = studio_job_postings.studio_id
        and usr.active = true
        and usr.role = any (array['studio_owner', 'studio_admin']::public.app_role[])
    )
  )
);

-- ============================================================================
-- #8 floor-space rental financial / ownership fields
-- ============================================================================
create function public._guard_appointments_floor_rental_financial_fields()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  v_platform_admin boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.appointment_type is distinct from 'floor_space_rental'::public.appointment_type then
      return new;
    end if;
  elsif old.appointment_type is distinct from 'floor_space_rental'::public.appointment_type
    and new.appointment_type is distinct from 'floor_space_rental'::public.appointment_type then
    return new;
  end if;

  v_platform_admin := exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  );

  if v_platform_admin
     or (
       exists (
         select 1 from public.user_studio_roles usr
         where usr.user_id = auth.uid()
           and usr.studio_id = new.studio_id
           and usr.active = true
           and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::public.app_role[])
       )
       and (
         tg_op = 'INSERT'
         or exists (
           select 1 from public.user_studio_roles usr
           where usr.user_id = auth.uid()
             and usr.studio_id = old.studio_id
             and usr.active = true
             and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::public.app_role[])
         )
       )
     ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.payment_status is distinct from 'unpaid'
       or new.price_amount is null
       or new.price_amount <= 0
       or new.client_package_id is not null
       or new.client_membership_id is not null then
      raise exception 'Floor rentals must be booked unpaid with a rental fee greater than zero.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.client_id is distinct from old.client_id
     or new.created_by is distinct from old.created_by
     or new.appointment_type is distinct from old.appointment_type
     or new.price_amount is distinct from old.price_amount
     or new.payment_status is distinct from old.payment_status
     or new.billing_type is distinct from old.billing_type
     or new.billing_note is distinct from old.billing_note
     or new.client_package_id is distinct from old.client_package_id
     or new.client_membership_id is distinct from old.client_membership_id then
    raise exception 'Floor rental pricing, payment and ownership can only be changed by the studio.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public._guard_appointments_floor_rental_financial_fields()
  from public, anon, authenticated, service_role;

create trigger appointments_00_guard_floor_rental_financial_fields
before insert or update on public.appointments
for each row
execute function public._guard_appointments_floor_rental_financial_fields();

-- >>> LAUNCH-SEC-2B POSTCONDITIONS
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.appointment_package_deduction_errors'::regclass)
     or (select string_agg(x::text, ',' order by x::text) from pg_class c, unnest(c.relacl) x
          where c.oid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'authenticated=rw/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres'
     or (select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy
          where polrelid = 'public.appointment_package_deduction_errors'::regclass)
        is distinct from 'Platform admins and studio finance staff read deduction errors:r,Platform admins can resolve package deduction errors:w'
     or (select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy
          where polrelid = 'public.studio_job_postings'::regclass)
        is distinct from 'Public can view published job postings:r,Studio admins can manage their own job postings:*'
     or (select tgname from pg_trigger
          where tgrelid = 'public.appointments'::regclass and not tgisinternal
          order by tgname limit 1) is distinct from 'appointments_00_guard_floor_rental_financial_fields'
     or not exists (select 1 from pg_trigger where tgname = 'appointments_00_guard_floor_rental_financial_fields' and tgenabled = 'O') then
    raise exception 'LAUNCH-SEC-2B postcondition failed';
  end if;
end $$;
-- <<< LAUNCH-SEC-2B POSTCONDITIONS

commit;
