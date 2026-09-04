-- FC-1B3: Room Resource Model Foundation
--
-- Adds the minimum schema needed to distinguish "a room is occupied" from
-- "a room is exclusively/fully reserved". Rooms may be shared by default;
-- overlapping room_id + time is not itself a conflict (see
-- src/lib/schedule/conflicts.ts). This migration adds:
--
--   appointments.exclusive_room_use  -- does this booking reserve the room
--     exclusively, blocking any other simultaneous use? Defaults false, so
--     every existing row is unaffected (matches current de-facto behavior:
--     nothing has ever been exclusive).
--
--   rooms.max_simultaneous_bookings  -- optional cap on how many bookings
--     may occupy the room at once. NULL (the default) means unlimited --
--     no studio's existing rooms behave any differently until a studio
--     staff member explicitly configures a finite number.
--
-- Deliberately does NOT touch rooms.capacity, which is an unrelated,
-- already-populated, physical/class people-capacity field.
--
-- Deliberately does NOT enable btree_gist or add any exclusion constraint.
-- A hard database-level concurrency guarantee for this model is a
-- separate, later design (see FC-1B3 audit) -- a simple pairwise exclusion
-- constraint cannot correctly express "capacity > 1" or "exclusive vs.
-- non-exclusive overlap" and is not attempted here.

ALTER TABLE appointments
  ADD COLUMN exclusive_room_use boolean NOT NULL DEFAULT false;

ALTER TABLE rooms
  ADD COLUMN max_simultaneous_bookings integer NULL;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_max_simultaneous_bookings_check
  CHECK (max_simultaneous_bookings IS NULL OR max_simultaneous_bookings >= 1);
