-- Rollback of 20270204100000 (D4-2: single-owner hardware-key price authorization). Returns the schema to EXACTLY 20270204090000 (the chain check compares it with no residue).
-- REFUSES (55000) while any owner-mode request, credential, challenge, audit row exists (that is evidence and never destroyed: forward-fix, or freeze publication with tw4_price_freeze),
-- or when one of the guarded functions was replaced by a later slice. Rolling back removes the hardware-key requirement: re-apply 20270204100000 before any owner-mode use.
begin;
set local lock_timeout = '5s';

do $$
declare r record;
begin
  if to_regclass('public.studio_sms_price_auth_config') is null then
    raise exception 'price owner authorization rollback: not applied';
  end if;
  for r in select * from (values
      ('public.tw4_price_authz_finish(uuid,text,text,text,text,text)', 'a02039f8f231bdb8a7a5fadabc44a1cb'),
      ('public._tw4price_do_propose_mode(text,integer,integer,text,text,uuid,text,text,uuid)', 'c3fa23e5f0c3c0f3518ff5bd77e9da2c'),
      ('public._tw4price_do_approve(uuid,uuid,text)', 'cefd0a499beaa2199c7ad7fe99a916e2'),
      ('public._tw4pricedual_guard()', '9e2e81171fa5eab1d608727997ab9f48'),
      ('public._tw4price_activation_guard()', '699ab93e749775f259d43160133642ac')) as x(sig, h) loop
    if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure(r.sig)) is distinct from r.h then
      raise exception 'price owner authorization rollback refused: % is no longer the body installed by 20270204100000', r.sig using errcode = '55000';
    end if;
  end loop;
  lock table public.studio_sms_price_change_requests, public.studio_sms_price_credentials, public.studio_sms_price_auth_challenges, public.studio_sms_price_audit in access exclusive mode;
  if exists (select 1 from public.studio_sms_price_change_requests where approval_mode = 'owner') or exists (select 1 from public.studio_sms_price_credentials)
     or exists (select 1 from public.studio_sms_price_auth_challenges) or exists (select 1 from public.studio_sms_price_audit) then
    raise exception 'price owner authorization rollback refused: owner-mode requests, credentials, challenges or audit rows exist (evidence)' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_price_authz_begin(uuid);
