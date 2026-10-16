-- TW-4 R1 dry-run fixtures (synthetic; reserved test domain; fixed ids). Used ONLY by localStack.tw4r1.test.ts against the local
-- QA Supabase stack (danceflow-e2e-qa). Idempotent: removes any earlier copy first. Never run against DEV or PROD.
begin;

delete from public.studio_sms_registrations where studio_id in (
  'a5e40000-0000-4000-8000-00000000000a', 'a5e40000-0000-4000-8000-00000000000b', 'a5e40000-0000-4000-8000-00000000000c', 'a5e40000-0000-4000-8000-00000000000d');
delete from public.studios where id in (
  'a5e40000-0000-4000-8000-00000000000a', 'a5e40000-0000-4000-8000-00000000000b', 'a5e40000-0000-4000-8000-00000000000c', 'a5e40000-0000-4000-8000-00000000000d',
  'a5e40000-0000-4000-8000-00000000000e', 'a5e40000-0000-4000-8000-00000000000f', 'a5e40000-0000-4000-8000-000000000010');
delete from auth.users where email like '%@tw4dry-e2e.test';

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4dry-e2e.test', now(), now()
from (values
  ('owner_a', 'a5e40000-0000-4000-8000-000000000101'), ('admin_a', 'a5e40000-0000-4000-8000-000000000102'),
  ('fd_a', 'a5e40000-0000-4000-8000-000000000103'), ('instr_a', 'a5e40000-0000-4000-8000-000000000104'),
  ('owner_b', 'a5e40000-0000-4000-8000-000000000201'), ('padmin', 'a5e40000-0000-4000-8000-000000000401'),
  ('outsider', 'a5e40000-0000-4000-8000-000000000999'), ('owner_e', 'a5e40000-0000-4000-8000-000000000301'),
  ('owner_f', 'a5e40000-0000-4000-8000-000000000302'), ('owner_g', 'a5e40000-0000-4000-8000-000000000303')) as t(k, id);

insert into public.profiles (id, platform_role)
select id::uuid, case when k = 'padmin' then 'platform_admin' end
from (values
  ('owner_a', 'a5e40000-0000-4000-8000-000000000101'), ('admin_a', 'a5e40000-0000-4000-8000-000000000102'),
  ('fd_a', 'a5e40000-0000-4000-8000-000000000103'), ('instr_a', 'a5e40000-0000-4000-8000-000000000104'),
  ('owner_b', 'a5e40000-0000-4000-8000-000000000201'), ('padmin', 'a5e40000-0000-4000-8000-000000000401'),
  ('outsider', 'a5e40000-0000-4000-8000-000000000999'), ('owner_e', 'a5e40000-0000-4000-8000-000000000301'),
  ('owner_f', 'a5e40000-0000-4000-8000-000000000302'), ('owner_g', 'a5e40000-0000-4000-8000-000000000303')) as t(k, id)
on conflict (id) do update set platform_role = excluded.platform_role;

insert into public.studios (id, name, slug, public_name) values
  ('a5e40000-0000-4000-8000-00000000000a', 'TW4DRY E2E Studio A', 'tw4dry-e2e-a', 'E2E Harbor Dance'),
  ('a5e40000-0000-4000-8000-00000000000b', 'TW4DRY E2E Studio B', 'tw4dry-e2e-b', null),
  ('a5e40000-0000-4000-8000-00000000000c', 'TW4DRY E2E Studio C', 'tw4dry-e2e-c', null),
  ('a5e40000-0000-4000-8000-00000000000d', 'TW4DRY E2E Studio D', 'tw4dry-e2e-d', null),
  ('a5e40000-0000-4000-8000-00000000000e', 'TW4DRY E2E Studio E', 'tw4dry-e2e-e', null),
  ('a5e40000-0000-4000-8000-00000000000f', 'TW4DRY E2E Studio F', 'tw4dry-e2e-f', null),
  ('a5e40000-0000-4000-8000-000000000010', 'TW4DRY E2E Studio G', 'tw4dry-e2e-g', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('a5e40000-0000-4000-8000-000000000101', 'a5e40000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('a5e40000-0000-4000-8000-000000000102', 'a5e40000-0000-4000-8000-00000000000a', 'studio_admin', true),
  ('a5e40000-0000-4000-8000-000000000103', 'a5e40000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('a5e40000-0000-4000-8000-000000000104', 'a5e40000-0000-4000-8000-00000000000a', 'instructor', true),
  ('a5e40000-0000-4000-8000-000000000201', 'a5e40000-0000-4000-8000-00000000000b', 'studio_owner', true),
  ('a5e40000-0000-4000-8000-000000000301', 'a5e40000-0000-4000-8000-00000000000e', 'studio_owner', true),
  ('a5e40000-0000-4000-8000-000000000302', 'a5e40000-0000-4000-8000-00000000000f', 'studio_owner', true),
  ('a5e40000-0000-4000-8000-000000000303', 'a5e40000-0000-4000-8000-000000000010', 'studio_owner', true);

-- studio C: an existing registration only (no onboarding, pilot switch never turned on)
insert into public.studio_sms_registrations (studio_id, registration_status) values ('a5e40000-0000-4000-8000-00000000000c', 'in_review');

commit;
