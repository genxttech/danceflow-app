-- Template: identifiers, names and amounts are placeholders in square brackets, so this file fails as written.
-- G-SUB prerequisite status (READ-ONLY; run with sb.sh prod-read). One JSON row; nothing written.
select jsonb_build_object(
  'now', now(),
  'pilot_studio', (select jsonb_build_object('id', id, 'name', name, 'status', subscription_status) from public.studios where id = '[PILOT-STUDIO-ID]'),
  'platform_admins', (select count(*) from public.profiles where platform_role = 'platform_admin'),
  'P0_access_enabled', coalesce((select enabled from public.studio_sms_onboarding_access where studio_id = '[PILOT-STUDIO-ID]'), false),
  'onboarding', (select jsonb_build_object('state', state, 'legal_name', legal_name, 'ein_last4_present', ein_last4 is not null, 'ein_stored', ein_stored_at is not null,
      'attested', attested_at is not null, 'attested_by_is_active_owner', exists (select 1 from public.user_studio_roles r where r.user_id = o.attested_by and r.studio_id = o.studio_id and r.role = 'studio_owner' and r.active),
      'rep_fields_present', rep_first_name is not null and rep_last_name is not null and rep_email is not null, 'address_present', address_line1 is not null, 'submitted_at', submitted_at)
    from public.studio_sms_onboarding o where studio_id = '[PILOT-STUDIO-ID]' and state <> 'cancelled' order by created_at desc limit 1),
  'P2_entity', (select jsonb_build_object('id', e.id, 'legal_name', e.legal_name, 'spend_cap_cents', e.spend_cap_cents) from public.studio_sms_legal_entities e join public.studio_sms_entity_studios s on s.legal_entity_id = e.id where s.studio_id = '[PILOT-STUDIO-ID]'),
  'entities_total', (select count(*) from public.studio_sms_legal_entities),
  'twilio_accounts_total', (select count(*) from public.studio_sms_twilio_accounts),
  'subaccount_confirmations_total', (select count(*) from public.studio_sms_subaccount_confirmations),
  'provisioning_steps_total', (select count(*) from public.studio_sms_provisioning_steps),
  'spend_events_total', (select count(*) from public.studio_sms_spend_events),
  'six_prices_active', (select count(*) from public.studio_sms_price_list where active)
) as r
