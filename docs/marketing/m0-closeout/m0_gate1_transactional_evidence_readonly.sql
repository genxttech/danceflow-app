-- Marketing M-0 Gate 1 -- evidence of a genuine TRANSACTIONAL email sent since the PROD stage-1 apply (READ-ONLY).
-- Owner rule (2026-10-14): a row counts only if it was created after 2026-10-14 02:26 UTC, is a successful email AND
-- has a provider message id AND a sent_at. Cron or digest HTTP 200s do not count. Never create activity to satisfy it.
-- Single statement; aggregate counts, template keys and dates only. No recipient, subject or body is selected.
with q as (
  select d.template_key, d.sent_at
  from public.outbound_deliveries d
  where d.channel = 'email'
    and d.created_at > timestamptz '2026-10-14 02:26:00+00'
    and d.status = 'sent'
    and coalesce(d.provider_message_id, '') <> ''
    and d.sent_at is not null
    and not public._mkt_is_commercial_outbound(d.channel, d.template_key, d.payload)
)
select 'G1 qualifying transactional emails (PASS if >= 1)' as check_name, count(*)::text as result from q
union all
select 'G1 earliest / latest sent_at', coalesce(min(sent_at)::text, 'none') || ' / ' || coalesce(max(sent_at)::text, 'none') from q
union all
select 'G1 by template key',
       coalesce((select string_agg(template_key || '=' || n, ', ' order by template_key) from (select template_key, count(*) n from q group by template_key) s), 'none')
union all
select 'G1 freeze still on (expect true)', public.marketing_send_frozen()::text;
