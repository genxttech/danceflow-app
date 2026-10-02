-- 20261010090000_launchsec2a_owner_billing_authority.sql
--
-- LAUNCH-SEC-2A: organizer self-escalation / organizer billing authority.
--
-- Before this migration any active member of a studio (instructor, front desk,
-- ...) could, through ordinary tenant writes:
--   * INSERT/UPDATE organizer_users rows for that studio's organizer with any
--     user_id and any role -- e.g. make themselves organizer_owner, which the
--     app treats as owner-level billing authority;
--   * INSERT an organizers row (it is born subscription_status 'trialing',
--     i.e. an active organizer entitlement) without the server's
--     owner + active-Organizer-plan check;
--   * UPDATE the organizer's server-owned billing/payment fields
--     (billing_plan, subscription_status, platform_fee_bps, Stripe ids/flags)
--     or move it to another studio.
--
-- The only legitimate writer of either table is createOrganizerAction, which
-- now performs both writes with the service role after verifying the caller
-- is the workspace owner and the workspace has an active Organizer plan.
-- No database function writes either table.
--
-- Fix (minimal; no data change, existing rows untouched):
--   1. organizer_users: drop the tenant INSERT and UPDATE policies. RLS then
--      denies every tenant write; SELECT is unchanged; there was never a
--      DELETE policy.
--   2. organizers: drop the tenant INSERT policy. The tenant UPDATE policy is
--      kept so profile fields stay editable exactly as before.
--   3. organizers: SECURITY INVOKER guard trigger deciding only on
--      current_user (the PAY-DC-4A / entitlement-guard pattern). For anon and
--      authenticated: INSERT is rejected; UPDATE changing id, studio_id or any
--      billing/payment field is rejected. service_role, postgres and SECURITY
--      DEFINER owner contexts pass.
--
-- Must be applied to BOTH DEV and PROD.

begin;

-- >>> LAUNCH-SEC-2A PRECONDITIONS
do $$
declare
  v_policies text;
  v_triggers text;
  v_missing int;
begin
  if to_regprocedure('public._guard_organizers_server_owned_fields()') is not null
     or exists (select 1 from pg_trigger where tgname = 'guard_organizers_server_owned_fields') then
    raise exception 'LAUNCH-SEC-2A: partial 2A state present';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.organizers'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.organizer_users'::regclass) then
    raise exception 'LAUNCH-SEC-2A: RLS is not enabled on organizers/organizer_users';
  end if;

  select string_agg(
           c.relname || '.' || p.polname || ':' || p.polcmd::text || ':'
           || md5(coalesce(pg_get_expr(p.polqual, p.polrelid), '')) || ':'
           || md5(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')),
           ',' order by c.relname, p.polname)
    into v_policies
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass)
    and p.polroles = array[0::oid]
    and p.polpermissive;

  if v_policies is distinct from
       'organizer_users.organizer_users_insert_by_studio_role:a:d41d8cd98f00b204e9800998ecf8427e:1c51ed42a06f053a59956dd6462683e6,'
    || 'organizer_users.organizer_users_select_by_studio_role_or_self:r:510b4666f599690b715be267205f4f1f:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizer_users.organizer_users_update_by_studio_role:w:1c51ed42a06f053a59956dd6462683e6:1c51ed42a06f053a59956dd6462683e6,'
    || 'organizers.organizers_insert_by_studio_role:a:d41d8cd98f00b204e9800998ecf8427e:a8bcfbbc64e9d41536b3746a8d0ad255,'
    || 'organizers.organizers_public_read_active:r:4edddc86d6a5ca53305b1985a672869e:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizers.organizers_select_by_studio_role:r:e4b2ce858493206c2bf98149d8aa4d1d:d41d8cd98f00b204e9800998ecf8427e,'
    || 'organizers.organizers_update_by_studio_role:w:e4b2ce858493206c2bf98149d8aa4d1d:e4b2ce858493206c2bf98149d8aa4d1d'
     or (select count(*) from pg_policy
          where polrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass)) <> 7 then
    raise exception 'LAUNCH-SEC-2A: organizers/organizer_users policies are not the reviewed definitions';
  end if;

  select string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgname)
    into v_triggers
  from pg_trigger
  where tgrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass)
    and not tgisinternal;

  if v_triggers is distinct from 'organizers.set_organizers_updated_at' then
    raise exception 'LAUNCH-SEC-2A: unexpected triggers on organizers/organizer_users: %', v_triggers;
  end if;

  select count(*) into v_missing
  from unnest(array[
    'id', 'studio_id', 'billing_plan', 'subscription_status', 'stripe_customer_id',
    'stripe_subscription_id', 'stripe_connected_account_id',
    'stripe_connect_details_submitted', 'stripe_connect_charges_enabled',
    'stripe_connect_payouts_enabled', 'stripe_connect_onboarding_complete',
    'platform_fee_bps'
  ]) as col(name)
  where not exists (
    select 1 from pg_attribute
    where attrelid = 'public.organizers'::regclass and attname = col.name and not attisdropped
  );

  if v_missing <> 0 then
    raise exception 'LAUNCH-SEC-2A: organizers is missing % guarded column(s)', v_missing;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizer_users'::regclass
      and conname = 'organizer_users_role_check'
      and pg_get_constraintdef(oid)
          = 'CHECK ((role = ANY (ARRAY[''organizer_owner''::text, ''organizer_admin''::text, ''organizer_staff''::text])))'
  ) then
    raise exception 'LAUNCH-SEC-2A: organizer_users role allowlist is not the reviewed constraint';
  end if;

  if exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace
      and prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?organizer(s|_users)\b'
  ) then
    raise exception 'LAUNCH-SEC-2A: a database function writes organizers/organizer_users';
  end if;
