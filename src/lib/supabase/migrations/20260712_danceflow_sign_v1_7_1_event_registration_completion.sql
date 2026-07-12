begin;

create table if not exists public.event_signing_checkpoints (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.event_orders(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  organizer_id uuid null,
  user_id uuid null references auth.users(id) on delete set null,
  buyer_email text not null,
  surface text not null check (surface in ('web', 'student_app')),
  payment_mode text not null default 'checkout' check (payment_mode in ('checkout', 'payment_sheet')),
  status text not null default 'signing' check (status in ('signing','ready_for_payment','payment_started','completed','expired','cancelled')),
  requirement_ids uuid[] not null default '{}',
  registration_ids uuid[] not null default '{}',
  current_position integer not null default 0,
  total_required integer not null default 0,
  mobile_return_url text null,
  expires_at timestamptz not null,
  last_progress_at timestamptz not null default now(),
  payment_started_at timestamptz null,
  completed_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_signing_checkpoints_status_expiry_idx
  on public.event_signing_checkpoints(status, expires_at);
create index if not exists event_signing_checkpoints_user_idx
  on public.event_signing_checkpoints(user_id, created_at desc);

alter table public.document_sign_envelopes
  add column if not exists event_signing_checkpoint_id uuid references public.event_signing_checkpoints(id) on delete set null,
  add column if not exists event_document_requirement_id uuid references public.event_document_requirements(id) on delete set null,
  add column if not exists event_order_id uuid references public.event_orders(id) on delete set null;

alter table public.document_assignments
  add column if not exists event_order_id uuid references public.event_orders(id) on delete set null,
  add column if not exists event_document_requirement_id uuid references public.event_document_requirements(id) on delete set null,
  add column if not exists event_signing_checkpoint_id uuid references public.event_signing_checkpoints(id) on delete set null;

create unique index if not exists document_sign_envelopes_checkpoint_requirement_uidx
  on public.document_sign_envelopes(event_signing_checkpoint_id, event_document_requirement_id)
  where event_signing_checkpoint_id is not null and event_document_requirement_id is not null;

create index if not exists document_sign_envelopes_event_order_idx
  on public.document_sign_envelopes(event_order_id, status);

alter table public.event_signing_checkpoints enable row level security;

-- Checkpoints are intentionally service-role only. Public and student routes must
-- validate their own session/order ownership before using the admin client.
revoke all on table public.event_signing_checkpoints from anon, authenticated;

grant all on table public.event_signing_checkpoints to service_role;

commit;
