-- GC-1.2: Class Attendance Integrity + Billing Foundation.
--
-- Introduces a validated per-student attendance path for shared `group_class`
-- appointments rows, built on top of GC-1.1's `appointment_attendees` roster.
-- Terminology: "lesson/appointment" = an individual or couple scheduled
-- service (private lesson, intro lesson, coaching); "class" = a group class
-- with multiple students, one shared class instance, a roster of enrolled
-- students, per-student attendance. The `appointments` row is the database
-- implementation detail only -- the live table stores both.
--
-- Existing lesson/appointment billing (the legacy trigger and RPC) is left
-- untouched except one narrow, additive guard (section 4) that prevents it
-- from ever firing against a class's shared `appointments` row -- class
-- billing is an entirely separate path built here, never a generalization
-- of the single-client helper (proven incompatible: its own validation
-- requires `appointments.client_id`/`client_package_id` to match its
-- caller-supplied values, and those columns are NULL on every class
-- `appointments` row under GC-1's locked model).

begin;

-- ============================================================================
-- 1. Shared eligibility predicate.
--
-- Used identically by both the attendance-integrity trigger (section 2) and
-- the class package-billing trigger (section 3) -- this is what guarantees
-- the two can never diverge (an attendance row cannot become 'attended'
-- without having already passed the exact same check billing will re-apply).
--
-- SECURITY INVOKER, not DEFINER: this function is only ever called from
-- within the two SECURITY DEFINER trigger functions below, which have
-- already elevated the execution context to their owning role by the time
-- this nested call happens -- marking this function DEFINER would be a
-- redundant no-op for its only real call sites. INVOKER is the smaller
-- privilege surface and the fail-safer default: if the "never granted to
-- authenticated" invariant below were ever violated by a future mistaken
-- grant, an INVOKER function stays scoped to whatever role calls it
-- directly (subject to that caller's own RLS visibility), whereas a
-- DEFINER function would silently bypass RLS for anyone who gained
-- EXECUTE. Not directly reachable by any client role either way (no grant
-- follows the revokes below).
-- ============================================================================
create or replace function public.class_enrollment_covers_participation(
  p_appointment_id uuid,
  p_client_id uuid,
  p_studio_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.appointment_attendees aa
    join public.appointments a on a.id = aa.appointment_id
    where aa.appointment_id = p_appointment_id
      and aa.client_id = p_client_id
      and aa.studio_id = p_studio_id
      and a.id = p_appointment_id
      and a.studio_id = p_studio_id
      and a.appointment_type = 'group_class'::public.appointment_type
      and (
        aa.status = 'booked'
        or (
          aa.status = 'cancelled'
          and aa.cancelled_at is not null
          and aa.cancelled_at > a.starts_at
        )
      )
  );
$$;

revoke all on function public.class_enrollment_covers_participation(uuid, uuid, uuid) from public;
revoke all on function public.class_enrollment_covers_participation(uuid, uuid, uuid) from anon;
revoke all on function public.class_enrollment_covers_participation(uuid, uuid, uuid) from authenticated;

-- ============================================================================
-- 2. Class attendance-integrity trigger.
--
-- Enforces that a schedule-linked attendance_records row for a group_class
-- appointments row always corresponds to a legitimate class_enrollment_
-- covers_participation() result. Event-linked rows (appointment_id IS NULL)
-- and non-class schedule-linked rows (private lesson, intro, coaching,
-- floor rental -- none of which have a roster concept) are exempt. Does not
-- change attendance_records RLS at all -- RLS already correctly gates WHO
-- may write attendance for a given appointments row (D2c-0B); this trigger
-- gates WHICH client_id is a legitimate target, which RLS cannot express.
-- ============================================================================
create or replace function public.enforce_class_attendance_eligibility()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_type public.appointment_type;
begin
  if new.appointment_id is null then
    return new;
  end if;

  select appointment_type into v_appointment_type
    from public.appointments
    where id = new.appointment_id;

  if v_appointment_type is distinct from 'group_class'::public.appointment_type then
    return new;
  end if;

  if not public.class_enrollment_covers_participation(new.appointment_id, new.client_id, new.studio_id) then
    raise exception 'Invalid class attendance record.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_class_attendance_eligibility() from public;
revoke all on function public.enforce_class_attendance_eligibility() from anon;
revoke all on function public.enforce_class_attendance_eligibility() from authenticated;

create trigger attendance_records_enforce_class_eligibility
  before insert or update on public.attendance_records
  for each row
  execute function public.enforce_class_attendance_eligibility();

-- ============================================================================
-- 3. Class package-deduction trigger.
--
-- A new, separate billing path for shared class attendance -- never calls
-- or modifies the incompatible deduct_package_credit_for_appointment(...)
-- RPC. Fires only on a genuine transition into 'attended' for a
-- group_class-linked attendance_records row; re-checks the exact same
-- shared eligibility predicate as section 2 (defense in depth -- the BEFORE
-- trigger already guarantees this row is eligible, but re-checking is what
-- makes "cannot diverge" a property of the code, not just of trigger
-- ordering); resolves the correct appointment_attendees row (preferring a
-- currently-booked row, else the most recent qualifying cancelled-after-
-- start row); only deducts for billing_type='package_credit' with a
-- populated client_package_id; preserves the exact lock order and
-- deduction shape of the existing lesson billing path. Idempotency key is
-- the explicit (appointment_id, client_id) pair (section 5's new unique
-- index), not client_package_id alone -- correct once one appointments row
-- has many attendees, each with their own distinct package.
-- ============================================================================
create or replace function public.deduct_package_credit_for_class_attendee()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_type public.appointment_type;
  v_attendee record;
  v_item record;
  v_next_used numeric;
  v_next_remaining numeric;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  select appointment_type into v_appointment_type
    from public.appointments
    where id = new.appointment_id;

  if v_appointment_type is distinct from 'group_class'::public.appointment_type then
    return new;
  end if;

  if not public.class_enrollment_covers_participation(new.appointment_id, new.client_id, new.studio_id) then
    return new;
  end if;

  select aa.client_package_id, aa.billing_type
    into v_attendee
    from public.appointment_attendees aa
    where aa.appointment_id = new.appointment_id
      and aa.client_id = new.client_id
    order by (aa.status = 'booked') desc, aa.created_at desc
    limit 1;

  if v_attendee.billing_type is distinct from 'package_credit' or v_attendee.client_package_id is null then
    return new;
  end if;

  begin
    if exists (
      select 1
      from public.lesson_transactions lt
      where lt.appointment_id = new.appointment_id
        and lt.client_id = new.client_id
        and lt.transaction_type::text = 'lesson_deduction'
    ) then
      return new;
    end if;

    -- Same lock order as the existing lesson billing path: client_packages
    -- first, then client_package_items FOR UPDATE.
    perform 1
      from public.client_packages
      where id = v_attendee.client_package_id
        and studio_id = new.studio_id
      for update;

    select cpi.id, cpi.quantity_used, cpi.quantity_remaining, cpi.is_unlimited
      into v_item
      from public.client_package_items cpi
      join public.client_packages cp on cp.id = cpi.client_package_id
      where cpi.client_package_id = v_attendee.client_package_id
        and cpi.usage_type = 'group_class'::public.package_usage_type
        and cp.studio_id = new.studio_id
        and cp.client_id = new.client_id
        and cp.active = true
      limit 1
      for update of cpi;

    if not found then
      return new;
    end if;

    if coalesce(v_item.is_unlimited, false) = true then
      insert into public.lesson_transactions (
        studio_id, client_id, client_package_id, appointment_id,
        transaction_type, lessons_delta, balance_after, notes
      )
      values (
        new.studio_id, new.client_id, v_attendee.client_package_id, new.appointment_id,
        'lesson_deduction'::transaction_type, 0, null,
        'Auto-recorded attended class from unlimited package.'
      );

      return new;
    end if;

    if coalesce(v_item.quantity_remaining, 0) <= 0 then
      return new;
    end if;

    v_next_used := coalesce(v_item.quantity_used, 0) + 1;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) - 1;

    update public.client_package_items
      set quantity_used = v_next_used,
          quantity_remaining = v_next_remaining
      where id = v_item.id;

    -- Reconcile lifecycle: after this deduction, does the package still
    -- have usable balance across ANY of its items? Same convention as the
    -- existing lesson billing trigger -- only narrows active true->false,
    -- never sets it back to true.
    update public.client_packages cp
      set updated_at = now(),
          active = case
            when exists (
              select 1
              from public.client_package_items cpi2
              where cpi2.client_package_id = cp.id
                and (cpi2.is_unlimited = true or coalesce(cpi2.quantity_remaining, 0) > 0)
            ) then cp.active
            else false
          end
      where cp.id = v_attendee.client_package_id
        and cp.studio_id = new.studio_id;

    insert into public.lesson_transactions (
      studio_id, client_id, client_package_id, appointment_id,
      transaction_type, lessons_delta, balance_after, notes
    )
    values (
      new.studio_id, new.client_id, v_attendee.client_package_id, new.appointment_id,
      'lesson_deduction'::transaction_type, -1, v_next_remaining,
      'Auto-deducted 1 class credit when attendance was marked attended.'
    );

    return new;

  exception when others then
    begin
      insert into public.appointment_package_deduction_errors (
        appointment_id, studio_id, client_id, client_package_id, appointment_type, error_message
      )
      values (
        new.appointment_id, new.studio_id, new.client_id, v_attendee.client_package_id,
        v_appointment_type::text, sqlerrm
      );
    exception when others then
      null;
    end;
    return new;
  end;
end;
$$;

revoke all on function public.deduct_package_credit_for_class_attendee() from public;
revoke all on function public.deduct_package_credit_for_class_attendee() from anon;
revoke all on function public.deduct_package_credit_for_class_attendee() from authenticated;

create trigger attendance_records_deduct_package_credit_for_class
  after insert or update of status on public.attendance_records
  for each row
  when (new.status = 'attended' and new.appointment_id is not null)
  execute function public.deduct_package_credit_for_class_attendee();

-- ============================================================================
-- 4. Legacy lesson/appointment billing trigger -- one narrow, additive
--    guard. Every other line of the currently-deployed function is
--    preserved byte-for-byte (captured live immediately before writing
--    this migration). This closes the latent path where an app action
--    with no appointment_type guard (e.g. a bulk "mark attended" action)
--    could set a class's shared appointments row to status='attended' and
--    inadvertently fire single-client billing against it -- the class's
--    shared appointments row must never be treated as one student's
--    attendance, regardless of which app code sets its status, now or
--    later. Zero effect on lesson/appointment billing: the added branch
--    only ever matches appointment_type='group_class', which no other
--    branch of this function currently reaches differently.
-- ============================================================================
create or replace function public.deduct_package_credit_when_appointment_attended()
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
$$;

commit;
