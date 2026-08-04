-- Step 1: add the new value to the existing PostgreSQL enum.
-- Run this migration by itself and allow it to commit before running Step 2.

alter type public.appointment_status
  add value if not exists 'confirmed';
