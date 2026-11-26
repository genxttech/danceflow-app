-- LOCAL / DISPOSABLE ONLY: committed fixtures for rest-authz.mjs. Run on a throwaway database.
insert into auth.users (id, email) select ('a8000000-0000-4000-8000-00000000000' || i)::uuid, 'u' || i || '@rest.test' from generate_series(1, 6) i;
insert into public.profiles (id) select id from auth.users where email like '%@rest.test' on conflict do nothing;
insert into public.studios (id, name, slug, subscription_status) values
  ('a8100000-0000-4000-8000-00000000000a', 'Rest A', 'rest-a', 'active'), ('a8100000-0000-4000-8000-00000000000b', 'Rest B', 'rest-b', 'active');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('a8000000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('a8000000-0000-4000-8000-000000000003', 'a8100000-0000-4000-8000-00000000000a', 'instructor', true),
  ('a8000000-0000-4000-8000-000000000006', 'a8100000-0000-4000-8000-00000000000b', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, status, visibility, start_date, end_date, created_by) values
  ('a8300000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-00000000000a', 'E1', 'rest-e1', 'published', 'public', '2027-03-01', '2027-03-01', 'a8000000-0000-4000-8000-000000000001');
insert into public.event_guest_coaches (id, event_id, studio_id, name) values ('a8400000-0000-4000-8000-000000000001', 'a8300000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-00000000000a', 'Coach');
insert into public.event_private_lesson_slots (event_id, coach_id, studio_id, starts_at, ends_at, status, buyer_name)
values ('a8300000-0000-4000-8000-000000000001', 'a8400000-0000-4000-8000-000000000001', 'a8100000-0000-4000-8000-00000000000a', '2027-03-01 10:00+00', '2027-03-01 10:45+00', 'booked', 'Fixture Buyer');
