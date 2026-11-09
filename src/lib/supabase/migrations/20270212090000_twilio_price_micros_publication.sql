-- 20270212090000_twilio_price_micros_publication.sql
-- TW-4F: publish SUB-CENT per-segment prices through the EXISTING price authorization (single-owner hardware-key ceremony, or team mode). Git only until separately authorized.
--   The owner's rates are $0.013 per INBOUND segment and $0.017 per OUTBOUND segment (13,000 and 17,000 micro-dollars). 20261231130000 added micro-dollar price columns but left
--   tw4_price_set_micros ungranted, and propose / approve take whole cents only. This migration lets a price change REQUEST carry the micro-dollar amounts for the two
--   per-segment kinds ('sms_usage', 'sms_inbound') and binds them into everything the ceremony already protects:
--     * the request columns price_micros / cost_micros (both null, or both set for a per-segment kind with the whole-cent columns equal to their ceilings);
--     * the canonical hash the hardware key signs (tag 'tw4price/v2') includes both amounts, so a signature over 17,000 cannot publish 18,000;
--     * the request guard freezes them with the rest of the binding, the applied price must carry exactly them;
--     * the price-list insert guard accepts a published price only when an approved request carries the same micro amounts; a published price is immutable in them;
--     * tw4_price_authz_begin shows them (summary, audit, monitoring event); tw4_price_authz_finish writes them; tw4_price_verify attests them; the list reader returns them.
--   New entry point: tw4_price_propose_micros(kind, price_micros, cost_micros, description, reason): authenticated only, same aal2 / fresh TOTP / session rules as tw4_price_propose
--   (it calls the same internal function). Everything else (cooling-off, separate session, WebAuthn assertion, limits, freeze, monitoring) is unchanged.
--   NOT changed on purpose: team-mode approval (_tw4price_do_approve) still inserts a whole-cent price, so a team approval of a micro request FAILS CLOSED at the insert guard;
--   a micro request is revised by withdrawing it (reject) and proposing again. tw4_price_set_micros stays ungranted. No price is published by this migration.
-- Requires 20270210100000 (and 20270210110000) and 20261231130000. Rollback: rollback/20270212090000_twilio_price_micros_publication_rollback.sql (refuses while any micro request exists).
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_price_auth_config') is null or to_regprocedure('public._tw4pm_cents(bigint)') is null then
    raise exception 'price micros publication precondition failed: 20270210100000 and 20261231130000 must be applied';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_sms_price_change_requests' and column_name = 'price_micros') then
    raise exception 'price micros publication precondition failed: already applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4price_request_hash(public.studio_sms_price_change_requests)'::regprocedure), chr(13), '')), 8) <> 'c495141c' then
    raise exception 'price micros publication precondition failed: public._tw4price_request_hash(public.studio_sms_price_change_requests) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4pricedual_guard()'::regprocedure), chr(13), '')), 8) <> '9e2e8117' then
    raise exception 'price micros publication precondition failed: public._tw4pricedual_guard() differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4price_activation_guard()'::regprocedure), chr(13), '')), 8) <> '33638329' then
    raise exception 'price micros publication precondition failed: public._tw4price_activation_guard() differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid)'::regprocedure), chr(13), '')), 8) <> 'bdba14fc' then
    raise exception 'price micros publication precondition failed: public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_price_authz_begin(uuid)'::regprocedure), chr(13), '')), 8) <> '9b8b3354' then
    raise exception 'price micros publication precondition failed: public.tw4_price_authz_begin(uuid) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_price_authz_finish(uuid,text,text,text,text,text)'::regprocedure), chr(13), '')), 8) <> '47c36885' then
    raise exception 'price micros publication precondition failed: public.tw4_price_authz_finish(uuid,text,text,text,text,text) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_price_revise(uuid,integer,integer,text,text)'::regprocedure), chr(13), '')), 8) <> '6418b2fd' then
    raise exception 'price micros publication precondition failed: public.tw4_price_revise(uuid,integer,integer,text,text) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4price_do_list(uuid)'::regprocedure), chr(13), '')), 8) <> '3b409b59' then
    raise exception 'price micros publication precondition failed: public._tw4price_do_list(uuid) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_price_verify(timestamp with time zone)'::regprocedure), chr(13), '')), 8) <> '8702bbf2' then
    raise exception 'price micros publication precondition failed: public.tw4_price_verify(timestamp with time zone) differs from 20270210100000';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_price_propose(text,integer,integer,text,text)'::regprocedure), chr(13), '')), 8) <> '3bb128ab' then
    raise exception 'price micros publication precondition failed: public.tw4_price_propose(text,integer,integer,text,text) differs from 20270210100000';
  end if;
