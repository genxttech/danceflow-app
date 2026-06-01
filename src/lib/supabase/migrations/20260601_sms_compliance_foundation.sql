-- 20260601_sms_compliance_foundation_no_leads.sql
-- SMS Compliance Foundation V1
-- Supports studio clients and organizer contacts.
-- No public.leads reference because this schema does not have a leads table.

create table if not exists public.sms_contact_permissions (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,

  client_id uuid references public.clients(id) on delete cascade,
  organizer_contact_id uuid references public.organizer_contacts(id) on delete cascade,

  phone_e164 text not null,

  consent_status text not null default 'unknown',
  consent_source text,
  consent_note text,
  consent_at timestamptz,
  opted_out_at timestamptz,
  opted_out_source text,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sms_contact_permissions_workspace_check check (
    (studio_id is not null and organizer_id is null)
    or
    (studio_id is null and organizer_id is not null)
  ),

  constraint sms_contact_permissions_contact_check check (
    client_id is not null
    or organizer_contact_id is not null
  ),

  constraint sms_contact_permissions_status_check check (
    consent_status in ('unknown', 'opted_in', 'opted_out')
  )
);

create table if not exists public.sms_message_logs (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,

  client_id uuid references public.clients(id) on delete set null,
  organizer_contact_id uuid references public.organizer_contacts(id) on delete set null,

  phone_e164 text not null,

  direction text not null default 'outbound',
  message_type text not null default 'manual',

  body text,
  segment_count integer not null default 1,

  status text not null default 'draft',

  provider text,
  provider_message_id text,
  provider_error_code text,
  provider_error_message text,

  related_table text,
  related_id uuid,

  sent_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sms_message_logs_workspace_check check (
    (studio_id is not null and organizer_id is null)
    or
    (studio_id is null and organizer_id is not null)
  ),

  constraint sms_message_logs_direction_check check (
    direction in ('outbound', 'inbound')
  ),

  constraint sms_message_logs_status_check check (
    status in ('draft', 'queued', 'sent', 'delivered', 'failed', 'suppressed', 'received')
  )
);

create index if not exists idx_sms_contact_permissions_studio
  on public.sms_contact_permissions(studio_id);

create index if not exists idx_sms_contact_permissions_organizer
  on public.sms_contact_permissions(organizer_id);

create index if not exists idx_sms_contact_permissions_client
  on public.sms_contact_permissions(client_id);

create index if not exists idx_sms_contact_permissions_organizer_contact
  on public.sms_contact_permissions(organizer_contact_id);

create index if not exists idx_sms_contact_permissions_phone
  on public.sms_contact_permissions(phone_e164);

create unique index if not exists uq_sms_permission_studio_client_phone
  on public.sms_contact_permissions(studio_id, client_id, phone_e164)
  where studio_id is not null and client_id is not null;

create unique index if not exists uq_sms_permission_organizer_contact_phone
  on public.sms_contact_permissions(organizer_id, organizer_contact_id, phone_e164)
  where organizer_id is not null and organizer_contact_id is not null;

create index if not exists idx_sms_message_logs_studio_created
  on public.sms_message_logs(studio_id, created_at desc);

create index if not exists idx_sms_message_logs_organizer_created
  on public.sms_message_logs(organizer_id, created_at desc);

create index if not exists idx_sms_message_logs_client
  on public.sms_message_logs(client_id);

create index if not exists idx_sms_message_logs_organizer_contact
  on public.sms_message_logs(organizer_contact_id);

create index if not exists idx_sms_message_logs_phone
  on public.sms_message_logs(phone_e164);

alter table public.sms_contact_permissions enable row level security;
alter table public.sms_message_logs enable row level security;

drop policy if exists sms_permissions_studio_select on public.sms_contact_permissions;
drop policy if exists sms_permissions_studio_insert on public.sms_contact_permissions;
drop policy if exists sms_permissions_studio_update on public.sms_contact_permissions;
drop policy if exists sms_permissions_organizer_select on public.sms_contact_permissions;
drop policy if exists sms_permissions_organizer_insert on public.sms_contact_permissions;
drop policy if exists sms_permissions_organizer_update on public.sms_contact_permissions;

drop policy if exists sms_logs_studio_select on public.sms_message_logs;
drop policy if exists sms_logs_studio_insert on public.sms_message_logs;
drop policy if exists sms_logs_organizer_select on public.sms_message_logs;
drop policy if exists sms_logs_organizer_insert on public.sms_message_logs;

create policy sms_permissions_studio_select on public.sms_contact_permissions
for select
using (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'instructor',
        'independent_instructor'
      )
  )
);

