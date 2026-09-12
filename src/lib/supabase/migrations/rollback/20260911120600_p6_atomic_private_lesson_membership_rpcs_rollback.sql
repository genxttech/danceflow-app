-- Rollback for 20260911120600_p6_atomic_private_lesson_membership_rpcs.sql
--
-- Safe only once every application call site has been reverted to its
-- pre-cutover write path first (plan section Z). Parameter type lists
-- match the Phase 2 widened/narrowed signatures.

begin;

drop function if exists public.update_private_lesson_membership_appointment_self_service(uuid, timestamptz, timestamptz, uuid, uuid, uuid);
drop function if exists public.create_private_lesson_membership_appointment_self_service(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz);
drop function if exists public.update_private_lesson_membership_appointment(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text);
drop function if exists public.create_private_lesson_membership_appointment(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text);
drop function if exists public._lesson_membership_reservation_core_update(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text, boolean);
drop function if exists public._lesson_membership_reservation_core_create(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text);

commit;