drop function public.tw4_price_authz_finish(uuid, text, text, text, text, text);
drop function public.tw4_price_revise(uuid, int, int, text, text);
drop function public.tw4_price_cred_begin(text, text, text, text, text, text);
drop function public.tw4_price_cred_enroll(text, text, text, text, text, text, text, text, text, text, text, text, text);
drop function public.tw4_price_cred_revoke(text, text, text, text, text, text);
drop function public.tw4_price_freeze(text);
drop function public.tw4_price_thaw(text, text, text, text, text);
drop function public.tw4_price_audit_feed(bigint, int);
drop function public._tw4price_owner_gate(uuid, uuid, text);
drop function public._tw4price_bootstrap(text, text[], bytea, bytea, bytea, text);
drop function public._tw4price_do_propose_mode(text, int, int, text, text, uuid, text, text, uuid);

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
    return new;
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.reason is distinct from old.reason
     or new.base_price_id is distinct from old.base_price_id or new.base_customer_price_cents is distinct from old.base_customer_price_cents
     or new.base_provider_cost_cents is distinct from old.base_provider_cost_cents or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at then
    raise exception 'studio_sms_price_change_requests: the binding of a proposal is fixed' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
    raise exception 'studio_sms_price_change_requests: status moves only through the dual-control functions' using errcode = '42501';
  end if;
  if not ((old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'invalidated')) or (old.status = 'approved' and new.status = 'applied')) then
    raise exception 'studio_sms_price_change_requests: % -> % is not a legal transition (a decided proposal is final)', old.status, new.status using errcode = '42501';
  end if;
  if new.status = 'applied' then
    -- the evidence names a published price with exactly the approved amounts
    select * into p from public.studio_sms_price_list x where x.id = new.applied_price_id;
    if p.id is null or p.kind <> new.kind or p.customer_price_cents <> new.customer_price_cents or p.provider_cost_cents <> new.provider_cost_cents or p.description <> new.description
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
       and x.description = new.description and x.decided_by = new.created_by and x.applied_price_id is null;
    if q.id is null or not new.active or q.decided_by = q.requested_by or not public._tw4price_admin_active(q.decided_by) or not public._tw4price_admin_active(q.requested_by) then
      raise exception 'a price is published only by an approved dual-control price change (two different platform administrators): none is being applied for these amounts' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published price is never deleted (a retired price stays as history)' using errcode = '42501';
  end if;
  -- UPDATE: a published price is immutable, whatever the session mode; the only change that remains is retiring it (active -> false)
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a published price is never edited: retire it and publish a new one through a price change request' using errcode = '42501';
  end if;
  if old.active = false and new.active = true then
    raise exception 'a published price is never edited: a retired price is never re-activated; publish a new price through a price change request' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public._tw4price_do_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  b public.studio_sms_price_list;
  lim public.studio_sms_price_limits;
  v_id uuid;
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
  if b.id is not null and b.customer_price_cents = p_customer_cents and b.provider_cost_cents = p_provider_cents then
    raise exception 'the proposed prices equal the active prices: nothing to change' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.kind = p_kind and x.status in ('pending', 'approved') for update;
  if q.id is not null then
    if q.expires_at <= clock_timestamp() then
      perform set_config('tw4.pricedual_write', 'on', true);
      update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
      perform set_config('tw4.pricedual_write', 'off', true);
    elsif q.requested_by = p_actor and q.customer_price_cents = p_customer_cents and q.provider_cost_cents = p_provider_cents and q.description = btrim(p_description)
          and q.reason = btrim(p_reason) and q.base_price_id is not distinct from b.id then
      return jsonb_build_object('request_id', q.id, 'status', q.status, 'expires_at', q.expires_at, 'replayed', true);
    else
      raise exception 'an open price proposal already exists for this kind: it must be approved, rejected or withdrawn, or expire, first' using errcode = 'TW041';
    end if;
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, base_price_id, base_customer_price_cents, base_provider_cost_cents, requested_by, expires_at)
  values (p_kind, p_customer_cents, p_provider_cents, btrim(p_description), btrim(p_reason), b.id, b.customer_price_cents, b.provider_cost_cents, p_actor, clock_timestamp() + interval '24 hours')
  returning id into v_id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'replayed', false);
end $$;

