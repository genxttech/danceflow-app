-- Package Refund P0, Slice 2a: schema foundation only.
--
-- Authoritative event history for Stripe Refund-object-driven package
-- credit reconciliation -- one row per Stripe Refund object
-- (stripe_refund_id unique). Financial truth (refund_status, mirroring
-- Stripe's own vocabulary verbatim) and credit truth
-- (reconciliation_outcome, what DanceFlow did to package entitlement in
-- response) are deliberately independent columns -- see the Package
-- Refund P0 design doc for the exact recomputation semantics that will
-- drive client_packages.refund_status/refunded_at in a later slice.
--
-- Brand-new, empty table at deploy time -- ordinary (non-CONCURRENT) DDL
-- is safe here; no existing rows, no lock-contention risk. This migration
-- makes no application/trigger/entitlement behavior changes -- nothing
-- yet writes to this table.

create table if not exists public.package_refund_reconciliations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  client_package_id uuid not null references public.client_packages(id) on delete restrict,
  payment_id uuid not null references public.payments(id) on delete restrict,
  stripe_refund_id text not null unique,
  stripe_charge_id text,
  refund_amount_cents integer not null check (refund_amount_cents > 0),
  refund_status text not null
    check (refund_status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  reconciliation_outcome text not null default 'not_yet_effective'
    check (reconciliation_outcome in (
      'not_yet_effective',
      'auto_applied',
      'pending_review',
      'staff_applied',
      'no_action_needed',
      'reversed'
    )),
  review_reason text,
  review_acknowledged_at timestamptz,
  review_acknowledged_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists package_refund_reconciliations_client_package_id_idx
  on public.package_refund_reconciliations (client_package_id);

create index if not exists package_refund_reconciliations_payment_id_idx
  on public.package_refund_reconciliations (payment_id);

alter table public.package_refund_reconciliations enable row level security;

-- Refund-administration audit trail (review outcomes, staff attribution,
-- credit-consequence decisions) -- a strict superset of what payments.status
-- alone reveals. Scoped to match the codebase's own narrower precedent for
-- refund issuance itself (refundClientPaymentAction,
-- src/app/app/clients/[id]/actions.ts, gated to studio_owner/studio_admin
-- only -- front_desk can record/manage ordinary payments but cannot issue
-- refunds), not the broader "studio staff manage payments" role set used
-- for ordinary payment recording. No write policy: all writes in this
-- design happen via security-definer RPCs / the service-role webhook
-- client, both of which bypass RLS -- there is no ordinary client-side
-- CRUD write path to this table.
drop policy if exists "package refund reconciliations studio staff read"
  on public.package_refund_reconciliations;
create policy "package refund reconciliations studio staff read"
  on public.package_refund_reconciliations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = package_refund_reconciliations.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );
