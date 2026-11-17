-- TW-4F pricing integrity: expire price proposals that nobody decided before their expiry. GIT-ONLY: not applied anywhere. Apply this SQL before the app.
--
-- Why: a price proposal is "pending" until a person approves or rejects it. Expiry was only ever written lazily (when someone proposes for the same kind or
-- opens the request). A proposal that nobody touches again stays 'pending' forever and, 48 hours after its expires_at, tw4_price_verify reports it as a
-- critical request_anomaly, so the scheduled price monitor answers 500 on every tick. Nothing was wrong with the price list: the proposals simply were never
-- closed. (Six proposals from 2026-11-12 were in exactly this state on 2026-11-16.)
--
-- What this adds: public.tw4_price_sweep_expired(), service-role only. It moves a pending request whose expires_at has passed to 'expired' using the SAME
-- transition, the SAME status shape and the SAME guard flag as the existing lazy expiry (decided_by stays null: the system decided; decided_at and a
-- decision_note are written). It cannot approve, reject, apply or publish anything, never touches an 'approved' or 'applied' request, never touches a request
-- that has not expired, and never writes the price list. It returns counts and request ids only. Idempotent: a second call finds nothing.
--
-- It does NOT change tw4_price_verify. A pending request more than 48 hours past expiry is still an anomaly: the monitor stays detect-only, and the sweep
-- is a separate scheduled act (src/app/api/cron/sms-price-sweep, not registered in vercel.json).

begin;

do $$
begin
  if to_regclass('public.studio_sms_price_change_requests') is null or to_regprocedure('public._tw4pricedual_guard()') is null then
    raise exception '20270219090000 requires 20270210090000 / 20270210100000 (price dual control)';
  end if;
end $$;

create or replace function public.tw4_price_sweep_expired()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  -- one sweeper at a time; a concurrent call simply finds nothing left
  perform pg_advisory_xact_lock(hashtextextended('tw4_price_sweep_expired', 0));
  perform set_config('tw4.pricedual_write', 'on', true);
  with s as (
    update public.studio_sms_price_change_requests q
       set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time (swept)'
     where q.status = 'pending' and q.expires_at <= clock_timestamp()
    returning q.id
  )
  select coalesce(array_agg(s.id order by s.id), '{}') into v_ids from s;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('expired', coalesce(array_length(v_ids, 1), 0), 'request_ids', to_jsonb(v_ids));
end $$;

revoke all on function public.tw4_price_sweep_expired() from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_sweep_expired() to service_role;

do $$
begin
  if exists (select 1 from information_schema.routine_privileges where specific_schema = 'public' and routine_name = 'tw4_price_sweep_expired' and grantee in ('PUBLIC', 'anon', 'authenticated')) then
    raise exception 'price sweep postcondition failed: unexpected grants';
  end if;
end $$;

commit;
