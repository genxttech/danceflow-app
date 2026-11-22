with exp(kind,pm,cc,cm,cost_c) as (values
 ('sms_usage',17000,null,12695,null),
 ('sms_inbound',15500,null,10205,null),
 ('brand_low_volume',null,700,null,450),
 ('campaign_vetting',null,2100,null,1500),
 ('monthly_low_volume',null,225,null,150),
 ('number',null,165,null,115)),
req as (select * from public.studio_sms_price_change_requests where status='pending' and requested_at>now()-interval '3 days')
select jsonb_build_object(
 'now',now(),
 'pending_total',(select count(*) from public.studio_sms_price_change_requests where status='pending'),
 'matched',(select count(*) from exp e join req r on r.kind=e.kind
    and (e.pm is null or r.price_micros=e.pm) and (e.cm is null or r.cost_micros=e.cm)
    and (e.cc is null or r.customer_price_cents=e.cc) and (e.cost_c is null or r.provider_cost_cents=e.cost_c)),
 'signable_now',(select count(*) from req where cooling_until<=now() and expires_at>now()),
 'min_cooling_until',(select min(cooling_until) from req),
 'min_expires_at',(select min(expires_at) from req),
 'min_minutes_left',(select round(extract(epoch from (min(expires_at)-now()))/60) from req),
 'price_rows',(select count(*) from public.studio_sms_price_list),
 'verify',public.tw4_price_verify(),
 'frozen',(select frozen from public.studio_sms_price_auth_config),
 'recovery_hold',(select recovery_hold from public.studio_sms_price_auth_config),
 'mode',(select mode from public.studio_sms_price_auth_config),
 'primary_keys',(select count(*) from public.studio_sms_price_credentials where role='primary'),
 'monitor_last',(select max(recorded_at) from public.studio_sms_price_monitor_evidence where kind='run'),
 'monitor_findings_since_filing',(select coalesce(sum((payload::jsonb->>'nf')::int),0) from public.studio_sms_price_monitor_evidence where kind='run' and recorded_at>='2026-11-20 20:06:00+00')
)::text as r;
