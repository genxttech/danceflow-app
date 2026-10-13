-- Marketing M-0 (stage 2 of 2) -- remove direct client-role writes to campaign recipients.
--
-- Apply ONLY AFTER the M-0 application is live. From then on every recipient write goes through the service-role
-- functions of 20261117090000 (marketing_sync_campaign_recipients, marketing_claim_campaign_recipient,
-- marketing_complete_campaign_recipient, marketing_unsubscribe_by_token). The pre-M-0 application wrote recipient rows
-- with the signed-in user's client and called unsubscribe_marketing_recipient as anon; after this migration it would
-- fail closed (no recipient changes, no sends), so the release order is: stage 1 SQL -> application -> stage 2 SQL.
--
-- Tenants keep read access (campaign pages show recipient lists and statuses). Campaign rows themselves (drafts, status)
-- stay writable by studio staff / organizer users through their existing policies.
--
-- Also removes every client-role write to outbound_deliveries (D): the M-0 application queues all notifications with
-- the service role, so a signed-in user can no longer create, re-route or forge a queued email/SMS by any path.
--
-- The pre-M-0 application must NEVER run against this stage (its sends would be accepted by the provider but not
-- recorded, and its studio unsubscribe page would fail). Roll this file back BEFORE any application rollback.
--
-- Rollback: rollback/20261117091000_m0_recipient_write_lockdown_rollback.sql (restores the stage-1 policies/grants).

begin;

drop policy if exists "studio staff manage marketing campaign recipients" on public.marketing_campaign_recipients;
drop policy if exists "Organizer users can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
drop policy if exists "Platform admins can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;

revoke insert, update, delete, truncate on public.marketing_campaign_recipients from anon, authenticated;
revoke insert, update, delete, truncate on public.organizer_marketing_campaign_recipients from anon, authenticated;

-- Outbound deliveries: no client-role writes (service role only).
drop policy if exists "outbound_deliveries_insert" on public.outbound_deliveries;
drop policy if exists "outbound_deliveries_update" on public.outbound_deliveries;
revoke insert, update, delete, truncate on public.outbound_deliveries from anon, authenticated;

-- The pre-M-0 page RPC: the new pages post to the server unsubscribe endpoint instead.
revoke execute on function public.unsubscribe_marketing_recipient(text) from public, anon, authenticated;
grant execute on function public.unsubscribe_marketing_recipient(text) to service_role;

commit;
