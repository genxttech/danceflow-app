insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'partner-profile-photos',
  'partner-profile-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "partner profile photos are publicly readable" on storage.objects;
drop policy if exists "users can upload their own partner profile photos" on storage.objects;
drop policy if exists "users can update their own partner profile photos" on storage.objects;

create policy "partner profile photos are publicly readable"
on storage.objects
for select
using (bucket_id = 'partner-profile-photos');

create policy "users can upload their own partner profile photos"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'partner-profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "users can update their own partner profile photos"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'partner-profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'partner-profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
