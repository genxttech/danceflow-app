-- Commerce security hardening slice 1.
-- Apply after 20260722114500_commerce_reporting_accuracy.sql.
-- Apply before deploying the matching Commerce security patch.

begin;

revoke delete on public.commerce_entitlements from authenticated;

drop policy if exists "commerce entitlements managers write" on public.commerce_entitlements;
drop policy if exists "commerce entitlements managers insert" on public.commerce_entitlements;
drop policy if exists "commerce entitlements managers update" on public.commerce_entitlements;
drop policy if exists "commerce entitlements managers delete" on public.commerce_entitlements;

create policy "commerce entitlements managers insert"
  on public.commerce_entitlements for insert to authenticated
  with check (
    exists (select 1 from public.user_studio_roles usr
      where usr.studio_id = commerce_entitlements.studio_id
        and usr.user_id = auth.uid() and usr.active = true
        and usr.role::text in ('platform_admin','studio_owner','studio_admin'))
    and exists (select 1 from public.clients client
      where client.id = commerce_entitlements.client_id
        and client.studio_id = commerce_entitlements.studio_id)
    and exists (select 1 from public.commerce_catalog_items item
      where item.id = commerce_entitlements.catalog_item_id
        and item.studio_id = commerce_entitlements.studio_id)
  );

create policy "commerce entitlements managers update"
  on public.commerce_entitlements for update to authenticated
  using (exists (select 1 from public.user_studio_roles usr
    where usr.studio_id = commerce_entitlements.studio_id
      and usr.user_id = auth.uid() and usr.active = true
      and usr.role::text in ('platform_admin','studio_owner','studio_admin')))
  with check (
    exists (select 1 from public.user_studio_roles usr
      where usr.studio_id = commerce_entitlements.studio_id
        and usr.user_id = auth.uid() and usr.active = true
        and usr.role::text in ('platform_admin','studio_owner','studio_admin'))
    and exists (select 1 from public.clients client
      where client.id = commerce_entitlements.client_id
        and client.studio_id = commerce_entitlements.studio_id)
    and exists (select 1 from public.commerce_catalog_items item
      where item.id = commerce_entitlements.catalog_item_id
        and item.studio_id = commerce_entitlements.studio_id)
  );

create or replace function public.commerce_complete_manual_digital_sale(
  p_studio_id uuid, p_catalog_item_id uuid, p_client_id uuid,
  p_payment_method text, p_external_reference text default null,
  p_notes text default null, p_actor_user_id uuid default null
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_item record; v_user_id uuid; v_order_id uuid;
  v_order_item_id uuid; v_payment_id uuid;
begin
  if p_payment_method not in ('cash','check','card','ach','venmo','zelle','other') then
    raise exception 'Payment method is invalid.';
  end if;

  if not exists (select 1 from public.clients client
    where client.id = p_client_id and client.studio_id = p_studio_id) then
    raise exception 'Client was not found in this studio.';
  end if;

  select item.id,item.name,item.item_type,item.price,item.currency into v_item
  from public.commerce_catalog_items item
  join public.commerce_digital_content content
    on content.catalog_item_id=item.id and content.studio_id=item.studio_id
  where item.id=p_catalog_item_id and item.studio_id=p_studio_id
    and item.active=true and item.published=true
    and item.item_type in ('digital_video','video_series','digital_download')
    and content.status='published';
  if not found then raise exception 'Published digital product was not found.'; end if;

  select link.user_id into v_user_id
  from public.client_account_links link
  where link.client_id=p_client_id and link.studio_id=p_studio_id
    and link.status='linked' and link.relationship_type='self'
  order by link.is_primary desc, link.created_at desc limit 1;
  if v_user_id is null then
    raise exception 'This client does not have a linked student account for this studio.';
  end if;

  if exists (select 1 from public.commerce_entitlements entitlement
    where entitlement.studio_id=p_studio_id and entitlement.client_id=p_client_id
      and entitlement.user_id=v_user_id and entitlement.catalog_item_id=p_catalog_item_id
      and entitlement.status in ('active','refunded_access_retained')) then
    raise exception 'This student already has access to this content.';
  end if;

  if p_external_reference is not null and exists (select 1 from public.payments
    where studio_id=p_studio_id and external_reference=p_external_reference
      and payment_channel='manual') then
    raise exception 'That external payment reference is already recorded.';
  end if;

  insert into public.commerce_orders (studio_id,order_number,client_id,customer_type,status,payment_status,fulfillment_status,subtotal,discount_total,tax_total,refund_total,total,currency,notes,created_by,updated_by,completed_at,metadata)
  values (p_studio_id,public.commerce_get_next_order_number(p_studio_id),p_client_id,'client','completed','paid','fulfilled',v_item.price,0,0,0,v_item.price,coalesce(v_item.currency,'usd'),nullif(trim(p_notes),''),p_actor_user_id,p_actor_user_id,now(),jsonb_build_object('source','manual_digital_sale','catalog_item_id',p_catalog_item_id,'student_user_id',v_user_id))
  returning id into v_order_id;

  insert into public.commerce_order_items (order_id,studio_id,catalog_item_id,item_type,name_snapshot,quantity,unit_price,discount_total,tax_total,line_total,fulfillment_status,cogs_total,metadata)
  values (v_order_id,p_studio_id,p_catalog_item_id,v_item.item_type,v_item.name,1,v_item.price,0,0,v_item.price,'fulfilled',0,jsonb_build_object('fulfillment_type','digital_entitlement','entitlement_status','active'))
  returning id into v_order_item_id;

  insert into public.payments (studio_id,client_id,amount,payment_method,status,notes,paid_at,created_by,payment_type,source,payment_channel,currency,external_reference,commerce_order_id)
  values (p_studio_id,p_client_id,v_item.price,p_payment_method,'paid',coalesce(nullif(trim(p_notes),''),'Digital order '||v_order_id::text),now(),p_actor_user_id,'digital_sale','commerce','manual',coalesce(v_item.currency,'usd'),nullif(trim(p_external_reference),''),v_order_id)
  returning id into v_payment_id;

  update public.commerce_orders set payment_id=v_payment_id
  where id=v_order_id and studio_id=p_studio_id;

  insert into public.commerce_entitlements (studio_id,catalog_item_id,client_id,user_id,order_id,order_item_id,entitlement_type,status,granted_at,starts_at,created_by,updated_by,metadata)
  values (p_studio_id,p_catalog_item_id,p_client_id,v_user_id,v_order_id,v_order_item_id,'purchase','active',now(),now(),p_actor_user_id,p_actor_user_id,jsonb_build_object('payment_id',v_payment_id,'payment_method',p_payment_method,'source','manual_digital_sale'));

  return v_order_id;
end;
$$;

grant execute on function public.commerce_complete_manual_digital_sale(uuid,uuid,uuid,text,text,text,uuid) to authenticated;

commit;
