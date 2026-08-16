-- Schedule Stabilization Slice 1b-a: DB-trigger lifecycle reconciliation.
--
-- deduct_package_credit_when_appointment_attended() previously deducted
-- real package credit on any appointments.status -> 'attended' transition
-- (regardless of caller -- staff UI, bulk imports, anything) without ever
-- reconciling client_packages.active. Only the JS-side
-- reconcileClientPackageLifecycle (src/lib/packages/lifecycle.ts) did that,
-- and it is reachable exclusively from the staff-initiated JS attendance
-- flows -- never from a direct appointments.status write, e.g. the
-- WellnessLiving/Mindbody attendance-CSV importers.
--
-- This replaces the function body to reconcile active immediately after a
-- real (non-unlimited) deduction, atomically with the deduction itself, in
-- the same statement family already covered by the trigger's existing
-- row-locking (`for update`) and idempotency check (lesson_transactions
-- marker). Preserves all existing deduction semantics, error handling
-- (non-blocking, logs to appointment_package_deduction_errors), and
-- transaction recording exactly as before -- the only change is the added
-- reconciliation step.
--
-- Reconciliation rule (matches hasUsablePackageCredit in lifecycle.ts):
-- the package remains active if ANY of its items is unlimited or has
-- quantity_remaining > 0; it becomes inactive only when every item is
-- finite and depleted. This can only narrow active from true to false --
-- it never sets active back to true, so a manually archived package
-- (already active=false) is never touched, and archive_at/archived_by/
-- archive_reason are never read or written by this trigger.

create or replace function deduct_package_credit_when_appointment_attended()
returns trigger
language plpgsql
security definer
as $$
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
$$;
