-- PROPOSED CORRECTION (WP-D4, local only): SMS price changes become dual controlled.
-- NOT a migration of the chain, NOT applied to any hosted database. Applied only inside the throwaway test database by localStack.wpd4dual.test.ts.
--
-- Defect it addresses: public.tw4_price_set(kind, customer_cents, provider_cents, description, actor) lets ONE platform administrator change the active customer price
-- immediately, with no second person and no approval record (docs: TW-4F_Completion_Tracker U-2 / A-13, Pilot Readiness B-6). It is also unconnected to any module today.
--
-- Rule enforced here:
--   * tw4_price_propose  records a proposal (pending, 24 h). It changes NO price.
--   * tw4_price_approve  must be called by a DIFFERENT platform administrator. It re-checks, under locks, that the proposal is unexpired, the requester is still an
--                        administrator and the active price is still the one the proposal was made against; only then does it retire the old price and publish the new one,
--                        once (the proposal becomes 'applied'; replays are idempotent; a decided proposal is final).
--   * tw4_price_reject   closes a pending proposal (the requester may withdraw).
--   * tw4_price_set      keeps its signature and grants, but no longer changes anything: administrators get TW042, everyone else 42501. There is no single-admin path left.
-- The request table is the audit trail (requester, decider, decision note, times, applied price id) and is append-only evidence.
-- Existing price-list rows, the unique one-active-price index and the price-list guard are untouched.
begin;

create table public.studio_sms_price_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage')),
  customer_price_cents int not null check (customer_price_cents > 0),
  provider_cost_cents int not null check (provider_cost_cents >= 0),
  description text not null check (char_length(btrim(description)) between 3 and 200),
  base_price_id uuid null,                 -- the active price when the proposal was made (null: none); the bound fact
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired', 'invalidated')),
  requested_by uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  decided_by uuid null,
  decided_at timestamptz null,
  decision_note text null check (decision_note is null or char_length(decision_note) between 10 and 500),
  applied_price_id uuid null references public.studio_sms_price_list(id) on delete restrict,
  constraint studio_sms_price_change_requests_window check (expires_at > requested_at),
  -- two DISTINCT platform administrators, enforced by the table itself
  constraint studio_sms_price_change_requests_distinct check (status <> 'applied' or (decided_by is not null and decided_by <> requested_by and applied_price_id is not null))
);
create unique index studio_sms_price_change_requests_one_open on public.studio_sms_price_change_requests (kind) where status = 'pending';
revoke all on public.studio_sms_price_change_requests from public, anon, authenticated, service_role;
alter table public.studio_sms_price_change_requests enable row level security;

create or replace function public._tw4pricedual_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_price_change_requests: rows are never deleted' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
    raise exception 'studio_sms_price_change_requests: status moves only through the dual-control functions' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.base_price_id is distinct from old.base_price_id
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at then
    raise exception 'studio_sms_price_change_requests: the binding of a proposal is fixed' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status = 'pending' then
    raise exception 'studio_sms_price_change_requests: % -> % is not a legal transition (a decided proposal is final)', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_price_change_requests_guard before update or delete on public.studio_sms_price_change_requests for each row execute function public._tw4pricedual_guard();
create trigger studio_sms_price_change_requests_truncate before truncate on public.studio_sms_price_change_requests for each statement execute function public._tw4c_truncate_guard();

create or replace function public.tw4_price_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  v_base uuid;
  v_id uuid;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if p_kind is null or p_kind not in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage') or p_customer_cents is null or p_customer_cents <= 0
     or p_provider_cents is null or p_provider_cents < 0 or p_description is null or char_length(btrim(p_description)) not between 3 and 200 then
    raise exception 'a price proposal needs a known kind, a positive customer price, a non-negative provider cost and a description' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  select x.id into v_base from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  select * into q from public.studio_sms_price_change_requests x where x.kind = p_kind and x.status = 'pending' for update;
  if q.id is not null then
    perform set_config('tw4.pricedual_write', 'on', true);
    if q.expires_at <= clock_timestamp() then
      update public.studio_sms_price_change_requests set status = 'expired' where id = q.id;
    elsif q.requested_by = p_actor and q.customer_price_cents = p_customer_cents and q.provider_cost_cents = p_provider_cents and q.base_price_id is not distinct from v_base
          and q.description = btrim(p_description) then
      perform set_config('tw4.pricedual_write', 'off', true);
      return jsonb_build_object('request_id', q.id, 'status', q.status, 'expires_at', q.expires_at, 'replayed', true);
    else
      update public.studio_sms_price_change_requests set status = 'invalidated' where id = q.id;   -- superseded: one open proposal per kind
    end if;
    perform set_config('tw4.pricedual_write', 'off', true);
  end if;
  insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, base_price_id, requested_by, expires_at)
  values (p_kind, p_customer_cents, p_provider_cents, btrim(p_description), v_base, p_actor, clock_timestamp() + interval '24 hours') returning id into v_id;
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'replayed', false);
end $$;

create or replace function public.tw4_price_approve(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  v_cur uuid;
  v_new uuid;
begin
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  perform 1 from public.profiles pr where pr.id in (coalesce(q.requested_by, p_actor), p_actor) order by pr.id for share;
  perform public._tw4c_admin(p_actor);
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
  perform set_config('tw4.pricedual_write', 'on', true);
  if q.expires_at <= clock_timestamp() then
    update public.studio_sms_price_change_requests set status = 'expired' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'expired', 'replayed', false);
  end if;
  select x.id into v_cur from public.studio_sms_price_list x where x.kind = q.kind and x.active;
  if v_cur is distinct from q.base_price_id or not public._tw4_r1_is_platform_admin(q.requested_by) then
    update public.studio_sms_price_change_requests set status = 'invalidated' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.description, p_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note), applied_price_id = v_new where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('status', 'applied', 'replayed', false, 'price_id', v_new);
end $$;

create or replace function public.tw4_price_reject(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_price_change_requests;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a rejection needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.status = 'rejected' then
    return jsonb_build_object('status', 'rejected', 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be rejected', q.status using errcode = 'TW041';
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'rejected', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  return jsonb_build_object('status', 'rejected', 'replayed', false);
end $$;

-- the single-admin path is closed: same signature and grants, no effect
create or replace function public.tw4_price_set(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  raise exception 'a price change needs a proposal and a second platform administrator: use tw4_price_propose and tw4_price_approve' using errcode = 'TW042';
end $$;

revoke all on function public._tw4pricedual_guard() from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_propose(text, int, int, text, uuid), public.tw4_price_approve(uuid, uuid, text), public.tw4_price_reject(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_price_propose(text, int, int, text, uuid), public.tw4_price_approve(uuid, uuid, text), public.tw4_price_reject(uuid, uuid, text) to service_role;

commit;
