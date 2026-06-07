begin;

alter table public.instructors
add column if not exists teaching_certifications text,
add column if not exists competitive_titles text,
add column if not exists credential_proof_url text,
add column if not exists credentials_verification_status text not null default 'unverified',
add column if not exists credentials_review_note text,
add column if not exists credentials_submitted_at timestamptz,
add column if not exists credentials_verified_at timestamptz,
add column if not exists credentials_verified_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'instructors_credentials_verification_status_check'
      and conrelid = 'public.instructors'::regclass
  ) then
    alter table public.instructors
      add constraint instructors_credentials_verification_status_check
      check (credentials_verification_status in ('unverified', 'submitted', 'verified', 'rejected'));
  end if;
end $$;

insert into storage.buckets (id, name, public)
values ('instructor-photos', 'instructor-photos', true)
on conflict (id) do update set public = true;

drop policy if exists "Studio staff can upload instructor photos" on storage.objects;
drop policy if exists "Studio staff can update instructor photos" on storage.objects;
drop policy if exists "Studio staff can read instructor photos" on storage.objects;
drop policy if exists "Public can read instructor photos" on storage.objects;

create policy "Public can read instructor photos"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'instructor-photos');

create policy "Studio staff can upload instructor photos"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'instructor-photos'
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id::text = split_part(name, '/', 1)
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy "Studio staff can update instructor photos"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'instructor-photos'
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id::text = split_part(name, '/', 1)
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
)
with check (
  bucket_id = 'instructor-photos'
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id::text = split_part(name, '/', 1)
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

commit;
