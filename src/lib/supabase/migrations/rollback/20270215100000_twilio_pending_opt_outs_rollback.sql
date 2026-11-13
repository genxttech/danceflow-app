-- Rollback for 20270215100000_twilio_pending_opt_outs.sql. Roll the app back first: the webhook and the notification sender call these functions and
-- tolerate their absence (the webhook then answers a failed STOP with 503 as before), but opt-outs still waiting in the table are lost on drop, so apply
-- them first: select public.sms_pending_opt_out_apply(200) until 'applied' is 0 and no open row remains.
do $$
begin
  if to_regclass('public.studio_sms_pending_opt_outs') is not null
     and exists (select 1 from public.studio_sms_pending_opt_outs where applied_at is null and superseded_at is null) then
    raise exception 'Refusing to drop: open pending opt-outs exist. Run sms_pending_opt_out_apply first.';
  end if;
end $$;
drop function if exists public.sms_pending_opt_out_apply(integer);
drop function if exists public.sms_pending_opt_out_supersede(uuid, text);
drop function if exists public.sms_pending_opt_out_record(uuid, text, text);
drop table if exists public.studio_sms_pending_opt_outs;
