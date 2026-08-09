-- P0.1 follow-up: atomic, row-locked package credit deduction.
--
-- The JS-side "sole deductor" path (missed-appointment charges, and the
-- attendance-trigger-didn't-fire fallback) previously did a plain
-- SELECT-then-UPDATE against client_package_items.quantity_remaining. That
-- is safe against sequential replay but not against a genuinely concurrent
-- deduction against the same package (e.g. one appointment being marked
-- attended while a different appointment on the same package is being
-- cancelled with a missed-appointment charge at the same time): both could
-- read the same starting balance and one decrement would be silently lost.
--
-- This function moves that decrement (plus its lesson_transactions ledger
-- row and the legacy client_packages mirror) into a single transaction that
-- takes `for update` on the client_package_items row, mirroring how
-- deduct_package_credit_when_appointment_attended (20260426060000) already
-- protects the attendance-trigger path. Two concurrent callers against the
-- same package now serialize on that row lock instead of racing.
--
-- It also recognizes BOTH the current (`lesson_deduction`) and legacy
-- (`appointment_attendance`) transaction_type markers as evidence that a
-- given (appointment_id, client_package_id) was already deducted, so
-- replaying a deduction for an appointment that was attended before the
-- lesson_deduction marker existed cannot consume a second credit.
--
-- Security-review follow-up: this function is SECURITY DEFINER and granted
-- to `authenticated` (the app calls it with the user's own session client,
-- not an admin client), so it cannot rely on the caller-supplied
-- p_studio_id/p_client_id/p_appointment_id being honest on their own —
-- anyone with a valid session could otherwise call it directly with
-- fabricated IDs to mutate an arbitrary client's package balance. It now
-- independently verifies, using auth.uid(), that the caller has an active
-- studio role entitled to record attendance/appointment activity for
-- p_studio_id (mirroring the role set behind canMarkAttendance /
-- canEditAppointments in src/lib/auth/permissions.ts, since both call paths
-- reach this function), or is a platform admin — and separately verifies
-- that p_appointment_id is a real appointment belonging to p_studio_id,
-- p_client_id, and p_client_package_id, so a caller who legitimately
-- belongs to the right studio still cannot pass a fabricated or
-- mismatched appointment/client/package combination to move someone else's
-- balance.
create or replace function deduct_package_credit_for_appointment(
  p_studio_id uuid,
  p_client_id uuid,
  p_client_package_id uuid,
  p_appointment_id uuid,
  p_usage_type text
)
returns table (
  found_item boolean,
  already_deducted boolean,
  is_unlimited boolean,
  quantity_used numeric,
  quantity_remaining numeric
)
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute
  on function deduct_package_credit_for_appointment(uuid, uuid, uuid, uuid, text)
  to authenticated;