end $$;

alter table public.studio_sms_price_change_requests add column price_micros int null, add column cost_micros int null;
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_micros check (
  (price_micros is null and cost_micros is null)
  or (kind in ('sms_usage', 'sms_inbound') and price_micros between 1 and 10000000 and cost_micros between 0 and 10000000
      and customer_price_cents = (price_micros + 9999) / 10000 and provider_cost_cents = (cost_micros + 9999) / 10000));

-- canonical hash the hardware key signs: v2 includes the micro amounts
create or replace function public._tw4price_request_hash(q public.studio_sms_price_change_requests)
returns bytea language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select sha256(convert_to(concat_ws('|', 'tw4price/v2', 'authorize', 'studio_sms_price_list', q.kind, coalesce(q.base_customer_price_cents::text, 'none'), coalesce(q.base_provider_cost_cents::text, 'none'),
    q.customer_price_cents::text, q.provider_cost_cents::text, coalesce(q.price_micros::text, 'none'), coalesce(q.cost_micros::text, 'none'), q.description, coalesce(q.base_price_id::text, 'none'), q.proposal_version::text, q.id::text, q.approval_mode,
    (extract(epoch from q.cooling_until) * 1000000)::bigint::text, (extract(epoch from q.expires_at) * 1000000)::bigint::text), 'UTF8'));
$$;

-- request binding and the price-list insert guard
create or replace function public._tw4pricedual_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare p public.studio_sms_price_list;
begin
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_price_change_requests: rows are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- a request is always BORN pending and undecided, whatever an owner-level insert supplies, and only the dual-control function creates one
    if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
      raise exception 'studio_sms_price_change_requests: a request is created only by tw4_price_propose' using errcode = '42501';
    end if;
    new.status := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    new.decision_note := null;
    new.applied_price_id := null;
    new.applied_at := null;
    new.auth_credential_id := null;
    new.auth_nonce := null;
    return new;
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.price_micros is distinct from old.price_micros or new.cost_micros is distinct from old.cost_micros or new.description is distinct from old.description or new.reason is distinct from old.reason
     or new.base_price_id is distinct from old.base_price_id or new.base_customer_price_cents is distinct from old.base_customer_price_cents
     or new.base_provider_cost_cents is distinct from old.base_provider_cost_cents or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at
     or new.approval_mode is distinct from old.approval_mode or new.cooling_until is distinct from old.cooling_until or new.proposer_session is distinct from old.proposer_session
     or new.proposal_version is distinct from old.proposal_version or new.replaces_request_id is distinct from old.replaces_request_id then
    raise exception 'studio_sms_price_change_requests: the binding of a proposal is fixed' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
    raise exception 'studio_sms_price_change_requests: status moves only through the dual-control functions' using errcode = '42501';
  end if;
  if not ((old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'invalidated')) or (old.status = 'approved' and new.status = 'applied')) then
    raise exception 'studio_sms_price_change_requests: % -> % is not a legal transition (a decided proposal is final)', old.status, new.status using errcode = '42501';
  end if;
  if (new.auth_credential_id is distinct from old.auth_credential_id or new.auth_nonce is distinct from old.auth_nonce) and not (old.status = 'pending' and new.status = 'approved') then
    raise exception 'studio_sms_price_change_requests: the hardware-key evidence is written once, with the approval' using errcode = '42501';
  end if;
  if new.status = 'applied' then
    -- the evidence names a published price with exactly the approved amounts
    select * into p from public.studio_sms_price_list x where x.id = new.applied_price_id;
    if p.id is null or p.kind <> new.kind or p.customer_price_cents <> new.customer_price_cents or p.provider_cost_cents <> new.provider_cost_cents or p.unit_price_micros is distinct from new.price_micros or p.unit_cost_micros is distinct from new.cost_micros or p.description <> new.description
       or p.created_by is distinct from new.decided_by then
      raise exception 'studio_sms_price_change_requests: the applied price is not the approved price' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create or replace function public._tw4price_activation_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_price_change_requests;
