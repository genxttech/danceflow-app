-- QA-only seed for the event-registration CLAIM flow (claim_my_event_registrations, SQL PR 604). Apply AFTER seed.sql and
-- seed-event.sql, on a throwaway iso-qa stack WITH the claim migration applied. Never on a hosted database.
-- Needs: psql -v uid="'<dana auth id>'" -v uid2="'<evan auth id>'"  (Evan = second dancer, evan.other@example.test).
-- Every registration here is for the seeded event and studio, has NO client link, and (except c4) user_id NULL, which is
-- exactly the state the web cart, studio sell-tickets and gifts leave behind. Column lists mirror seed-event.sql.
-- The function claims only unclaimed rows whose REGISTRATION BUYER email (event_registrations.attendee_email) equals the
-- caller's verified email, case and spaces ignored. It never reads event_registration_attendees emails.
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

insert into event_ticket_types (id, event_id, name, description, ticket_kind, price, currency, active, attendees_per_ticket, sort_order)
  values ('55555555-5555-4555-8555-555555555552', '44444444-4444-4444-8444-444444444441', 'Spectator', 'Watch the social', 'general_admission', 10, 'usd', true, 1, 2)
  on conflict (id) do nothing;

-- c1: public web cart, buyer email typed with capitals and stray spaces. Dana's claim must take it.
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666662', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555551', null, null, null, 'Dana', 'Dancer', '  Dana.Dancer@Example.TEST ',
          'confirmed', 'paid', 1, 25, 25, 'public_cart')
  on conflict (id) do nothing;
-- c2: studio-sold ticket (sell-tickets), buyer email matches Dana exactly. Dana's claim must take it.
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666663', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555552', null, null, null, 'Dana', 'Dancer', 'dana.dancer@example.test',
          'confirmed', 'paid', 1, 10, 10, 'studio_sell_tickets')
  on conflict (id) do nothing;
-- c3: GIFT. Evan is the purchaser (registration buyer email); Dana is only the guest attendee. Evan's claim takes it;
-- Dana's claim must NOT (guest attendee emails are never matched).
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666664', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555551', null, null, null, 'Evan', 'Other', 'evan.other@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_cart')
  on conflict (id) do nothing;
-- c4: already owned by Evan, buyer email is Dana's. Dana's claim must NOT take it (user_id is not null).
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666665', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555551', null, :uid2, :uid2, 'Dana', 'Dancer', 'dana.dancer@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_cart')
  on conflict (id) do nothing;
-- c5: unclaimed, belongs to nobody in this test. Must stay unclaimed and invisible to both.
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444441', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555551', null, null, null, 'Nobody', 'Here', 'nobody@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_cart')
  on conflict (id) do nothing;

-- One attendee (ticket) per registration. c3's attendee is Dana (the gift recipient).
insert into event_registration_attendees (id, registration_id, event_id, ticket_type_id, first_name, last_name, email, sort_order, ticket_code, ticket_issued_at) values
  ('77777777-7777-4777-8777-777777777772', '66666666-6666-4666-8666-666666666662', '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555551', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-CLAIM-0001', now()),
  ('77777777-7777-4777-8777-777777777773', '66666666-6666-4666-8666-666666666663', '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555552', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-CLAIM-0002', now()),
  ('77777777-7777-4777-8777-777777777774', '66666666-6666-4666-8666-666666666664', '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555551', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-GIFT-0003', now()),
  ('77777777-7777-4777-8777-777777777775', '66666666-6666-4666-8666-666666666665', '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555551', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-OWNED-0004', now()),
  ('77777777-7777-4777-8777-777777777776', '66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444441', '55555555-5555-4555-8555-555555555551', 'Nobody', 'Here', 'nobody@example.test', 1, 'QA-NOBODY-0005', now())
  on conflict (id) do nothing;
commit;
