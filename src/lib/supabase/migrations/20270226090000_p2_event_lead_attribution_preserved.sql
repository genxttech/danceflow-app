-- P2 (owner disposition 2026-11-26) -- event ticket checkout preserves existing lead attribution.
--
-- Before: capture_event_registration_lead (G-02, 20270219100000) reused an existing client with the buyer's email and filled
-- blank referral_source / source_system with the event origin, which relabelled a real lead as an event registrant.
-- After: an existing client is linked to the registration and nothing on the client row changes. A NEW client created from a
-- flagged ticket still records the event origin. Everything else is byte-for-byte the G-02 function.
--
-- Depends on 20270219100000 (G-02). No data is backfilled or modified. Rollback:
-- rollback/20270226090000_p2_event_lead_attribution_preserved_rollback.sql (restores the G-02 function).

begin;

do $guard$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_ticket_types' and column_name = 'creates_prospect_lead') then
    raise exception 'P2 needs 20270219100000 (event_ticket_types.creates_prospect_lead) applied first';
  end if;
end
$guard$;

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
    -- P2: an existing client is only linked. Ticket checkout never writes a client's lead attribution (referral_source,
    -- source_system) or any other column, not even a blank one.
    select c.id into v_client_id
    from public.clients c
    where c.studio_id = v_studio_id and lower(c.email) = v_email
    order by c.created_at asc
    limit 1;

    if not found then
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

commit;
