-- Competition Registration Desk Check-In V1
-- Batch readiness, participant presence/waivers, entry verification, and competitor credentials.
-- Save in: src/lib/supabase/migrations/20260621_competition_checkin_foundation_v1.sql

begin;

alter table public.event_competition_contest_registration_rules
  add column if not exists number_assignment_mode text not null default 'primary_participant',
  add column if not exists number_holder_role text;

alter table public.event_competition_contest_registration_rules
  drop constraint if exists event_competition_contest_registration_rules_number_mode_check;
alter table public.event_competition_contest_registration_rules
  add constraint event_competition_contest_registration_rules_number_mode_check
  check (number_assignment_mode in ('primary_participant', 'per_participant', 'per_entry', 'team', 'none'));

update public.event_competition_contest_registration_rules r
set
  number_assignment_mode = case
    when c.entry_format = 'team' then 'team'
    when c.entry_format = 'random_partner' then 'primary_participant'
    else 'primary_participant'
  end,
  number_holder_role = case
    when c.entry_format = 'pro_am' then 'student'
    when c.entry_format = 'pro_pro' then 'professional'
    when c.entry_format in ('couple', 'mixed_amateur', 'professional') then 'leader'
    when c.entry_format in ('solo', 'random_partner') then 'dancer'
    else null
  end,
  updated_at = now()
from public.event_competition_contests c
where c.id = r.contest_id;

create or replace function public.set_competition_registration_number_defaults()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare selected_entry_format text;
begin
  select entry_format into selected_entry_format
  from public.event_competition_contests where id = new.contest_id;
  if selected_entry_format = 'team' then
    new.number_assignment_mode := 'team';
    new.number_holder_role := null;
  elsif selected_entry_format = 'pro_am' then
    new.number_assignment_mode := 'primary_participant';
    new.number_holder_role := 'student';
  elsif selected_entry_format = 'pro_pro' then
    new.number_assignment_mode := 'primary_participant';
    new.number_holder_role := 'professional';
  elsif selected_entry_format in ('couple', 'mixed_amateur', 'professional') then
    new.number_assignment_mode := 'primary_participant';
    new.number_holder_role := 'leader';
  elsif selected_entry_format in ('solo', 'random_partner') then
    new.number_assignment_mode := 'primary_participant';
    new.number_holder_role := 'dancer';
  end if;
  return new;
end;
$$;

drop trigger if exists set_competition_registration_number_defaults on public.event_competition_contest_registration_rules;
create trigger set_competition_registration_number_defaults
before insert on public.event_competition_contest_registration_rules
for each row execute function public.set_competition_registration_number_defaults();

alter table public.event_competition_entries
  add column if not exists verification_status text not null default 'unverified',
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id) on delete set null;

alter table public.event_competition_entries
  drop constraint if exists event_competition_entries_verification_status_check;
alter table public.event_competition_entries
  add constraint event_competition_entries_verification_status_check
  check (verification_status in ('unverified', 'verified', 'disputed', 'corrected'));

create table if not exists public.event_competition_checkin_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  registration_cart_id uuid,
  registration_id uuid references public.event_registrations(id) on delete set null,
  order_id uuid references public.event_orders(id) on delete set null,
  status text not null default 'not_started',
  payment_status text not null default 'needs_review',
  waiver_status text not null default 'needs_review',
  entry_status text not null default 'needs_review',
  credential_status text not null default 'needs_review',
  balance_due numeric(10, 2) not null default 0,
  currency text not null default 'USD',
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_checkin_sessions_cart_fk
    foreign key (registration_cart_id, event_id)
    references public.event_competition_registration_carts(id, event_id) on delete restrict,
  constraint event_competition_checkin_sessions_status_check
    check (status in ('not_started', 'in_progress', 'blocked', 'ready', 'complete', 'cancelled')),
  constraint event_competition_checkin_sessions_payment_check
    check (payment_status in ('needs_review', 'balance_due', 'complete', 'waived')),
  constraint event_competition_checkin_sessions_waiver_check
    check (waiver_status in ('needs_review', 'missing', 'complete', 'waived')),
  constraint event_competition_checkin_sessions_entry_check
    check (entry_status in ('needs_review', 'disputed', 'complete')),
  constraint event_competition_checkin_sessions_credential_check
    check (credential_status in ('needs_review', 'missing', 'complete', 'not_required')),
  constraint event_competition_checkin_sessions_balance_check check (balance_due >= 0),
  unique (id, event_id)
);

