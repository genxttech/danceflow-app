-- READ-ONLY preflight for 20270221090000 (claim function) + 20270221091000 (index). Counts only; no emails are selected.
-- One result row (jsonb) so a single-statement runner returns everything.
select jsonb_build_object(
  'prereq_objects', (select to_jsonb(t) from (select
      to_regprocedure('public.my_verified_email()') is not null as my_verified_email,
      to_regprocedure('public.record_email_proof_web()') is not null as record_email_proof_web,
      to_regprocedure('public.complete_email_binding(uuid,uuid)') is not null as complete_email_binding,
      to_regprocedure('public.email_binding_status()') is not null as email_binding_status,
      to_regclass('public.verified_email_identities') is not null as verified_email_identities,
      to_regclass('public.auth_email_change_markers') is not null as auth_email_change_markers,
      to_regclass('auth.sessions') is not null as auth_sessions) t),
  'my_verified_email_definition', (select to_jsonb(t) from (select p.prosecdef as security_definer, pg_get_userbyid(p.proowner) as owner,
      p.proconfig as config, has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec
      from pg_proc p where p.oid = to_regprocedure('public.my_verified_email()')) t),
  'event_registrations_columns', (select jsonb_agg(to_jsonb(t) order by t.column_name) from (select column_name, data_type, is_nullable
      from information_schema.columns where table_schema = 'public' and table_name = 'event_registrations'
        and column_name in ('user_id', 'attendee_email', 'order_id', 'client_id', 'status', 'payment_status', 'updated_at', 'registration_source', 'notes')) t),
  'event_registrations_policies', (select jsonb_agg(to_jsonb(t) order by t.policyname) from (select policyname, cmd, roles::text as roles
      from pg_policies where schemaname = 'public' and tablename = 'event_registrations') t),
  'self_select_qual', (select qual from pg_policies where schemaname = 'public' and tablename = 'event_registrations' and policyname = 'event_registrations_self_select'),
  'event_registrations_triggers', (select jsonb_agg(to_jsonb(t) order by t.tgname) from (select tgname, tgenabled::text as enabled
      from pg_trigger where tgrelid = 'public.event_registrations'::regclass and not tgisinternal) t),
  'claim_objects', (select to_jsonb(t) from (select
      to_regprocedure('public.claim_my_event_registrations()') is not null as function_exists,
      to_regclass('public.event_registrations_unclaimed_email_idx') is not null as index_exists,
      (select count(*) from pg_index i where i.indrelid = 'public.event_registrations'::regclass and not i.indisvalid) as invalid_indexes_on_table) t),
  'table_size', (select to_jsonb(t) from (select c.reltuples::bigint as est_rows, pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
      pg_get_userbyid(c.relowner) as owner from pg_class c where c.oid = 'public.event_registrations'::regclass) t),
  'unclaimed_counts', (select to_jsonb(t) from (select
      count(*) as total_registrations,
      count(*) filter (where user_id is null) as unclaimed,
      count(*) filter (where user_id is null and attendee_email is not null and btrim(attendee_email) <> '') as unclaimed_with_email,
      count(distinct lower(btrim(attendee_email))) filter (where user_id is null and attendee_email is not null and btrim(attendee_email) <> '') as unclaimed_distinct_emails,
      count(*) filter (where user_id is null and order_id is not null and attendee_email is not null and btrim(attendee_email) <> '') as unclaimed_order_backed,
      count(*) filter (where user_id is null and registration_source = 'admin') as unclaimed_admin_sold
      from public.event_registrations) t),
  'would_match_bound_identity_now', (select to_jsonb(t) from (select
      count(*) as registrations, count(distinct v.user_id) as distinct_accounts,
      count(*) filter (where er.registration_source = 'admin') as of_which_admin_sold
      from public.event_registrations er
      join public.verified_email_identities v on v.credential_status = 'bound' and v.bound_at is not null and lower(btrim(er.attendee_email)) = v.email
      where er.user_id is null and er.attendee_email is not null and btrim(er.attendee_email) <> '') t),
  'would_match_any_account_email', (select to_jsonb(t) from (select
      count(*) as registrations, count(distinct u.id) as distinct_accounts
      from public.event_registrations er
      join auth.users u on lower(btrim(u.email)) = lower(btrim(er.attendee_email))
      where er.user_id is null and er.attendee_email is not null and btrim(er.attendee_email) <> '') t),
  'bound_identities', (select count(*) from public.verified_email_identities where credential_status = 'bound')
) as preflight;
