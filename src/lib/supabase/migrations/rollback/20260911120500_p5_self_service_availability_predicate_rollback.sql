-- Rollback for 20260911120500_p5_self_service_availability_predicate.sql

begin;

drop function if exists public._self_service_slot_within_availability(uuid, uuid, uuid, text, timestamptz, timestamptz);

commit;
