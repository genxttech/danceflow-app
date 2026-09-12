-- Membership Usage-Period Alignment -- P3: fail-safe usage-sync writer +
-- secure generic error infrastructure + non-destructive retry.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections H, I, J.
--
-- The usage-sync trigger is created DISABLED (plan section K, step 1) --
-- the old TypeScript writer (syncMembershipUsageForAppointment /
-- clearMembershipUsageForAppointment, schedule/actions.ts:921-1077) remains
-- sole authority until the application deploy that stops calling it has
-- shipped and the trigger is explicitly enabled afterward. Do not enable
-- this trigger as part of this migration or any later migration in this
-- set -- enabling it is a separate, tiny SQL step run by hand per plan
-- section K/AC/AD, only after the application deploy.

begin;

-- ============================================================================
-- 1. Secure generic error table (plan section I). Benefit-agnostic by
--    design: private lessons populate appointment_id (leave
--    attendance_record_id null); a future group-class implementation
--    populates attendance_record_id (leaves appointment_id null). Same
--    table, same secure posture, never two tables.
-- ============================================================================
create table if not exists public.membership_usage_sync_errors (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  attendance_record_id uuid references public.attendance_records(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  client_membership_id uuid references public.client_memberships(id) on delete set null,
  membership_plan_benefit_id uuid references public.membership_plan_benefits(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_notes text
);

comment on table public.membership_usage_sync_errors is
  'Membership Usage-Period Alignment: secure, benefit-agnostic audit trail for '
  'recoverable client_membership_usage sync failures. RLS enabled, zero policies -- '
  'deliberately NOT modeled on the insecure appointment_package_deduction_errors '
  '(see SEC -- Package Deduction Error Table Access Hardening, tracked separately).';

alter table public.membership_usage_sync_errors enable row level security;
-- No policies added for any role -- RLS enabled with zero policies denies
-- all PostgREST access by default (anon, authenticated).

revoke all on public.membership_usage_sync_errors from public;
revoke all on public.membership_usage_sync_errors from anon;
revoke all on public.membership_usage_sync_errors from authenticated;
-- service_role keeps its normal implicit RLS-bypass/table access for backend
-- tooling/support scripts -- an ordinary internal data table, not an
-- auth.uid()-dependent RPC, so this is standard and not the SEC-P0 pattern.

create index idx_membership_usage_sync_errors_studio_id
  on public.membership_usage_sync_errors (studio_id);
create index idx_membership_usage_sync_errors_unresolved
  on public.membership_usage_sync_errors (studio_id)
  where resolved_at is null;

-- ============================================================================
-- 2. Canonical DB-side writer for private-lesson usage sync (plan section
--    H). Delete-then-maybe-reinsert, byte-for-byte matching today's actual
--    syncMembershipUsageForAppointment behavior. Never touches
--    appointments.status. On failure, logs to the error table above and
--    returns normally -- the caller (the trigger wrapper below) always
--    succeeds, so attendance can never be blocked by a usage-sync failure
--    (plan section F's approved fail-safe decision).
-- ============================================================================
create or replace function public._sync_membership_usage_for_private_lesson_appointment(
  p_appointment_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_appt record;
  v_benefit_id uuid;
  v_period_id uuid;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found or v_appt.appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    return;
  end if;

  delete from public.client_membership_usage
    where reference_type = 'appointment' and reference_id = p_appointment_id;

  if v_appt.status = 'attended' and v_appt.billing_type = 'membership' and v_appt.client_membership_id is not null then
    select mpb.id into v_benefit_id
      from public.membership_plan_benefits mpb
      join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
      where cm.id = v_appt.client_membership_id
        and mpb.benefit_type = 'included_private_lessons';

    if v_benefit_id is not null then
      v_period_id := public._ensure_membership_period_for_date(v_appt.client_membership_id, v_appt.starts_at::date);
      insert into public.client_membership_usage (
        client_membership_id, client_membership_period_id, membership_plan_benefit_id,
        usage_date, quantity_used, reference_type, reference_id
      ) values (
        v_appt.client_membership_id, v_period_id, v_benefit_id,
        v_appt.starts_at::date, 1, 'appointment', p_appointment_id
      );
    end if;
  end if;
exception when others then
  insert into public.membership_usage_sync_errors (
    studio_id, appointment_id, client_id, client_membership_id, membership_plan_benefit_id, error_message
  ) values (
    v_appt.studio_id, p_appointment_id, v_appt.client_id, v_appt.client_membership_id, v_benefit_id, sqlerrm
  );
end;
$$;

revoke all on function public._sync_membership_usage_for_private_lesson_appointment(uuid) from public, anon, authenticated, service_role;

create or replace function public.sync_membership_usage_for_private_lesson_appointment()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  perform public._sync_membership_usage_for_private_lesson_appointment(new.id);
  return new;
end;
$$;

revoke all on function public.sync_membership_usage_for_private_lesson_appointment() from public, anon, authenticated, service_role;

-- Created DISABLED -- see the header note above. Fires on the same
-- INSERT-or-UPDATE-OF-status shape the old TS writer's single call site
-- reacts to.
create trigger appointments_sync_membership_usage_for_private_lesson
  after insert or update of status on public.appointments
  for each row
  execute function public.sync_membership_usage_for_private_lesson_appointment();

alter table public.appointments disable trigger appointments_sync_membership_usage_for_private_lesson;

-- ============================================================================
-- 3. Generic non-destructive retry (plan section J). Dispatches by which
--    reference column is populated on the error row -- one retry RPC for
--    both benefit categories, never two parallel architectures. The
--    attendance_record_id branch has no live target yet (group-class
--    sync is a downstream slice, not implemented here) -- it is wired for
--    forward compatibility only, exactly as the plan specifies.
-- ============================================================================
create or replace function public.retry_membership_usage_sync_error(
  p_error_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_error record;
begin
  select * into v_error from public.membership_usage_sync_errors where id = p_error_id;
  if not found then
    raise exception 'Error record not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_error.studio_id) then
    raise exception 'Not authorized to retry membership usage synchronization for this studio.';
  end if;

  begin
    if v_error.attendance_record_id is not null then
      raise exception 'Group-class usage-sync retry is not yet implemented (downstream slice).';
    elsif v_error.appointment_id is not null then
      perform public._sync_membership_usage_for_private_lesson_appointment(v_error.appointment_id);
    else
      raise exception 'This error record has no resync target.';
    end if;

    update public.membership_usage_sync_errors
      set resolved_at = now(), resolution_notes = coalesce(resolution_notes, 'Retried successfully.')
      where id = p_error_id;
    return true;
  exception when others then
    update public.membership_usage_sync_errors
      set error_message = error_message || ' | retry failed: ' || sqlerrm
      where id = p_error_id;
    return false;
  end;
end;
$$;

revoke all on function public.retry_membership_usage_sync_error(uuid) from public;
revoke all on function public.retry_membership_usage_sync_error(uuid) from anon;
revoke all on function public.retry_membership_usage_sync_error(uuid) from service_role;
grant execute on function public.retry_membership_usage_sync_error(uuid) to authenticated;

commit;
