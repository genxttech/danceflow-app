-- 20261012090000_smsa2p1_studio_sms_registrations.sql
--
-- SMS-A2P-1: per-studio A2P registration foundation.
--
-- Model: GenX TotalTech LLC / DanceFlow is the ISV; each studio is its own
-- campaign/message sender. This table records, per studio, the NON-SECRET Twilio
-- resource identifiers and review status that later slices will use to route
-- sends. It does NOT enable sending: nothing in the application reads it for
-- routing yet, and the global sender/approval flag is unchanged.
--
--   * One row per studio (unique studio_id).
--   * messaging_service_sid (MG...), campaign_sid (QE... US A2P campaign) and
--     sender_e164 are distinct resources and distinct columns.
--   * registration_status is a constrained set that defaults to
--     'not_registered' and can only be 'approved' when all three identifiers
--     are present (fails closed).
--   * No Twilio auth token, account secret or API key is stored here.
--   * RLS: platform admins only (profiles.platform_role = 'platform_admin').
--     No studio-user policy; anon has no privileges; no DELETE policy.
--     service_role bypasses RLS for trusted server paths.
--
-- Must be applied to BOTH DEV and PROD. Additive; no existing object changes.

begin;

-- SMS-A2P-1 preconditions (reviewed identical in DEV and PROD)
do $$
begin
  if to_regclass('public.studio_sms_registrations') is not null then
    raise exception 'SMS-A2P-1 precondition failed: studio_sms_registrations already exists';
  end if;
  if to_regclass('public.studios') is null or to_regclass('public.profiles') is null then
    raise exception 'SMS-A2P-1 precondition failed: studios/profiles missing';
  end if;
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass and attname = 'platform_role' and not attisdropped
  ) then
    raise exception 'SMS-A2P-1 precondition failed: profiles.platform_role missing';
  end if;
end $$;

create table public.studio_sms_registrations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null unique references public.studios(id) on delete cascade,

  messaging_service_sid text,
  campaign_sid text,
  sender_e164 text,

  registration_status text not null default 'not_registered',
  submitted_at timestamptz,
  approved_at timestamptz,
  review_note text,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_sms_registrations_status_check check (
    registration_status in ('not_registered', 'in_review', 'approved', 'rejected', 'suspended')
  ),
  constraint studio_sms_registrations_messaging_service_sid_check check (
    messaging_service_sid is null or messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'
  ),
  constraint studio_sms_registrations_campaign_sid_check check (
    campaign_sid is null or campaign_sid ~ '^QE[0-9a-fA-F]{32}$'
  ),
  constraint studio_sms_registrations_sender_e164_check check (
    sender_e164 is null or sender_e164 ~ '^\+[1-9][0-9]{9,14}$'
  ),
  constraint studio_sms_registrations_review_note_check check (
    review_note is null or char_length(review_note) <= 500
  ),
  constraint studio_sms_registrations_approved_requires_identifiers check (
    registration_status <> 'approved'
    or (
      messaging_service_sid is not null
      and campaign_sid is not null
      and sender_e164 is not null
    )
  )
);

comment on table public.studio_sms_registrations is
  'SMS-A2P-1: per-studio A2P registration (non-secret Twilio identifiers + status). Platform-managed; never store credentials here.';

create unique index uq_studio_sms_registrations_messaging_service_sid
  on public.studio_sms_registrations (messaging_service_sid)
  where messaging_service_sid is not null;

create unique index uq_studio_sms_registrations_campaign_sid
  on public.studio_sms_registrations (campaign_sid)
  where campaign_sid is not null;

create unique index uq_studio_sms_registrations_sender_e164
  on public.studio_sms_registrations (sender_e164)
  where sender_e164 is not null;

-- Integrity trigger (SECURITY INVOKER): studio binding is immutable, timestamps
-- are server-derived, and the actor is recorded.
create or replace function public.studio_sms_registrations_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id then
    raise exception 'studio_sms_registrations.studio_id is immutable';
  end if;

  new.updated_at := now();
  new.updated_by := auth.uid();

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;

  if new.registration_status = 'approved' then
    new.approved_at := coalesce(new.approved_at, now());
  else
    new.approved_at := null;
  end if;

  if new.registration_status <> 'not_registered' then
    new.submitted_at := coalesce(new.submitted_at, now());
  end if;

  return new;
end;
$$;

create trigger trg_studio_sms_registrations_integrity
before insert or update on public.studio_sms_registrations
for each row execute function public.studio_sms_registrations_integrity();

alter table public.studio_sms_registrations enable row level security;

revoke all on public.studio_sms_registrations from public;
revoke all on public.studio_sms_registrations from anon;
revoke all on public.studio_sms_registrations from authenticated;
grant select, insert, update on public.studio_sms_registrations to authenticated;
grant all on public.studio_sms_registrations to service_role;

create policy "Platform admins read studio sms registrations"
on public.studio_sms_registrations
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
);

create policy "Platform admins create studio sms registrations"
on public.studio_sms_registrations
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
);

create policy "Platform admins update studio sms registrations"
on public.studio_sms_registrations
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
);

commit;
