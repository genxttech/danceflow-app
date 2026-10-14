-- Marketing M-0 -- PRODUCTION PREFLIGHT (READ-ONLY). Prepared for owner authorization; NOT run against PROD.
-- Validated for syntax/columns on the local QA stack and for baselines on DEV (A4 hash, A5 = 0, A6 = none).
--
-- Run only with explicit owner authorization, from a fresh scratch workdir linked to PROD, in one read-only transaction.
-- Every statement is a SELECT; no table is written, no function is created. The output is aggregate counts and schema
-- metadata only: no email address, name, token or message content is returned.
--
-- Also run sql-tests/m0_marketing_fingerprint.sql (read-only) and compare it with the DEV pre-M-0 fingerprint
-- (TOTAL 191 9493285ff9d2d87f2880d6dce461ed33). Any difference must be explained before stage-1 SQL is applied.

begin transaction read only;
set local statement_timeout = '30s';

-- A. Schema facts the migrations depend on --------------------------------------------------------------------------
select 'A1 unsubscribe unique indexes' as check_name,
       string_agg(tablename || ': ' || indexdef, ' | ' order by tablename) as result
from pg_indexes
where schemaname = 'public'
  and tablename in ('marketing_unsubscribes', 'organizer_marketing_unsubscribes')
  and indexdef ilike '%unique%';

select 'A2 recipient status constraints' as check_name,
       string_agg(conrelid::regclass::text || ': ' || pg_get_constraintdef(oid), ' | ') as result
from pg_constraint
where conname in ('marketing_campaign_recipients_status_check', 'organizer_marketing_campaign_recipients_status_check');

select 'A3 marketing policies' as check_name,
       string_agg(tablename || '.' || policyname || ' [' || cmd || '] q=' || md5(coalesce(qual, '')) || ' c=' || md5(coalesce(with_check, '')), ' | ' order by tablename, policyname) as result
from pg_policies
where schemaname = 'public'
  and tablename in ('marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribes',
                    'organizer_marketing_campaign_recipients', 'organizer_marketing_unsubscribes');

select 'A4 legacy unsubscribe RPC body' as check_name,
       md5(replace(prosrc, E'\r\n', E'\n')) as result   -- DEV/repo: fa41c255eae94a56a745b92d6c6373fc
from pg_proc where proname = 'unsubscribe_marketing_recipient' and pronamespace = 'public'::regnamespace;

select 'A5 M-0 objects already present (expect 0)' as check_name, count(*)::text as result
from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'marketing\_%' or proname like '\_mkt\_%');

select 'A6 triggers on marketing tables (expect none before M-0)' as check_name, coalesce(string_agg(event_object_table || '.' || trigger_name, ' | '), 'none') as result
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('marketing_campaign_recipients', 'organizer_marketing_campaign_recipients', 'marketing_unsubscribes',
                             'organizer_marketing_unsubscribes', 'organizer_contacts');

-- A7-A9: the stage-1 preconditions, checked read-only first (stage 1 itself refuses, changing nothing, on a mismatch).
select 'A7 dispatcher claim function (expect d3179a2f46f603111b1bad5293ae6857, PAY-WH-1)' as check_name,
       coalesce((select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
                 where oid = to_regprocedure('public.claim_outbound_deliveries(uuid,integer,integer)')), 'MISSING') as result;
