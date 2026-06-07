begin;

create table if not exists public.instructor_credentials (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  credential_type text not null default 'certification',
  name text not null,
  issuing_organization text,
  credential_year integer,
  proof_url text,
  notes text,
  public_enabled boolean not null default true,
  display_order integer not null default 0,
  verification_status text not null default 'submitted',
  review_note text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instructor_credentials_type_check check (
    credential_type in ('certification', 'title', 'achievement')
  ),
  constraint instructor_credentials_status_check check (
    verification_status in ('submitted', 'verified', 'rejected')
  )
);

create index if not exists idx_instructor_credentials_studio
  on public.instructor_credentials(studio_id, verification_status, created_at desc);

create index if not exists idx_instructor_credentials_instructor
  on public.instructor_credentials(instructor_id, display_order, created_at desc);

create index if not exists idx_instructor_credentials_public_verified
  on public.instructor_credentials(studio_id, instructor_id, display_order)
  where public_enabled = true and verification_status = 'verified';

create or replace function public.touch_instructor_credentials_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_instructor_credentials_touch on public.instructor_credentials;
create trigger trg_instructor_credentials_touch
before update on public.instructor_credentials
for each row
execute function public.touch_instructor_credentials_updated_at();

alter table public.instructor_credentials enable row level security;

drop policy if exists instructor_credentials_studio_select on public.instructor_credentials;
drop policy if exists instructor_credentials_studio_manage on public.instructor_credentials;
drop policy if exists instructor_credentials_platform_select on public.instructor_credentials;
drop policy if exists instructor_credentials_platform_update on public.instructor_credentials;
drop policy if exists instructor_credentials_public_select_verified on public.instructor_credentials;

create policy instructor_credentials_studio_select
on public.instructor_credentials
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_credentials.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
);

create policy instructor_credentials_studio_manage
on public.instructor_credentials
for all
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_credentials.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_credentials.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy instructor_credentials_platform_select
on public.instructor_credentials
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create policy instructor_credentials_platform_update
on public.instructor_credentials
for update
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create policy instructor_credentials_public_select_verified
on public.instructor_credentials
for select
to anon, authenticated
using (
  public_enabled = true
  and verification_status = 'verified'
  and exists (
    select 1
    from public.instructors i
    where i.id = instructor_credentials.instructor_id
      and i.studio_id = instructor_credentials.studio_id
      and i.active = true
      and i.public_profile_enabled = true
  )
);

insert into public.instructor_credentials (
  studio_id,
  instructor_id,
  credential_type,
  name,
  proof_url,
  verification_status,
  review_note,
  submitted_at,
  created_at,
  updated_at
)
select
  i.studio_id,
  i.id,
  'certification',
  i.teaching_certifications,
  i.credential_proof_url,
  case
    when i.credentials_verification_status in ('verified', 'rejected', 'submitted') then i.credentials_verification_status
    else 'submitted'
  end,
  i.credentials_review_note,
  coalesce(i.credentials_submitted_at, now()),
  now(),
  now()
from public.instructors i
where nullif(trim(coalesce(i.teaching_certifications, '')), '') is not null
  and not exists (
    select 1
    from public.instructor_credentials ic
    where ic.instructor_id = i.id
      and ic.credential_type = 'certification'
      and ic.name = i.teaching_certifications
  );

insert into public.instructor_credentials (
  studio_id,
  instructor_id,
  credential_type,
  name,
  proof_url,
  verification_status,
  review_note,
  submitted_at,
  created_at,
  updated_at
)
select
  i.studio_id,
  i.id,
  'title',
  i.competitive_titles,
  i.credential_proof_url,
  case
    when i.credentials_verification_status in ('verified', 'rejected', 'submitted') then i.credentials_verification_status
    else 'submitted'
  end,
  i.credentials_review_note,
  coalesce(i.credentials_submitted_at, now()),
  now(),
  now()
from public.instructors i
where nullif(trim(coalesce(i.competitive_titles, '')), '') is not null
  and not exists (
    select 1
    from public.instructor_credentials ic
    where ic.instructor_id = i.id
      and ic.credential_type = 'title'
      and ic.name = i.competitive_titles
  );

commit;
