-- Rollback of 20270204090000 (D4-1: dual-controlled SMS price changes). FAIL CLOSED: it never restores single-administrator price publication.
--
-- What "rolled back" means (and why it differs from the catalog before the migration):
--   * tw4_price_set is NOT restored to its 20261122090000 body. It stays the refusing stub (TW042), and EXECUTE is revoked from every role, including service_role.
--   * The price-list triggers stay (ENABLE ALWAYS). The insert guard is rewritten to refuse EVERY insert ("price publication is disabled"); update, delete and truncate
--     stay refused as before (retiring a price stays possible).
--   * If any request row or approver-registry row exists, the three tables (requests, approvers, limits) are RETAINED with their guards: audit evidence and authorization
--     data are never destroyed. With no such rows they are dropped.
--   * Every callable function of the migration (propose, approve, reject, list, verify, the internal _tw4price_do_* and helpers) is dropped.
--   So the catalog after this rollback differs from the pre-migration catalog by exactly: tw4_price_set's privileges, the refusing _tw4price_activation_guard and
--   _tw4price_truncate_guard functions with their two price-list triggers, and (only when evidence exists) the retained tables and their guard functions.
--   That deviation is deliberate: the alternative (restoring the old body) would reopen the single-administrator hole.
-- REFUSES (SQLSTATE 55000) when tw4_price_set or one of the guarded functions is no longer the body this migration installed (a later slice replaced it).
-- RECOVERY after a rollback, with or without evidence: re-apply 20270204090000 (idempotent over retained tables). The full reverse chain (20261122090000's rollback) removes
-- tw4_price_set and the price list itself, which drops the two triggers; the two refusing guard functions then remain, harmless and replaced by a re-apply.
begin;

set local lock_timeout = '5s';

do $$
declare
  r record;
begin
  if to_regprocedure('public.tw4_price_propose(text,integer,integer,text,text)') is null then
    raise exception 'price dual control rollback: not applied';
  end if;
  -- a later slice must not be clobbered: the bodies must still be exactly the ones this migration installed (line endings ignored)
  for r in select * from (values
      ('public.tw4_price_set(text,integer,integer,text,uuid)', '0821967b21143cd9820a12a00da1d745'),
      ('public.tw4_price_propose(text,integer,integer,text,text)', '97ae77e15c1e60d01c7b9887f0e7fbf5'),
      ('public.tw4_price_approve(uuid,text)', '387af03f65f1e1298a6341c23378ac3c'),
      ('public._tw4price_do_approve(uuid,uuid,text)', '4030438f5d7d89ceead9226c09a8719f'),
      ('public._tw4price_activation_guard()', '40be6b54f38eb9ad0e017343156fc7c0')) as x(sig, h) loop
    if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure(r.sig)) is distinct from r.h then
      raise exception 'price dual control rollback refused: % is no longer the body installed by 20270204090000', r.sig using errcode = '55000';
    end if;
  end loop;
  lock table public.studio_sms_price_change_requests, public.studio_sms_price_approvers, public.studio_sms_price_limits in access exclusive mode;
end $$;

-- fail closed FIRST: no price can be published, by anyone, from here on
create or replace function public._tw4price_activation_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    raise exception 'price publication is disabled: the dual-control price machinery was rolled back (re-apply 20270204090000 to publish prices)' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published price is never deleted (a retired price stays as history)' using errcode = '42501';
  end if;
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
revoke all on function public.tw4_price_set(text, int, int, text, uuid) from public, anon, authenticated, service_role;

drop function public.tw4_price_propose(text, int, int, text, text);
drop function public.tw4_price_approve(uuid, text);
drop function public.tw4_price_reject(uuid, text);
drop function public.tw4_price_requests_list();
drop function public.tw4_price_verify(timestamptz);
drop function public._tw4price_do_propose(text, int, int, text, text, uuid);
drop function public._tw4price_do_approve(uuid, uuid, text);
drop function public._tw4price_do_reject(uuid, uuid, text);
drop function public._tw4price_do_list(uuid);
drop function public._tw4price_session_actor(text);
drop function public._tw4price_registered_at(uuid, timestamptz);
drop function public._tw4price_admin_active(uuid);
drop function public._tw4price_kinds();

do $$
begin
  -- evidence or authorization data exists: keep all three tables and their guards; otherwise remove them
  if exists (select 1 from public.studio_sms_price_change_requests) or exists (select 1 from public.studio_sms_price_approvers) then
    raise notice 'price dual control rollback: request / registry rows exist, the tables are retained';
  else
    drop table public.studio_sms_price_change_requests;
    drop table public.studio_sms_price_approvers;
    drop table public.studio_sms_price_limits;
    drop function public._tw4pricedual_guard();
    drop function public._tw4price_registry_guard();
  end if;
end $$;

commit;
