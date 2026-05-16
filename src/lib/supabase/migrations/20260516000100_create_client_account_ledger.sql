create table if not exists public.client_account_ledger (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  entry_date date not null default current_date,
  entry_type text not null,
  direction text not null,
  amount numeric(10,2) not null,

  description text,
  reference_type text,
  reference_id uuid,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_account_ledger_direction_check
    check (direction in ('credit', 'debit')),

  constraint client_account_ledger_amount_positive_check
    check (amount > 0),

  constraint client_account_ledger_entry_type_check
    check (
      entry_type in (
        'credit_added',
        'credit_applied',
        'charge_added',
        'payment_received',
        'refund_credit',
        'manual_adjustment',
        'floor_fee_credit',
        'floor_fee_charge',
        'package_purchase',
        'lesson_charge',
        'reversal'
      )
    )
);

create index if not exists client_account_ledger_studio_client_idx
on public.client_account_ledger(studio_id, client_id);

create index if not exists client_account_ledger_entry_date_idx
on public.client_account_ledger(studio_id, entry_date desc);

create index if not exists client_account_ledger_reference_idx
on public.client_account_ledger(reference_type, reference_id);

alter table public.client_account_ledger enable row level security;