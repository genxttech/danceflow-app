-- ROLLBACK for PKG-MUT-1. Manual, owner-approved use only -- never automatic.
--
-- Restores the exact pre-PKG-MUT-1 released bodies (captured from PROD and
-- DEV via pg_get_functiondef; identical in both apart from line endings) of:
--   public.deduct_package_credit_for_appointment(uuid, uuid, uuid, uuid, text)
--   public.deduct_package_credit_when_appointment_attended()
-- i.e. removes only the PKG-MUT-1 package-first `perform 1 ... for update`
-- lock. `create or replace` preserves owner and EXECUTE ACL.
--
-- Section 2 additionally drops the two manual package mutation RPCs created
-- by 20260823091500_package_item_manual_mutation_rpcs.sql. Running it
-- returns lesson-count correction and package balance adjustment to their
-- pre-hotfix failing state (they fail before any write). Run section 2 only
-- if those RPCs themselves must be withdrawn. The two sections are
-- independent: package-first locking is safe to keep without the RPCs, and
-- remove only the section(s) you intend to run.
--
-- No schema, grant, policy, trigger or data change beyond the above.

begin;

-- Section 1: restore pre-PKG-MUT-1 lock order (item-first) bodies.
CREATE OR REPLACE FUNCTION public.deduct_package_credit_for_appointment(p_studio_id uuid, p_client_id uuid, p_client_package_id uuid, p_appointment_id uuid, p_usage_type text)
 RETURNS TABLE(found_item boolean, already_deducted boolean, is_unlimited boolean, quantity_used numeric, quantity_remaining numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_id uuid := auth.uid();
  v_authorized boolean;
  v_item record;
  v_found_item boolean;
  v_already_deducted boolean;
  v_next_used numeric;
  v_next_remaining numeric;
  v_usage_label text := replace(p_usage_type, '_', ' ');
begin
  v_authorized := exists (
    select 1
    from profiles
    where id = v_caller_id
      and platform_role = 'platform_admin'
  ) or exists (
    select 1
    from user_studio_roles
    where user_id = v_caller_id
      and studio_id = p_studio_id
      and active = true
      and role in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'instructor',
        'independent_instructor'
      )
  );

  if not v_authorized then
    raise exception 'Not authorized to record package usage for this studio.';
  end if;

  if not exists (
    select 1
    from appointments a
    where a.id = p_appointment_id
      and a.studio_id = p_studio_id
      and a.client_id = p_client_id
      and a.client_package_id = p_client_package_id
  ) then
    raise exception 'Appointment does not match the supplied studio, client, and package.';
  end if;

  select
    cpi.id,
    cpi.quantity_used,
    cpi.quantity_remaining,
    cpi.is_unlimited,
    cp.lessons_remaining
  into v_item
  from client_package_items cpi
  join client_packages cp
    on cp.id = cpi.client_package_id
  where cpi.client_package_id = p_client_package_id
    and cpi.usage_type = p_usage_type::package_usage_type
    and cp.studio_id = p_studio_id
    and cp.client_id = p_client_id
    and cp.active = true
  limit 1
  for update of cpi;

  v_found_item := found;

  -- Recognize both the current and legacy deduction markers so replaying a
  -- deduction for an appointment attended before this function existed
  -- cannot consume a second credit.
  v_already_deducted := exists (
    select 1
    from lesson_transactions lt
    where lt.appointment_id = p_appointment_id
      and lt.client_package_id = p_client_package_id
      and lt.transaction_type::text in ('lesson_deduction', 'appointment_attendance')
  );

  if not v_found_item then
    if v_already_deducted then
      -- Already deducted and the package has since been reconciled to
      -- inactive (e.g. it was fully depleted) — nothing left to do.
      return query select false, true, false, null::numeric, null::numeric;
      return;
    end if;

    raise exception 'No matching active package credit was found for this appointment.';
  end if;

  if coalesce(v_item.is_unlimited, false) then
    if not v_already_deducted then
      insert into lesson_transactions (
        studio_id,
        client_id,
        client_package_id,
        appointment_id,
        transaction_type,
        lessons_delta,
        balance_after,
        notes
      )
      values (
        p_studio_id,
        p_client_id,
        p_client_package_id,
        p_appointment_id,
        'lesson_deduction'::transaction_type,
        0,
        null,
        'Auto-recorded ' || v_usage_label || ' usage from unlimited package.'
      );
    end if;

    return query select true, v_already_deducted, true, v_item.quantity_used, v_item.quantity_remaining;
    return;
  end if;

  if v_already_deducted then
    v_next_used := v_item.quantity_used;
    v_next_remaining := v_item.quantity_remaining;
  else
    if coalesce(v_item.quantity_remaining, 0) <= 0 then
      raise exception 'The selected package has no remaining credits.';
    end if;

    v_next_used := coalesce(v_item.quantity_used, 0) + 1;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) - 1;

    update client_package_items
    set
      quantity_used = v_next_used,
      quantity_remaining = v_next_remaining
    where id = v_item.id;

    insert into lesson_transactions (
      studio_id,
      client_id,
      client_package_id,
      appointment_id,
      transaction_type,
      lessons_delta,
      balance_after,
      notes
    )
    values (
      p_studio_id,
      p_client_id,
      p_client_package_id,
      p_appointment_id,
      'lesson_deduction'::transaction_type,
      -1,
      v_next_remaining,
      'Auto-deducted 1 ' || v_usage_label || ' credit for this appointment.'
    );
  end if;

  if p_usage_type = 'private_lesson' then
    update client_packages
    set
      lessons_used = v_next_used,
      lessons_remaining = case
        when v_item.lessons_remaining is not null then v_next_remaining
        else lessons_remaining
      end,
      updated_at = now()
    where id = p_client_package_id
      and studio_id = p_studio_id;
  else
    update client_packages
    set updated_at = now()
    where id = p_client_package_id
      and studio_id = p_studio_id;
  end if;

  return query select true, v_already_deducted, false, v_next_used, v_next_remaining;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.deduct_package_credit_when_appointment_attended()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_usage_type text;
  v_item record;
  v_next_used numeric;
  v_next_remaining numeric;
begin
  if coalesce(new.status::text, '') <> 'attended' then
    return new;
  end if;

  if tg_op = 'UPDATE' and coalesce(old.status::text, '') = coalesce(new.status::text, '') then
    return new;
  end if;

  if new.appointment_type::text = 'group_class' then
    return new;
  end if;

  begin
    if new.client_package_id is null or new.client_id is null then
      return new;
    end if;

    if exists (
      select 1
      from lesson_transactions lt
      where lt.appointment_id = new.id
        and lt.client_package_id = new.client_package_id
        and lt.transaction_type::text = 'lesson_deduction'
    ) then
      return new;
    end if;

    v_usage_type :=
      case new.appointment_type::text
        when 'private_lesson' then 'private_lesson'
        when 'intro_lesson' then 'private_lesson'
        when 'coaching' then 'private_lesson'
        when 'group_class' then 'group_class'
        when 'practice_party' then 'practice_party'
        when 'event' then 'practice_party'
        else null
      end;

    if v_usage_type is null then
      return new;
    end if;

    select
      cpi.id,
      cpi.client_package_id,
      cpi.usage_type,
      cpi.quantity_used,
      cpi.quantity_remaining,
      cpi.is_unlimited
    into v_item
    from client_package_items cpi
    join client_packages cp
      on cp.id = cpi.client_package_id
    where cpi.client_package_id = new.client_package_id
      and cpi.usage_type = v_usage_type::package_usage_type
      and cp.studio_id = new.studio_id
      and cp.client_id = new.client_id
      and cp.active = true
    limit 1
    for update;

    if not found then
      return new;
    end if;

    if coalesce(v_item.is_unlimited, false) = true then
      insert into lesson_transactions (
        studio_id,
        client_id,
        client_package_id,
        appointment_id,
        transaction_type,
        lessons_delta,
        balance_after,
        notes
      )
      values (
        new.studio_id,
        new.client_id,
        new.client_package_id,
        new.id,
        'lesson_deduction'::transaction_type,
        0,
        null,
        'Auto-recorded attended ' || replace(v_usage_type, '_', ' ') || ' from unlimited package.'
      );

      return new;
    end if;

    if coalesce(v_item.quantity_remaining, 0) <= 0 then
      return new;
    end if;

    v_next_used := coalesce(v_item.quantity_used, 0) + 1;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) - 1;

    update client_package_items
    set
      quantity_used = v_next_used,
      quantity_remaining = v_next_remaining
    where id = v_item.id;

    -- Reconcile lifecycle: after this deduction, does the package still
    -- have usable balance across ANY of its items? OR-across-items,
    -- matching hasUsablePackageCredit. Only narrows active true->false;
    -- never sets it back to true, never touches archive metadata.
    update client_packages cp
    set
      updated_at = now(),
      active = case
        when exists (
          select 1
          from client_package_items cpi2
          where cpi2.client_package_id = cp.id
            and (cpi2.is_unlimited = true or coalesce(cpi2.quantity_remaining, 0) > 0)
        ) then cp.active
        else false
      end
    where cp.id = new.client_package_id
      and cp.studio_id = new.studio_id;

    insert into lesson_transactions (
      studio_id,
      client_id,
      client_package_id,
      appointment_id,
      transaction_type,
      lessons_delta,
      balance_after,
      notes
    )
    values (
      new.studio_id,
      new.client_id,
      new.client_package_id,
      new.id,
      'lesson_deduction'::transaction_type,
      -1,
      v_next_remaining,
      'Auto-deducted 1 ' || replace(v_usage_type, '_', ' ') || ' credit when appointment was marked attended.'
    );

    return new;

  exception when others then
    begin
      insert into appointment_package_deduction_errors (
        appointment_id,
        studio_id,
        client_id,
        client_package_id,
        appointment_type,
        error_message
      )
      values (
        new.id,
        new.studio_id,
        new.client_id,
        new.client_package_id,
        new.appointment_type::text,
        sqlerrm
      );
    exception when others then
      null;
    end;

    return new;
  end;
end;
$function$
;

-- Section 2: withdraw the manual package mutation RPCs.
drop function if exists public.apply_package_item_manual_correction(uuid, uuid, uuid, text, integer, text, uuid);
drop function if exists public.apply_package_balance_adjustment(uuid, uuid, text, text, numeric, text, uuid);

commit;