begin
  if tg_op = 'INSERT' then
    select * into q from public.studio_sms_price_change_requests x
     where x.status = 'approved' and x.kind = new.kind and x.customer_price_cents = new.customer_price_cents and x.provider_cost_cents = new.provider_cost_cents
       and x.price_micros is not distinct from new.unit_price_micros and x.cost_micros is not distinct from new.unit_cost_micros
       and x.description = new.description and x.decided_by = new.created_by and x.applied_price_id is null;
    if q.id is null or not new.active or not public._tw4price_admin_active(q.decided_by) or not public._tw4price_admin_active(q.requested_by)
       or public._tw4price_suspended()
       or not ((q.approval_mode = 'team' and q.decided_by <> q.requested_by)
               or (q.approval_mode = 'owner' and q.auth_credential_id is not null and q.auth_nonce is not null and q.cooling_until <= clock_timestamp())) then
      raise exception 'a price is published only by an approved price change (team: two different registered administrators; owner: after the cooling-off, with the hardware-key approval of the exact proposal): none is being applied for these amounts' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published price is never deleted (a retired price stays as history)' using errcode = '42501';
  end if;
  -- UPDATE: a published price is immutable, whatever the session mode; the only change that remains is retiring it (active -> false)
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.unit_price_micros is distinct from old.unit_price_micros or new.unit_cost_micros is distinct from old.unit_cost_micros or new.description is distinct from old.description or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a published price is never edited: retire it and publish a new one through a price change request' using errcode = '42501';
  end if;
  if old.active = false and new.active = true then
    raise exception 'a published price is never edited: a retired price is never re-activated; publish a new price through a price change request' using errcode = '42501';
  end if;
  return new;
end $$;

