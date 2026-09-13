-- Rollback for 20260913091000_gc3c_group_class_funding_candidate_set_function.sql
--
-- Restores enroll_class_attendee to its exact immediately-prior (GC-2d)
-- definition via CREATE OR REPLACE -- reproduced verbatim from
-- 20260913090300_gc2d_enrollment_funding_row_selection.sql, not an older
-- historical version. Drops the purely-new
-- get_eligible_group_class_funding_candidates function outright.
--
-- IMPORTANT: run this BEFORE rolling back gc3b (20260913090900) -- this
-- file's restored enroll_class_attendee body no longer references
-- group_class_enrollment_policies at all, so ordering only matters the one
-- direction (gc3c back out first, then gc3b).

begin;

drop function if exists public.get_eligible_group_class_funding_candidates(uuid, uuid, uuid, uuid);

create or replace function public.enroll_class_attendee(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text default null,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_authority text;
  v_studio_id uuid;
  v_starts_at timestamptz;
  v_source text;
  v_billing_type text;
  v_client_package_id uuid;
  v_client_membership_id uuid;
  v_eligible_package_count int;
  v_eligible_unlimited_membership_count int;
  v_eligible_finite_membership_count int;
  v_attendee_id uuid;
begin
  select studio_id, starts_at into v_studio_id, v_starts_at
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  v_authority := public._gc1_4_class_enrollment_authority(v_studio_id, p_appointment_id);

  if v_authority is null then
    raise exception 'Not authorized to enroll a student into this class.';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  if v_authority = 'broad' then
    v_source := 'staff';
    v_billing_type := coalesce(p_billing_type, 'package_credit');
    v_client_package_id := p_client_package_id;
    v_client_membership_id := p_client_membership_id;
  else
    -- own_instructor: ignore every caller-supplied billing parameter.
    v_source := 'instructor';

    select count(*) into v_eligible_package_count
      from public.client_package_items cpi
      join public.client_packages cp on cp.id = cpi.client_package_id
      where cp.studio_id = v_studio_id
        and cp.client_id = p_client_id
        and cp.active = true
        and cpi.usage_type = 'group_class'::package_usage_type
        and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0);

    select count(distinct cm.id) into v_eligible_unlimited_membership_count
      from public.client_memberships cm
      join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
      where cm.studio_id = v_studio_id
        and cm.client_id = p_client_id
        and cm.status = 'active'
        and mpb.benefit_type = 'unlimited_group_classes'
        and mpb.quantity is null
        and (
          mpb.applies_to is null
          or mpb.applies_to = ''
          or mpb.applies_to = 'all'
          or mpb.applies_to = 'group_class'
        );

    select count(*) into v_eligible_finite_membership_count
      from (
        select distinct cm.id as membership_id, mpb.id as benefit_id
        from public.client_memberships cm
        join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
        where cm.studio_id = v_studio_id
          and cm.client_id = p_client_id
          and cm.status = 'active'
          and mpb.benefit_type = 'included_group_classes'
          and (
            mpb.applies_to is null
            or mpb.applies_to = ''
            or mpb.applies_to = 'all'
            or mpb.applies_to = 'group_class'
          )
          and not exists (
            select 1 from public.membership_plan_benefits mpb2
            where mpb2.membership_plan_id = cm.membership_plan_id
              and mpb2.benefit_type = 'unlimited_group_classes'
          )
      ) candidates
      cross join lateral public._group_class_finite_balance(
        candidates.membership_id, candidates.benefit_id, v_starts_at, null
      ) bal
      where bal.available > 0;

    if (v_eligible_package_count + v_eligible_unlimited_membership_count + v_eligible_finite_membership_count) <> 1 then
      raise exception 'This enrollment needs a billing decision -- ask an owner, admin, or front desk to complete it.';
    end if;

    if v_eligible_package_count = 1 then
      select cp.id into v_client_package_id
        from public.client_package_items cpi
        join public.client_packages cp on cp.id = cpi.client_package_id
        where cp.studio_id = v_studio_id
          and cp.client_id = p_client_id
          and cp.active = true
          and cpi.usage_type = 'group_class'::package_usage_type
          and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0)
        limit 1;

      v_billing_type := 'package_credit';
      v_client_membership_id := null;
    elsif v_eligible_unlimited_membership_count = 1 then
      select distinct cm.id into v_client_membership_id
        from public.client_memberships cm
        join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
        where cm.studio_id = v_studio_id
          and cm.client_id = p_client_id
          and cm.status = 'active'
          and mpb.benefit_type = 'unlimited_group_classes'
          and mpb.quantity is null
          and (
            mpb.applies_to is null
            or mpb.applies_to = ''
            or mpb.applies_to = 'all'
            or mpb.applies_to = 'group_class'
          )
        limit 1;

      v_billing_type := 'membership';
      v_client_package_id := null;
    else
      select candidates.membership_id into v_client_membership_id
        from (
          select distinct cm.id as membership_id, mpb.id as benefit_id
          from public.client_memberships cm
          join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
          where cm.studio_id = v_studio_id
            and cm.client_id = p_client_id
            and cm.status = 'active'
            and mpb.benefit_type = 'included_group_classes'
            and (
              mpb.applies_to is null
              or mpb.applies_to = ''
              or mpb.applies_to = 'all'
              or mpb.applies_to = 'group_class'
            )
            and not exists (
              select 1 from public.membership_plan_benefits mpb2
              where mpb2.membership_plan_id = cm.membership_plan_id
                and mpb2.benefit_type = 'unlimited_group_classes'
            )
        ) candidates
        cross join lateral public._group_class_finite_balance(
          candidates.membership_id, candidates.benefit_id, v_starts_at, null
        ) bal
        where bal.available > 0
        limit 1;

      v_billing_type := 'membership';
      v_client_package_id := null;
    end if;
  end if;

  begin
    insert into public.appointment_attendees (
      studio_id, appointment_id, client_id, status, source,
      billing_type, client_package_id, client_membership_id, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'booked', v_source,
      v_billing_type, v_client_package_id, v_client_membership_id, auth.uid()
    )
    returning id into v_attendee_id;
  exception when unique_violation then
    raise exception 'This client is already enrolled in this class.';
  end;

  return v_attendee_id;
end;
$$;

revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from public;
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from anon;
grant execute on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) to authenticated;
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from service_role;

commit;
