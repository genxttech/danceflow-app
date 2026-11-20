-- QA-only seed for run.mjs --past-registrations: the dancer's ENDED event registrations (Tickets & registrations > Past events).
-- Needs seed.sql (studio, client) and seed-event.sql (QA Social Dance Night, the upcoming baseline with a ticket). Needs psql -v uid="'<auth user id>'".
-- Registrations: one with a ticket, one WITHOUT a ticket, one cancelled+refunded, 13 more ended ones (in no public directory) so the 12-item page and
-- "Show more" are exercised, one upcoming registration, and a PRIVATE ended event the dancer registered for (a probe: does the events embed still return
-- its end date for the dancer? the scenario records what the app shows; no SQL is needed if it does).
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;
select set_config('qa.uid', :uid, false);

-- named events (all public + in the directory is not needed: this list reads registrations, not the directory)
insert into events (id, studio_id, name, slug, event_type, start_date, end_date, start_time, end_time, timezone, visibility, status,
                    public_directory_enabled, registration_required, public_summary, venue_name, city, state)
select v.id::uuid, '11111111-1111-4111-8111-111111111111', v.name, v.slug, 'social_dance', v.sd, v.sd, '19:00'::time, '22:00'::time, 'America/New_York', 'public', 'published',
       false, true, 'QA past-registrations fixture', 'QA Ballroom', 'Austin', 'TX'
from (values
  ('44444444-4444-4444-8444-44444444aa01', 'QA Past With Ticket',        'qa-past-with-ticket',  (current_date - 2)),
  ('44444444-4444-4444-8444-44444444aa02', 'QA Past No Ticket',          'qa-past-no-ticket',    (current_date - 3)),
  ('44444444-4444-4444-8444-44444444aa03', 'QA Past Cancelled Refunded', 'qa-past-cancelled',    (current_date - 4)),
  ('44444444-4444-4444-8444-44444444aa04', 'QA Upcoming Registered',     'qa-upcoming-reg',      (current_date + 20))
) as v(id, name, slug, sd)
on conflict (id) do nothing;

-- 13 more ended events (oldest first by date): total ended registrations = 3 named + 13 bulk (+1 private probe) > 12
insert into events (id, studio_id, name, slug, event_type, start_date, end_date, start_time, end_time, timezone, visibility, status,
                    public_directory_enabled, registration_required, public_summary, venue_name, city, state)
select ('44444444-4444-4444-8444-44444444' || lpad(to_hex(4096 + n), 4, '0'))::uuid, '11111111-1111-4111-8111-111111111111',
       'QA Bulk Past ' || lpad(n::text, 2, '0'), 'qa-bulk-past-' || n, 'social_dance', (date '2026-01-01' + n), (date '2026-01-01' + n), '19:00'::time, '22:00'::time,
       'America/New_York', 'public', 'published', false, true, 'QA past-registrations fixture', 'QA Ballroom', 'Austin', 'TX'
from generate_series(1, 13) as n
on conflict (id) do nothing;

-- ticket types and registrations: one per event above (ids derived from the event id so they are stable)
insert into event_ticket_types (id, event_id, name, description, ticket_kind, price, currency, active, attendees_per_ticket, sort_order)
select overlay(e.id::text placing '55555555-5555-4555-8555-5555' from 1 for 28)::uuid, e.id, 'General', 'fixture', 'general_admission', 25, 'usd', true, 1, 1
from events e
where e.name like 'QA Past %' or e.name like 'QA Bulk Past %' or e.name = 'QA Upcoming Registered'
on conflict (id) do nothing;

-- registrations (the dancer owns them: user_id = auth user, so the dancer views return them)
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
select overlay(e.id::text placing '66666666-6666-4666-8666-6666' from 1 for 28)::uuid, e.id, '11111111-1111-4111-8111-111111111111',
       overlay(e.id::text placing '55555555-5555-4555-8555-5555' from 1 for 28)::uuid,
       '22222222-2222-4222-8222-222222222222', :uid::uuid, :uid::uuid, 'Dana', 'Dancer', 'dana.dancer@example.test',
       case when e.name = 'QA Past Cancelled Refunded' then 'cancelled' else 'confirmed' end,
       case when e.name = 'QA Past Cancelled Refunded' then 'refunded' else 'paid' end,
       1, 25, 25, 'public_event_page'
from events e
where e.name like 'QA Past %' or e.name like 'QA Bulk Past %' or e.name = 'QA Upcoming Registered'
on conflict (id) do nothing;

-- one ticket, only for "QA Past With Ticket"
insert into event_registration_attendees (id, registration_id, event_id, ticket_type_id, first_name, last_name, email, sort_order, ticket_code, ticket_issued_at)
select '77777777-7777-4777-8777-777777777791'::uuid, r.id, r.event_id, r.ticket_type_id, 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-PASTREG-0001', now()
from event_registrations r join events e on e.id = r.event_id where e.name = 'QA Past With Ticket'
on conflict (id) do nothing;

-- PRIVATE ended event the dancer registered for (probe). If the visibility value is not allowed the probe is skipped and the scenario says so.
do $$
begin
  insert into events (id, studio_id, name, slug, event_type, start_date, end_date, start_time, end_time, timezone, visibility, status,
                      public_directory_enabled, registration_required, public_summary, venue_name, city, state)
  values ('44444444-4444-4444-8444-44444444aa09', '11111111-1111-4111-8111-111111111111', 'QA Private Ended', 'qa-private-ended', 'social_dance',
          current_date - 5, current_date - 5, '19:00', '22:00', 'America/New_York', 'private', 'published', false, true, 'QA probe', 'QA Ballroom', 'Austin', 'TX');
  insert into event_ticket_types (id, event_id, name, description, ticket_kind, price, currency, active, attendees_per_ticket, sort_order)
  values ('55555555-5555-4555-8555-555500aa0009', '44444444-4444-4444-8444-44444444aa09', 'General', 'probe', 'general_admission', 25, 'usd', true, 1, 1);
  insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                   status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666600aa0009', '44444444-4444-4444-8444-44444444aa09', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555500aa0009',
          '22222222-2222-4222-8222-222222222222', current_setting('qa.uid')::uuid, current_setting('qa.uid')::uuid, 'Dana', 'Dancer', 'dana.dancer@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_event_page');
exception when others then
  raise notice 'private probe skipped: %', sqlerrm;
end $$;
commit;
