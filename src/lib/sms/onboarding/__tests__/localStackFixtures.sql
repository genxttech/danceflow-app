-- TW-4A local-stack fixtures (synthetic; reserved test domain; fixed ids). Used ONLY by localStack.tw4a.test.ts against the local
-- QA Supabase stack (danceflow-e2e-qa). Idempotent: removes any earlier copy first. Never run against DEV or PROD.
begin;

delete from public.studio_sms_registrations where studio_id in (
  'a5e20000-0000-4000-8000-00000000000a', 'a5e20000-0000-4000-8000-00000000000b', 'a5e20000-0000-4000-8000-00000000000c', 'a5e20000-0000-4000-8000-00000000000d');
delete from public.studios where id in (
  'a5e20000-0000-4000-8000-00000000000a', 'a5e20000-0000-4000-8000-00000000000b', 'a5e20000-0000-4000-8000-00000000000c', 'a5e20000-0000-4000-8000-00000000000d');
delete from auth.users where email like '%@tw4a-e2e.test';

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4a-e2e.test', now(), now()
from (values
  ('owner_a', 'a5e20000-0000-4000-8000-000000000101'), ('admin_a', 'a5e20000-0000-4000-8000-000000000102'),
  ('fd_a', 'a5e20000-0000-4000-8000-000000000103'), ('instr_a', 'a5e20000-0000-4000-8000-000000000104'),
  ('owner_b', 'a5e20000-0000-4000-8000-000000000201'), ('padmin', 'a5e20000-0000-4000-8000-000000000401'),
  ('outsider', 'a5e20000-0000-4000-8000-000000000999')) as t(k, id);

insert into public.profiles (id, platform_role)
select id::uuid, case when k = 'padmin' then 'platform_admin' end
from (values
  ('owner_a', 'a5e20000-0000-4000-8000-000000000101'), ('admin_a', 'a5e20000-0000-4000-8000-000000000102'),
  ('fd_a', 'a5e20000-0000-4000-8000-000000000103'), ('instr_a', 'a5e20000-0000-4000-8000-000000000104'),
  ('owner_b', 'a5e20000-0000-4000-8000-000000000201'), ('padmin', 'a5e20000-0000-4000-8000-000000000401'),
  ('outsider', 'a5e20000-0000-4000-8000-000000000999')) as t(k, id)
on conflict (id) do update set platform_role = excluded.platform_role;

insert into public.studios (id, name, slug, public_name) values
  ('a5e20000-0000-4000-8000-00000000000a', 'TW4A E2E Studio A', 'tw4a-e2e-a', 'E2E Harbor Dance'),
  ('a5e20000-0000-4000-8000-00000000000b', 'TW4A E2E Studio B', 'tw4a-e2e-b', null),
  ('a5e20000-0000-4000-8000-00000000000c', 'TW4A E2E Studio C', 'tw4a-e2e-c', null),
  ('a5e20000-0000-4000-8000-00000000000d', 'TW4A E2E Studio D', 'tw4a-e2e-d', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('a5e20000-0000-4000-8000-000000000101', 'a5e20000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('a5e20000-0000-4000-8000-000000000102', 'a5e20000-0000-4000-8000-00000000000a', 'studio_admin', true),
  ('a5e20000-0000-4000-8000-000000000103', 'a5e20000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('a5e20000-0000-4000-8000-000000000104', 'a5e20000-0000-4000-8000-00000000000a', 'instructor', true),
  ('a5e20000-0000-4000-8000-000000000201', 'a5e20000-0000-4000-8000-00000000000b', 'studio_owner', true);

-- studio C: an existing registration only (no onboarding, pilot switch never turned on)
insert into public.studio_sms_registrations (studio_id, registration_status) values ('a5e20000-0000-4000-8000-00000000000c', 'in_review');

commit;
