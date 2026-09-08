-- GC-1.1: Roster Schema Foundation.
--
-- Introduces `appointment_attendees`, the authoritative per-student roster for
-- shared `group_class` appointments (approved GC-1 architecture; identity
-- decision locked by the GC-0 report: `client_id` remains the sole identity
-- anchor -- `clients` is the durable per-studio relationship record, and
-- `clients.status = 'lead'` already represents a public prospect, so no
-- separate person/lead/dancer-profile FK is added here).
--
-- Purely additive: no existing table, policy, or helper function is altered.
-- The table starts empty and nothing reads or writes it yet (read-path
-- cutover, booking cutover, attendance billing, and compensation changes are
-- all separate, later slices -- GC-1.2+).

begin;

-- ============================================================================
-- 1. Table.
-- ============================================================================
create table public.appointment_attendees (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios(id),
  appointment_id              uuid not null references public.appointments(id),
  client_id                   uuid not null references public.clients(id),
  status                      text not null default 'booked',
  source                      text not null,
  client_package_id           uuid references public.client_packages(id),
  client_membership_id        uuid references public.client_memberships(id),
  price_amount                numeric,
  payment_status              text not null default 'unpaid',
  billing_type                text not null default 'package_credit',
  billing_note                text,
  confirmed_at                timestamptz,
  confirmation_source         text,
  confirmation_actor_user_id  uuid,
  notes                       text,
  created_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  cancelled_at                timestamptz,
  cancelled_by                uuid,

  constraint appointment_attendees_status_check
    check (status = any (array['booked', 'cancelled']::text[])),
  constraint appointment_attendees_source_check
    check (source = any (array['staff', 'portal', 'self_service', 'booking_request']::text[])),
  constraint appointment_attendees_payment_status_check
    check (payment_status = any (array['unpaid', 'partial', 'paid', 'waived', 'refunded']::text[])),
  constraint appointment_attendees_billing_type_check
    check (billing_type = any (array['package_credit', 'membership', 'pay_as_you_go', 'free_comped']::text[])),
  constraint appointment_attendees_confirmation_source_check
    check (confirmation_source is null or confirmation_source = any (array['email_link', 'student_portal', 'student_mobile']::text[])),
  constraint appointment_attendees_cancellation_check
    check (
      (status = 'cancelled' and cancelled_at is not null)
      or (status <> 'cancelled' and cancelled_at is null and cancelled_by is null)
    )
);

comment on table public.appointment_attendees is
  'GC-1.1: authoritative per-student roster for shared group_class appointments. '
  'client_id is the sole identity anchor (references clients.id, including lead-status rows) -- '
  'no separate person/lead/dancer-profile FK. Not yet read or written by any app code (GC-1.2+).';

-- ============================================================================
-- 2. Indexes / constraints.
-- ============================================================================
create unique index uq_appointment_attendees_active
  on public.appointment_attendees (appointment_id, client_id)
  where status <> 'cancelled';

create index idx_appointment_attendees_studio_id
  on public.appointment_attendees (studio_id);
create index idx_appointment_attendees_appointment_id
  on public.appointment_attendees (appointment_id);
create index idx_appointment_attendees_client_id
  on public.appointment_attendees (client_id);
create index idx_appointment_attendees_status
  on public.appointment_attendees (status);

