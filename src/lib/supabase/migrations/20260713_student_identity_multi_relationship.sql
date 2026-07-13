
begin;

alter table public.client_account_links
  add column if not exists can_view_schedule boolean not null default true,
  add column if not exists can_view_billing boolean not null default true,
  add column if not exists can_manage_bookings boolean not null default true,
  add column if not exists can_sign_documents boolean not null default true,
  add column if not exists is_primary boolean not null default false;

alter table public.client_account_links
  drop constraint if exists client_account_links_relationship_check;

alter table public.client_account_links
  add constraint client_account_links_relationship_check
  check (
    relationship_type in (
      'self',
      'guardian',
      'parent',
      'billing_contact',
      'dependent_manager',
      'dependent'
    )
  );

alter table public.client_account_links
  drop constraint if exists client_account_links_linked_requires_user_check;

alter table public.client_account_links
  add constraint client_account_links_linked_requires_user_check
  check (status <> 'linked' or user_id is not null);

drop index if exists public.client_account_links_one_linked_self_per_client;

create unique index if not exists client_account_links_one_linked_self_per_client
  on public.client_account_links(client_id)
  where status = 'linked' and relationship_type = 'self';

create unique index if not exists client_account_links_one_primary_per_user_studio
  on public.client_account_links(user_id, studio_id)
  where status = 'linked' and is_primary = true;

update public.client_account_links
set
  can_view_schedule = true,
  can_view_billing = true,
  can_manage_bookings = true,
  can_sign_documents = true,
  is_primary = true
where relationship_type = 'self'
  and status = 'linked';

commit;
