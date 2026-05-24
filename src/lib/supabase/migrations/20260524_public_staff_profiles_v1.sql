begin;

alter table public.instructors
add column if not exists public_title text,
add column if not exists public_specialties text;

alter table public.instructors
alter column public_profile_enabled set default false,
alter column display_order set default 0;

update public.instructors
set public_profile_enabled = false
where public_profile_enabled is null;

update public.instructors
set display_order = 0
where display_order is null;

alter table public.instructors
alter column public_profile_enabled set not null,
alter column display_order set not null;

alter table public.instructors enable row level security;

drop policy if exists "Public can view enabled instructor profiles"
on public.instructors;

create policy "Public can view enabled instructor profiles"
on public.instructors
for select
to anon, authenticated
using (
  active = true
  and public_profile_enabled = true
  and exists (
    select 1
    from public.studios s
    where s.id = instructors.studio_id
      and s.public_directory_enabled = true
      and lower(coalesce(s.subscription_status, '')) in ('active', 'trialing')
  )
);

commit;
