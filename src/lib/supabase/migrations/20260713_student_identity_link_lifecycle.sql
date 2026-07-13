-- DanceFlow Student Identity link lifecycle.
-- Makes invitations explicit and prevents email-only silent linking.

alter table public.client_account_links
  alter column user_id drop not null;

alter table public.client_account_links
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz,
  add column if not exists invite_sent_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists conflict_details text;

drop index if exists public.client_account_links_client_user_unique;

create unique index if not exists client_account_links_client_user_unique
  on public.client_account_links(client_id, user_id)
  where user_id is not null;

create unique index if not exists client_account_links_one_open_invitation_per_client
  on public.client_account_links(client_id)
  where status in ('invited', 'claim_pending');

create index if not exists client_account_links_invited_email_status_idx
  on public.client_account_links(lower(invited_email), status)
  where invited_email is not null;

create index if not exists client_account_links_invite_token_hash_idx
  on public.client_account_links(invite_token_hash)
  where invite_token_hash is not null;

alter table public.client_account_links
  drop constraint if exists client_account_links_linked_requires_user_check;

alter table public.client_account_links
  add constraint client_account_links_linked_requires_user_check
  check (
    status not in ('linked', 'disconnected', 'former_client', 'rejected', 'conflict')
    or user_id is not null
  ) not valid;

alter table public.client_account_links
  validate constraint client_account_links_linked_requires_user_check;

create or replace function public.claim_client_account_invitation(
  p_user_id uuid,
  p_email text,
  p_studio_id uuid default null
)
returns table(client_id uuid, studio_id uuid, link_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(p_email, '')));
  invitation record;
  existing_user uuid;
begin
  if p_user_id is null or normalized_email = '' then
    return;
  end if;

  for invitation in
    select cal.*
    from public.client_account_links cal
    where cal.status in ('invited', 'claim_pending')
      and lower(trim(coalesce(cal.invited_email, ''))) = normalized_email
      and (p_studio_id is null or cal.studio_id = p_studio_id)
      and (cal.invite_expires_at is null or cal.invite_expires_at > now())
    order by cal.created_at asc
    for update
  loop
    select c.portal_user_id
      into existing_user
    from public.clients c
    where c.id = invitation.client_id
      and c.studio_id = invitation.studio_id
    for update;

    if existing_user is not null and existing_user <> p_user_id then
      update public.client_account_links
      set
        status = 'conflict',
        user_id = existing_user,
        conflict_details = 'Client record was already connected to a different DanceFlow account.',
        updated_at = now()
      where id = invitation.id;

      continue;
    end if;

    update public.clients
    set
      portal_user_id = p_user_id,
      updated_at = now()
    where id = invitation.client_id
      and studio_id = invitation.studio_id
      and (portal_user_id is null or portal_user_id = p_user_id);

    update public.client_account_links
    set
      user_id = p_user_id,
      status = 'linked',
      claimed_at = coalesce(claimed_at, now()),
      linked_at = coalesce(linked_at, now()),
      accepted_at = coalesce(accepted_at, now()),
      disconnected_at = null,
      disconnected_by = null,
      disconnect_reason = null,
      rejected_at = null,
      conflict_details = null,
      updated_at = now()
    where id = invitation.id;

    client_id := invitation.client_id;
    studio_id := invitation.studio_id;
    link_id := invitation.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_client_account_invitation(uuid, text, uuid) from public;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;

drop policy if exists client_account_links_self_select on public.client_account_links;
create policy client_account_links_self_select
on public.client_account_links
for select
to authenticated
using (user_id = auth.uid());

comment on function public.claim_client_account_invitation(uuid, text, uuid) is
  'Claims only explicit, unexpired client-account invitations matching the authenticated email.';
