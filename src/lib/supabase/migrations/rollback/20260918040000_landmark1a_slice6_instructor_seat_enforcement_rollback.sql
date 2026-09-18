-- Rollback for 20260918040000_landmark1a_slice6_instructor_seat_enforcement.sql
--
-- Removes only the objects/state this migration created: the three
-- public RPCs, the four private helpers, and the
-- hybrid_client_assignment_attested column. Touches no pre-existing
-- Slice 1-5 object and no data outside the dropped column. Never deletes
-- instructor_audit_events rows -- they remain immutable via Slice 1's
-- own BEFORE UPDATE OR DELETE trigger regardless of what this script
-- attempts, and any audit history already written by these functions
-- before rollback stays exactly as it is.

begin;

drop function if exists public.promote_hybrid_instructor(uuid, uuid, boolean, text);
drop function if exists public.reactivate_instructor(uuid, uuid);
drop function if exists public.grant_instructor_capability(uuid, uuid);

drop function if exists public._landmark1a_authorize_counted_transition(uuid, public.instructors);
drop function if exists public._landmark1a_lock_instructor_for_transition(uuid, uuid);
drop function if exists public._landmark1a_resolve_studio_seat_limit(uuid);
drop function if exists public._landmark1a_can_manage_instructors(uuid);

alter table public.instructors
  drop column if exists hybrid_client_assignment_attested;

commit;
