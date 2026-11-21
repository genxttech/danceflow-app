-- Marketing M-0 closeout -- STATE RECONCILIATION (READ-ONLY, single statement, aggregates and schema metadata only).
-- Run with: sb.sh prod-read (or dev-read) <this file>. sb.sh wraps it in BEGIN READ ONLY / ROLLBACK and returns the
-- last statement only, so everything is one UNION ALL. No email, name, token or message content is selected.
select check_name, result from (
select 1 as ord, 'S1 freeze row' as check_name,
  coalesce((select 'frozen=' || frozen::text || ' changed_at=' || changed_at::text || ' reason=' || coalesce(reason,'')
            from public.marketing_send_controls where id), 'NO ROW') as result
union all
select 2, 'S2 freeze events (count / latest)',
  (select count(*)::text || ' / ' || coalesce(max(changed_at)::text,'none') from public.marketing_send_control_events)
union all
select 3, 'S3 stage-1 functions present (marketing_ / _mkt_)',
  (select count(*)::text from pg_proc where pronamespace='public'::regnamespace and (proname like 'marketing\_%' or proname like '\_mkt\_%'))
union all
select 4, 'S4 stage-1 tables present',
  (select string_agg(t, ',' order by t) from unnest(array['marketing_email_suppressions','marketing_message_unsubscribe_tokens','marketing_test_sends','marketing_send_controls','marketing_send_control_events']) t where to_regclass('public.'||t) is not null)
union all
select 5, 'S5 M-0 named policies (stage 1)',
  coalesce((select string_agg(tablename||'.'||policyname, ' | ' order by tablename, policyname) from pg_policies
   where schemaname='public' and policyname like 'm0 %'),'none')
union all
select 6, 'S6 STAGE-2 INDICATOR: client write policies still present (stage 2 drops these)',
  coalesce((select string_agg(tablename||'.'||policyname, ' | ' order by tablename, policyname) from pg_policies
   where schemaname='public' and policyname in ('studio staff manage marketing campaign recipients','Organizer users can manage organizer marketing recipients','Platform admins can manage organizer marketing recipients','outbound_deliveries_insert','outbound_deliveries_update')),'none (stage 2 applied?)')
union all
select 7, 'S7 STAGE-2 INDICATOR: anon/authenticated write grants on recipients + outbound_deliveries',
  coalesce((select string_agg(table_name||':'||grantee||':'||privilege_type, ',' order by table_name, grantee, privilege_type)
   from information_schema.role_table_grants
   where table_schema='public' and table_name in ('marketing_campaign_recipients','organizer_marketing_campaign_recipients','outbound_deliveries')
     and grantee in ('anon','authenticated','PUBLIC') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),'none (stage 2 applied?)')
union all
select 8, 'S8 unsubscribe_marketing_recipient execute grantees (stage 2 leaves service_role only)',
  coalesce((select string_agg(distinct grantee, ',') from information_schema.routine_privileges
   where routine_schema='public' and routine_name='unsubscribe_marketing_recipient'),'none')
union all
select 9, 'S9 claim_outbound_deliveries body md5',
  coalesce((select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc where oid=to_regprocedure('public.claim_outbound_deliveries(uuid,integer,integer)')),'MISSING')
union all
select 10, 'C1 studio campaigns by status', coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from public.marketing_campaigns group by status) s),'none')
union all
select 11, 'C2 organizer campaigns by status', coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from public.organizer_marketing_campaigns group by status) s),'none')
union all
select 12, 'C3 studio recipients by status', coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from public.marketing_campaign_recipients group by status) s),'none')
union all
select 13, 'C4 organizer recipients by status', coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from public.organizer_marketing_campaign_recipients group by status) s),'none')
union all
select 14, 'C5 unsubscribe records (studio / organizer)', (select count(*) from public.marketing_unsubscribes)||' / '||(select count(*) from public.organizer_marketing_unsubscribes)
union all
select 15, 'C6 platform suppressions / test sends / message unsubscribe tokens',
  (select count(*) from public.marketing_email_suppressions)||' / '||(select count(*) from public.marketing_test_sends)||' / '||(select count(*) from public.marketing_message_unsubscribe_tokens)
union all
select 16, 'C7 campaigns stuck in sending (studio / organizer)',
  (select count(*) from public.marketing_campaigns where status='sending')||' / '||(select count(*) from public.organizer_marketing_campaigns where status='sending')
union all
select 17, 'C8 recipient rows in a claim/attempt state (sending, delivery_unknown, or first_attempt_at set)',
  (select count(*) from public.marketing_campaign_recipients where status in ('sending','delivery_unknown') or first_attempt_at is not null)||' studio / '||
  (select count(*) from public.organizer_marketing_campaign_recipients where status in ('sending','delivery_unknown') or first_attempt_at is not null)||' organizer'
union all
select 18, 'C9 recipient rows created AFTER the freeze (expect 0 while frozen)',
  (select count(*) from public.marketing_campaign_recipients r, public.marketing_send_controls c where c.id and r.created_at > c.changed_at)||' studio / '||
  (select count(*) from public.organizer_marketing_campaign_recipients r, public.marketing_send_controls c where c.id and r.created_at > c.changed_at)||' organizer'
union all
select 19, 'C10 legacy organizer-unsubscribe-page signature rows created after 2026-10-14 (expect 0 if the M-0 app is live)',
  (select count(*) from public.organizer_marketing_campaign_recipients r where r.status='unsubscribed' and r.error_message='Recipient unsubscribed from organizer marketing' and r.created_at > '2026-10-14')::text
union all
select 20, 'C11 automation-family outbound rows by status (last 30 days)',
  coalesce((select string_agg(status||'='||n, ', ') from (select status, count(*) n from public.outbound_deliveries where (template_key like 'aria\_execution\_%' or template_key like 'automation\_%') and created_at > now()-interval '30 days' group by status) s),'none')
union all
select 21, 'C12 duplicate recipient tokens / non-lowercase studio tokens (expect 0 / 0)',
  ((select count(*) from (select unsubscribe_token from public.marketing_campaign_recipients where unsubscribe_token is not null group by 1 having count(*)>1) d)
  +(select count(*) from (select unsubscribe_token from public.organizer_marketing_campaign_recipients where unsubscribe_token is not null group by 1 having count(*)>1) d))::text
  ||' / '||(select count(*) from public.marketing_campaign_recipients where unsubscribe_token<>lower(unsubscribe_token))::text
union all
select 22, 'C13 duplicate unsubscribe records per scope+lower(email) (expect 0)',
  ((select count(*) from (select studio_id, lower(email) from public.marketing_unsubscribes group by 1,2 having count(*)>1) d)
  +(select count(*) from (select organizer_id, lower(email) from public.organizer_marketing_unsubscribes group by 1,2 having count(*)>1) d))::text
union all
select 23, 'C14 campaigns whose ENT-1 recorded usage exceeds current sent rows (pre-M-0 C2 damage)',
  (select count(*)::text from (
     select e.related_id, sum(e.quantity) used,
       coalesce((select count(*) from public.marketing_campaign_recipients r where r.campaign_id=e.related_id and r.status in ('sent','delivery_unknown')),0)
      +coalesce((select count(*) from public.organizer_marketing_campaign_recipients r where r.campaign_id=e.related_id and r.status in ('sent','delivery_unknown')),0) sent_now
     from public.usage_events e where e.feature_key='email_campaign_recipient' group by e.related_id) x where used>sent_now)
) q order by ord;
