-- Rollback of 20261205090000 (usage reconciliation). Restores tw4_usage_settle and tw4_usage_due as of 20261201090000 and drops the run, checkpoint and
-- recovery objects and the attempt's reconciliation columns.
-- REFUSES once any reconciliation run, inbound checkpoint, inbound recovery, or attempt carrying reconciliation evidence (identity-checked evidence, a
-- recorded evidence failure, an escalation) or attempt transition history exists: from then on the stance is forward-fix only. Roll the app back first (unset SMS_USAGE_RECONCILER).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_reconcile_runs') is null then
    raise exception 'usage-reconciliation rollback: not applied';
  end if;
  -- no writer may add evidence between this check and the drops below
  lock table public.studio_sms_reconcile_runs, public.studio_sms_inbound_scan_cursors, public.studio_sms_inbound_recoveries, public.studio_sms_inbound_unresolved,
    public.studio_sms_usage_attempt_events, public.studio_sms_usage_attempts in access exclusive mode;
  if exists (select 1 from public.studio_sms_reconcile_runs)
     or exists (select 1 from public.studio_sms_inbound_scan_cursors)
     or exists (select 1 from public.studio_sms_inbound_recoveries)
     or exists (select 1 from public.studio_sms_inbound_unresolved)
     or exists (select 1 from public.studio_sms_usage_attempt_events)
     or exists (select 1 from public.studio_sms_usage_attempts where evidence_failures > 0 or evidence_error_code is not null or evidence_next_at is not null
                                                                 or evidence_created_at is not null or escalated_at is not null) then
    raise exception 'usage-reconciliation rollback refused: reconciliation evidence exists' using errcode = '55000';
  end if;
end $$;