create unique index if not exists event_competition_checkin_sessions_cart_uidx
  on public.event_competition_checkin_sessions(registration_cart_id)
  where registration_cart_id is not null;
create unique index if not exists event_competition_checkin_sessions_registration_uidx
  on public.event_competition_checkin_sessions(registration_id)
  where registration_cart_id is null and registration_id is not null;

create table if not exists public.event_competition_checkin_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  checkin_session_id uuid not null,
  registration_attendee_id uuid not null references public.event_registration_attendees(id) on delete cascade,
  display_name text not null,
  participant_type text not null default 'dancer',
  presence_status text not null default 'not_arrived',
  waiver_status text not null default 'missing',
  checked_in_at timestamptz,
  checked_in_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_checkin_participants_session_fk
    foreign key (checkin_session_id, event_id)
    references public.event_competition_checkin_sessions(id, event_id) on delete cascade,
  constraint event_competition_checkin_participants_name_check check (length(btrim(display_name)) between 1 and 200),
  constraint event_competition_checkin_participants_presence_check
    check (presence_status in ('not_arrived', 'present', 'absent', 'excused')),
  constraint event_competition_checkin_participants_waiver_check
    check (waiver_status in ('missing', 'signed', 'waived', 'not_required')),
  unique (checkin_session_id, registration_attendee_id),
  unique (id, event_id)
);

create table if not exists public.event_competition_participant_waivers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  checkin_participant_id uuid not null,
  template_id uuid not null references public.document_templates(id) on delete restrict,
  template_version_id uuid,
  document_signature_id uuid references public.document_signatures(id) on delete set null,
  signer_name text not null,
  signer_email text,
  signature_text text not null,
  consent_text text not null,
  signed_body text not null,
  signed_at timestamptz not null default now(),
  signed_by_staff uuid references auth.users(id) on delete set null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint event_competition_participant_waivers_participant_fk
    foreign key (checkin_participant_id, event_id)
    references public.event_competition_checkin_participants(id, event_id) on delete cascade,
  constraint event_competition_participant_waivers_signer_check check (length(btrim(signer_name)) between 1 and 200),
  unique (checkin_participant_id, template_id)
);

create table if not exists public.event_competition_credentials (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  checkin_session_id uuid not null,
  credential_type text not null default 'competitor_number',
  credential_number text not null,
  holder_type text not null,
  registration_attendee_id uuid references public.event_registration_attendees(id) on delete restrict,
  entry_id uuid,
  registration_cart_id uuid,
  display_name text not null,
  status text not null default 'assigned',
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz,
  issued_by uuid references auth.users(id) on delete set null,
  returned_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_credentials_session_fk
    foreign key (checkin_session_id, event_id)
    references public.event_competition_checkin_sessions(id, event_id) on delete cascade,
  constraint event_competition_credentials_entry_fk
    foreign key (entry_id, event_id)
    references public.event_competition_entries(id, event_id) on delete restrict,
  constraint event_competition_credentials_cart_fk
    foreign key (registration_cart_id, event_id)
    references public.event_competition_registration_carts(id, event_id) on delete restrict,
  constraint event_competition_credentials_type_check
    check (credential_type in ('competitor_number', 'team_number', 'studio_packet', 'other')),
  constraint event_competition_credentials_holder_check
    check (holder_type in ('participant', 'entry', 'studio')),
  constraint event_competition_credentials_number_check check (length(btrim(credential_number)) between 1 and 40),
  constraint event_competition_credentials_name_check check (length(btrim(display_name)) between 1 and 200),
  constraint event_competition_credentials_status_check
    check (status in ('assigned', 'issued', 'returned', 'void')),
  constraint event_competition_credentials_holder_reference_check check (
    (holder_type = 'participant' and registration_attendee_id is not null and entry_id is null)
    or (holder_type = 'entry' and entry_id is not null and registration_attendee_id is null)
    or (holder_type = 'studio' and registration_cart_id is not null and registration_attendee_id is null and entry_id is null)
  ),
  unique (event_id, credential_type, credential_number),
  unique (id, event_id)
);

