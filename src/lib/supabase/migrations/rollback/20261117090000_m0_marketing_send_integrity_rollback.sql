-- Rollback of 20261117090000_m0_marketing_send_integrity.sql: restores the exact pre-M-0 schema (verified with
-- sql-tests/m0_marketing_fingerprint.sql), including the PAY-WH-1 dispatcher claim function.
--
-- NOT part of a normal application rollback. Stage 1 is compatible with the pre-M-0 application and stays in place:
-- it carries the send freeze, the legacy unsubscribe compatibility (organizer page persistence, per-message tokens on
-- the legacy studio RPC) and the client-write guards, and the rollback-compat build's one-click endpoint depends on it.
--
-- This file removes M-0 only when NOTHING depends on it. It refuses (changing nothing) unless all of these hold, and it
-- has NO override:
--   * stage 2 (20261117091000) has been rolled back;
--   * marketing sends are frozen;
--   * no recipient was ever handed to the email provider by M-0 (first_attempt_at) and none is in an M-0-only status;
--   * no per-message unsubscribe token, platform suppression, test-send record or M-0 unsubscribe audit detail exists.
-- Once M-0 has sent anything, its unsubscribe links depend on this infrastructure, so this file can no longer run.
-- Any exceptional teardown after that is a separately authorized recovery procedure that must keep every issued
-- unsubscribe link working (docs/marketing/m0-email-compliance.md §6).
--
-- It returns the database to S0: it removes the send freeze itself (campaign hiding, dispatcher hold), so marketing
-- becomes sendable by the pre-M-0 application and held commercial email is dispatched. It therefore needs the same
-- separate owner authorization as releasing the freeze, and the application must already be below M-0.
--
-- Unsubscribe records themselves are never deleted by this rollback.

begin;

do $$
declare
  v_blockers text := '';
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'outbound_deliveries' and policyname = 'outbound_deliveries_insert')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'marketing_campaign_recipients'
                    and policyname = 'studio staff manage marketing campaign recipients') then
    raise exception 'M-0 rollback refused: roll back 20261117091000 (stage 2) first';
  end if;
  if to_regproc('public.marketing_send_frozen') is null or not public.marketing_send_frozen() then
    raise exception 'M-0 rollback refused: marketing sends must be frozen first';
  end if;
  if exists (select 1 from public.marketing_campaign_recipients where first_attempt_at is not null or status in ('sending', 'suppressed', 'delivery_unknown'))
     or exists (select 1 from public.organizer_marketing_campaign_recipients where first_attempt_at is not null or status in ('sending', 'suppressed', 'delivery_unknown')) then
    v_blockers := v_blockers || ' recipients-mailed-by-m0';
  end if;
  if exists (select 1 from public.marketing_email_suppressions) then v_blockers := v_blockers || ' platform-suppressions'; end if;
  if exists (select 1 from public.marketing_message_unsubscribe_tokens) then v_blockers := v_blockers || ' message-tokens'; end if;
  if exists (select 1 from public.marketing_test_sends) then v_blockers := v_blockers || ' test-sends'; end if;
  if exists (select 1 from public.marketing_unsubscribes where source is not null or last_source is not null or campaign_id is not null or recipient_id is not null or request_count <> 1)
     or exists (select 1 from public.organizer_marketing_unsubscribes where source is not null or last_source is not null or campaign_id is not null or recipient_id is not null or request_count <> 1) then
    v_blockers := v_blockers || ' unsubscribe-audit';
  end if;
  if v_blockers <> '' then
    raise exception 'M-0 rollback refused (M-0 is in use; issued unsubscribe links depend on it):%', v_blockers;
  end if;
end;
$$;

drop trigger if exists marketing_unsubscribes_00_m0_guard on public.marketing_unsubscribes;
drop trigger if exists organizer_marketing_unsubscribes_00_m0_guard on public.organizer_marketing_unsubscribes;
drop trigger if exists marketing_campaign_recipients_00_m0_guard on public.marketing_campaign_recipients;
drop trigger if exists organizer_marketing_campaign_recipients_00_m0_guard on public.organizer_marketing_campaign_recipients;
drop trigger if exists organizer_contacts_00_m0_unsubscribe_guard on public.organizer_contacts;
drop trigger if exists outbound_deliveries_00_m0_content_origin_guard on public.outbound_deliveries;
drop trigger if exists marketing_campaigns_00_m0_delete_guard on public.marketing_campaigns;
drop trigger if exists organizer_marketing_campaigns_00_m0_delete_guard on public.organizer_marketing_campaigns;
drop trigger if exists organizer_marketing_campaign_recipients_10_m0_legacy_unsubscribe on public.organizer_marketing_campaign_recipients;
drop policy if exists "m0 freeze hides campaigns" on public.marketing_campaigns;
drop policy if exists "m0 freeze hides campaigns" on public.organizer_marketing_campaigns;
drop trigger if exists outbound_deliveries_01_m0_client_write_guard on public.outbound_deliveries;