-- A8: the exact authorization state stage 1 requires (same signature as its precondition; a parity test keeps them in
-- step). Every table must read MATCH-PRE. Anything else: stop -- stage 1 would refuse, and the difference needs review.
select 'A8 ' || v.name as check_name,
       case when md5(
      coalesce((select c.relrowsecurity::text || '/' || c.relforcerowsecurity::text from pg_class c
                where c.oid = to_regclass('public.' || v.name)), 'missing')
      || '|' || coalesce((select string_agg(p.policyname || ':' || p.cmd || ':' || p.permissive || ':'
                                      || array_to_string(array(select r from unnest(p.roles) r order by 1), ',') || ':'
                                      || md5(coalesce(p.qual, '')) || ':' || md5(coalesce(p.with_check, '')), ';' order by p.policyname)
                          from pg_policies p
                          where p.schemaname = 'public' and p.tablename = v.name
                            and p.policyname not in ('m0 marketing managers can view campaign recipients',
                                'm0 marketing managers can view unsubscribes',
                                'm0 freeze hides pending recipients',
                                'm0 freeze blocks recipient inserts',
                                'm0 freeze blocks recipient updates',
                                'm0 freeze blocks recipient deletes',
                                'm0 freeze hides campaigns')), '')
      || '|' || coalesce((select string_agg(g.grantee || ':' || g.privilege_type, ',' order by g.grantee, g.privilege_type)
                          from information_schema.role_table_grants g
                          where g.table_schema = 'public' and g.table_name = v.name
                            and g.grantee in ('anon', 'authenticated', 'PUBLIC')), '')) = v.expected_pre then 'MATCH-PRE'
            else 'MISMATCH (got ' || md5(
      coalesce((select c.relrowsecurity::text || '/' || c.relforcerowsecurity::text from pg_class c
                where c.oid = to_regclass('public.' || v.name)), 'missing')
      || '|' || coalesce((select string_agg(p.policyname || ':' || p.cmd || ':' || p.permissive || ':'
                                      || array_to_string(array(select r from unnest(p.roles) r order by 1), ',') || ':'
                                      || md5(coalesce(p.qual, '')) || ':' || md5(coalesce(p.with_check, '')), ';' order by p.policyname)
                          from pg_policies p
                          where p.schemaname = 'public' and p.tablename = v.name
                            and p.policyname not in ('m0 marketing managers can view campaign recipients',
                                'm0 marketing managers can view unsubscribes',
                                'm0 freeze hides pending recipients',
                                'm0 freeze blocks recipient inserts',
                                'm0 freeze blocks recipient updates',
                                'm0 freeze blocks recipient deletes',
                                'm0 freeze hides campaigns')), '')
      || '|' || coalesce((select string_agg(g.grantee || ':' || g.privilege_type, ',' order by g.grantee, g.privilege_type)
                          from information_schema.role_table_grants g
                          where g.table_schema = 'public' and g.table_name = v.name
                            and g.grantee in ('anon', 'authenticated', 'PUBLIC')), '')) || ', expected ' || v.expected_pre || ')' end as result
from (values
  ('marketing_campaign_recipients', '5823c0836141ec35a90ed8e19405da74'),
  ('organizer_marketing_campaign_recipients', 'c982224e6fad5a051db26be275940115'),
  ('marketing_unsubscribes', 'aa4b495e4d629f452cbc6488f6ef6dba'),
  ('organizer_marketing_unsubscribes', 'd8146791ccb632d55f3150e7782d7f62'),
  ('marketing_campaigns', 'c01650bf177593bfb13933b164e3f7d3'),
  ('organizer_marketing_campaigns', '12f6e63cf2756a3c4b99cd671096f3e9'),
  ('outbound_deliveries', '0a979302c19343dd2a1bf1b2e2cebc97')
) as v(name, expected_pre)
order by v.name;
-- A9: the details behind A8, for review when it does not match (metadata only).
select 'A9 ' || c.relname || ' rls' as check_name,
       c.relrowsecurity::text || ' / forced ' || c.relforcerowsecurity::text as result
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('marketing_campaign_recipients', 'organizer_marketing_campaign_recipients', 'marketing_unsubscribes', 'organizer_marketing_unsubscribes', 'marketing_campaigns', 'organizer_marketing_campaigns', 'outbound_deliveries')
union all
select 'A9 ' || p.tablename || ' policy', p.policyname || ' [' || p.cmd || ', ' || p.permissive || ', roles ' ||
       array_to_string(array(select r from unnest(p.roles) r order by 1), ',') || '] q=' || md5(coalesce(p.qual, '')) || ' c=' || md5(coalesce(p.with_check, ''))
from pg_policies p
where p.schemaname = 'public' and p.tablename in ('marketing_campaign_recipients', 'organizer_marketing_campaign_recipients', 'marketing_unsubscribes', 'organizer_marketing_unsubscribes', 'marketing_campaigns', 'organizer_marketing_campaigns', 'outbound_deliveries')
union all
select 'A9 ' || g.table_name || ' grants', g.grantee || ': ' || string_agg(g.privilege_type, ',' order by g.privilege_type)
from information_schema.role_table_grants g
where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'PUBLIC')
  and g.table_name in ('marketing_campaign_recipients', 'organizer_marketing_campaign_recipients', 'marketing_unsubscribes', 'organizer_marketing_unsubscribes', 'marketing_campaigns', 'organizer_marketing_campaigns', 'outbound_deliveries')
group by g.table_name, g.grantee
order by 1, 2;
select 'A9b send-freeze table absent (expect absent)' as check_name,
       case when to_regclass('public.marketing_send_controls') is null then 'absent' else 'PRESENT' end as result;
select 'A10 outbound_deliveries client write paths (insert policy roles; for D)' as check_name,
       coalesce(string_agg(policyname || ' [' || cmd || '] ' || array_to_string(roles, ','), ' | ' order by policyname), 'none') as result
from pg_policies where schemaname = 'public' and tablename = 'outbound_deliveries';

