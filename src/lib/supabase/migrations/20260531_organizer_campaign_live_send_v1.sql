begin;

alter table public.organizer_marketing_campaign_recipients
add column if not exists unsubscribe_token uuid;

update public.organizer_marketing_campaign_recipients
set unsubscribe_token = gen_random_uuid()
where unsubscribe_token is null;

create unique index if not exists uq_organizer_marketing_campaign_recipients_unsubscribe_token
on public.organizer_marketing_campaign_recipients(unsubscribe_token)
where unsubscribe_token is not null;

create index if not exists idx_organizer_marketing_campaign_recipients_pending
on public.organizer_marketing_campaign_recipients(campaign_id, organizer_id, created_at)
where status = 'pending';

notify pgrst, 'reload schema';

commit;
