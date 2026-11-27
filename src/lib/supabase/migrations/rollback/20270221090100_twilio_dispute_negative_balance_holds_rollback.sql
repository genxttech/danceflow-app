-- Rollback of 20270221090100_twilio_dispute_negative_balance_holds.sql. Re-runnable (a second run finds nothing to drop and changes nothing).
-- Restores tw4_credit_apply_dispute (the 20261125090000 body) and tw4_credit_set_hold (the 20261122090000 body), drops the negative-credit trigger, the dispute-hold
-- functions and tables, and removes the two alert kinds this migration added.
-- REFUSES (55000) while ANY evidence exists that would be lost: a dispute-hold row (it carries the estimated, unallocated provider dispute fee record and the release notes), a switch change,
-- or an alert of kind credit_dispute / credit_negative (also refused: either function changed since this migration) (history is never deleted or rewritten). An account still on hold with the reason 'dispute' is refused too:
-- after the rollback nothing would know it is a dispute hold. No application rollback is needed first: the application calls no function this file adds.
begin;
set local lock_timeout = '5s';
do $$
declare
  v_new text[] := array['credit_dispute', 'credit_negative'];
  v_name text;
  v_def text;
  v_vals text[];
  v_rows boolean := false;
begin
  -- This file restores two function bodies blind, so it refuses unless each is EXACTLY what 20270221090100 installed (or what this file already restored: it is re-runnable).
  -- Anything else means a later migration changed it; restoring the old body would silently undo that change. CR is ignored (md5 of prosrc with chr(13) removed).
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_credit_apply_dispute(text,text,integer,text,text)'::regprocedure)
       not in ('251d17d60a30b9ad1800fdbc71fee461', 'e3541ee9ce86e59e3db30503c72da4da') then
    raise exception 'dispute hold rollback refused: tw4_credit_apply_dispute is no longer the version 20270221090100 installed; review the later change first' using errcode = '55000';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_credit_set_hold(uuid,boolean,text,uuid)'::regprocedure)
       not in ('909beeb0074685391d2e2af65749372e', '07787632259d7dbd237abea79c43c636') then
    raise exception 'dispute hold rollback refused: tw4_credit_set_hold is no longer the version 20270221090100 installed; review the later change first' using errcode = '55000';
  end if;
  if to_regclass('public.studio_sms_credit_dispute_holds') is not null then
    execute 'select exists (select 1 from public.studio_sms_credit_dispute_holds)' into v_rows;
    if v_rows then
      raise exception 'dispute hold rollback refused: dispute-hold rows exist (fee records and release notes are never deleted)' using errcode = '55000';
    end if;
  end if;
  if to_regclass('public.studio_sms_dispute_hold_switch_log') is not null then
    execute 'select exists (select 1 from public.studio_sms_dispute_hold_switch_log)' into v_rows;
    if v_rows then
      raise exception 'dispute hold rollback refused: the dispute-hold switch has a change history' using errcode = '55000';
    end if;
  end if;
  if exists (select 1 from public.studio_sms_credit_accounts a where a.hold and a.hold_reason = 'dispute') then
    raise exception 'dispute hold rollback refused: an account is on an automatic dispute hold' using errcode = '55000';
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  if exists (select 1 from public.studio_sms_provider_alerts a where a.kind = any (v_new)) then
    raise exception 'dispute hold rollback refused: alert rows use a kind that only 20270221090100 allows; they are never deleted or rewritten' using errcode = '55000';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'dispute hold rollback refused: the alert-kind constraint is missing' using errcode = '55000';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is not null and v_new <@ v_vals then
    v_vals := (select array_agg(x order by x) from unnest(v_vals) x where x <> all (v_new));
    execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
    execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
  end if;
end $$;

drop trigger if exists studio_sms_credit_accounts_negative_alert on public.studio_sms_credit_accounts;