-- Freeze and visibility policies (section 10 / 12 of the migration).
drop policy if exists "m0 freeze hides pending recipients" on public.marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient inserts" on public.marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient updates" on public.marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient deletes" on public.marketing_campaign_recipients;
drop policy if exists "m0 freeze hides pending recipients" on public.organizer_marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient inserts" on public.organizer_marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient updates" on public.organizer_marketing_campaign_recipients;
drop policy if exists "m0 freeze blocks recipient deletes" on public.organizer_marketing_campaign_recipients;
drop policy if exists "m0 marketing managers can view campaign recipients" on public.marketing_campaign_recipients;
drop policy if exists "m0 marketing managers can view unsubscribes" on public.marketing_unsubscribes;
drop policy if exists "studio members can view marketing campaign recipients" on public.marketing_campaign_recipients;
create policy "studio members can view marketing campaign recipients" on public.marketing_campaign_recipients
  for select using (public.user_has_studio_access(studio_id));
drop policy if exists "studio members can view marketing unsubscribes" on public.marketing_unsubscribes;
create policy "studio members can view marketing unsubscribes" on public.marketing_unsubscribes
  for select using (public.user_has_studio_access(studio_id));

-- PAY-WH-1 dispatcher claim, restored byte-for-byte from 20261116091000_paywh1_settlement_outbox.sql (grants unchanged).
create or replace function public.claim_outbound_deliveries(
  p_owner uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns setof public.outbound_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner is null then
    raise exception 'claim_outbound_deliveries: owner is required' using errcode = '22023';
  end if;

  return query
  with due as (
    select d.id
    from public.outbound_deliveries d
    where d.status = 'queued'
      and (d.claim_owner is null or d.claim_expires_at <= now())
    order by d.created_at
    limit least(greatest(coalesce(p_limit, 25), 1), 200)
    for update skip locked
  )
  update public.outbound_deliveries d
  set claim_owner = p_owner,
      claim_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 1800))
  from due
  where d.id = due.id
  returning d.*;
end;
$$;

drop function if exists public._mkt_guard_unsubscribe_writes();
drop function if exists public._mkt_guard_recipient_writes();
drop function if exists public._mkt_guard_contact_unsubscribe();
drop function if exists public._mkt_guard_campaign_delete();
drop function if exists public._mkt_guard_outbound_content_origin();
drop function if exists public._mkt_guard_outbound_client_writes();
drop function if exists public._mkt_outbound_appointment_payload(uuid, uuid, text, text, text, text);
drop function if exists public._mkt_outbound_automation_recipient_ok(uuid, uuid, text);
drop function if exists public._mkt_outbound_appointment_recipient_ok(uuid, uuid, text, text, text);
drop function if exists public._mkt_outbound_automation_action_ok(uuid, uuid);
drop function if exists public._mkt_persist_legacy_organizer_unsubscribe();
drop function if exists public._mkt_can_view_studio_marketing(uuid);
drop function if exists public._mkt_is_commercial_outbound(text, text, jsonb);
drop function if exists public.marketing_set_send_freeze(boolean, text);
drop function if exists public.marketing_send_frozen();
drop function if exists public._mkt_campaign_has_mailed(text, uuid);
drop function if exists public._mkt_campaign_exists(text, uuid);
drop function if exists public.marketing_authorize_test_send(text, uuid, uuid, uuid, text, integer);
drop function if exists public.marketing_unsubscribe_by_token(text, text);
drop function if exists public.marketing_issue_message_unsubscribe_token(text, uuid, text, text, uuid);
drop function if exists public.marketing_complete_campaign_recipient(text, uuid, uuid, uuid, text, text, text);
drop function if exists public.marketing_claim_campaign_recipient(text, uuid, uuid, uuid, integer);
drop function if exists public.marketing_sync_campaign_recipients(text, uuid, uuid, jsonb);
drop function if exists public.marketing_suppression_status(text, uuid, text);
drop function if exists public._mkt_suppression_status(text, uuid, text);
drop function if exists public._mkt_lock_email(text);
drop function if exists public._mkt_norm_email(text);

drop table if exists public.marketing_test_sends;
drop table if exists public.marketing_message_unsubscribe_tokens;
drop table if exists public.marketing_email_suppressions;
drop table if exists public.marketing_send_control_events;
drop table if exists public.marketing_send_controls;

