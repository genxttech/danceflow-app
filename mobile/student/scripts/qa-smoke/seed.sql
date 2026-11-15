-- QA-only seed for the disposable iso-qa stack: one studio, the test dancer as its client, two open payment requests.
-- Usage: docker exec -i df-isoqa-<name>-db psql -U postgres -d postgres -v uid="'<auth user id>'" < seed.sql
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica; -- QA seed only: skips the reward trigger that breaks plain inserts on the local baseline
insert into studios (id, name, slug) values ('11111111-1111-4111-8111-111111111111', 'QA Dance Studio', 'qa-dance-studio')
  on conflict (id) do nothing;
insert into clients (id, studio_id, first_name, last_name, email)
  values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Dana', 'Dancer', 'dana.dancer@example.test')
  on conflict (id) do nothing;
insert into client_account_links (studio_id, client_id, user_id, status, relationship_type, initiated_by, linked_at, can_view_schedule, can_view_billing, can_manage_bookings, can_sign_documents, is_primary)
  values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', :uid, 'linked', 'self', 'dancer', now(), true, true, true, true, true);
insert into payments (id, studio_id, client_id, amount, payment_method, status, payment_type, notes, currency)
  values ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 40, 'card', 'pending', 'lesson', 'QA lesson payment', 'usd'),
         ('33333333-3333-4333-8333-333333333332', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 75, 'card', 'pending', 'package', 'QA package payment', 'usd');
commit;
