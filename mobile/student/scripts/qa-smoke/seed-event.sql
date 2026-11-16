-- QA-only event seed, applied after seed.sql when run.mjs is given --events (needs seed.sql's studio and client).
-- One public event of the seeded studio, one ticket type, and one confirmed, paid registration for the test dancer
-- with an issued ticket code (so Event detail and the Wallet ticket screen both have data).
-- Column lists were taken from the live schema (NOT NULL columns and CHECK constraints); the first run proves it.
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;
update studios set public_directory_enabled = true, subscription_status = 'active'
  where id = '11111111-1111-4111-8111-111111111111';
insert into events (id, studio_id, name, slug, event_type, start_date, end_date, start_time, end_time, visibility, status,
                    public_directory_enabled, registration_required, public_summary, venue_name, city, state)
  values ('44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111', 'QA Social Dance Night', 'qa-social-dance-night',
          'social_dance', (current_date + 14), (current_date + 14), '19:00', '22:00', 'public', 'published',
          true, true, 'A QA social dance with a beginner lesson.', 'QA Ballroom', 'Austin', 'TX')
  on conflict (id) do nothing;
insert into event_ticket_types (id, event_id, name, description, ticket_kind, price, currency, active, attendees_per_ticket, sort_order)
  values ('55555555-5555-4555-8555-555555555551', '44444444-4444-4444-8444-444444444441', 'General Admission', 'Entry and beginner lesson', 'general_admission', 25, 'usd', true, 1, 1)
  on conflict (id) do nothing;
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666661', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555551', '22222222-2222-4222-8222-222222222222', 'Dana', 'Dancer', 'dana.dancer@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_event_page')
  on conflict (id) do nothing;
insert into event_registration_attendees (id, registration_id, event_id, ticket_type_id, first_name, last_name, email, sort_order, ticket_code, ticket_issued_at)
  values ('77777777-7777-4777-8777-777777777771', '66666666-6666-4666-8666-666666666661', '44444444-4444-4444-8444-444444444441',
          '55555555-5555-4555-8555-555555555551', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-DANA-0001', now())
  on conflict (id) do nothing;
commit;
