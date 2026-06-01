-- 20260601_sms_provider_integration_v1.sql
-- Helpful indexes for Twilio delivery callbacks and inbound message lookup.

create index if not exists idx_sms_message_logs_provider_message_id
  on public.sms_message_logs(provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_sms_contact_permissions_phone_status
  on public.sms_contact_permissions(phone_e164, consent_status);
