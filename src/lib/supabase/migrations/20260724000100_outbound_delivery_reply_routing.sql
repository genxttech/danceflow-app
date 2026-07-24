begin;

alter table public.outbound_deliveries
  add column if not exists reply_to_email text;

comment on column public.outbound_deliveries.reply_to_email is
  'Tenant-scoped Reply-To address used for an outbound email. Null for SMS and DanceFlow system/platform messages.';

alter table public.outbound_deliveries
  drop constraint if exists outbound_deliveries_reply_to_email_length_check;

alter table public.outbound_deliveries
  add constraint outbound_deliveries_reply_to_email_length_check
  check (reply_to_email is null or char_length(reply_to_email) <= 320);

-- Preserve reply routing for already queued studio-originated emails. DanceFlow
-- platform/system templates intentionally remain non-studio-routed.
update public.outbound_deliveries as delivery
set
  reply_to_email = lower(trim(studio.email)),
  updated_at = now()
from public.studios as studio
where delivery.studio_id = studio.id
  and delivery.channel = 'email'
  and delivery.status = 'queued'
  and delivery.reply_to_email is null
  and nullif(trim(studio.email), '') is not null
  and delivery.template_key not like 'platform\_%' escape '\'
  and delivery.template_key not like 'danceflow\_%' escape '\'
  and delivery.template_key not in ('welcome_to_danceflow', 'platform_admin_invite');

commit;
