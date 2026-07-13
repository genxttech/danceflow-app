-- DanceFlow Student Identity self-service account controls.
-- Preserves studio relationship history when an auth account is deleted.

alter table public.client_account_links
  add column if not exists deleted_user_reference_hash text,
  add column if not exists account_deleted_at timestamptz,
  add column if not exists left_by_user_at timestamptz;

do $$
declare
  constraint_name text;
begin
  select tc.constraint_name
    into constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.constraint_schema = kcu.constraint_schema
  where tc.constraint_schema = 'public'
    and tc.table_name = 'client_account_links'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'user_id'
  limit 1;

  if constraint_name is not null then
    execute format(
      'alter table public.client_account_links drop constraint %I',
      constraint_name
    );
  end if;
end;
$$;

alter table public.client_account_links
  add constraint client_account_links_user_id_fkey
  foreign key (user_id)
  references auth.users(id)
  on delete set null;

create table if not exists public.account_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  user_reference_hash text not null,
  requested_email_hash text,
  linked_relationship_count integer not null default 0,
  deleted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.account_deletion_audit enable row level security;

comment on table public.account_deletion_audit is
  'Minimal non-identifying audit record for completed DanceFlow account deletion.';