-- B. Campaign state (aggregates) --------------------------------------------------------------------------------------
select 'B1 studio campaigns by status' as check_name, coalesce(string_agg(status || '=' || n, ', '), 'none') as result
from (select status, count(*) n from public.marketing_campaigns group by status) s;
select 'B2 organizer campaigns by status' as check_name, coalesce(string_agg(status || '=' || n, ', '), 'none') as result
from (select status, count(*) n from public.organizer_marketing_campaigns group by status) s;
select 'B3 studio recipients by status' as check_name, coalesce(string_agg(status || '=' || n, ', '), 'none') as result
from (select status, count(*) n from public.marketing_campaign_recipients group by status) s;
select 'B4 organizer recipients by status' as check_name, coalesce(string_agg(status || '=' || n, ', '), 'none') as result
from (select status, count(*) n from public.organizer_marketing_campaign_recipients group by status) s;
select 'B5 campaigns stuck in sending (C13)' as check_name,
       (select count(*) from public.marketing_campaigns where status = 'sending') || ' studio / ' ||
       (select count(*) from public.organizer_marketing_campaigns where status = 'sending') || ' organizer' as result;
select 'B6 partially sent campaigns (sent rows + pending rows)' as check_name,
       (select count(distinct campaign_id) from public.marketing_campaign_recipients r
         where status = 'sent' and exists (select 1 from public.marketing_campaign_recipients p where p.campaign_id = r.campaign_id and p.status = 'pending')) || ' studio / ' ||
       (select count(distinct campaign_id) from public.organizer_marketing_campaign_recipients r
         where status = 'sent' and exists (select 1 from public.organizer_marketing_campaign_recipients p where p.campaign_id = r.campaign_id and p.status = 'pending')) || ' organizer' as result;
select 'B7 duplicate recipient addresses within a campaign' as check_name,
       (select count(*) from (select campaign_id, lower(email) from public.marketing_campaign_recipients group by 1, 2 having count(*) > 1) d) || ' studio / ' ||
       (select count(*) from (select campaign_id, lower(email) from public.organizer_marketing_campaign_recipients group by 1, 2 having count(*) > 1) d) || ' organizer' as result;

select 'B8 rows that would violate the stage-1 constraints (expect 0)' as check_name,
       ((select count(*) from public.marketing_campaign_recipients
          where status not in ('pending', 'sending', 'sent', 'failed', 'skipped', 'unsubscribed', 'suppressed', 'delivery_unknown') or status = 'sending')
      + (select count(*) from public.organizer_marketing_campaign_recipients
          where status not in ('pending', 'sending', 'sent', 'failed', 'skipped', 'unsubscribed', 'suppressed', 'delivery_unknown') or status = 'sending'))::text
       || ' recipients / unsubscribe duplicates '
       || ((select count(*) from (select studio_id, lower(email) from public.marketing_unsubscribes group by 1, 2 having count(*) > 1) d)
         + (select count(*) from (select organizer_id, lower(email) from public.organizer_marketing_unsubscribes group by 1, 2 having count(*) > 1) d))::text as result;

select 'B9 recipient token uniqueness (stage 1 ensures unique indexes; expect 0 duplicates)' as check_name,
       (select count(*) from (select unsubscribe_token from public.marketing_campaign_recipients where unsubscribe_token is not null group by 1 having count(*) > 1) d)::text
       || ' studio / ' ||
       (select count(*) from (select unsubscribe_token from public.organizer_marketing_campaign_recipients where unsubscribe_token is not null group by 1 having count(*) > 1) d)::text
       || ' organizer; indexes present: ' ||
       (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('marketing_campaign_recipients_unsubscribe_token_unique', 'uq_organizer_marketing_campaign_recipients_unsubscribe_token'))::text as result;
select 'B10 non-lowercase studio tokens (the resolver matches the canonical form; expect 0)' as check_name,
       count(*)::text as result
from public.marketing_campaign_recipients where unsubscribe_token <> lower(unsubscribe_token);
select 'B11 mailed campaigns (protected from tenant delete after stage 1)' as check_name,
       (select count(distinct campaign_id) from public.marketing_campaign_recipients where status in ('sent', 'failed'))::text || ' studio / ' ||
       (select count(distinct campaign_id) from public.organizer_marketing_campaign_recipients where status in ('sent', 'failed'))::text || ' organizer' as result;
select 'B12 outbound_deliveries client write policies (D1 guard target)' as check_name,
       coalesce(string_agg(policyname || ' [' || cmd || ']', ', ' order by policyname), 'none') as result
from pg_policies where schemaname = 'public' and tablename = 'outbound_deliveries' and cmd in ('INSERT', 'UPDATE', 'ALL');

-- C. Evidence of past C2 damage (sent rows deleted by a regenerate): ENT-1 recorded more usage for a campaign than it
--    now has sent rows. Counts only; deleted rows cannot be reconstructed.
select 'C1 campaigns whose recorded usage exceeds current sent rows' as check_name,
       count(*)::text || ' campaigns, ' || coalesce(sum(used - sent_now), 0)::text || ' recipients unaccounted' as result
