-- DanceFlow Source-Specific Migration Support
-- Square Slice 6: pilot reconciliation and payment source identity.
--
-- Apply after:
--   20260728000100_square_commerce_mapping_foundation_v1.sql

alter table public.payments
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

create unique index if not exists payments_source_identity_unique
  on public.payments(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create index if not exists payments_import_source_idx
  on public.payments(studio_id, source_system, imported_at desc);

comment on column public.payments.source_system is
  'External system that supplied this payment, such as square.';

comment on column public.payments.source_external_id is
  'Durable payment identifier from the external source system for idempotent imports.';

comment on column public.payments.imported_at is
  'Timestamp when this payment was last imported from an external source.';
