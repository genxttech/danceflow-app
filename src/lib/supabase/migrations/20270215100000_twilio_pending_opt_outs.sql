-- TW-4F compliance: durable pending opt-outs. GIT-ONLY: not applied anywhere. Roll the app back first (see rollback file).
--
-- Why: an inbound STOP is claimed in sms_webhook_receipts BEFORE its consent change. If record_sms_inbound_opt_event then fails (twice, inline), Twilio
-- does not retry the 5xx, and the only other recovery (usage reconciler) is unscheduled and gated. The webhook parks the intent here and a scheduled
-- caller applies it with the canonical STOP. A later START supersedes it (latest intent wins), so a recovered STOP never undoes a START.
--
-- Service-role only. No client-visible grants. Everything is idempotent.

begin;

create table if not exists public.studio_sms_pending_opt_outs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{9,14}$'),
  message_sid text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  superseded_at timestamptz,
  attempts int not null default 0,
  last_error_code text
);

-- one waiting opt-out per studio + phone
create unique index if not exists uq_studio_sms_pending_opt_outs_open
  on public.studio_sms_pending_opt_outs (studio_id, phone_e164)
  where applied_at is null and superseded_at is null;

alter table public.studio_sms_pending_opt_outs enable row level security;
revoke all on public.studio_sms_pending_opt_outs from public, anon, authenticated, service_role;

create or replace function public.sms_pending_opt_out_record(p_studio_id uuid, p_phone_e164 text, p_message_sid text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_phone text := trim(coalesce(p_phone_e164, ''));
begin
  -- validated here so a bad input returns false with no database error text (which would echo the number)
  if p_studio_id is null or v_phone !~ '^\+[1-9][0-9]{9,14}$' or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    return false;
  end if;
  insert into public.studio_sms_pending_opt_outs (studio_id, phone_e164, message_sid)
  values (p_studio_id, v_phone, left(p_message_sid, 80))
  on conflict (studio_id, phone_e164) where applied_at is null and superseded_at is null do nothing;
  return true;
end $$;

create or replace function public.sms_pending_opt_out_supersede(p_studio_id uuid, p_phone_e164 text)
returns integer language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_rows int;
begin
  update public.studio_sms_pending_opt_outs
     set superseded_at = now()
   where studio_id = p_studio_id and phone_e164 = trim(coalesce(p_phone_e164, ''))
     and applied_at is null and superseded_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- Applies waiting opt-outs with the canonical STOP. Each row is its own subtransaction: one failure never blocks the others. Rows locked by a
-- concurrent supersede/apply are skipped and picked up by the next run.
create or replace function public.sms_pending_opt_out_apply(p_limit integer default 50)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  v_applied int := 0;
  v_failed int := 0;
begin
  -- bounded retention: finished rows older than 90 days, a small batch per run
  delete from public.studio_sms_pending_opt_outs
   where id in (select id from public.studio_sms_pending_opt_outs
                 where coalesce(applied_at, superseded_at) < now() - interval '90 days' limit 100);
  -- fewest attempts first, so a row that keeps failing cannot starve newer ones
  for r in
    select id, studio_id, phone_e164 from public.studio_sms_pending_opt_outs
     where applied_at is null and superseded_at is null
     order by attempts, created_at
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
       for update skip locked
  loop
    begin
      perform public.record_sms_inbound_opt_event(r.studio_id, r.phone_e164, 'stop');
      update public.studio_sms_pending_opt_outs set applied_at = now(), attempts = attempts + 1, last_error_code = null where id = r.id;
      v_applied := v_applied + 1;
    exception when others then
      update public.studio_sms_pending_opt_outs set attempts = attempts + 1, last_error_code = sqlstate where id = r.id;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'failed', v_failed);
end $$;

revoke all on function public.sms_pending_opt_out_record(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.sms_pending_opt_out_supersede(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.sms_pending_opt_out_apply(integer) from public, anon, authenticated, service_role;
grant execute on function public.sms_pending_opt_out_record(uuid, text, text) to service_role;
grant execute on function public.sms_pending_opt_out_supersede(uuid, text) to service_role;
grant execute on function public.sms_pending_opt_out_apply(integer) to service_role;

commit;
