-- ROLLBACK for 20261026090000_gc352_public_class_purchase_holds.sql
--
-- Data-safe by design. Application rollback comes FIRST (no caller may still be
-- starting/finalizing purchases), then this file.
--
--   1. Verifies the exact GC-3.5-2 definitions before touching anything.
--   2. Restores the exact predecessor _group_class_roster_reserved_count
--      (booked attendees only; body md5 79777b57...), same owner/ACL.
--   3. Drops the four GC-3.5-2 RPCs (start/attach/finalize/release).
--   4. The holds table:
--        * ZERO rows  -> dropped with its guard triggers/functions (never used).
--        * ANY rows   -> RETAINED with its rows, RLS, read grants and the
--                        immutability/transition guards. These rows are purchase
--                        evidence (paid conversions and conflicts awaiting or
--                        recording refunds). They no longer reserve capacity
--                        (step 2) and nothing can write them (step 3).
--      Clients, links, attendees and payments created by finalize are ordinary
--      DanceFlow records and are never touched by this rollback.
--   Re-applying the forward migration after a data-retaining rollback needs a
--   dedicated reviewed migration (its precondition refuses an existing table).

begin;

do $$
declare
  v_drift text;
begin
  if to_regclass('public.group_class_enrollment_holds') is null then
    raise exception 'GC-3.5-2 rollback: group_class_enrollment_holds does not exist';
  end if;

  select string_agg(want.sig, ', ') into v_drift
  from (values
    ('public._group_class_roster_reserved_count(uuid)', '6c3b2f2cb9642e991e1f4da0a7b35e4b'),
    ('public.start_public_class_purchase(uuid,text,text,text)', '0412aa4dd5edb763bdd5456ea02207f6'),
    ('public.attach_public_class_purchase_checkout(uuid,text,text,timestamp with time zone)', '868f6467473e2c93f957364133577b6f'),
    ('public.finalize_public_class_purchase(uuid,text,text,text,integer,text)', '07404efdc108a0dcd5fe38389ca6ebdf'),
    ('public.release_public_class_purchase(uuid)', '08f5e4508d6c37ac267266a751079aac'),
    ('public._gc352_guard_hold_transition()', '48d14dc7befe3c0a4435ae9daccb5978'),
    ('public._gc352_refuse_committed_converting()', 'f1f8b6c5b6ced2b9477b1f84dba08f06')
  ) as want(sig, body_md5)
  where to_regprocedure(want.sig) is null
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p where p.oid = to_regprocedure(want.sig)) <> want.body_md5;

  if v_drift is not null then
    raise exception 'GC-3.5-2 rollback: definitions are not the reviewed GC-3.5-2 candidate: %', v_drift;
  end if;
end $$;

-- 2. Exact predecessor (gc3a / gcsc3): booked attendees only.
create or replace function public._group_class_roster_reserved_count(p_appointment_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.appointment_attendees
  where appointment_id = p_appointment_id
    and status = 'booked';
$$;

revoke all on function public._group_class_roster_reserved_count(uuid) from public, anon, authenticated, service_role;

-- 3. The RPCs.
drop function public.start_public_class_purchase(uuid, text, text, text);
drop function public.attach_public_class_purchase_checkout(uuid, text, text, timestamptz);
drop function public.finalize_public_class_purchase(uuid, text, text, text, integer, text);
drop function public.release_public_class_purchase(uuid);

-- 4. The table: drop only if it was never used.
do $$
declare
  v_rows bigint;
begin
  select count(*) into v_rows from public.group_class_enrollment_holds;
  if v_rows = 0 then
    drop table public.group_class_enrollment_holds;
    drop function public._gc352_guard_hold_transition();
    drop function public._gc352_refuse_committed_converting();
    raise notice 'GC-3.5-2 rollback: holds table was empty and has been dropped.';
  else
    raise notice 'GC-3.5-2 rollback: holds table RETAINED with % row(s) as purchase evidence.', v_rows;
  end if;
end $$;

-- Post-conditions.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._group_class_roster_reserved_count(uuid)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and md5(replace(p.prosrc, E'\r', '')) = '79777b57f07320850cdfb06513169715'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres'
  ) then
    raise exception 'GC-3.5-2 rollback: reserved-count predecessor not restored exactly';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('start_public_class_purchase', 'attach_public_class_purchase_checkout',
      'finalize_public_class_purchase', 'release_public_class_purchase')
  ) then
    raise exception 'GC-3.5-2 rollback: a GC-3.5-2 RPC still exists';
  end if;
end $$;

commit;
