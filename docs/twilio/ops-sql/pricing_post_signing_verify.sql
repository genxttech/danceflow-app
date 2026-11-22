select jsonb_build_object(
 'now',now(),
 'pending',(select count(*) from public.studio_sms_price_change_requests where status='pending'),
 'price_rows',(select count(*) from public.studio_sms_price_list),
 'prices',(select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from public.studio_sms_price_list p),
 'verify',public.tw4_price_verify(),
 'frozen',(select frozen from public.studio_sms_price_auth_config),
 'monitor_last',(select max(recorded_at) from public.studio_sms_price_monitor_evidence where kind='run'),
 'monitor_findings_2h',(select coalesce(sum((payload::jsonb->>'nf')::int),0) from public.studio_sms_price_monitor_evidence where kind='run' and recorded_at>now()-interval '2 hours')
)::text as r;
