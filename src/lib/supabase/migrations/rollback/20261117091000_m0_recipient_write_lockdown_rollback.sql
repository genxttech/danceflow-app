-- Rollback of 20261117091000_m0_recipient_write_lockdown.sql: restores the stage-1 client-role recipient policies,
-- outbound_deliveries client policies, table privileges and the pre-M-0 page RPC grants.
-- Required BEFORE any application rollback below M-0 (the pre-M-0 application must never run against stage 2).
-- Safe with the M-0 application still live (it uses only service-role writes). The stage-1 outbound client-write guard
-- keeps restored client inserts limited to appointment notifications and legacy automation drafts.
-- The stage-1 guards (20261117090000) stay in force: tenants still cannot delete or rewrite rows that were handed to
-- the provider, overwrite an unsubscribed recipient, or clear an unsubscribe record.

begin;

drop policy if exists "studio staff manage marketing campaign recipients" on public.marketing_campaign_recipients;
create policy "studio staff manage marketing campaign recipients" on public.marketing_campaign_recipients
  for all
  using (exists (select 1 from public.user_studio_roles usr
                 where usr.user_id = auth.uid() and usr.studio_id = marketing_campaign_recipients.studio_id
                   and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                   and usr.active = true))
  with check (exists (select 1 from public.user_studio_roles usr
                      where usr.user_id = auth.uid() and usr.studio_id = marketing_campaign_recipients.studio_id
                        and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                        and usr.active = true));

drop policy if exists "Organizer users can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
create policy "Organizer users can manage organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaign_recipients.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaign_recipients.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

drop policy if exists "Platform admins can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
create policy "Platform admins can manage organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for all
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

grant insert, update, delete, truncate on public.marketing_campaign_recipients to anon, authenticated;
grant insert, update, delete, truncate on public.organizer_marketing_campaign_recipients to anon, authenticated;

grant execute on function public.unsubscribe_marketing_recipient(text) to public, anon, authenticated;

-- Outbound deliveries client policies and privileges, as they were before stage 2.
drop policy if exists "outbound_deliveries_insert" on public.outbound_deliveries;
create policy "outbound_deliveries_insert" on public.outbound_deliveries
  for insert to authenticated
  with check (
    (exists (select 1 from public.user_studio_roles usr
             where usr.user_id = auth.uid() and usr.studio_id = outbound_deliveries.studio_id
               and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role, 'instructor'::app_role])
               and usr.active = true))
    or (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'::text))
  );
drop policy if exists "outbound_deliveries_update" on public.outbound_deliveries;
create policy "outbound_deliveries_update" on public.outbound_deliveries
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'::text))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'::text));
grant insert, update, delete, truncate on public.outbound_deliveries to anon, authenticated;

commit;
