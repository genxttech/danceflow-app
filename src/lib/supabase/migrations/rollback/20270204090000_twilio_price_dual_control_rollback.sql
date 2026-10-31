-- Rollback of 20270204090000 (D4-1: dual-controlled SMS price changes). Restores tw4_price_set to its 20261122090000 body BYTE FOR BYTE and drops every object this migration created.
-- REFUSES (SQLSTATE 55000) once any request row exists: a price-change request is audit evidence of who proposed and who approved a published price and is never destroyed;
-- from then on the stance is forward-fix only. Roll the application back first. Published prices themselves are untouched.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_price_change_requests') is null then
    raise exception 'price dual control rollback: not applied';
  end if;
  lock table public.studio_sms_price_change_requests in access exclusive mode;
  if exists (select 1 from public.studio_sms_price_change_requests) then
    raise exception 'price dual control rollback refused: price change requests exist (audit evidence)' using errcode = '55000';
  end if;
end $$;

drop trigger studio_sms_price_list_00_activation on public.studio_sms_price_list;
drop function public._tw4price_activation_guard();

drop function public.tw4_price_propose(text, int, int, text, text, uuid);
drop function public.tw4_price_approve(uuid, uuid, text);
drop function public.tw4_price_reject(uuid, uuid, text);
drop function public.tw4_price_requests_list(uuid);

drop table public.studio_sms_price_change_requests;
drop function public._tw4pricedual_guard();
drop function public._tw4price_kinds();
drop function public._tw4price_admin_active(uuid);

-- as of 20261122090000 (grants are unchanged by create or replace)
create or replace function public.tw4_price_set(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || coalesce(p_kind, '')));
  update public.studio_sms_price_list set active = false where kind = p_kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (p_kind, p_customer_cents, p_provider_cents, p_description, p_actor) returning id into v_id;
  return jsonb_build_object('price_id', v_id);
end $$;

commit;
