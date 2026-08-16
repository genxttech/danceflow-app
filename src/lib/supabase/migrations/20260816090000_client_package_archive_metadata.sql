-- Schedule Stabilization Slice 1b-a: individual client-package archive/reactivate.
--
-- Additive, nullable, no backfill. `active` continues to represent current
-- booking eligibility unchanged (Slice 1's entitlement resolver never reads
-- these columns). `archived_at` is the authoritative "was this manually
-- archived by staff" signal, taking precedence over passively-computed
-- Depleted/Expired status in the staff-visible package status derivation
-- (see src/lib/packages/entitlement.ts's getClientPackageStatus).
--
-- Existing rows correctly default to archived_at IS NULL ("not manually
-- archived"), including rows already active=false from natural depletion.

alter table public.client_packages
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null,
  add column if not exists archive_reason text;