-- the internal proposal function gains the micro amounts (the 9-argument version is dropped first: a 9-argument call would otherwise be ambiguous)
drop function public._tw4price_do_propose_mode(text, int, int, text, text, uuid, text, text, uuid);
create or replace function public._tw4price_do_propose_mode(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid, p_mode text, p_session text, p_replaces uuid default null, p_price_micros int default null, p_cost_micros int default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  b public.studio_sms_price_list;
  lim public.studio_sms_price_limits;
  v_id uuid;
  cfg public.studio_sms_price_auth_config;
  v_now timestamptz := clock_timestamp();
  v_cool timestamptz;
  v_exp timestamptz;
  v_ver int := 1;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_kind is null or p_customer_cents is null or p_customer_cents <= 0 or p_customer_cents > 10000000 or p_provider_cents is null or p_provider_cents < 0 or p_provider_cents > 10000000
     or p_description is null or char_length(btrim(p_description)) not between 3 and 200 or p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'a price proposal needs a known kind, a positive customer price and a non-negative provider cost (each at most 10,000,000 cents), a description (3 to 200) and a written reason (10 to 500)' using errcode = '22023';
  end if;
  if not (p_kind = any (public._tw4price_kinds())) then
    raise exception 'unknown price kind' using errcode = '22023';
  end if;
  -- a micro-dollar proposal: only the per-segment kinds, both amounts, and the whole-cent columns are exactly the informational ceilings the price-list check requires
  if (p_price_micros is null) <> (p_cost_micros is null) then
    raise exception 'a micro-dollar proposal needs both the price and the cost in micro-dollars' using errcode = '22023';
  end if;
  if p_price_micros is not null and (p_kind not in ('sms_usage', 'sms_inbound') or p_price_micros < 1 or p_price_micros > 10000000 or p_cost_micros < 0 or p_cost_micros > 10000000
     or p_customer_cents <> (p_price_micros + 9999) / 10000 or p_provider_cents <> (p_cost_micros + 9999) / 10000) then
    raise exception 'micro-dollar amounts are for the per-segment kinds only (price 1 to 10,000,000 micro-dollars, cost 0 to 10,000,000) and the cents must be their ceilings' using errcode = '22023';
  end if;
  if p_mode not in ('owner', 'team') then
    raise exception 'unknown approval mode' using errcode = '22023';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  if public._tw4price_suspended() then
    raise exception 'price changes are suspended (freeze or a monitoring suspension)' using errcode = '42501';
  end if;
  if p_mode = 'owner' and (p_session is null or p_session = '') then
    raise exception 'an owner-mode proposal needs the session id of the proposing session' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  select * into b from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  -- OWNER-APPROVED limits only (data; unapproved proposals in the limits table are not enforced)
  select * into lim from public.studio_sms_price_limits l where l.kind = p_kind and l.approved;
  if lim.kind is not null then
    if p_customer_cents > lim.max_customer_cents or p_provider_cents > lim.max_provider_cents
       or (lim.max_provider_pct_of_customer is not null and p_provider_cents::bigint * 100 > p_customer_cents::bigint * lim.max_provider_pct_of_customer)
       or (lim.max_step_pct is not null and b.id is not null and abs(p_customer_cents::bigint - b.customer_price_cents) * 100 > b.customer_price_cents::bigint * lim.max_step_pct) then
      raise exception 'the proposed prices exceed the owner-approved limits for this kind' using errcode = '22023';
    end if;
  end if;
  if b.id is not null and b.customer_price_cents = p_customer_cents and b.provider_cost_cents = p_provider_cents and b.unit_price_micros is not distinct from p_price_micros and b.unit_cost_micros is not distinct from p_cost_micros then
    raise exception 'the proposed prices equal the active prices: nothing to change' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.kind = p_kind and x.status in ('pending', 'approved') for update;
  if q.id is not null then
    if q.expires_at <= clock_timestamp() then
      perform set_config('tw4.pricedual_write', 'on', true);
      update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
      perform set_config('tw4.pricedual_write', 'off', true);
    elsif p_replaces is null and q.approval_mode = (case when p_mode = 'owner' then 'owner' else 'team' end) and q.requested_by = p_actor and q.customer_price_cents = p_customer_cents and q.provider_cost_cents = p_provider_cents and q.price_micros is not distinct from p_price_micros and q.cost_micros is not distinct from p_cost_micros and q.description = btrim(p_description)
          and q.reason = btrim(p_reason) and q.base_price_id is not distinct from b.id then
      return jsonb_build_object('request_id', q.id, 'status', q.status, 'expires_at', q.expires_at, 'replayed', true);
    else
      raise exception 'an open price proposal already exists for this kind: it must be approved, rejected or withdrawn, or expire, first' using errcode = 'TW041';
    end if;
  end if;
  if p_mode = 'owner' then
    v_cool := v_now + make_interval(hours => cfg.cooling_off_hours);
    v_exp := v_cool + make_interval(hours => cfg.authz_window_hours);
  else
    v_exp := v_now + interval '24 hours';
  end if;
  if p_replaces is not null then
    select proposal_version + 1 into v_ver from public.studio_sms_price_change_requests where id = p_replaces;
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, base_price_id, base_customer_price_cents, base_provider_cost_cents, requested_by, requested_at, expires_at,
    approval_mode, cooling_until, proposer_session, proposal_version, replaces_request_id, price_micros, cost_micros)
  values (p_kind, p_customer_cents, p_provider_cents, btrim(p_description), btrim(p_reason), b.id, b.customer_price_cents, b.provider_cost_cents, p_actor, v_now, v_exp,
    p_mode, v_cool, case when p_mode = 'owner' then p_session else null end, v_ver, p_replaces, p_price_micros, p_cost_micros)
  returning id into v_id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('proposed', p_actor, p_session, v_id, null, jsonb_build_object('kind', p_kind, 'mode', p_mode, 'customer_cents', p_customer_cents, 'provider_cents', p_provider_cents, 'price_micros', p_price_micros, 'cost_micros', p_cost_micros, 'version', v_ver));
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'replayed', false, 'mode', p_mode, 'cooling_until', v_cool, 'expires_at', v_exp, 'version', v_ver);
end $$;
revoke all on function public._tw4price_do_propose_mode(text, int, int, text, text, uuid, text, text, uuid, int, int) from public, anon, authenticated, service_role;

