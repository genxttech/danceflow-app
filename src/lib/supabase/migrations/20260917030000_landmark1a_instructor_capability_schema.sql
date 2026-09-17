-- Landmark 1A -- Slice 1: Instructional Capability Schema Foundation +
-- Audit Infrastructure.
--
-- Purely additive, behavior-inert schema foundation for the Landmark 1A
-- team/seat & instructional-capability architecture (see the Landmark 1A
-- consolidated architecture and Slice 1 design). Adds the future
-- instructional-capability signal and a generic, append-only instructor
-- state-change audit trail. Nothing in this migration is read or written
-- by any application code yet -- no row is backfilled to `true`, no
-- audit event is ever inserted by this migration, no seat/assignability
-- enforcement exists yet. Those are later slices (2, 3, 5, 6, 7).

begin;

-- 1. instructors.can_instruct -----------------------------------------

alter table public.instructors
  add column can_instruct boolean not null default false;

comment on column public.instructors.can_instruct is
  'Explicit studio instructional capability. Distinct from active (current roster/activity status) and user_id (canonical DanceFlow account linkage). A complete operational studio instructor later requires active=true AND can_instruct=true AND user_id IS NOT NULL -- this migration does not enforce that relationship, only adds the column. Safe-by-default false; never inferred from active, role, historical appointments, payroll, or renter status. See Landmark 1A Owner Decisions 1 and 8.';

-- 2. public.instructor_audit_events -------------------------------------
--
-- Generic, append-only instructor state-change audit trail. Covers
-- capability grant/revoke, activation/deactivation, and account
-- link/unlink -- one row shape for all six event types via the
-- before_value/after_value/metadata jsonb columns, rather than a
-- narrower capability-only table.

create table public.instructor_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete restrict,
  actor_user_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type in (
    'capability_granted',
    'capability_revoked',
    'activated',
    'deactivated',
    'account_linked',
    'account_unlinked'
  )),
  before_value jsonb,
  after_value jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);

comment on table public.instructor_audit_events is
  'Append-only audit trail for instructor state changes (capability grant/revoke, activation/deactivation, account link/unlink). Rows are immutable once written -- see the instructor_audit_events_immutable trigger. Landmark 1A Slice 1. Not yet written to by any application code (see later slices 2, 6, 7).';

create index instructor_audit_events_studio_id_idx
  on public.instructor_audit_events (studio_id);

create index instructor_audit_events_instructor_id_idx
  on public.instructor_audit_events (instructor_id);

-- 3. Immutability -- append-only, enforced independently of RLS ---------
--
-- RLS alone does not stop a service-role-authenticated write from later
-- mutating a row, since the service-role key bypasses RLS by design.
-- This trigger rejects UPDATE/DELETE unconditionally, regardless of
-- calling role.

create function public.prevent_instructor_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'instructor_audit_events rows are immutable and cannot be updated or deleted';
end;
$$;

create trigger instructor_audit_events_immutable
  before update or delete on public.instructor_audit_events
  for each row execute function public.prevent_instructor_audit_event_mutation();

-- 4. RLS / permissions ---------------------------------------------------
--
-- No anon access. No direct authenticated insert/update/delete -- writes
-- are expected from trusted server/service-role paths in later slices
-- (the service-role client bypasses RLS entirely, so it needs no
-- explicit policy here, matching this project's established pattern for
-- every other write-only-via-service-role table). Read access is scoped
-- to the already-approved instructor-management actor set
-- (platform_admin, studio_owner, studio_admin -- the same set
-- canManageInstructors already enforces in application code) for their
-- own studio's rows only, reusing the same studio-access helper already
-- used by other studio-scoped SELECT policies in this project.

alter table public.instructor_audit_events enable row level security;

create policy "instructor managers can view their studio's audit events"
on public.instructor_audit_events
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_audit_events.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'studio_admin')
  )
);

commit;
