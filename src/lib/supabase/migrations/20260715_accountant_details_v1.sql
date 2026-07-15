begin;

create table if not exists public.studio_accountant_profiles (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null unique references public.studios(id) on delete cascade,
  accountant_name text not null,
  firm_name text,
  email text not null,
  phone text,
  preferred_cadence text not null default 'manual' check (preferred_cadence in ('manual','monthly','quarterly','annually')),
  preferred_export_types text[] not null default '{}'::text[],
  internal_notes text,
  authorized_to_receive_exports boolean not null default false,
  authorization_granted_at timestamptz,
  authorization_granted_by uuid references auth.users(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  constraint studio_accountant_profiles_email_not_blank check (length(trim(email)) > 3),
  constraint studio_accountant_profiles_name_not_blank check (length(trim(accountant_name)) > 0),
  constraint studio_accountant_profiles_authorization_consistent check (
    (authorized_to_receive_exports = false and authorization_granted_at is null and authorization_granted_by is null)
    or
    (authorized_to_receive_exports = true and authorization_granted_at is not null and authorization_granted_by is not null)
  )
);

create table if not exists public.studio_accountant_profile_history (
  id bigint generated always as identity primary key,
  studio_id uuid not null references public.studios(id) on delete cascade,
  accountant_profile_id uuid not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  action text not null check (action in ('insert','update')),
  snapshot jsonb not null
);

create or replace function public.log_studio_accountant_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.studio_accountant_profile_history(studio_id, accountant_profile_id, changed_by, action, snapshot)
  values (new.studio_id, new.id, auth.uid(), lower(tg_op), to_jsonb(new));
  return new;
end;
$$;

revoke all on function public.log_studio_accountant_profile_change() from public, anon, authenticated;

drop trigger if exists studio_accountant_profile_audit_trigger on public.studio_accountant_profiles;
create trigger studio_accountant_profile_audit_trigger
after insert or update on public.studio_accountant_profiles
for each row execute function public.log_studio_accountant_profile_change();

alter table public.studio_accountant_profiles enable row level security;
alter table public.studio_accountant_profile_history enable row level security;

drop policy if exists studio_accountant_profiles_select on public.studio_accountant_profiles;
drop policy if exists studio_accountant_profiles_insert on public.studio_accountant_profiles;
drop policy if exists studio_accountant_profiles_update on public.studio_accountant_profiles;
create policy studio_accountant_profiles_select on public.studio_accountant_profiles for select to authenticated using (
  exists (select 1 from public.user_studio_roles usr where usr.studio_id = studio_accountant_profiles.studio_id and usr.user_id = auth.uid() and usr.active = true and usr.role in ('studio_owner','studio_admin'))
);
create policy studio_accountant_profiles_insert on public.studio_accountant_profiles for insert to authenticated with check (
  exists (select 1 from public.user_studio_roles usr where usr.studio_id = studio_accountant_profiles.studio_id and usr.user_id = auth.uid() and usr.active = true and usr.role in ('studio_owner','studio_admin'))
);
create policy studio_accountant_profiles_update on public.studio_accountant_profiles for update to authenticated using (
  exists (select 1 from public.user_studio_roles usr where usr.studio_id = studio_accountant_profiles.studio_id and usr.user_id = auth.uid() and usr.active = true and usr.role in ('studio_owner','studio_admin'))
) with check (
  exists (select 1 from public.user_studio_roles usr where usr.studio_id = studio_accountant_profiles.studio_id and usr.user_id = auth.uid() and usr.active = true and usr.role in ('studio_owner','studio_admin'))
);

drop policy if exists studio_accountant_profile_history_select on public.studio_accountant_profile_history;
create policy studio_accountant_profile_history_select on public.studio_accountant_profile_history for select to authenticated using (
  exists (select 1 from public.user_studio_roles usr where usr.studio_id = studio_accountant_profile_history.studio_id and usr.user_id = auth.uid() and usr.active = true and usr.role in ('studio_owner','studio_admin'))
);

revoke all on public.studio_accountant_profiles from anon;
revoke all on public.studio_accountant_profile_history from anon;
grant select, insert, update on public.studio_accountant_profiles to authenticated;
grant select on public.studio_accountant_profile_history to authenticated;

commit;
