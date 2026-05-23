-- DanceFlow Marketing Campaign Send/Unsubscribe V1
-- Run in Supabase SQL editor before testing live campaign sends.

alter table public.marketing_campaign_recipients
add column if not exists unsubscribe_token text;

create unique index if not exists marketing_campaign_recipients_unsubscribe_token_unique
on public.marketing_campaign_recipients (unsubscribe_token)
where unsubscribe_token is not null;

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
