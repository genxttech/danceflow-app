-- Marketing M-0 -- schema fingerprint of every object the M-0 migrations touch (read-only).
-- Used to prove apply -> rollback returns the database to its exact pre-M-0 state, and to compare DEV / PROD.
-- Output: one row per item plus a final 'TOTAL <count> <md5>' row.
with items as (
  select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' def=' || coalesce(column_default, '') as item
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                       'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                       'organizer_marketing_unsubscribes', 'organizer_contacts',
                       'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  union all
  select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid::regclass::text in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                                     'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                                     'organizer_marketing_unsubscribes', 'organizer_contacts',
                                     'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  union all
  select 'idx ' || tablename || ' ' || indexdef
  from pg_indexes
  where schemaname = 'public'
    and tablename in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                      'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                      'organizer_marketing_unsubscribes', 'organizer_contacts',
                      'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  union all
  select 'trg ' || event_object_table || ' ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation || ' ' || action_statement
  from information_schema.triggers
  where event_object_schema = 'public'
    and event_object_table in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                               'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                               'organizer_marketing_unsubscribes', 'organizer_contacts')
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' q=' || coalesce(qual, '') || ' c=' || coalesce(with_check, '')
  from pg_policies
  where schemaname = 'public'
    and tablename in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                      'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                      'organizer_marketing_unsubscribes', 'organizer_contacts',
                      'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  union all
  select 'rls ' || relname || ' ' || relrowsecurity::text
  from pg_class
  where relnamespace = 'public'::regnamespace
    and relname in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                    'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                    'organizer_marketing_unsubscribes', 'organizer_contacts',
                    'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  union all
  select 'grant ' || table_name || ' ' || grantee || ' ' || string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated', 'service_role')
    and table_name in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                       'organizer_marketing_campaigns', 'organizer_marketing_campaign_recipients',
                       'organizer_marketing_unsubscribes', 'organizer_contacts',
                       'marketing_email_suppressions', 'marketing_message_unsubscribe_tokens', 'marketing_test_sends')
  group by table_name, grantee
  union all
  select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') secdef=' || p.prosecdef
         || ' md5=' || md5(replace(p.prosrc, E'\r\n', E'\n')) || ' acl=' || coalesce(array_to_string(array(select x::text from unnest(p.proacl) as x order by 1), ','), '')
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (p.proname like 'marketing\_%' or p.proname like '\_mkt\_%' or p.proname = 'unsubscribe_marketing_recipient'
         or p.proname = 'claim_outbound_deliveries')
  union all
  -- remediation scope: outbound_deliveries write controls and the send-freeze control tables
  select 'trg ' || event_object_table || ' ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation || ' ' || action_statement
  from information_schema.triggers
  where event_object_schema = 'public' and event_object_table = 'outbound_deliveries'
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' ' || array_to_string(roles, ',') || ' q=' || coalesce(qual, '') || ' c=' || coalesce(with_check, '')
  from pg_policies
  where schemaname = 'public' and tablename in ('outbound_deliveries', 'marketing_send_controls', 'marketing_send_control_events')
  union all
  select 'grant ' || table_name || ' ' || grantee || ' ' || string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
    and table_name in ('outbound_deliveries', 'marketing_send_controls', 'marketing_send_control_events')
  group by table_name, grantee
  union all
  select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' def=' || coalesce(column_default, '')
  from information_schema.columns
  where table_schema = 'public' and table_name in ('marketing_send_controls', 'marketing_send_control_events')
  union all
  select 'rls ' || relname || ' ' || relrowsecurity::text
  from pg_class
  where relnamespace = 'public'::regnamespace and relname in ('outbound_deliveries', 'marketing_send_controls', 'marketing_send_control_events')
)
select item from items
union all
select 'TOTAL ' || count(*) || ' ' || md5(string_agg(item, E'\n' order by item)) from items
order by 1;