from (
  select e.related_id as campaign_id, sum(e.quantity) as used,
         coalesce((select count(*) from public.marketing_campaign_recipients r where r.campaign_id = e.related_id and r.status = 'sent'), 0)
       + coalesce((select count(*) from public.organizer_marketing_campaign_recipients r where r.campaign_id = e.related_id and r.status = 'sent'), 0) as sent_now
  from public.usage_events e
  where e.feature_key = 'email_campaign_recipient'
  group by e.related_id
) x
where used > sent_now;

-- D. Missing organizer suppression records (C1): recipients the old organizer page marked unsubscribed (its row update
--    succeeded) whose organizer-level unsubscribe was never stored (its upsert failed). These are the exact repair rows.
select 'D1 organizer link-unsubscribes without a stored unsubscribe' as check_name,
       count(*)::text || ' rows, ' || count(distinct (r.organizer_id, lower(r.email)))::text || ' distinct organizer+address' as result
from public.organizer_marketing_campaign_recipients r
where r.status = 'unsubscribed'
  and r.error_message = 'Recipient unsubscribed from organizer marketing'
  and not exists (
    select 1 from public.organizer_marketing_unsubscribes u
    where u.organizer_id = r.organizer_id and lower(u.email) = lower(r.email)
  );
select 'D2 of those, organizers affected / later sends to the same address' as check_name,
       count(distinct r.organizer_id)::text || ' organizers / ' ||
       (select count(*) from public.organizer_marketing_campaign_recipients s
         where s.status = 'sent'
           and exists (select 1 from public.organizer_marketing_campaign_recipients r2
                       where r2.organizer_id = s.organizer_id and lower(r2.email) = lower(s.email)
                         and r2.status = 'unsubscribed' and r2.error_message = 'Recipient unsubscribed from organizer marketing'
                         and s.sent_at > r2.created_at))::text || ' later sent rows (upper bound)' as result
from public.organizer_marketing_campaign_recipients r
where r.status = 'unsubscribed' and r.error_message = 'Recipient unsubscribed from organizer marketing';
select 'D3 studio rows unsubscribed by link without a studio record (expect 0)' as check_name, count(*)::text as result
from public.marketing_campaign_recipients r
where r.status = 'unsubscribed' and r.error_message = 'Unsubscribed before send'
  and not exists (select 1 from public.marketing_unsubscribes u where u.studio_id = r.studio_id and lower(u.email) = lower(r.email));
select 'D4 unsubscribe records' as check_name,
       (select count(*) from public.marketing_unsubscribes) || ' studio / ' || (select count(*) from public.organizer_marketing_unsubscribes) || ' organizer' as result;

-- E. Commercial ARIA / automation email exposure (last 90 days; counts only)
select 'E1 queued/sent automation-family email by key and status' as check_name,
       coalesce(string_agg(template_key || ':' || status || '=' || n, ', ' order by template_key, status), 'none') as result
from (select template_key, status, count(*) n from public.outbound_deliveries
      where (template_key like 'aria\_execution\_%' or template_key like 'automation\_%') and created_at > now() - interval '90 days'
      group by 1, 2) s;
select 'E2 commercial-key emails sent to an address unsubscribed from that studio' as check_name, count(*)::text as result
from public.outbound_deliveries d
where d.status = 'sent'
  and d.template_key in ('aria_execution_aria_low_package_balance', 'aria_execution_aria_stale_active_student',
                         'aria_execution_aria_intro_no_purchase', 'aria_execution_aria_membership_canceling',
                         'automation_low_package_balance', 'automation_no_upcoming_lesson', 'automation_first_lesson_follow_up')
  and exists (select 1 from public.marketing_unsubscribes u where u.studio_id = d.studio_id and lower(u.email) = lower(d.recipient_email));
select 'E3 queued commercial-key email right now (would pass M-0 controls at dispatch)' as check_name, count(*)::text as result
from public.outbound_deliveries
where status = 'queued' and (template_key like 'aria\_execution\_%' or template_key like 'automation\_%');
select 'E4 studios with queued/recent commercial email but an incomplete postal address' as check_name, count(distinct d.studio_id)::text as result
from public.outbound_deliveries d
join public.studios s on s.id = d.studio_id
where (d.template_key like 'aria\_execution\_%' or d.template_key like 'automation\_%')
  and d.created_at > now() - interval '30 days'
  and (coalesce(btrim(s.address_line_1), '') = '' or coalesce(btrim(s.city), '') = '' or coalesce(btrim(s.state), '') = ''
       or coalesce(btrim(s.postal_code), '') = '' or coalesce(btrim(s.country), '') = '');

rollback;
