-- 20261106090000_twilio_tw3_registration_metadata_rollback.sql
--
-- Reviewed rollback for Twilio TW-3. NEVER run automatically.
--
-- Restores the exact pre-TW-3 studio_sms_registrations schema. Roll the application
-- back FIRST. Fails closed if any TW-3 metadata has been populated (that is setup
-- evidence); to discard it after review, set in the same transaction:
--   set local tw3.allow_data_loss = 'yes';

begin;

do $$
declare
  v_used bigint := 0;
begin
  if to_regclass('public.studio_sms_registrations') is not null
     and exists (
       select 1 from pg_attribute
       where attrelid = 'public.studio_sms_registrations'::regclass and attname = 'brand_status' and not attisdropped
     ) then
    execute $q$
      select count(*) from public.studio_sms_registrations
      where customer_profile_sid is not null or brand_sid is not null or phone_number_sid is not null
         or campaign_use_case is not null or brand_status <> 'not_started' or campaign_status <> 'not_started'
    $q$ into v_used;
    if v_used > 0 and coalesce(current_setting('tw3.allow_data_loss', true), '') <> 'yes' then
      raise exception 'TW-3 rollback refused: % row(s) hold TW-3 registration metadata', v_used;
    end if;
  end if;
end $$;

drop index if exists public.uq_studio_sms_registrations_phone_number_sid;

alter table public.studio_sms_registrations
  drop constraint if exists studio_sms_registrations_approved_requires_full_setup,
  drop constraint if exists studio_sms_registrations_phone_sid_requires_sender,
  drop constraint if exists studio_sms_registrations_campaign_approved_requires_sid_use_case,
  drop constraint if exists studio_sms_registrations_brand_approved_requires_sid,
  drop constraint if exists studio_sms_registrations_campaign_status_check,
  drop constraint if exists studio_sms_registrations_brand_status_check,
  drop constraint if exists studio_sms_registrations_campaign_use_case_check,
  drop constraint if exists studio_sms_registrations_phone_number_sid_check,
  drop constraint if exists studio_sms_registrations_brand_sid_check,
  drop constraint if exists studio_sms_registrations_customer_profile_sid_check,
  drop column if exists campaign_status,
  drop column if exists brand_status,
  drop column if exists campaign_use_case,
  drop column if exists phone_number_sid,
  drop column if exists brand_sid,
  drop column if exists customer_profile_sid;

commit;