end $$;
-- <<< LAUNCH-SEC-2A PRECONDITIONS

-- 1. organizer_users: server-only writes.
drop policy organizer_users_insert_by_studio_role on public.organizer_users;
drop policy organizer_users_update_by_studio_role on public.organizer_users;

-- 2. organizers: server-only creation (profile UPDATE policy kept).
drop policy organizers_insert_by_studio_role on public.organizers;

-- 3. organizers: server-owned identity/billing/payment fields.
create function public._guard_organizers_server_owned_fields()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      raise exception 'organizers can only be created by the server.'
        using errcode = '42501';
    end if;

    if new.id is distinct from old.id
       or new.studio_id is distinct from old.studio_id
       or new.billing_plan is distinct from old.billing_plan
       or new.subscription_status is distinct from old.subscription_status
       or new.stripe_customer_id is distinct from old.stripe_customer_id
       or new.stripe_subscription_id is distinct from old.stripe_subscription_id
       or new.stripe_connected_account_id is distinct from old.stripe_connected_account_id
       or new.stripe_connect_details_submitted is distinct from old.stripe_connect_details_submitted
       or new.stripe_connect_charges_enabled is distinct from old.stripe_connect_charges_enabled
       or new.stripe_connect_payouts_enabled is distinct from old.stripe_connect_payouts_enabled
       or new.stripe_connect_onboarding_complete is distinct from old.stripe_connect_onboarding_complete
       or new.platform_fee_bps is distinct from old.platform_fee_bps then
      raise exception 'organizers billing and payment fields cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_organizers_server_owned_fields()
  from public, anon, authenticated, service_role;

create trigger guard_organizers_server_owned_fields
before insert or update on public.organizers
for each row
execute function public._guard_organizers_server_owned_fields();

-- >>> LAUNCH-SEC-2A POSTCONDITIONS
do $$
declare
  v_policies text;
begin
  select string_agg(c.relname || '.' || p.polname || ':' || p.polcmd::text, ',' order by c.relname, p.polname)
    into v_policies
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polrelid in ('public.organizers'::regclass, 'public.organizer_users'::regclass);

  if v_policies is distinct from
       'organizer_users.organizer_users_select_by_studio_role_or_self:r,'
    || 'organizers.organizers_public_read_active:r,'
    || 'organizers.organizers_select_by_studio_role:r,'
    || 'organizers.organizers_update_by_studio_role:w' then
    raise exception 'LAUNCH-SEC-2A postcondition: unexpected policies %', v_policies;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.organizers'::regclass
      and tgname = 'guard_organizers_server_owned_fields'
      and tgenabled = 'O'
  ) then
    raise exception 'LAUNCH-SEC-2A postcondition: guard trigger missing or disabled';
  end if;
end $$;
-- <<< LAUNCH-SEC-2A POSTCONDITIONS

commit;
