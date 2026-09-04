-- Rollback for 20260903120000_fc1b3_room_resource_model_foundation.sql
--
-- Purely additive forward migration (one new boolean column with a false
-- default, one new nullable integer column, one check constraint) -- no
-- data was transformed or backfilled, so rollback is a straightforward
-- drop. Safe even if application code has already started writing
-- exclusive_room_use/max_simultaneous_bookings values, since dropping the
-- columns discards only that new information, nothing pre-existing.
--
-- Lives in a sibling rollback/ directory so it is never auto-applied as a
-- forward migration, matching the existing rollback convention.

begin;

alter table rooms
  drop constraint if exists rooms_max_simultaneous_bookings_check;

alter table rooms
  drop column if exists max_simultaneous_bookings;

alter table appointments
  drop column if exists exclusive_room_use;

commit;
