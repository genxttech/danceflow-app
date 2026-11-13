-- Website Embeds: FICTIONAL fixtures for DEV (two made-up studios, no users, no payment accounts, no client data).
-- Everything is keyed by the fixed ids below so fixtures-cleanup.sql removes exactly this and nothing else.
-- Idempotent: it removes any earlier copy of these ids first, then recreates dates relative to today.
-- Apply only with owner authorization: sb.sh dev-apply scripts/qa/embeds/dev/fixtures.sql <sha256>
do $$
declare
  a constant uuid := 'e3b00000-0000-4000-8000-000000000001';
  b constant uuid := 'e3b00000-0000-4000-8000-000000000002';
  series constant uuid := 'e3b00000-0000-4000-8000-0000000000a1';
  priced constant uuid := 'e3b00000-0000-4000-8000-0000000000a9';
  first_day date := (now() at time zone 'America/New_York')::date + 3;
  n int;
begin
  -- clean earlier copy (children first)
  delete from public.group_class_enrollment_policies where studio_id in (a, b);
  delete from public.appointments where studio_id in (a, b);
  delete from public.group_class_series where studio_id in (a, b);
  delete from public.events where studio_id in (a, b);
  if to_regclass('public.studio_embed_settings') is not null then
    delete from public.studio_embed_settings where studio_id in (a, b);
  end if;
  delete from public.studios where id in (a, b);

  insert into public.studios (id, name, slug, subscription_status, timezone, public_directory_enabled) values
    (a, 'Embed QA Studio A (fictional)', 'embed-qa-fictional-a', 'trialing', 'America/New_York', true),
    (b, 'Embed QA Studio B (fictional)', 'embed-qa-fictional-b', 'trialing', 'America/New_York', true);

  insert into public.group_class_series (id, studio_id, title, description, timezone, weekdays, interval_weeks, starts_on, occurrence_count,
      local_start_time, duration_minutes, default_roster_capacity, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount)
  values (series, a, 'QA Bachata Series', 'Fictional weekly partner work for embed testing.', 'America/New_York',
      array[extract(isodow from first_day)::smallint], 1, first_day, 4, '19:00', 60, 6, true, true, array['direct_payment']::text[], 20);

  for n in 1..4 loop
    insert into public.appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, roster_capacity, group_class_series_id, series_occurrence_index, occurrence_original_start)
    values (('e3b00000-0000-4000-8000-0000000000a' || (n + 1))::uuid, a, 'group_class', 'QA Bachata Series',
      ((first_day + (n - 1) * 7)::text || ' 19:00 America/New_York')::timestamptz,
      ((first_day + (n - 1) * 7)::text || ' 20:00 America/New_York')::timestamptz, 'scheduled', 6, series, n,
      ((first_day + (n - 1) * 7)::text || ' 19:00 America/New_York')::timestamptz);
  end loop;
  insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount)
  select studio_id, id, true, true, array['direct_payment']::text[], 20 from public.appointments where group_class_series_id = series;

  insert into public.appointments (id, studio_id, appointment_type, title, starts_at, ends_at, status, roster_capacity)
  values (priced, a, 'group_class', 'QA Rumba Workshop', ((first_day + 1)::text || ' 15:00 America/New_York')::timestamptz, ((first_day + 1)::text || ' 16:00 America/New_York')::timestamptz, 'scheduled', 8);
  insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount)
  values (a, priced, true, true, array['direct_payment']::text[], 25);

  insert into public.events (studio_id, name, slug, event_type, start_date, end_date, status, visibility, public_directory_enabled, venue_name, city, state, timezone) values
    (a, 'QA Social Night (fictional)', 'embed-qa-public', 'social_dance', first_day + 2, first_day + 2, 'published', 'public', true, 'Fictional Hall', 'Albany', 'NY', 'America/New_York'),
    (a, 'QA Winter Workshop (fictional)', 'embed-qa-multiday', 'workshop', first_day + 4, first_day + 6, 'published', 'public', true, 'Fictional Hall', 'Albany', 'NY', 'America/New_York'),
    (a, 'QA Private Retreat (fictional)', 'embed-qa-private', 'workshop', first_day + 2, first_day + 2, 'published', 'private', false, null, null, null, 'America/New_York'),
    (a, 'QA Draft Gala (fictional)', 'embed-qa-draft', 'party', first_day + 2, first_day + 2, 'draft', 'public', true, null, null, null, 'America/New_York'),
    (b, 'QA Other Studio Event (fictional)', 'embed-qa-other', 'social_dance', first_day + 2, first_day + 2, 'published', 'public', true, null, null, null, 'America/New_York');
end
$$;
