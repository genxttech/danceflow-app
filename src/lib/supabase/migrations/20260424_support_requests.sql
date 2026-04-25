begin;

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid,
  user_id uuid,
  user_role text,
  issue_type text not null,
  subject text not null,
  description text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_requests_issue_type_check
    check (
      issue_type in (
        'technical',
        'billing',
        'account_access',
        'feature_question',
        'other'
      )
    ),

  constraint support_requests_status_check
    check (
      status in (
        'open',
        'in_progress',
        'resolved',
        'closed'
      )
    )
);

create index if not exists support_requests_studio_id_idx
  on public.support_requests (studio_id);

create index if not exists support_requests_user_id_idx
  on public.support_requests (user_id);

create index if not exists support_requests_status_idx
  on public.support_requests (status);

create index if not exists support_requests_created_at_idx
  on public.support_requests (created_at desc);

create or replace function public.set_support_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_support_requests_updated_at
  on public.support_requests;

create trigger trg_support_requests_updated_at
before update on public.support_requests
for each row
execute function public.set_support_requests_updated_at();

alter table public.support_requests enable row level security;

drop policy if exists support_requests_insert_authenticated
  on public.support_requests;

drop policy if exists support_requests_select_own_or_owner
  on public.support_requests;

create policy support_requests_insert_authenticated
on public.support_requests
for insert
to authenticated
with check (auth.uid() = user_id);

create policy support_requests_select_own_or_owner
on public.support_requests
for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = support_requests.studio_id
      and usr.active = true
      and usr.role in ('platform_admin', 'studio_owner', 'organizer_owner', 'studio_admin', 'organizer_admin')
  )
);

commit;