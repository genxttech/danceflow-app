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
--     approval: null | { selection_id: uuid, e164, status: open | expired, expires_at, statement },
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
     or to_regprocedure('public._tw4sr_latest(uuid)') is null or to_regprocedure('public.tw4_num_select_as_owner(uuid, uuid, text, integer)') is null then
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
  -- the owner's open approval of this onboarding (expired ones are shown as such until they are replaced; withdrawal needs the id)
  if o.id is not null then
    select * into v_sel from public.studio_sms_number_selections s where s.studio_id = p_studio_id and s.status = 'approved' and s.approved_at >= o.created_at
     order by s.approved_at desc, s.id limit 1;
  end if;

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
end $$;

commit;
