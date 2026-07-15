-- Run and commit this migration by itself before any SQL references
-- the new enum values.

alter type public.payment_method
  add value if not exists 'venmo';

alter type public.payment_method
  add value if not exists 'zelle';