-- 20261125090000 body
create or replace function public.tw4_credit_apply_dispute(p_payment_ref text, p_dispute_id text, p_amount_cents int, p_action text, p_event_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  d public.studio_sms_credit_disputes;
  r jsonb;
  v_amount int;
  v_other_open int;
begin
  if p_dispute_id is null or char_length(btrim(p_dispute_id)) < 3 or p_event_id is null or char_length(btrim(p_event_id)) < 3 or p_action not in ('withdrawn', 'reinstated') then
    raise exception 'invalid dispute event' using errcode = '22023';
  end if;
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and (x.provider_ref = p_payment_ref or x.payment_intent_ref = p_payment_ref) limit 1;
  if t.id is null or t.status <> 'settled' then
    raise exception 'no settled payment for this dispute' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.legal_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  select * into d from public.studio_sms_credit_disputes x where x.topup_id = t.id and x.dispute_id = p_dispute_id;

  if p_action = 'withdrawn' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'invalid dispute amount' using errcode = '22023';
    end if;
    if d.id is not null then
      return jsonb_build_object('replayed', true); -- created, then funds_withdrawn, or a redelivery: one withdrawal per dispute id
    end if;
    -- never take back more than is still unreversed (a refunded payment can also be disputed): the debit is capped, never an error that retries forever.
    -- The dispute's FULL claim is still recorded, so while it is open it keeps counting against what any other dispute of this payment may give back.
    v_amount := greatest(least(p_amount_cents, t.amount_cents - t.refunded_cents - t.disputed_cents), 0);
    insert into public.studio_sms_credit_disputes (topup_id, legal_entity_id, dispute_id, claim_cents, withdrawn_cents)
    values (t.id, t.legal_entity_id, p_dispute_id, p_amount_cents, v_amount);
    if v_amount = 0 then
      return jsonb_build_object('replayed', false, 'capped_to_zero', true);
    end if;
    r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -v_amount, 0, 'dispute_w:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
           left('dispute withdrawn;event=' || p_event_id, 280));
    update public.studio_sms_credit_topups set disputed_cents = disputed_cents + v_amount, reversed_cents = reversed_cents + v_amount where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('dispute;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
    return r;
  end if;

  -- reinstated (the dispute was decided in the studio's favour): only once per dispute id, and never more than the payment minus refunds minus what the other
  -- still-open disputes claim, whatever order the provider's events arrived in
  if d.id is null then
    raise exception 'this dispute has not been recorded for the payment' using errcode = '22023'; -- its withdrawal event has not been processed yet: retried, never dropped
  end if;
  if d.state = 'won' then
    return jsonb_build_object('replayed', true);
  end if;
  select coalesce(sum(x.claim_cents), 0) into v_other_open from public.studio_sms_credit_disputes x where x.topup_id = t.id and x.dispute_id <> p_dispute_id and x.state = 'open';
  v_amount := greatest(least(d.withdrawn_cents, t.amount_cents - t.refunded_cents - v_other_open, t.disputed_cents), 0);
  update public.studio_sms_credit_disputes set state = 'won', reinstated_cents = v_amount, resolved_at = now() where id = d.id;
  if v_amount = 0 then
    return jsonb_build_object('replayed', false, 'capped_to_zero', true);
  end if;
  r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'adjustment', v_amount, 0, 'dispute_r:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
         left('dispute reinstated;event=' || p_event_id, 280));
  update public.studio_sms_credit_topups set disputed_cents = disputed_cents - v_amount, reversed_cents = reversed_cents - v_amount where id = t.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_adjustment', left('dispute reinstated;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
  return r;
end $$;

-- 20261122090000 body
create or replace function public.tw4_credit_set_hold(p_entity_id uuid, p_hold boolean, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4c_lock(p_entity_id);
  if p_hold and (p_reason is null or char_length(btrim(p_reason)) < 5) then
    raise exception 'a hold needs a reason' using errcode = '22023';
  end if;
  update public.studio_sms_credit_accounts set hold = p_hold, hold_reason = case when p_hold then left(btrim(p_reason), 300) else null end where legal_entity_id = p_entity_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_hold', left('hold=' || p_hold, 300));
  return jsonb_build_object('hold', p_hold);
end $$;

revoke all on function public.tw4_credit_apply_dispute(text, text, int, text, text), public.tw4_credit_set_hold(uuid, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.tw4_credit_apply_dispute(text, text, int, text, text), public.tw4_credit_set_hold(uuid, boolean, text, uuid) to service_role;

drop function if exists public.tw4_credit_dispute_holds_list(uuid, uuid);
drop function if exists public.tw4_credit_dispute_hold_release(uuid, uuid, uuid, text);
drop function if exists public._tw4dh_on_reinstated(uuid);
drop function if exists public._tw4dh_on_withdrawn(uuid);
drop function if exists public.tw4_dispute_hold_switch_set(boolean, uuid, text);
drop function if exists public.tw4_dispute_record_switch_set(boolean, uuid, text);
drop function if exists public._tw4dh_auto_hold_on();
drop function if exists public._tw4dh_record_on();
drop function if exists public._tw4dh_switch_on(text);
drop function if exists public._tw4dh_est_provider_fee_cents();
drop function if exists public._tw4dh_negative_alert();
drop table if exists public.studio_sms_credit_dispute_holds;
drop function if exists public._tw4dh_guard();
drop table if exists public.studio_sms_dispute_hold_switch_log;
commit;