create or replace function public._tw4price_do_approve(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  v_cur uuid;
  v_new uuid;
begin
  -- an unlocked read learns the parties; their profile rows are share-locked FIRST (in id order) and the standing of both is checked after the lock, so a demotion either
  -- committed before (this refuses or invalidates) or waits until this transaction ends
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  perform 1 from public.profiles pr where pr.id in (coalesce(q.requested_by, p_actor), p_actor) order by pr.id for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an approval needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  if q.requested_by = p_actor then
    raise exception 'the requester cannot approve their own price proposal: a second platform administrator must' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.status = 'applied' and q.decided_by = p_actor then
    return jsonb_build_object('status', 'applied', 'replayed', true, 'price_id', q.applied_price_id);
  end if;
  if q.status in ('expired', 'invalidated') then
    return jsonb_build_object('status', q.status, 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be approved', q.status using errcode = 'TW041';
  end if;
  if q.expires_at <= clock_timestamp() then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'expired', 'replayed', false);
  end if;
  select x.id into v_cur from public.studio_sms_price_list x where x.kind = q.kind and x.active for update;
  if v_cur is distinct from q.base_price_id then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the active price changed after the proposal was made' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  if not public._tw4price_admin_active(q.requested_by) then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the requester is no longer an active platform administrator' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'approved', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.description, p_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', applied_price_id = v_new, applied_at = clock_timestamp() where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('status', 'applied', 'replayed', false, 'price_id', v_new);
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
  select coalesce(jsonb_agg(jsonb_build_object('price_id', x.id, 'kind', x.kind, 'customer_price_cents', x.customer_price_cents, 'provider_cost_cents', x.provider_cost_cents,
           'description', x.description, 'created_at', x.created_at) order by x.kind), '[]'::jsonb) into v_active from public.studio_sms_price_list x where x.active;
  select coalesce(jsonb_agg(t order by t.requested_at desc, t.request_id), '[]'::jsonb) into v_requests from (
    select r.id as request_id, r.kind, r.customer_price_cents, r.provider_cost_cents, r.description, r.reason, r.base_price_id, r.base_customer_price_cents, r.base_provider_cost_cents,
           case when r.status = 'pending' and r.expires_at <= clock_timestamp() then 'expired' else r.status end as status,
           r.requested_by, r.requested_at, r.expires_at, r.decided_by, r.decided_at, r.decision_note, r.applied_price_id,
           ((select a.id from public.studio_sms_price_list a where a.kind = r.kind and a.active) is distinct from r.base_price_id) as base_changed
      from public.studio_sms_price_change_requests r order by r.requested_at desc, r.id limit 100) t;
  return jsonb_build_object('active', v_active, 'requests', v_requests);
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
                                 and q.provider_cost_cents = p.provider_cost_cents and q.description = p.description and q.decided_by = p.created_by
                                 and q.decided_by <> q.requested_by and public._tw4price_registered_at(q.requested_by, q.requested_at)
                                 and public._tw4price_registered_at(q.decided_by, q.decided_at)) loop
    v := v || jsonb_build_object('code', 'price_unattested', 'price_id', r.id, 'kind', r.kind, 'created_at', r.created_at);
  end loop;
  for r in select q.id, q.status, q.kind from public.studio_sms_price_change_requests q
            where (q.status in ('approved', 'applied') and (q.decided_by is null or q.decided_by = q.requested_by))
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

create or replace function public.tw4_price_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return public._tw4price_do_propose(p_kind, p_customer_cents, p_provider_cents, p_description, p_reason, public._tw4price_session_actor('recent'));
end $$;

alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_owner_evidence;
alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_owner_shape;
alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_distinct;
alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_window;
alter table public.studio_sms_price_change_requests
  drop column approval_mode, drop column cooling_until, drop column proposer_session, drop column proposal_version, drop column replaces_request_id, drop column auth_credential_id, drop column auth_nonce;
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_window check (expires_at > requested_at and expires_at <= requested_at + interval '48 hours');
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_distinct check (decided_by is null or decided_by <> requested_by or status = 'rejected');

drop table public.studio_sms_price_audit;
drop table public.studio_sms_price_auth_challenges;
drop table public.studio_sms_price_credentials;
drop table public.studio_sms_price_auth_config;
drop function public._tw4priceauth_guard();
drop function public._tw4price_audit(text, uuid, text, uuid, bytea, jsonb);
drop function public._tw4price_check_assertion(text, bytea, bytea, bytea, bytea, bytea, bytea, boolean);
drop function public._tw4price_request_hash(public.studio_sms_price_change_requests);
drop function public._tw4price_cred_hash(text, bytea, bytea, bytea, text, text);
drop function public._tw4price_thaw_hash();
drop function public._tw4price_new_nonce();
drop function public._tw4price_session_id();
drop function public._tw4price_p256_verify(numeric, numeric, numeric, numeric, numeric);
drop function public._tw4price_p256_oncurve(numeric, numeric);
drop function public._tw4price_jadd(numeric, numeric, numeric, numeric, numeric, numeric);
drop function public._tw4price_jdbl(numeric, numeric, numeric);
drop function public._tw4price_der_rs(bytea);
drop function public._tw4price_num2bits(numeric);
drop function public._tw4price_powmod(numeric, numeric, numeric);
drop function public._tw4price_bytes2num(bytea);
drop function public._tw4price_b64u(bytea);
drop function public._tw4price_unb64u(text);

commit;