create index if not exists event_competition_checkin_sessions_event_idx
  on public.event_competition_checkin_sessions(event_id, status, created_at);
create index if not exists event_competition_checkin_participants_session_idx
  on public.event_competition_checkin_participants(checkin_session_id, presence_status);
create index if not exists event_competition_credentials_session_idx
  on public.event_competition_credentials(checkin_session_id, status);
create unique index if not exists event_competition_credentials_participant_uidx
  on public.event_competition_credentials(event_id, credential_type, registration_attendee_id)
  where registration_attendee_id is not null and status <> 'void';
create unique index if not exists event_competition_credentials_entry_uidx
  on public.event_competition_credentials(event_id, credential_type, entry_id)
  where entry_id is not null and status <> 'void';

create or replace function public.validate_competition_checkin_links()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare linked_event_id uuid;
begin
  if tg_table_name = 'event_competition_checkin_sessions' then
    if new.registration_id is not null then
      select event_id into linked_event_id from public.event_registrations where id = new.registration_id;
      if linked_event_id is distinct from new.event_id then raise exception 'Registration belongs to a different event.'; end if;
    end if;
    if new.order_id is not null then
      select event_id into linked_event_id from public.event_orders where id = new.order_id;
      if linked_event_id is distinct from new.event_id then raise exception 'Order belongs to a different event.'; end if;
    end if;
  elsif tg_table_name = 'event_competition_checkin_participants' then
    select event_id into linked_event_id from public.event_registration_attendees where id = new.registration_attendee_id;
    if linked_event_id is distinct from new.event_id then raise exception 'Participant belongs to a different event.'; end if;
  elsif tg_table_name = 'event_competition_credentials' and new.registration_attendee_id is not null then
    select event_id into linked_event_id from public.event_registration_attendees where id = new.registration_attendee_id;
    if linked_event_id is distinct from new.event_id then raise exception 'Credential participant belongs to a different event.'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_competition_checkin_session_links on public.event_competition_checkin_sessions;
create trigger validate_competition_checkin_session_links
before insert or update of event_id, registration_id, order_id on public.event_competition_checkin_sessions
for each row execute function public.validate_competition_checkin_links();
drop trigger if exists validate_competition_checkin_participant_links on public.event_competition_checkin_participants;
create trigger validate_competition_checkin_participant_links
before insert or update of event_id, registration_attendee_id on public.event_competition_checkin_participants
for each row execute function public.validate_competition_checkin_links();
drop trigger if exists validate_competition_credential_links on public.event_competition_credentials;
create trigger validate_competition_credential_links
before insert or update of event_id, registration_attendee_id on public.event_competition_credentials
for each row execute function public.validate_competition_checkin_links();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_checkin_sessions',
    'event_competition_checkin_participants',
    'event_competition_credentials'
  ] loop
    execute format('drop trigger if exists set_event_competition_updated_at on public.%I', table_name);
    execute format('create trigger set_event_competition_updated_at before update on public.%I for each row execute function public.set_event_competition_updated_at()', table_name);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_checkin_sessions',
    'event_competition_checkin_participants',
    'event_competition_participant_waivers',
    'event_competition_credentials'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists competition_manage on public.%I', table_name);
    execute format('create policy competition_manage on public.%I for all to authenticated using (public.can_manage_event_competition(event_id)) with check (public.can_manage_event_competition(event_id))', table_name);
  end loop;
end $$;

comment on table public.event_competition_checkin_sessions is
  'Registration-desk checklist for payment, participant waivers, entry verification, and credential release.';
comment on table public.event_competition_credentials is
  'Competitor, team, or studio credentials issued at registration desk; numbers are not duplicated per dance entry.';
comment on table public.event_competition_participant_waivers is
  'Participant-specific participation waiver snapshots and signature evidence collected at competition check-in.';

notify pgrst, 'reload schema';
commit;