alter table public.marketing_campaign_recipients drop constraint if exists marketing_campaign_recipients_claim_shape;
alter table public.organizer_marketing_campaign_recipients drop constraint if exists organizer_marketing_campaign_recipients_claim_shape;
alter table public.marketing_campaign_recipients drop constraint if exists marketing_campaign_recipients_status_check;
alter table public.marketing_campaign_recipients add constraint marketing_campaign_recipients_status_check
  check (status = any (array['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'unsubscribed'::text]));
alter table public.organizer_marketing_campaign_recipients drop constraint if exists organizer_marketing_campaign_recipients_status_check;
alter table public.organizer_marketing_campaign_recipients add constraint organizer_marketing_campaign_recipients_status_check
  check (status = any (array['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'unsubscribed'::text]));

alter table public.marketing_campaign_recipients
  drop column if exists claim_id, drop column if exists claimed_at, drop column if exists claim_expires_at,
  drop column if exists first_attempt_at, drop column if exists attempt_count, drop column if exists last_attempt_error,
  drop column if exists status_changed_at;
alter table public.organizer_marketing_campaign_recipients
  drop column if exists claim_id, drop column if exists claimed_at, drop column if exists claim_expires_at,
  drop column if exists first_attempt_at, drop column if exists attempt_count, drop column if exists last_attempt_error,
  drop column if exists status_changed_at;
alter table public.marketing_unsubscribes
  drop column if exists source, drop column if exists last_source, drop column if exists last_requested_at,
  drop column if exists request_count, drop column if exists campaign_id, drop column if exists recipient_id;
alter table public.organizer_marketing_unsubscribes
  drop column if exists source, drop column if exists last_source, drop column if exists last_requested_at,
  drop column if exists request_count, drop column if exists campaign_id, drop column if exists recipient_id;

-- Pre-M-0 policies and privileges.
drop policy if exists "studio staff manage marketing unsubscribes" on public.marketing_unsubscribes;
create policy "studio staff manage marketing unsubscribes" on public.marketing_unsubscribes
  for all
  using (exists (select 1 from public.user_studio_roles usr
                 where usr.user_id = auth.uid() and usr.studio_id = marketing_unsubscribes.studio_id
                   and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                   and usr.active = true))
  with check (exists (select 1 from public.user_studio_roles usr
                      where usr.user_id = auth.uid() and usr.studio_id = marketing_unsubscribes.studio_id
                        and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                        and usr.active = true));

drop policy if exists "Organizer users can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
create policy "Organizer users can manage organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_unsubscribes.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_unsubscribes.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

drop policy if exists "Platform admins can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
create policy "Platform admins can manage organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for all
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

grant insert, update, delete, truncate on public.marketing_unsubscribes to anon, authenticated;
grant insert, update, delete, truncate on public.organizer_marketing_unsubscribes to anon, authenticated;

-- Pre-M-0 page RPC, restored byte-for-byte from marketing-campaign-send-unsubscribe-migration.sql.
create or replace function public.unsubscribe_marketing_recipient(p_token text)
returns table (
  success boolean,
  studio_name text,
  email text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  recipient_record record;
  existing_unsubscribe_id uuid;
begin
  select
    mcr.id,
    mcr.studio_id,
    mcr.email,
    s.name as studio_name
  into recipient_record
  from public.marketing_campaign_recipients mcr
  join public.studios s on s.id = mcr.studio_id
  where mcr.unsubscribe_token = p_token
  limit 1;

  if recipient_record.id is null then
    return query select false, null::text, null::text;
    return;
  end if;

  select mu.id
  into existing_unsubscribe_id
  from public.marketing_unsubscribes mu
  where mu.studio_id = recipient_record.studio_id
    and lower(mu.email) = lower(recipient_record.email)
  limit 1;

  if existing_unsubscribe_id is null then
    insert into public.marketing_unsubscribes (
      studio_id,
      email,
      reason,
      unsubscribed_at,
      created_at
    )
    values (
      recipient_record.studio_id,
      lower(recipient_record.email),
      'recipient_unsubscribe_link',
      now(),
      now()
    );
  else
    update public.marketing_unsubscribes
    set
      reason = coalesce(reason, 'recipient_unsubscribe_link'),
      unsubscribed_at = now()
    where id = existing_unsubscribe_id;
  end if;

  update public.marketing_campaign_recipients
  set
    status = case
      when status = 'pending' then 'unsubscribed'
      else status
    end,
    error_message = case
      when status = 'pending' then 'Unsubscribed before send'
      else error_message
    end
  where id = recipient_record.id;

  return query select true, recipient_record.studio_name::text, lower(recipient_record.email)::text;
end;
$$;

grant execute on function public.unsubscribe_marketing_recipient(text) to anon;
grant execute on function public.unsubscribe_marketing_recipient(text) to authenticated;

commit;
