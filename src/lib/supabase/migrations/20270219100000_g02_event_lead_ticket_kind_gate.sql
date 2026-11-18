-- G-02 -- Event registrations create studio CRM leads only for ticket types the STUDIO has explicitly flagged.
--
-- Before: capture_event_registration_lead(uuid) (20261116091000) turned EVERY paid registrant of a studio-hosted event
-- into a studio CRM lead, whatever the ticket (spectator, vendor, staff, table, pass, competitor ...), and those leads
-- then showed up in CRM Leads and the new_leads campaign audience.
-- After (owner decision A1 = "Rule 1"): a new per-ticket-type setting event_ticket_types.creates_prospect_lead
--   (boolean, NOT NULL, default FALSE) decides. A lead is created/refreshed only when the registration's ticket type has the
--   flag set. A CHECK makes the flag impossible for every kind except general_admission (spectator, vendor, staff, table,
--   pass, competitor are hard-excluded; vip and other are not flaggable until the owner decides A3). Every other paid
--   registration creates NO client row, changes NO client row and does not link the registration to a client; the studio
--   still receives an in-app notification labelled as a registration that was NOT added as a lead (same notifications
--   table / 'event_registration' type: no new channel, no constraint change).
--
-- Defaults used while owner decisions are pending (flagged in the PR): A2 existing ticket types default OFF (no backfill);
-- A3 vip/other not flaggable; A4 free sign-ups follow the same flag (no special case); A5 no banner.
--
-- Compatibility: the function keeps its signature and jsonb contract. The non-lead path returns outcome='skipped'
-- (reason 'ticket_not_flagged_for_leads', notified=true), which the existing TypeScript outbox worker already treats as
-- success, so SQL and app can be released in either order. The new column has a default, so the old app keeps working.
-- No data is backfilled, deleted or modified: existing leads, clients, notifications and ticket types are untouched.
-- Rollback: rollback/20270219090000_g02_event_lead_ticket_kind_gate_rollback.sql (restores the 20261116091000 body and
-- drops the column; refuses nothing because the column only ever held opt-ins).

begin;

alter table public.event_ticket_types
  add column if not exists creates_prospect_lead boolean not null default false;

-- Hard exclusion: only general_admission may ever be flagged (A1 hard CHECK; vip/other wait for owner decision A3).
alter table public.event_ticket_types
  drop constraint if exists event_ticket_types_prospect_lead_kind_check;
alter table public.event_ticket_types
  add constraint event_ticket_types_prospect_lead_kind_check
  check (not creates_prospect_lead or ticket_kind = 'general_admission');

comment on column public.event_ticket_types.creates_prospect_lead is
  'Studio setting: buyers of this ticket type become studio CRM leads (prospective students) when paid. Default false. Only general_admission may be true.';

create or replace function public.capture_event_registration_lead(p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg record;
  v_email text;
  v_first text;
  v_last text;
  v_client_id uuid;
  v_existing record;
  v_studio_id uuid;
  v_kind text;
  v_flag boolean;
begin
  select er.id, er.studio_id, er.client_id, er.status, er.payment_status, er.attendee_first_name, er.attendee_last_name,
         er.attendee_email, er.attendee_phone, er.ticket_type_id, e.id as event_id, e.name as event_name,
         e.studio_id as event_studio_id, e.organizer_id
  into v_reg
  from public.event_registrations er
  join public.events e on e.id = er.event_id
  where er.id = p_registration_id;

  if not found then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'registration_not_found');
  end if;
  -- Leads are captured only from committed, paid registrations, and never for organizer listings
  -- (organizer listings use organizer contacts).
  if v_reg.payment_status <> 'paid' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'registration_not_paid');
  end if;
  if v_reg.organizer_id is not null then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'organizer_listing');
  end if;

  v_studio_id := coalesce(v_reg.event_studio_id, v_reg.studio_id);
  v_email := lower(btrim(coalesce(v_reg.attendee_email, '')));
  v_first := coalesce(nullif(btrim(coalesce(v_reg.attendee_first_name, '')), ''), 'Event');
  v_last := coalesce(nullif(btrim(coalesce(v_reg.attendee_last_name, '')), ''), 'Registrant');

  -- Ticket setting (tenant-safe: the ticket type must belong to this registration's event). Fail closed: no ticket type,
  -- a foreign ticket type, or an unflagged one means no lead. The kind is re-checked here as defence in depth.
  select ett.ticket_kind, ett.creates_prospect_lead into v_kind, v_flag
  from public.event_ticket_types ett
  where ett.id = v_reg.ticket_type_id and ett.event_id = v_reg.event_id;

  if v_studio_id is not null and not (coalesce(v_flag, false) and v_kind = 'general_admission') then
    -- Not a prospective-student ticket: NO client is created, linked or modified. The studio is still told about the
    -- committed registration, clearly labelled. Idempotent per registration (replays are no-ops).
    insert into public.notifications (studio_id, client_id, type, title, body, dedupe_key)
    values (v_studio_id, v_reg.client_id, 'event_registration', 'New event registration (not added as a lead)',
            format('%s %s registered for %s with a "%s" ticket. This registration was not added to Leads because this ticket type is not set to add buyers as prospective students.',
                   v_first, v_last, v_reg.event_name, coalesce(nullif(btrim(coalesce(v_kind, '')), ''), 'unclassified')),
            'event_registration_notice:' || v_reg.id::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
    return jsonb_build_object('outcome', 'skipped', 'reason', 'ticket_not_flagged_for_leads', 'notified', true,
                              'ticket_kind', coalesce(v_kind, ''), 'flag', coalesce(v_flag, false));
  end if;

  if v_studio_id is null or v_email = '' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'missing_studio_or_email');
  end if;

  -- Serialize concurrent captures for the same studio + email (no unique index exists on clients.email).
  perform pg_advisory_xact_lock(hashtextextended('paywh1_lead:' || v_studio_id::text || ':' || v_email, 0));

  v_client_id := v_reg.client_id;
  if v_client_id is null then
    select c.id, c.referral_source, c.source_system into v_existing
    from public.clients c
    where c.studio_id = v_studio_id and lower(c.email) = v_email
    order by c.created_at asc
    limit 1;

    if found then
      v_client_id := v_existing.id;
      update public.clients
      set referral_source = coalesce(referral_source, 'Event Registration'),
          source_system = coalesce(source_system, 'event_registration')
      where id = v_client_id and (referral_source is null or source_system is null);
    else
      insert into public.clients (studio_id, first_name, last_name, email, phone, status, referral_source, source_system, notes)
      values (v_studio_id, v_first, v_last, v_email, nullif(v_reg.attendee_phone, ''), 'lead',
              'Event Registration', 'event_registration', format('Created from event registration for %s.', v_reg.event_name))
      returning id into v_client_id;
    end if;

    update public.event_registrations set client_id = v_client_id where id = v_reg.id and client_id is null;
  end if;

  insert into public.notifications (studio_id, client_id, type, title, body, dedupe_key)
  values (v_studio_id, v_client_id, 'event_registration', 'New event registration',
          format('%s %s registered for %s.', v_first, v_last, v_reg.event_name), 'event_registration_lead:' || v_reg.id::text)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('outcome', 'captured', 'client_id', v_client_id);
end;
$$;

revoke all on function public.capture_event_registration_lead(uuid) from public, anon, authenticated;
grant execute on function public.capture_event_registration_lead(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