create policy sms_permissions_studio_insert on public.sms_contact_permissions
for insert
with check (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy sms_permissions_studio_update on public.sms_contact_permissions
for update
using (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
)
with check (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy sms_permissions_organizer_select on public.sms_contact_permissions
for select
using (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create policy sms_permissions_organizer_insert on public.sms_contact_permissions
for insert
with check (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create policy sms_permissions_organizer_update on public.sms_contact_permissions
for update
using (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
)
with check (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create policy sms_logs_studio_select on public.sms_message_logs
for select
using (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_message_logs.studio_id
      and usr.user_id = auth.uid()
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'instructor',
        'independent_instructor'
      )
  )
);

create policy sms_logs_studio_insert on public.sms_message_logs
for insert
with check (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_message_logs.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy sms_logs_organizer_select on public.sms_message_logs
for select
using (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_message_logs.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create policy sms_logs_organizer_insert on public.sms_message_logs
for insert
with check (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_message_logs.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create or replace function public.touch_sms_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sms_contact_permissions_touch on public.sms_contact_permissions;

create trigger trg_sms_contact_permissions_touch
before update on public.sms_contact_permissions
for each row
execute function public.touch_sms_updated_at();

drop trigger if exists trg_sms_message_logs_touch on public.sms_message_logs;

create trigger trg_sms_message_logs_touch
before update on public.sms_message_logs
for each row
execute function public.touch_sms_updated_at();

create or replace function public.upsert_sms_contact_permission(
  p_studio_id uuid,
  p_organizer_id uuid,
  p_client_id uuid,
  p_organizer_contact_id uuid,
  p_phone_e164 text,
  p_consent_status text,
  p_consent_source text default null,
  p_consent_note text default null
)
returns public.sms_contact_permissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sms_contact_permissions;
  v_result public.sms_contact_permissions;
  v_can_manage boolean := false;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_phone_e164 is null or length(trim(p_phone_e164)) < 8 then
    raise exception 'A valid phone number is required';
  end if;

  if p_consent_status not in ('unknown', 'opted_in', 'opted_out') then
    raise exception 'Invalid SMS consent status';
  end if;

  if (p_studio_id is null and p_organizer_id is null)
     or (p_studio_id is not null and p_organizer_id is not null) then
    raise exception 'Provide either a studio or organizer workspace';
  end if;

  if p_client_id is null and p_organizer_contact_id is null then
    raise exception 'A contact reference is required';
  end if;

  if p_studio_id is not null then
    select exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = p_studio_id
        and usr.user_id = v_user_id
        and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
    )
    into v_can_manage;
  else
    select exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = p_organizer_id
        and ou.user_id = v_user_id
        and ou.role in ('organizer_owner', 'organizer_admin')
    )
    into v_can_manage;
  end if;

  if not v_can_manage then
    raise exception 'You do not have permission to update SMS consent';
  end if;

  select *
  into v_existing
  from public.sms_contact_permissions scp
  where coalesce(scp.studio_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_studio_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.client_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_client_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.organizer_contact_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_organizer_contact_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and scp.phone_e164 = p_phone_e164
  order by scp.updated_at desc
  limit 1;

  if v_existing.id is not null then
    update public.sms_contact_permissions
    set consent_status = p_consent_status,
        consent_source = p_consent_source,
        consent_note = p_consent_note,
        consent_at = case
          when p_consent_status = 'opted_in' then now()
          else consent_at
        end,
        opted_out_at = case
          when p_consent_status = 'opted_out' then now()
          when p_consent_status = 'opted_in' then null
          else opted_out_at
        end,
        opted_out_source = case
          when p_consent_status = 'opted_out' then coalesce(p_consent_source, 'manual')
          when p_consent_status = 'opted_in' then null
          else opted_out_source
        end,
        updated_by = v_user_id,
        updated_at = now()
    where id = v_existing.id
    returning *
    into v_result;

    return v_result;
  end if;

  insert into public.sms_contact_permissions (
    studio_id,
    organizer_id,
    client_id,
    organizer_contact_id,
    phone_e164,
    consent_status,
    consent_source,
    consent_note,
    consent_at,
    opted_out_at,
    opted_out_source,
    created_by,
    updated_by
  )
  values (
    p_studio_id,
    p_organizer_id,
    p_client_id,
    p_organizer_contact_id,
    p_phone_e164,
    p_consent_status,
    p_consent_source,
    p_consent_note,
    case when p_consent_status = 'opted_in' then now() else null end,
    case when p_consent_status = 'opted_out' then now() else null end,
    case when p_consent_status = 'opted_out' then coalesce(p_consent_source, 'manual') else null end,
    v_user_id,
    v_user_id
  )
  returning *
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.upsert_sms_contact_permission(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text
) to authenticated;