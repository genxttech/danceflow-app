-- Rollback of 20261231140000_twilio_inbound_absorbed_alert.sql: drops the four functions and restores the alert-kind constraint WITHOUT the two kinds this migration added.
-- REFUSES (55000) while any alert row uses one of those kinds (history is never deleted or rewritten), or when the live constraint does not carry exactly them.
begin;
set local lock_timeout = '5s';
do $$
declare
  v_new text[] := array['inbound_absorbed_allowance', 'inbound_volume_high'];
  v_name text;
  v_def text;
  v_vals text[];
begin
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'inbound absorbed alert rollback refused: the alert-kind constraint is missing' using errcode = '55000';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or not (v_new <@ v_vals) then
    raise exception 'inbound absorbed alert rollback refused: the alert-kind constraint does not carry this migration''s kinds (a later change, or already rolled back)' using errcode = '55000';
  end if;
  if exists (select 1 from public.studio_sms_provider_alerts a where a.kind = any (v_new)) then
    raise exception 'inbound absorbed alert rollback refused: alert rows use a kind that only 20261231140000 allows; they are never deleted or rewritten' using errcode = '55000';
  end if;
  v_vals := (select array_agg(x order by x) from unnest(v_vals) x where x <> all (v_new));
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;
drop function if exists public.tw4_rfl_inbound_allowance_check();
drop function if exists public._tw4ia_absorbed_cents(uuid, timestamptz);
drop function if exists public._tw4ia_daily_segment_limit();
drop function if exists public._tw4ia_allowance_cents();
commit;
