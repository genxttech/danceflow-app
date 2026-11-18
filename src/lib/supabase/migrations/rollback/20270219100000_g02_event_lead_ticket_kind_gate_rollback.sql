-- Rollback of 20270219090000_g02_event_lead_ticket_kind_gate.sql: restores the 20261116091000 capture_event_registration_lead
-- body (every paid studio-event registrant becomes a lead) and drops the creates_prospect_lead setting + its CHECK.
-- Notifications already written (dedupe_key event_registration_notice:*) are kept; no client data is touched.

begin;

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
begin
  select er.id, er.studio_id, er.client_id, er.status, er.payment_status, er.attendee_first_name, er.attendee_last_name,
         er.attendee_email, er.attendee_phone, e.id as event_id, e.name as event_name, e.studio_id as event_studio_id,
         e.organizer_id
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

  v_email := lower(btrim(coalesce(v_reg.attendee_email, '')));
  if coalesce(v_reg.event_studio_id, v_reg.studio_id) is null or v_email = '' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'missing_studio_or_email');
  end if;
  v_first := coalesce(nullif(btrim(coalesce(v_reg.attendee_first_name, '')), ''), 'Event');
  v_last := coalesce(nullif(btrim(coalesce(v_reg.attendee_last_name, '')), ''), 'Registrant');

  -- Serialize concurrent captures for the same studio + email (no unique index exists on clients.email).
  perform pg_advisory_xact_lock(hashtextextended('paywh1_lead:' || coalesce(v_reg.event_studio_id, v_reg.studio_id)::text || ':' || v_email, 0));

  v_client_id := v_reg.client_id;
  if v_client_id is null then
    select c.id, c.referral_source, c.source_system into v_existing
    from public.clients c
    where c.studio_id = coalesce(v_reg.event_studio_id, v_reg.studio_id) and lower(c.email) = v_email
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
      values (coalesce(v_reg.event_studio_id, v_reg.studio_id), v_first, v_last, v_email, nullif(v_reg.attendee_phone, ''), 'lead',
              'Event Registration', 'event_registration', format('Created from event registration for %s.', v_reg.event_name))
      returning id into v_client_id;
    end if;

    update public.event_registrations set client_id = v_client_id where id = v_reg.id and client_id is null;
  end if;

  insert into public.notifications (studio_id, client_id, type, title, body, dedupe_key)
  values (coalesce(v_reg.event_studio_id, v_reg.studio_id), v_client_id, 'event_registration', 'New event registration',
          format('%s %s registered for %s.', v_first, v_last, v_reg.event_name), 'event_registration_lead:' || v_reg.id::text)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('outcome', 'captured', 'client_id', v_client_id);
end;
$$;

revoke all on function public.capture_event_registration_lead(uuid) from public, anon, authenticated;
grant execute on function public.capture_event_registration_lead(uuid) to service_role;

alter table public.event_ticket_types drop constraint if exists event_ticket_types_prospect_lead_kind_check;
alter table public.event_ticket_types drop column if exists creates_prospect_lead;

notify pgrst, 'reload schema';

commit;