create or replace function public.tw4_price_authz_begin(p_request_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('recent');
  v_sid text := public._tw4price_session_id();
  q public.studio_sms_price_change_requests;
  cfg public.studio_sms_price_auth_config;
  v_hash bytea;
  v_nonce bytea;
  v_creds jsonb;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  -- a refusal by a REGISTERED administrator's session is RECORDED (committed) and returned, not raised: the audit is the detector, independent of any other table
  begin
    q := public._tw4price_owner_gate(p_request_id, v_actor, v_sid);
    perform public._tw4price_limits_check(q.kind, q.customer_price_cents, q.provider_cost_cents, q.base_customer_price_cents);
  exception when others then
    perform public._tw4price_audit('gate_refused', v_actor, v_sid, p_request_id, null, jsonb_build_object('step', 'begin', 'code', sqlstate, 'reason', left(sqlerrm, 200)));
    return jsonb_build_object('status', 'refused', 'code', sqlstate, 'reason', sqlerrm);
  end;
  select * into cfg from public.studio_sms_price_auth_config;
  v_hash := public._tw4price_request_hash(q);
  v_nonce := public._tw4price_new_nonce();
  perform set_config('tw4.priceauth_write', 'on', true);
  insert into public.studio_sms_price_auth_challenges (nonce, purpose, bound_hash, request_id, issued_to, session_id, expires_at)
  values (v_nonce, 'authorize', v_hash, q.id, v_actor, v_sid, clock_timestamp() + make_interval(secs => cfg.challenge_ttl_seconds));
  perform set_config('tw4.priceauth_write', 'off', true);
  select coalesce(jsonb_agg(public._tw4price_b64u(c.credential_id)), '[]'::jsonb) into v_creds from public.studio_sms_price_credentials c where c.status = 'active' and c.role <> 'recovery';
  perform public._tw4price_audit('challenge_issued', v_actor, v_sid, q.id, null, jsonb_build_object('purpose', 'authorize', 'kind', q.kind, 'new_customer_cents', q.customer_price_cents,
    'new_provider_cents', q.provider_cost_cents, 'new_price_micros', q.price_micros, 'new_cost_micros', q.cost_micros, 'fingerprint', left(encode(v_hash, 'hex'), 16)));
  -- the SECOND CHANNEL: the monitoring feed carries the same fingerprint and values, so an alert can show them to the owner on a path that does not run through the page that signs
  perform public._tw4price_emit('price_authorization_started', v_actor, jsonb_build_object('request_id', q.id, 'kind', q.kind, 'new_customer_cents', q.customer_price_cents,
    'new_provider_cents', q.provider_cost_cents, 'new_price_micros', q.price_micros, 'new_cost_micros', q.cost_micros, 'fingerprint', left(encode(v_hash, 'hex'), 16)));
  return jsonb_build_object('nonce', public._tw4price_b64u(v_nonce), 'challenge', public._tw4price_b64u(sha256(v_hash || v_nonce)), 'rp_id', cfg.rp_id, 'allow_credentials', v_creds,
    'expires_in_seconds', cfg.challenge_ttl_seconds, 'summary', jsonb_build_object('scope', 'studio_sms_price_list', 'kind', q.kind, 'old_customer_cents', q.base_customer_price_cents,
      'old_provider_cents', q.base_provider_cost_cents, 'new_customer_cents', q.customer_price_cents, 'new_provider_cents', q.provider_cost_cents, 'new_price_micros', q.price_micros, 'new_cost_micros', q.cost_micros,
      'old_price_micros', (select x.unit_price_micros from public.studio_sms_price_list x where x.id = q.base_price_id), 'old_cost_micros', (select x.unit_cost_micros from public.studio_sms_price_list x where x.id = q.base_price_id), 'description', q.description,
      'proposal_version', q.proposal_version, 'request_id', q.id, 'hash', encode(v_hash, 'hex'), 'expires_at', q.expires_at));
end $$;
create or replace function public.tw4_price_authz_finish(p_request_id uuid, p_nonce text, p_credential_id text, p_auth_data text, p_client_data text, p_signature text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('recent');
  v_sid text := public._tw4price_session_id();
  q public.studio_sms_price_change_requests;
  v_nonce bytea;
  v_cred bytea;
  v_reason text;
  v_new uuid;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  begin
    q := public._tw4price_owner_gate(p_request_id, v_actor, v_sid);
    perform public._tw4price_limits_check(q.kind, q.customer_price_cents, q.provider_cost_cents, q.base_customer_price_cents);
  exception when others then
    perform public._tw4price_audit('gate_refused', v_actor, v_sid, p_request_id, null, jsonb_build_object('step', 'finish', 'code', sqlstate, 'reason', left(sqlerrm, 200)));
    return jsonb_build_object('status', 'refused', 'code', sqlstate, 'reason', sqlerrm);
  end;
  begin
    v_nonce := public._tw4price_unb64u(p_nonce);
    v_cred := public._tw4price_unb64u(p_credential_id);
    if not public._tw4price_challenge_ok(v_nonce, v_actor, v_sid) or not exists (select 1 from public.studio_sms_price_auth_challenges c where c.nonce = v_nonce and c.request_id = q.id) then
      v_reason := 'the challenge was issued to another session or request';
    else
      v_reason := public._tw4price_check_assertion('authorize', v_nonce, public._tw4price_request_hash(q), v_cred, public._tw4price_unb64u(p_auth_data), public._tw4price_unb64u(p_client_data),
        public._tw4price_unb64u(p_signature), true);
    end if;
  exception when others then
    v_reason := 'malformed input';
  end;
  if v_reason is not null then
    -- recorded and committed: nothing else changes. A sign counter that did not increase is an integrity failure (a cloned authenticator?), recorded as such.
    perform public._tw4price_audit(case when v_reason like 'sign counter%' then 'integrity_failure' else 'assertion_rejected' end, v_actor, v_sid, q.id, v_cred, jsonb_build_object('reason', v_reason, 'step', 'finish'));
    if v_reason like 'sign counter%' then
      perform public._tw4price_emit_safe('price_integrity_failure', v_actor, jsonb_build_object('reason', 'sign counter did not increase', 'request_id', q.id));
    end if;
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'approved', decided_by = v_actor, decided_at = clock_timestamp(),
    decision_note = 'authorized with a hardware-backed transaction approval after the cooling-off', auth_credential_id = v_cred, auth_nonce = v_nonce where id = q.id;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, unit_price_micros, unit_cost_micros, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.price_micros, q.cost_micros, q.description, v_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', applied_price_id = v_new, applied_at = clock_timestamp() where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('authorized', v_actor, v_sid, q.id, v_cred, jsonb_build_object('hash', encode(public._tw4price_request_hash(q), 'hex')));
  perform public._tw4price_audit('published', v_actor, v_sid, q.id, v_cred, jsonb_build_object('price_id', v_new, 'kind', q.kind, 'customer_cents', q.customer_price_cents, 'provider_cents', q.provider_cost_cents, 'price_micros', q.price_micros, 'cost_micros', q.cost_micros));
  return jsonb_build_object('status', 'applied', 'price_id', v_new);
end $$;
create or replace function public.tw4_price_revise(p_request_id uuid, p_customer_cents int, p_provider_cents int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('recent');
  q public.studio_sms_price_change_requests;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.requested_by <> v_actor or not public._tw4price_admin_active(v_actor) then
    raise exception 'only the administrator who made the proposal can revise it' using errcode = '42501';
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be revised', q.status using errcode = 'TW041';
  end if;
  if q.price_micros is not null then
    raise exception 'a micro-dollar proposal is not revised: withdraw it (reject) and propose the new amounts' using errcode = 'TW041';
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: revised by the proposer, a new version restarts the cooling-off' where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('revised', v_actor, public._tw4price_session_id(), q.id, null, jsonb_build_object('from_version', q.proposal_version));
  return public._tw4price_do_propose_mode(q.kind, p_customer_cents, p_provider_cents, p_description, p_reason, v_actor, q.approval_mode, public._tw4price_session_id(), q.id);
end $$;
create or replace function public._tw4price_do_list(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active jsonb;
  v_requests jsonb;
begin
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('price_id', x.id, 'kind', x.kind, 'customer_price_cents', x.customer_price_cents, 'provider_cost_cents', x.provider_cost_cents, 'unit_price_micros', x.unit_price_micros, 'unit_cost_micros', x.unit_cost_micros,
           'description', x.description, 'created_at', x.created_at) order by x.kind), '[]'::jsonb) into v_active from public.studio_sms_price_list x where x.active;
  select coalesce(jsonb_agg(t order by t.requested_at desc, t.request_id), '[]'::jsonb) into v_requests from (
    select r.id as request_id, r.kind, r.customer_price_cents, r.provider_cost_cents, r.price_micros, r.cost_micros, r.description, r.reason, r.base_price_id, r.base_customer_price_cents, r.base_provider_cost_cents,
           case when r.status = 'pending' and r.expires_at <= clock_timestamp() then 'expired' else r.status end as status,
           r.requested_by, r.requested_at, r.expires_at, r.approval_mode, r.cooling_until, r.proposal_version, r.decided_by, r.decided_at, r.decision_note, r.applied_price_id,
           ((select a.id from public.studio_sms_price_list a where a.kind = r.kind and a.active) is distinct from r.base_price_id) as base_changed
      from public.studio_sms_price_change_requests r order by r.requested_at desc, r.id limit 100) t;
  return jsonb_build_object('active', v_active, 'requests', v_requests, 'mode', (select mode from public.studio_sms_price_auth_config), 'frozen', (select frozen from public.studio_sms_price_auth_config));
end $$;
create or replace function public.tw4_price_verify(p_since timestamptz default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
begin
  -- a published price with no attesting applied request (prices published before this migration are listed too: pass p_since to look only at newer ones)
  for r in select p.id, p.kind, p.created_at from public.studio_sms_price_list p
            where (p_since is null or p.created_at >= p_since)
              and not exists (select 1 from public.studio_sms_price_change_requests q
                               where q.status = 'applied' and q.applied_price_id = p.id and q.kind = p.kind and q.customer_price_cents = p.customer_price_cents
                                 and q.provider_cost_cents = p.provider_cost_cents and q.price_micros is not distinct from p.unit_price_micros and q.cost_micros is not distinct from p.unit_cost_micros and q.description = p.description and q.decided_by = p.created_by
                                 and ((q.approval_mode = 'team' and q.decided_by <> q.requested_by)
                                      or (q.approval_mode = 'owner' and q.auth_credential_id is not null and q.decided_at >= q.cooling_until
                                          and exists (select 1 from public.studio_sms_price_auth_challenges c where c.nonce = q.auth_nonce and c.used_at is not null and c.request_id = q.id)
                                          and exists (select 1 from public.studio_sms_price_credentials k where k.credential_id = q.auth_credential_id)))
                                 and public._tw4price_registered_at(q.requested_by, q.requested_at)
                                 and public._tw4price_registered_at(q.decided_by, q.decided_at)) loop
    v := v || jsonb_build_object('code', 'price_unattested', 'price_id', r.id, 'kind', r.kind, 'created_at', r.created_at);
  end loop;
  for r in select q.id, q.status, q.kind from public.studio_sms_price_change_requests q
            where (q.status in ('approved', 'applied') and (q.decided_by is null or (q.decided_by = q.requested_by and q.approval_mode = 'team')))
               or (q.status = 'applied' and not exists (select 1 from public.studio_sms_price_list p where p.id = q.applied_price_id))
               or (q.status = 'approved' and q.decided_at < clock_timestamp() - interval '1 minute')
               or (q.status = 'pending' and q.expires_at < clock_timestamp() - interval '48 hours')
               or (q.status in ('approved', 'applied') and not (public._tw4price_registered_at(q.requested_by, q.requested_at) and public._tw4price_registered_at(q.decided_by, q.decided_at))) loop
    v := v || jsonb_build_object('code', 'request_anomaly', 'request_id', r.id, 'status', r.status, 'kind', r.kind);
  end loop;
  for r in select x.kind, count(*) as n from public.studio_sms_price_list x where x.active group by x.kind having count(*) > 1 loop
    v := v || jsonb_build_object('code', 'several_active_prices', 'kind', r.kind, 'count', r.n);
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(v) = 0, 'anomalies', v, 'checked_at', clock_timestamp());
end $$;

-- the new entry point (same shape as tw4_price_propose; micro-dollar amounts)
create or replace function public.tw4_price_propose_micros(p_kind text, p_price_micros int, p_cost_micros int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  cfg public.studio_sms_price_auth_config;
  v_actor uuid := public._tw4price_session_actor('recent');
  v_res jsonb;
begin
  select * into cfg from public.studio_sms_price_auth_config;
  -- a monitoring outage never lets a financial proposal through silently
  if cfg.monitoring_expected and to_regclass('public.studio_sms_price_security_events') is null then
    raise exception 'the monitoring events table is expected but missing: a price proposal is refused' using errcode = 'TW046';
  end if;
  if p_price_micros is null or p_cost_micros is null then
    raise exception 'a micro-dollar proposal needs both the price and the cost' using errcode = '22023';
  end if;
  v_res := public._tw4price_do_propose_mode(p_kind, public._tw4pm_cents(p_price_micros), public._tw4pm_cents(p_cost_micros), p_description, p_reason, v_actor,
    case when cfg.mode = 'single_owner' then 'owner' else 'team' end, public._tw4price_session_id(), null, p_price_micros, p_cost_micros);
  -- monitoring expected: ANY failure to deliver the event (missing table, permission, lock timeout) refuses the proposal; otherwise the event is best effort
  if cfg.monitoring_expected then
    perform public._tw4price_emit('price_proposed', v_actor, jsonb_build_object('kind', p_kind, 'new_price_micros', p_price_micros, 'new_cost_micros', p_cost_micros, 'request_id', v_res ->> 'request_id'));
  else
    perform public._tw4price_emit_safe('price_proposed', v_actor, jsonb_build_object('kind', p_kind, 'new_price_micros', p_price_micros, 'new_cost_micros', p_cost_micros, 'request_id', v_res ->> 'request_id'));
  end if;
  return v_res;
end $$;
revoke all on function public.tw4_price_propose_micros(text, int, int, text, text) from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_propose_micros(text, int, int, text, text) to authenticated;

do $$
begin
  if has_function_privilege('service_role', 'public.tw4_price_propose_micros(text,integer,integer,text,text)', 'execute') or has_function_privilege('anon', 'public.tw4_price_propose_micros(text,integer,integer,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.tw4_price_propose_micros(text,integer,integer,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid,integer,integer)', 'execute')
     or has_function_privilege('service_role', 'public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid,integer,integer)', 'execute')
     or has_function_privilege('anon', 'public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute') or has_function_privilege('service_role', 'public.tw4_price_set_micros(text,integer,integer,text,uuid)', 'execute') then
    raise exception 'price micros publication postcondition failed: unexpected function privileges';
  end if;
end $$;

commit;
