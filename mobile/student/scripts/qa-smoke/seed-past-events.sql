-- QA-only seed for the past-events regression smoke (run.mjs --past-events), applied AFTER sign-in so the "ends in 25 minutes" rows are still
-- in the future when the screens are read. Needs seed.sql (studio, client) and seed-event.sql (QA Social Dance Night, the upcoming baseline).
-- Needs psql -v uid="'<auth user id>'" (run.mjs passes it). Dates are relative to the stack's clock, in each event's OWN time zone.
\set ON_ERROR_STOP on
begin;
set local session_replication_role = replica;

-- helper: (now() + interval) as local wall-clock time in a zone
-- Pacific/Auckland is UTC+13 and Pacific/Honolulu is UTC-10 in November: a reader that ignores the zone (or reads the wall clock as UTC)
-- gets the "ended an hour ago" Auckland row wrong and the "ends in 25 minutes" Honolulu row wrong.
insert into events (id, studio_id, name, slug, event_type, start_date, end_date, start_time, end_time, timezone, visibility, status,
                    public_directory_enabled, registration_required, public_summary, venue_name, city, state)
select v.id::uuid, '11111111-1111-4111-8111-111111111111', v.name, v.slug, 'social_dance', v.sd, v.ed, v.st, v.et, v.tz, 'public', 'published',
       true, true, 'QA past-events fixture', 'QA Ballroom', 'Austin', 'TX'
from (values
  ('44444444-4444-4444-8444-4444444444a1', 'QA Ended Last Week',            'qa-ended-last-week',   (current_date - 8),  (current_date - 7),  '19:00'::time, '22:00'::time, 'America/New_York'),
  ('44444444-4444-4444-8444-4444444444a2', 'QA Ended Two Days Ago',         'qa-ended-two-days',    (current_date - 3),  (current_date - 2),  '19:00'::time, '22:00'::time, 'America/New_York'),
  ('44444444-4444-4444-8444-4444444444a3', 'QA Multi Day Last Day',         'qa-multi-day-last',    ((now() at time zone 'America/New_York')::date - 2), (now() at time zone 'America/New_York')::date, '09:00'::time, null::time, 'America/New_York'),
  ('44444444-4444-4444-8444-4444444444a4', 'QA Ends Soon Auckland',         'qa-ends-soon-akl',     ((now() + interval '25 minutes') at time zone 'Pacific/Auckland')::date, ((now() + interval '25 minutes') at time zone 'Pacific/Auckland')::date, '00:00'::time, ((now() + interval '25 minutes') at time zone 'Pacific/Auckland')::time(0), 'Pacific/Auckland'),
  ('44444444-4444-4444-8444-4444444444a5', 'QA Ended Hour Ago Auckland',    'qa-ended-hour-akl',    ((now() - interval '60 minutes') at time zone 'Pacific/Auckland')::date, ((now() - interval '60 minutes') at time zone 'Pacific/Auckland')::date, '00:00'::time, ((now() - interval '60 minutes') at time zone 'Pacific/Auckland')::time(0), 'Pacific/Auckland'),
  ('44444444-4444-4444-8444-4444444444a6', 'QA Ends Soon Honolulu',        'qa-ends-soon-hnl',     ((now() + interval '25 minutes') at time zone 'Pacific/Honolulu')::date, ((now() + interval '25 minutes') at time zone 'Pacific/Honolulu')::date, '00:00'::time, ((now() + interval '25 minutes') at time zone 'Pacific/Honolulu')::time(0), 'Pacific/Honolulu'),
  ('44444444-4444-4444-8444-4444444444a7', 'QA Ended Half Hour Honolulu',  'qa-ended-half-hnl',    ((now() - interval '30 minutes') at time zone 'Pacific/Honolulu')::date, ((now() - interval '30 minutes') at time zone 'Pacific/Honolulu')::date, '00:00'::time, ((now() - interval '30 minutes') at time zone 'Pacific/Honolulu')::time(0), 'Pacific/Honolulu'),
  -- New York DST edges: 2026-11-01 01:30 happens twice (fall back; ended long ago), 2027-03-14 02:30 does not exist (spring forward; upcoming until then)
  ('44444444-4444-4444-8444-4444444444a8', 'QA DST Fall Ambiguous Hour',    'qa-dst-fall',          '2026-11-01'::date,  '2026-11-01'::date,  '00:30'::time, '01:30'::time, 'America/New_York'),
  ('44444444-4444-4444-8444-4444444444a9', 'QA DST Spring Missing Hour',    'qa-dst-spring',        '2027-03-14'::date,  '2027-03-14'::date,  '01:00'::time, '02:30'::time, 'America/New_York')
) as v(id, name, slug, sd, ed, st, et, tz)
on conflict (id) do nothing;

-- An ended event the dancer owns a ticket for, and has saved: history must stay reachable.
insert into event_ticket_types (id, event_id, name, description, ticket_kind, price, currency, active, attendees_per_ticket, sort_order)
  values ('55555555-5555-4555-8555-555555555552', '44444444-4444-4444-8444-4444444444a1', 'Past General Admission', 'Ended event ticket', 'general_admission', 25, 'usd', true, 1, 1)
  on conflict (id) do nothing;
insert into event_registrations (id, event_id, studio_id, ticket_type_id, client_id, user_id, portal_user_id, attendee_first_name, attendee_last_name, attendee_email,
                                 status, payment_status, quantity, unit_price, total_price, registration_source)
  values ('66666666-6666-4666-8666-666666666681', '44444444-4444-4444-8444-4444444444a1', '11111111-1111-4111-8111-111111111111',
          '55555555-5555-4555-8555-555555555552', '22222222-2222-4222-8222-222222222222', :uid, :uid, 'Dana', 'Dancer', 'dana.dancer@example.test',
          'confirmed', 'paid', 1, 25, 25, 'public_event_page')
  on conflict (id) do nothing;
insert into event_registration_attendees (id, registration_id, event_id, ticket_type_id, first_name, last_name, email, sort_order, ticket_code, ticket_issued_at)
  values ('77777777-7777-4777-8777-777777777781', '66666666-6666-4666-8666-666666666681', '44444444-4444-4444-8444-4444444444a1',
          '55555555-5555-4555-8555-555555555552', 'Dana', 'Dancer', 'dana.dancer@example.test', 1, 'QA-PAST-0001', now())
  on conflict (id) do nothing;
insert into user_favorites (user_id, target_type, event_id)
  select :uid::uuid, 'event', e.id from (values ('44444444-4444-4444-8444-4444444444a1'::uuid), ('44444444-4444-4444-8444-444444444441'::uuid)) as e(id);
commit;