-- ============================================================================
-- 3. Integrity trigger/function.
--
-- Deliberately NOT exposed as a callable predicate: returns trigger (not
-- boolean), and is revoked from every client-facing role including
-- `authenticated` -- it can only ever run as a side effect of a write the
-- caller is already attempting via the table's own RLS policies (section 4).
-- Every failure branch raises the identical message so no differential
-- response can be used as an oracle for data outside the caller's own
-- visibility.
-- ============================================================================
create or replace function public.enforce_appointment_attendee_integrity()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_studio_id uuid;
  v_appointment_type public.appointment_type;
  v_client_studio_id uuid;
  v_package_client_id uuid;
  v_package_studio_id uuid;
  v_membership_client_id uuid;
  v_membership_studio_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.appointment_id is distinct from old.appointment_id
       or new.client_id is distinct from old.client_id
       or new.studio_id is distinct from old.studio_id
    then
      raise exception 'Invalid roster enrollment.';
    end if;
  end if;

  select studio_id, appointment_type
    into v_appointment_studio_id, v_appointment_type
    from public.appointments
    where id = new.appointment_id;

  if v_appointment_studio_id is null
     or v_appointment_studio_id is distinct from new.studio_id
     or v_appointment_type is distinct from 'group_class'::public.appointment_type
  then
    raise exception 'Invalid roster enrollment.';
  end if;

  select studio_id into v_client_studio_id
    from public.clients
    where id = new.client_id;

  if v_client_studio_id is null or v_client_studio_id is distinct from new.studio_id then
    raise exception 'Invalid roster enrollment.';
  end if;

  if new.client_package_id is not null then
    select client_id, studio_id into v_package_client_id, v_package_studio_id
      from public.client_packages
      where id = new.client_package_id;

    if v_package_client_id is null
       or v_package_client_id is distinct from new.client_id
       or v_package_studio_id is distinct from new.studio_id
    then
      raise exception 'Invalid roster enrollment.';
    end if;
  end if;

  if new.client_membership_id is not null then
    select client_id, studio_id into v_membership_client_id, v_membership_studio_id
      from public.client_memberships
      where id = new.client_membership_id;

    if v_membership_client_id is null
       or v_membership_client_id is distinct from new.client_id
       or v_membership_studio_id is distinct from new.studio_id
    then
      raise exception 'Invalid roster enrollment.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_appointment_attendee_integrity() from public;
revoke all on function public.enforce_appointment_attendee_integrity() from anon;
revoke all on function public.enforce_appointment_attendee_integrity() from authenticated;
-- No `grant execute` statement follows: this function is reachable only as a
-- trigger body. Trigger execution does not require the invoking role to hold
-- EXECUTE on the trigger function -- Postgres fires BEFORE ROW triggers as
-- part of the write itself, under the function's own SECURITY DEFINER
-- context, regardless of the calling role's own grants. Verified live after
-- apply (see the implementation report).

create trigger appointment_attendees_enforce_integrity
  before insert or update on public.appointment_attendees
  for each row
  execute function public.enforce_appointment_attendee_integrity();

-- ============================================================================
-- 4. RLS.
-- ============================================================================
alter table public.appointment_attendees enable row level security;

create policy "appointment_attendees_select" on public.appointment_attendees
for select
to authenticated
using (
  -- 1. platform admin: broad, studio-role-independent.
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  -- 2. broad operational roles at this studio: may manage enrollment (read included).
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_attendees.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  -- 3. assigned instructor: read-only roster visibility for their own class.
  --    Reuses the existing, already-audited ownership helper unchanged. A
  --    hybrid user's authority here derives ONLY from this genuine teaching
  --    relationship; their floor-rental relationship (if any) is never
  --    referenced by this policy at all.
  or exists (
    select 1 from public.appointments a
    where a.id = appointment_attendees.appointment_id
      and a.studio_id = appointment_attendees.studio_id
      and a.instructor_id is not null
      and public.is_own_instructor_appointment(a.studio_id, a.instructor_id)
  )
  -- 4. portal/student: own enrollment row only, never classmates. Reuses the
  --    existing portal ownership helper unchanged -- this already requires a
  --    'linked' client_account_links row, so portal access is never inferred
  --    merely from clients.status = 'lead'.
  or public.user_has_client_portal_access(appointment_attendees.studio_id, appointment_attendees.client_id)
);

create policy "appointment_attendees_insert" on public.appointment_attendees
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_attendees.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

create policy "appointment_attendees_update" on public.appointment_attendees
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_attendees.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_attendees.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

-- No DELETE policy is created. With RLS enabled and no matching permissive
-- policy for any role, every DELETE is denied by default -- hard deletion is
-- structurally unreachable through the API, matching the soft-cancel-only
-- model (historical rows are always retained).

commit;
