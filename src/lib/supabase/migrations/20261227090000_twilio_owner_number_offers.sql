-- 20261227090000_twilio_owner_number_offers.sql
-- TW-4F J3 (tracker O-3): the studio OWNER's view of the texting numbers DanceFlow offered, the owner's own open approval, and whether approving can lead to a
-- purchase, so the owner can choose one number and approve its published monthly price through tw4_num_select_as_owner (20261208, unchanged).
--   * public.get_studio_sms_number_offers(p_studio_id): derives the caller from auth.uid(), never from an argument. Allowed: an ACTIVE studio_owner of THAT studio
--     only. Everyone else (studio admin, front desk, another studio's owner, platform admins, anyone unauthenticated, the service role) is refused (42501).
--   * Returns only what the owner decides on: the offered numbers (E.164, locality, region: the numbers are what the owner chooses between), the offer's id and
--     expiry (the approval binds to them), the PUBLISHED customer price the owner will be charged per month, the funding path, the owner's own open approval
--     (number, expiry, the stored approval statement) and a coarse reason when approving cannot lead to a purchase. Never a Twilio SID, an account, provider cost,
--     a balance, the search parameters, an evidence digest or anything about another studio.
--   * Read-only (STABLE): nothing is written, nothing calls Twilio. Offers come only from the administrator's runner (tw4_num_offer_record).
--
-- Contract (version 1):
--   { available: false }
--   { available: true, version: 1,
--     step_open: bool,                                 -- onboarding at the number step, campaign verified, active subaccount, no live number to release first
--     price: { published: bool, monthly_cents: int|null },   -- the published customer price (null when not published: nothing can be approved)
--     funding_mode: credit_recurring | pilot,
--     pilot_ceiling_reached: bool,                     -- pilot only: the business's pilot ceiling cannot take another number's rent
--     offer: null | { offer_id: uuid, expires_at: timestamptz, numbers: [{ e164, locality, region }] },
--     approval: null | { selection_id: uuid, e164, status: open | expired, expires_at, statement },   -- any still-'approved' selection of the studio
--     blocker: none | not_open | unpriced | current_number | pilot_ceiling }
--
-- The approval itself stays in tw4_num_select_as_owner / tw4_num_withdraw_as_owner. Note for reviewers: those functions do not check the pilot ceiling or funding
-- at approval time; the purchase does (tw4_num_begin -> _tw4num_reserve, TW007). This read reports the ceiling so the owner is not asked to approve a number that
-- cannot be bought, and the application refuses to submit an approval while it is reached.
-- Requires 20261208 (R2b). Rollback: rollback/20261227090000_twilio_owner_number_offers_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_number_offers') is null or to_regclass('public.studio_sms_number_selections') is null then
    raise exception 'J3 precondition failed: 20261208 (R2b) must be applied first';
  end if;
  if to_regprocedure('public._sms_onb_access_enabled(uuid)') is null or to_regprocedure('public._tw4num_account(uuid)') is null
     or to_regprocedure('public._tw4num_campaign(uuid)') is null or to_regprocedure('public._tw4num_price(text)') is null
     or to_regprocedure('public._tw4sr_latest(uuid)') is null or to_regprocedure('public._tw4num_taken(text, uuid)') is null or to_regprocedure('public._tw4sr_lock(uuid)') is null
     or to_regprocedure('public.tw4_num_select_as_owner(uuid, uuid, text, integer)') is null or to_regprocedure('public.tw4_num_withdraw_as_owner(uuid, uuid, text)') is null then
    raise exception 'J3 precondition failed: a required helper is missing';
  end if;
end $$;

create or replace function public.get_studio_sms_number_offers(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_price int;
  v_mode text := 'credit_recurring';
  v_ceiling bigint;
  v_used bigint;
  v_ceiling_reached boolean := false;
  v_latest public.studio_sms_billed_senders;
  v_current_number boolean := false;
  v_campaign boolean := false;
  v_open boolean := false;
  v_offer public.studio_sms_number_offers;
  v_sel public.studio_sms_number_selections;
  v_blocker text := 'none';
begin
  -- the owner of THIS studio, and nobody else (the role comes from the database, never from the caller)
  if auth.uid() is null or not exists (select 1 from public.user_studio_roles r where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    return jsonb_build_object('available', false);
  end if;

  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  v_account := public._tw4num_account(p_studio_id);
  v_price := public._tw4num_price('number');
  if v_entity is not null then
    select y.ceiling_cents into v_ceiling from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
    if found then
      v_mode := 'pilot';
      -- the same sum _tw4num_reserve checks at purchase time
      select coalesce(sum(r.amount_cents), 0) into v_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
      v_ceiling_reached := v_price is not null and v_used + v_price > v_ceiling;
    end if;
  end if;
  v_latest := public._tw4sr_latest(p_studio_id);
  v_current_number := v_latest.id is not null and v_latest.status <> 'released' and v_latest.phone_number_sid is not null;
  if o.id is not null and o.state = 'campaign_pending' and v_account is not null then
    v_campaign := (public._tw4num_campaign(p_studio_id)).id is not null;
  end if;
  v_open := v_campaign and not v_current_number;
  v_blocker := case when not v_campaign then 'not_open' when v_current_number then 'current_number' when v_price is null then 'unpriced'
                    when v_ceiling_reached then 'pilot_ceiling' else 'none' end;

  if v_open then
    -- the newest live offer on the business's ACTIVE subaccount (an offer from another account cannot be approved)
    select * into v_offer from public.studio_sms_number_offers f where f.studio_id = p_studio_id and f.twilio_account_sid = v_account and f.expires_at > now()
     order by f.created_at desc, f.id limit 1;
  end if;
  -- the owner's approval that is still 'approved' for this studio: the same per-studio rule tw4_num_select applies (one open approval per location), so an approval
  -- the owner can no longer see could never block a new one. Expired ones are shown as such until they are replaced; withdrawal needs the id.
  select * into v_sel from public.studio_sms_number_selections s where s.studio_id = p_studio_id and s.status = 'approved' order by s.approved_at desc, s.id limit 1;

  return jsonb_build_object(
    'available', true,
    'version', 1,
    'step_open', v_open,
    'price', jsonb_build_object('published', v_price is not null, 'monthly_cents', v_price),
    'funding_mode', v_mode,
    'pilot_ceiling_reached', v_ceiling_reached,
    'offer', case when v_offer.id is null then null else jsonb_build_object('offer_id', v_offer.id, 'expires_at', v_offer.expires_at,
        'numbers', coalesce((select jsonb_agg(jsonb_build_object('e164', c ->> 'e164', 'locality', c ->> 'locality', 'region', c ->> 'region') order by c ->> 'e164')
                               from jsonb_array_elements(v_offer.candidates) c
                              where c ->> 'e164' ~ '^\+1[2-9][0-9]{9}$' and not public._tw4num_taken(c ->> 'e164', p_studio_id)), '[]'::jsonb)) end,
    'approval', case when v_sel.id is null then null else jsonb_build_object('selection_id', v_sel.id, 'e164', v_sel.e164,
        'status', case when v_sel.expires_at > now() then 'open' else 'expired' end, 'expires_at', v_sel.expires_at, 'statement', v_sel.statement) end,
    'blocker', v_blocker);
end $$;

-- fingerprint precheck: replace only the body 20261222 installed (or this migration's own, on a re-apply); anything else was changed elsewhere and must be reconciled first
do $$
begin
  if to_regprocedure('public.get_studio_sms_texting_status(uuid)') is null or (select md5(p.prosrc) from pg_proc p where p.oid = 'public.get_studio_sms_texting_status(uuid)'::regprocedure) not in ('ced244161431a8988b0a09789fab95b6', '972869a5d27d9342d1b93bb0978d7ece') then
    raise exception 'J3 precondition failed: get_studio_sms_texting_status is not the 20261222 body';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- J2 follow-up (owned by this slice): get_studio_sms_texting_status (20261222) maps the activation checklist items added since then to owner areas instead of
-- "other": usage_reconciler_ready (20261218/20261219) -> monitoring; pilot_ki1_redecided (#298, mapped ahead of time) -> review ("a DanceFlow review").
-- The body is 20261222's verbatim apart from those two mapping lines; the privileges are unchanged (create or replace keeps the grants).
-- Rollback: rollback/20261227090000 restores the 20261222 body.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.get_studio_sms_texting_status(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_p public.studio_sms_num_operations;
  v_res text;
  v_sel public.studio_sms_number_selections;
  v_num text := 'not_started';
  v_display text := null;
  v_selection text := 'none';
  v_s public.studio_sms_billed_senders;
  v_v public.studio_sms_sender_verifications;
  v_sender text := 'not_ready';
  v_cmp public.studio_sms_compliance_checks;
  v_compliance text := 'pending';
  v_items jsonb;
  v_activation jsonb := null;
  v_fees jsonb;
  v_paused boolean := false;
  v_unexpected boolean := false;
  v_cur text;
  v_nxt text;
  v_account text;
  v_ms_sid text;
  v_qe_sid text;
begin
  -- the owner of THIS studio, and nobody else (the role comes from the database, never from the caller)
  if auth.uid() is null or not exists (select 1 from public.user_studio_roles r where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not public._sms_onb_access_enabled(p_studio_id) then
    return jsonb_build_object('available', false);
  end if;

  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';

  if o.id is not null then
    -- the business's ACTIVE subaccount and R2a's provider-confirmed service and campaign on it (null when not confirmed): evidence on another account,
    -- service or campaign is history, never this location's current state
    v_account := public._tw4num_account(p_studio_id);
    v_ms_sid := (public._tw4num_service(p_studio_id)).provider_sid;
    v_qe_sid := (public._tw4num_campaign(p_studio_id)).provider_sid;
    -- number: the newest live purchase of THIS onboarding on the active subaccount, then the owner's selection made during it, then a live offer
    select * into v_p from public.studio_sms_num_operations x
     where x.studio_id = p_studio_id and x.onboarding_id = o.id and x.op_kind = 'number_purchase' and x.superseded_at is null and x.twilio_account_sid = v_account
       -- an attempt older than a retired (superseded) purchase is history: it never resurfaces as this location's current number
       and x.attempt > coalesce((select max(y.attempt) from public.studio_sms_num_operations y where y.onboarding_id = o.id and y.op_kind = 'number_purchase' and y.superseded_at is not null), 0)
     order by x.attempt desc limit 1;
    select * into v_sel from public.studio_sms_number_selections s where s.studio_id = p_studio_id and s.approved_at >= o.created_at order by s.approved_at desc, s.id limit 1;
    v_selection := case when v_sel.id is null then 'none' when v_sel.status = 'consumed' then 'used' when v_sel.status = 'withdrawn' then 'withdrawn'
                        when v_sel.expires_at <= now() then 'expired' else 'open' end;
    if v_p.id is not null and v_p.status = 'succeeded' then
      select r.status into v_res from public.studio_sms_num_resources r where r.operation_id = v_p.id;
      if v_res = 'owned' then
        v_num := 'secured';
        v_display := '***-***-' || right(v_p.e164, 4);   -- masked, and only once a provider read confirmed ownership
      elsif v_res = 'mismatch' then
        v_num := 'attention';
      else
        v_num := 'purchasing';                          -- the purchase call returned; the provider read has not confirmed it yet
      end if;
    elsif v_p.id is not null and v_p.status in ('in_flight', 'unknown_outcome') then
      v_num := 'purchasing';
    elsif v_selection = 'open' then
      v_num := 'selected';
    elsif v_p.id is not null and v_p.status in ('failed', 'abandoned') then
      v_num := 'failed';
    elsif exists (select 1 from public.studio_sms_number_offers f where f.studio_id = p_studio_id and f.expires_at > now()) then
      v_num := 'options_available';
    end if;

    -- sender: verified and current (the PR #249 readiness), else the latest sender's own verification
    if (public._tw4sr_ready_core(p_studio_id)).id is not null then
      v_sender := 'ready';
    else
      v_s := public._tw4sr_latest(p_studio_id);
      if v_s.id is not null and v_s.status in ('pending', 'approved') then
        select * into v_v from public.studio_sms_sender_verifications x where x.studio_id = p_studio_id and x.outcome in ('verified', 'failed') order by x.seq desc limit 1;
        v_sender := case when v_v.id is not null and v_v.outcome = 'failed' and v_v.created_at >= v_s.created_at then 'failed_verification' else 'verifying' end;
      end if;
    end if;

    -- compliance: the latest provider validation and DanceFlow's opt-out attestation, both for the CURRENT account, service and campaign (the same predicates as
    -- the activation checklist minus freshness, which stays the checklist's job); a validation of anything else is history and reads pending
    select * into v_cmp from public.studio_sms_compliance_checks c where c.studio_id = p_studio_id order by c.created_at desc limit 1;
    v_compliance := case
      when v_cmp.id is null or v_cmp.twilio_account_sid is distinct from v_account or v_cmp.messaging_service_sid is distinct from v_ms_sid
           or v_cmp.campaign_sid is distinct from v_qe_sid then 'pending'
      when v_cmp.outcome = 'failed' then 'attention'
      when exists (select 1 from public.studio_sms_optout_attestations a where a.studio_id = p_studio_id and a.twilio_account_sid = v_account
                     and a.messaging_service_sid = v_ms_sid and a.campaign_sid = v_qe_sid) then 'complete'
      else 'pending' end;

    -- the activation checklist, reduced to owner areas (no item detail: it carries internal codes). Evaluated only once the location reached activation:
    -- before that it says nothing the stages above do not, and it is the costliest part of this read.
    if o.state in ('ready_for_activation', 'active', 'suspended') then
    begin
      v_items := public._tw4act_items(p_studio_id);
      if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
        raise exception 'empty checklist';   -- caught below: no checklist is not a passed one
      end if;
      select jsonb_build_object('ready', bool_and(g.ok), 'checklist', jsonb_agg(jsonb_build_object('area', g.area, 'ok', g.ok) order by g.ord))
        into v_activation
        from (select a.area, a.ord, bool_and(coalesce((i ->> 'ok')::boolean, false)) as ok
                from jsonb_array_elements(v_items) i
                cross join lateral (select case
                  when i ->> 'id' in ('subaccount_active', 'service_ready', 'campaign_verified') then 'provider'
                  when i ->> 'id' in ('number_owned', 'number_attached') then 'number'
                  when i ->> 'id' = 'sender_ready' then 'sender'
                  when i ->> 'id' in ('opt_out_attested', 'compliance_passed', 'inbound_route_pinned') then 'compliance'
                  when i ->> 'id' in ('rfl_ready', 'funding_continuity') then 'billing'
                  when i ->> 'id' in ('inventory_reconciled', 'usage_reconciler_ready') then 'monitoring'
                  when i ->> 'id' = 'pilot_ki1_redecided' then 'review'
                  else 'other' end as area) a0
                cross join lateral (select a0.area, array_position(array['provider', 'number', 'sender', 'compliance', 'billing', 'monitoring', 'review', 'other'], a0.area) as ord) a
               group by a.area, a.ord) g;
    exception when others then
      v_activation := null;   -- an unreadable checklist is not shown as progress
    end;
    end if;
  end if;

  -- recurring provider-fee coverage of THIS location's live resources. An unexpected resource is DanceFlow's to settle and never asks the owner for anything:
  -- a campaign orphan (registered from it, or carrying its SID while it is not closed) and a number orphan of the business (open, acknowledged or adopted) are left
  -- out; a resource an administrator registered by hand is never presented as the owner's to authorize or fund (DanceFlow reviews it).
  -- Every resource of a location belongs to its one business, so the period keys are computed once (the calendar helpers are costly).
  -- The sending gate matters only where texting can be on; the calendar work runs only when the location has a live fee resource at all.
  if o.id is not null and o.state in ('active', 'suspended') then
    v_paused := coalesce(public._tw4rfl_gate_suspended(p_studio_id), false);
  end if;
  if v_entity is not null and exists (select 1 from public.studio_sms_provider_resources r where r.studio_id = p_studio_id and r.provider_state = 'active' and r.fee_kind is not null) then
    v_cur := public._tw4ml_month_key(v_entity, now());
    v_nxt := public._tw4ml_key_add(v_cur, 1);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', f.kind, 'current_period', f.cur_state, 'next_period', f.nxt_state,
           'attention', case when f.cur_state = 'covered' and f.nxt_state = 'covered' then 'none'
                             when f.source = 'admin' then 'danceflow_review'
                             else case split_part(case when f.cur_state = 'not_covered' then f.cur_cover else f.nxt_cover end, ':', 2)
                                    when 'no_authorization' then 'authorization_needed' when 'authorization_expired' then 'authorization_needed'
                                    when 'authorization_revoked' then 'authorization_needed' when 'not_authorized_period' then 'authorization_needed'
                                    when 'awaiting_charge' then 'payment_processing' when 'charge_unfunded' then 'funds_needed'
                                    when 'charge_held' then 'contact_danceflow' when 'charge_refused' then 'contact_danceflow'
                                    when 'no_pilot_approval' then 'pilot_approval'
                                    else 'danceflow_review' end end) order by f.ord, f.registered_at, f.id), '[]'::jsonb)
    into v_fees
    from (select r.id, r.registered_at, r.source, case r.resource_kind when 'campaign' then 'texting_service' else 'phone_number' end as kind,
                 case r.resource_kind when 'campaign' then 1 else 2 end as ord, c.cur_cover, c.nxt_cover,
                 case when c.cur_cover like 'covered:%' or c.cur_settled then 'covered' else 'not_covered' end as cur_state,
                 case when c.nxt_cover like 'covered:%' or c.nxt_settled then 'covered' else 'not_covered' end as nxt_state
            from public.studio_sms_provider_resources r
            cross join lateral (select public._tw4rfl_cover(r, v_cur) as cur_cover, public._tw4rfl_cover(r, v_nxt) as nxt_cover,
                   -- a period DanceFlow settled itself (absorbed, or confirmed not billed) is not the owner's to cover
                   exists (select 1 from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.period_key = v_cur and e.state = 'closed'
                            and e.disposition in ('absorbed', 'not_billed_confirmed')) as cur_settled,
                   exists (select 1 from public.studio_sms_provider_exposure e where e.resource_id = r.id and e.period_key = v_nxt
                            and e.state = 'closed' and e.disposition in ('absorbed', 'not_billed_confirmed')) as nxt_settled) c
           where r.studio_id = p_studio_id and r.legal_entity_id = v_entity and r.provider_state = 'active' and r.fee_kind is not null
             and not exists (select 1 from public.studio_sms_prov_orphans po where po.rfl_resource_id = r.id or (po.provider_sid = r.provider_sid and po.status <> 'closed'))
             and not exists (select 1 from public.studio_sms_num_orphans nor where nor.legal_entity_id = r.legal_entity_id and nor.phone_number_sid = r.provider_sid
                               and nor.status in ('open', 'acknowledged', 'adopted'))) f;
  v_fees := jsonb_build_object('texting_paused', v_paused,
    'cancellation_in_progress', exists (select 1 from public.studio_sms_provider_cancel_ops co where co.studio_id = p_studio_id and co.status in ('authorized', 'in_flight', 'unknown_outcome')),
    'items', v_fees);

  -- unexpected provider resources: informational only (no identifier, kind, count or cost)
  v_unexpected := exists (select 1 from public.studio_sms_prov_orphans po where po.studio_id = p_studio_id and po.status <> 'closed')
    or (v_entity is not null and exists (select 1 from public.studio_sms_num_orphans nor where nor.legal_entity_id = v_entity and nor.status = 'open'));

  return jsonb_build_object(
    'available', true,
    'version', 1,
    'number', jsonb_build_object('status', v_num, 'display', v_display, 'selection', v_selection),
    'sender', jsonb_build_object('status', v_sender),
    'compliance', jsonb_build_object('status', v_compliance),
    'activation', v_activation,
    'fees', v_fees,
    'unexpected_resource_review', v_unexpected);
end $$;

revoke all on function public.get_studio_sms_number_offers(uuid) from public, anon, service_role;
grant execute on function public.get_studio_sms_number_offers(uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.get_studio_sms_number_offers(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.get_studio_sms_number_offers(uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.get_studio_sms_number_offers(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_studio_sms_number_offers(uuid)', 'EXECUTE') then
    raise exception 'J3 postcondition failed: unexpected privileges on get_studio_sms_number_offers';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_studio_sms_number_offers(uuid)'::regprocedure and p.prosecdef
                   and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']) then
    raise exception 'J3 postcondition failed: get_studio_sms_number_offers is not security definer with a pinned search_path';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.get_studio_sms_texting_status(uuid)'::regprocedure) <> '972869a5d27d9342d1b93bb0978d7ece' then
    raise exception 'J3 postcondition failed: unexpected get_studio_sms_texting_status body';
  end if;
  if has_function_privilege('anon', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE') or not has_function_privilege('authenticated', 'public.get_studio_sms_texting_status(uuid)', 'EXECUTE') then
    raise exception 'J3 postcondition failed: unexpected privileges on get_studio_sms_texting_status';
  end if;
end $$;

commit;
