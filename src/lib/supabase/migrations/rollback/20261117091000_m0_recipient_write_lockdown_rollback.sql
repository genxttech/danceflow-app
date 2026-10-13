-- Rollback of 20261117091000_m0_recipient_write_lockdown.sql: restores the stage-1 client-role recipient policies,
-- table privileges and the pre-M-0 page RPC grants. Only needed if the application must roll back below M-0.
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

commit;