-- as of 20261201090000
-- evidence from the provider's Message resource. Charge table on STATUS; the provider price is cost evidence only.
create or replace function public.tw4_usage_settle(p_attempt_id uuid, p_evidence jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_usage_attempts;
  v_status text := lower(coalesce(p_evidence->>'status', ''));
  v_sid text := p_evidence->>'sid';
  v_account text := p_evidence->>'account_sid';
  v_segments int;
  v_media int;
  v_price numeric;
  v_unit text := upper(nullif(btrim(coalesce(p_evidence->>'price_unit', '')), ''));
  v_review text;
  v_cents int;
begin
  a := public._tw4us_lock_attempt(p_attempt_id);
  if a.state = 'settled' then
    return jsonb_build_object('outcome', 'settled', 'charged_cents', a.charged_cents, 'replayed', true);
  end if;
  if a.state <> 'submitted' or a.provider_sid is null then
    raise exception 'only a submitted text is settled from evidence (state %)', a.state using errcode = '22023';
  end if;
  if v_sid is distinct from a.provider_sid or v_account is distinct from a.account_sid then
    raise exception 'the evidence is for another message or account' using errcode = '42501';
  end if;
  if coalesce(p_evidence->>'num_segments', '') ~ '^[0-9]{1,3}$' then v_segments := (p_evidence->>'num_segments')::int; end if;
  if coalesce(p_evidence->>'num_media', '') ~ '^[0-9]{1,3}$' then v_media := (p_evidence->>'num_media')::int; end if;
  if coalesce(p_evidence->>'price', '') ~ '^-?[0-9]{1,6}(\.[0-9]{1,10})?$' then v_price := abs((p_evidence->>'price')::numeric) * 1000000; end if;
  update public.studio_sms_usage_attempts
     set evidence_status = left(v_status, 40), evidence_segments = v_segments, evidence_media = v_media, evidence_price_micros = v_price,
         evidence_price_unit = left(v_unit, 10), evidence_at = clock_timestamp(), last_reconciled_at = clock_timestamp()
   where id = a.id;

  if v_status in ('failed', 'canceled') then
    perform public._tw4us_release_reservation(a, 'not_charged:' || v_status);
    update public.studio_sms_usage_attempts set state = 'settled', charged_cents = 0, closed_at = clock_timestamp() where id = a.id;
    update public.sms_message_logs set status = 'failed', failed_at = now(), updated_at = now() where id = a.message_log_id;
    return jsonb_build_object('outcome', 'settled', 'charged_cents', 0, 'replayed', false);
  elsif a.provider_sid like 'MM%' or coalesce(v_media, 0) > 0 then
    v_review := 'multimedia message';
  elsif v_price is not null and v_unit is distinct from 'USD' then
    v_review := 'price not in USD';
  elsif v_status in ('delivered', 'undelivered', 'read') or (v_status = 'sent' and a.submitted_at < now() - interval '72 hours') then
    if v_segments is null or v_segments < 1 or v_segments > 10 or v_segments > a.estimated_segments + 2 then
      v_review := 'segment count outside the expected range';
    else
      v_cents := public._tw4us_charge(a, v_segments, 'evidence:' || v_status);
      update public.studio_sms_usage_attempts set state = 'settled', charged_cents = v_cents, closed_at = clock_timestamp() where id = a.id;
      update public.sms_message_logs set status = case when v_status = 'undelivered' then 'failed' when v_status = 'sent' then 'sent' else 'delivered' end,
             segment_count = v_segments, delivered_at = case when v_status in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end, updated_at = now()
       where id = a.message_log_id;
      return jsonb_build_object('outcome', 'settled', 'charged_cents', v_cents, 'replayed', false);
    end if;
  elsif v_status in ('accepted', 'scheduled', 'queued', 'sending', 'sent') then
    return jsonb_build_object('outcome', 'pending', 'replayed', false);
  else
    v_review := 'unrecognized provider status';
  end if;
  update public.studio_sms_usage_attempts set state = 'review', review_reason = v_review, closed_at = null where id = a.id;
  return jsonb_build_object('outcome', 'review', 'reason', v_review, 'replayed', false);
end $$;

-- the reconciler's work list: submitted texts not read in the last 10 minutes (oldest first), with what is needed to read the evidence
create or replace function public.tw4_usage_due(p_limit int default 100)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('attempt_id', x.id, 'account_sid', x.account_sid, 'provider_sid', x.provider_sid) order by x.last_reconciled_at nulls first, x.submitted_at)
    from (select * from public.studio_sms_usage_attempts y
           where y.state = 'submitted' and y.provider_sid is not null and (y.last_reconciled_at is null or y.last_reconciled_at < now() - interval '10 minutes')
           order by y.last_reconciled_at nulls first, y.submitted_at limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;
comment on function public.tw4_usage_due(int) is null;

drop function public.tw4_usage_reconcile_overview(uuid, int);
drop function public.tw4_inbound_scan_advance(uuid, text, timestamptz);
drop function public.tw4_inbound_note_unresolved(uuid, text, text, text);
drop function public.tw4_inbound_unrecorded(text, text[]);
drop function public.tw4_inbound_recover(uuid, text, jsonb);
drop function public.tw4_inbound_scan_targets(int);
drop function public.tw4_usage_escalate(uuid, int);
drop function public.tw4_usage_evidence_failed(uuid, text, boolean);
drop function public.tw4_usage_release_stale(uuid, int);
drop function public.tw4_reconcile_run_finish(uuid, text, jsonb, text);
drop function public.tw4_reconcile_run_begin(text, text, int);

drop trigger studio_sms_usage_attempts_90_events on public.studio_sms_usage_attempts;
drop table public.studio_sms_usage_attempt_events;
drop function public._tw4ur_attempt_event();
drop index public.studio_sms_usage_attempts_due;
alter table public.studio_sms_usage_attempts drop column escalated_at;
alter table public.studio_sms_usage_attempts drop column evidence_created_at;
alter table public.studio_sms_usage_attempts drop column evidence_next_at;
alter table public.studio_sms_usage_attempts drop column evidence_error_code;
alter table public.studio_sms_usage_attempts drop column evidence_failures;

drop table public.studio_sms_inbound_unresolved;
drop table public.studio_sms_inbound_recoveries;
drop table public.studio_sms_inbound_scan_cursors;
drop table public.studio_sms_reconcile_runs;

drop function public._tw4ur_instant(text);
drop function public._tw4ur_account_of(uuid, text);
drop function public._tw4ur_fence(uuid, text);
drop function public._tw4ur_guard();

-- privileges as of 20261201090000
revoke all on function public.tw4_usage_settle(uuid, jsonb), public.tw4_usage_due(int) from public, anon, authenticated;
grant execute on function public.tw4_usage_settle(uuid, jsonb), public.tw4_usage_due(int) to service_role;

commit;
