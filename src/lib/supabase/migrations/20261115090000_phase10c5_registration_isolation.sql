-- Phase 10C.5 registration isolation (forward migration on top of 20261114090000_phase10c5_profile_v3.sql).
--
-- Competition setup must not change ordinary event registration. Until now create_competition_draft set the event's
-- registration_required, account_required_for_registration and registration window -- shared fields that also
-- drive ordinary ticket checkout and the public event page -- and competition registration depended on them.
--   1. create_competition_draft no longer writes those event fields. The competition registration window and the
--      account requirement are stored on each program it creates (configuration.setup.registration), and the event
--      row is only written when the organizer changed its page, venue or dates.
--   2. competition_registration_program_open (the public gate used by the catalog policies and checkout): programs
--      with setup.registration use their own window and no longer require the event's ticket registration flag.
--      Programs without it (10B / Advanced / earlier setups) keep the exact previous rule.
--   3. open_competition_registration: the event ticket registration flag is only a prerequisite for programs without
--      setup.registration. Pricing-pending and registration-hold (Multi-Dance) guards are unchanged.
--   4. start_competition_registration: the account requirement comes from competition_registration_account_required.
--   5. protect_competition_program_registration_settings: client sessions (anon / authenticated) cannot set, change
--      or remove a program's configuration.setup.registration; only create_competition_draft writes it.
-- No existing event, program or profile row is modified. Rollback:
-- rollback/20261115090000_phase10c5_registration_isolation_rollback.sql.

-- ---------------------------------------------------------------------------
-- 0. Preflight: the 20261114090000 state
-- ---------------------------------------------------------------------------
do $$
begin
  if md5(pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) <> 'a5bd1f13b01df19b4821073419076e67'
    or md5(pg_get_functiondef('public.competition_registration_program_open(uuid,uuid)'::regprocedure)) <> '9e72b1af862446dc044fc50ea723c298'
    or md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> '040ed4e9444af229b40842ade65bf5e8'
    or md5(pg_get_functiondef('public.start_competition_registration(uuid,uuid,jsonb,uuid)'::regprocedure)) <> '573612a0b299bee1a434e68bf4c52dde' then
    raise exception 'Phase 10C.5 registration isolation preflight: the functions are not the 20261114090000 definitions.';
  end if;
  if to_regprocedure('public.competition_registration_account_required(uuid)') is not null
    or to_regprocedure('public.protect_competition_program_registration_settings()') is not null then
    raise exception 'Phase 10C.5 registration isolation preflight: a 20261115090000 function already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. competition_registration_account_required
-- ---------------------------------------------------------------------------
create function public.competition_registration_account_required(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  -- Whether competition registration for the event needs a signed-in account: a setup-wizard program uses its own
  -- setting (configuration.setup.registration.account_required); a legacy program uses the event's setting. Only
  -- programs whose registration is actually open count.
  select coalesce(bool_or(case when p.configuration #> '{setup,registration}' is not null
                               then coalesce((p.configuration #>> '{setup,registration,account_required}')::boolean, true)
                               else e.account_required_for_registration end), true)
  from public.event_competition_programs p
  join public.events e on e.id = p.event_id
  where p.event_id = p_event_id
    and public.competition_registration_program_open(p_event_id, p.id);
$fn$;

revoke all on function public.competition_registration_account_required(uuid) from public;
grant execute on function public.competition_registration_account_required(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1b. Program registration settings guard
-- ---------------------------------------------------------------------------
create function public.protect_competition_program_registration_settings()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if current_user in ('anon', 'authenticated') then
    if (tg_op = 'INSERT' and new.configuration #> '{setup,registration}' is not null)
      or (tg_op = 'UPDATE' and (new.configuration #> '{setup,registration}') is distinct from (old.configuration #> '{setup,registration}')) then
      raise exception 'Competition registration settings are set only by competition setup.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.protect_competition_program_registration_settings() from public, anon, authenticated;

create trigger protect_competition_program_registration_settings
before insert or update on public.event_competition_programs
for each row execute function public.protect_competition_program_registration_settings();

-- ---------------------------------------------------------------------------
-- 2. competition_registration_program_open
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.competition_registration_program_open(p_event_id uuid, p_program_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
    from public.events e
    join public.event_competition_programs p on p.event_id = e.id
    where e.id = p_event_id
      and p.id = p_program_id
      and e.status = 'published'
      and e.visibility in ('public', 'unlisted')
      and case
            -- 10C.5 registration isolation: setup-wizard programs carry their own competition registration window
            -- and do not depend on the event's ordinary ticket registration settings.
            when p.configuration #> '{setup,registration}' is not null then
              ((p.configuration #>> '{setup,registration,opens_at}')::timestamptz is null
                 or (p.configuration #>> '{setup,registration,opens_at}')::timestamptz <= now())
              and ((p.configuration #>> '{setup,registration,closes_at}')::timestamptz is null
                 or (p.configuration #>> '{setup,registration,closes_at}')::timestamptz >= now())
            else
              e.registration_required
              and (e.registration_opens_at is null or e.registration_opens_at <= now())
              and (e.registration_closes_at is null or e.registration_closes_at >= now())
          end
      and p.status in ('configured', 'active')
      and p.registration_status = 'open'
      and (p.rules_profile_key is null or p.profile_locked_at is not null)
  );
$function$
;

-- ---------------------------------------------------------------------------
-- 3. open_competition_registration
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_competition_registration(p_program_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_program record;
  v_event record;
  v_contests int;
  v_divisions int;
begin
  select p.* into v_program from public.event_competition_programs p where p.id = p_program_id for update;
  if v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'COMP10C_FORBIDDEN: competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.* into v_event from public.events e where e.id = v_program.event_id;
  if v_program.status not in ('configured', 'active') then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if v_program.rules_profile_key is not null and v_program.profile_locked_at is null then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  -- 10C.5 registration isolation: setup-wizard programs have their own registration settings, so the event's
  -- ordinary ticket registration flag is neither a prerequisite nor changed here.
  if v_program.configuration #> '{setup,registration}' is null and not v_event.registration_required then
    raise exception 'COMP10C_EVENT_REGISTRATION_OFF: turn on event registration before opening competition registration.';
  end if;
  -- 10C.5: a category whose pricing was deferred ("Configure later") blocks opening until it is priced.
  if exists (select 1 from public.event_competition_contests c
             where c.program_id = v_program.id and c.event_id = v_program.event_id and c.status in ('draft', 'open')
               and coalesce(c.configuration #>> '{setup,pricing_pending}', 'false') = 'true') then
    raise exception 'COMP10C_PRICING_PENDING: Pricing requires completion before registration can open.';
  end if;
  -- 10C.5: a category the rules profile cannot run yet (e.g. Multi-Dance, whose combined results are not computed)
  -- blocks opening; the draft and its divisions still exist.
  if exists (select 1 from public.event_competition_contests hc
             where hc.program_id = v_program.id and hc.event_id = v_program.event_id
               and hc.status = any (array['draft', 'open'])
               and hc.configuration #>> '{setup,registration_hold}' is not null) then
    raise exception 'COMP10C_REGISTRATION_HOLD: This competition has a category that cannot open registration yet (Multi-Dance results are not supported).';
  end if;

  -- Open every category that has at least one division, its draft divisions, and its rule.
  with ready as (
    select c.id from public.event_competition_contests c
    where c.program_id = v_program.id and c.event_id = v_program.event_id
      and c.status in ('draft', 'open')
      and exists (select 1 from public.event_competition_divisions d
                  where d.contest_id = c.id and d.event_id = c.event_id and d.status in ('draft', 'open'))
      and exists (select 1 from public.event_competition_contest_registration_rules r
                  where r.contest_id = c.id and r.event_id = c.event_id)
  ), opened as (
    update public.event_competition_contests c set status = 'open', updated_at = now()
    from ready where c.id = ready.id and c.status = 'draft' returning c.id
  )
  select (select count(*) from ready) into v_contests;
  if v_contests = 0 then
    raise exception 'COMP10C_NOTHING_REGISTRABLE: add a category with at least one division before opening registration.';
  end if;

  update public.event_competition_divisions d set status = 'open', updated_at = now()
  where d.program_id = v_program.id and d.event_id = v_program.event_id and d.status = 'draft'
    and exists (select 1 from public.event_competition_contests c where c.id = d.contest_id and c.status = 'open');
  select count(*) into v_divisions from public.event_competition_divisions d
  where d.program_id = v_program.id and d.status = 'open';

  update public.event_competition_contest_registration_rules r set registration_open = true, updated_at = now()
  where r.program_id = v_program.id and r.event_id = v_program.event_id and not r.registration_open
    and exists (select 1 from public.event_competition_contests c where c.id = r.contest_id and c.status = 'open');

  update public.event_competition_programs
  set registration_status = 'open', registration_opened_at = now(), updated_at = now()
  where id = v_program.id;

  return jsonb_build_object('program_id', v_program.id, 'registration_status', 'open',
    'open_categories', v_contests, 'open_divisions', v_divisions);
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 4. start_competition_registration
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_competition_registration(p_event_id uuid, p_client_request_id uuid, p_draft jsonb, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  c_hold interval := interval '40 minutes';
  v_now timestamptz := now();
  v_fingerprint text;
  v_existing record;
  v_event record;
  v_quote jsonb;
  v_mode text;
  v_buyer_name text;
  v_buyer_first text;
  v_buyer_last text;
  v_buyer_email text;
  v_buyer_phone text;
  v_studio_name text;
  v_actor_verified_email text;
  v_actor_client uuid;
  v_actor_instructor uuid;
  v_is_manager boolean;
  v_requires_signing boolean;
  v_total bigint;
  v_free_now boolean;
  v_cart_id uuid;
  v_order_id uuid;
  v_registration_id uuid;
  v_person jsonb;
  v_entry jsonb;
  v_line jsonb;
  v_person_map jsonb := '{}'::jsonb;
  v_competitor_map jsonb := '{}'::jsonb;
  v_attendee_map jsonb := '{}'::jsonb;
  v_cart_entry_map jsonb := '{}'::jsonb;
  v_entry_map jsonb := '{}'::jsonb;
  v_competitor_id uuid;
  v_cart_person_id uuid;
  v_cart_entry_id uuid;
  v_entry_id uuid;
  v_item_id uuid;
  v_attendee_id uuid;
  v_user uuid;
  v_client uuid;
  v_instructor uuid;
  v_email text;
  v_dob date;
  v_contest record;
  v_division record;
  v_display text;
  v_names text[];
  v_entry_cents bigint;
  v_entry_lines jsonb;
  v_offering text;
  v_sort int;
  v_idx int;
  v_pid text;
  v_role text;
  v_dance text;
  v_person_type text;
  v_primary_role text;
  v_snapshot jsonb;
begin
  if p_event_id is null or p_client_request_id is null or p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'COMP10C_INVALID: registration request is incomplete.';
  end if;

  -- Idempotency: one logical registration per (event, client_request_id). Concurrent retries
  -- serialize here; the loser replays the winner's stored result.
  perform pg_advisory_xact_lock(hashtextextended('comp10c:start:' || p_event_id::text || ':' || p_client_request_id::text, 0));
  v_fingerprint := md5(jsonb_build_object('actor', p_actor_user_id, 'draft', p_draft)::text);

  select c.id, c.request_fingerprint into v_existing
  from public.event_competition_registration_carts c
  where c.event_id = p_event_id and c.client_request_id = p_client_request_id;
  if v_existing.id is not null then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'COMP10C_IDEMPOTENCY_CONFLICT: this registration request was already submitted with different details.';
    end if;
    return public._comp10c_result(v_existing.id, true);
  end if;

  select e.id, e.studio_id, e.organizer_id, e.name, e.account_required_for_registration into v_event
  from public.events e where e.id = p_event_id for share;
  if v_event.id is null or not public.competition_registration_event_open(p_event_id) then
    raise exception 'COMP10C_CLOSED: competition registration is not open.';
  end if;
  if public.competition_registration_account_required(p_event_id) and p_actor_user_id is null then
    raise exception 'COMP10C_SIGN_IN_REQUIRED: sign in before registering.';
  end if;

  v_quote := public._comp10c_quote(p_event_id, p_draft, v_now);
  if not (v_quote->>'valid')::boolean then
    raise exception 'COMP10C_INVALID: %', coalesce(v_quote->'errors'->>0, 'Registration is incomplete.')
      using detail = (v_quote->'errors')::text;
  end if;

  v_mode := p_draft->>'registrationMode';
  v_buyer_name := left(btrim(regexp_replace(p_draft->>'buyerName', '\s+', ' ', 'g')), 200);
  v_buyer_first := split_part(v_buyer_name, ' ', 1);
  v_buyer_last := btrim(substr(v_buyer_name, length(v_buyer_first) + 1));
  v_buyer_email := left(lower(btrim(p_draft->>'buyerEmail')), 254);
  v_buyer_phone := nullif(left(btrim(coalesce(p_draft->>'buyerPhone', '')), 40), '');
  v_studio_name := case when v_mode = 'studio' then nullif(left(btrim(coalesce(p_draft->>'registeringStudioName', '')), 200), '') end;

  -- Buyer identity: the server-verified session user, and their own LINKED self client at the
  -- event studio (canonical client_account_links; never an email match).
  if p_actor_user_id is not null then
    v_actor_verified_email := public.verified_email_for_user(p_actor_user_id);
    select l.client_id into v_actor_client
    from public.client_account_links l
    where l.user_id = p_actor_user_id and l.studio_id = v_event.studio_id
      and l.status = 'linked' and l.relationship_type = 'self'
    order by l.is_primary desc nulls last, l.linked_at nulls last
    limit 1;
    select i.id into v_actor_instructor
    from public.instructors i
    where i.user_id = p_actor_user_id and i.studio_id = v_event.studio_id and i.active
    limit 1;
  end if;
  v_is_manager := public._comp10c_actor_can_manage(p_event_id, p_actor_user_id);

  v_total := (v_quote->>'total_cents')::bigint;
  v_requires_signing := exists (
    select 1 from public.event_document_requirements r
    where r.event_id = p_event_id and r.active and r.is_required
  );
  v_free_now := v_total = 0 and not v_requires_signing;

  v_snapshot := jsonb_build_object(
    'pricing_version', '10c.1',
    'priced_at', v_now,
    'currency', v_quote->>'currency',
    'subtotal_cents', (v_quote->>'subtotal_cents')::bigint,
    'discount_cents', (v_quote->>'discount_cents')::bigint,
    'total_cents', v_total,
    'lines', v_quote->'lines'
  );

  insert into public.event_competition_registration_carts (
    event_id, registration_mode, buyer_name, buyer_email, buyer_phone, registering_studio_name, status, currency,
    quoted_subtotal, quoted_discount, quoted_total, quote_checksum, quoted_at, expires_at, submitted_at,
    client_request_id, request_fingerprint, buyer_user_id, buyer_client_id, priced_at, price_snapshot
  ) values (
    p_event_id, v_mode, v_buyer_name, v_buyer_email, v_buyer_phone, v_studio_name,
    case when v_free_now then 'submitted' else 'checkout_pending' end, v_quote->>'currency',
    ((v_quote->>'subtotal_cents')::numeric / 100), ((v_quote->>'discount_cents')::numeric / 100), (v_total::numeric / 100),
    md5(v_snapshot::text), v_now, v_now + c_hold, case when v_free_now then v_now end,
    p_client_request_id, v_fingerprint, p_actor_user_id, v_actor_client, v_now, v_snapshot
  ) returning id into v_cart_id;

  insert into public.event_orders (
    event_id, studio_id, organizer_id, buyer_name, buyer_email, buyer_phone, buyer_notes,
    subtotal_amount, discount_amount, total_amount, currency, status, payment_status, expires_at, paid_at,
    client_request_id, metadata
  ) values (
    p_event_id, v_event.studio_id, v_event.organizer_id, v_buyer_name, v_buyer_email, v_buyer_phone,
    case when v_studio_name is not null then 'Studio registration: ' || v_studio_name end,
    ((v_quote->>'subtotal_cents')::numeric / 100), ((v_quote->>'discount_cents')::numeric / 100), (v_total::numeric / 100),
    v_quote->>'currency',
    case when v_free_now then 'confirmed' else 'pending' end,
    case when v_free_now then 'paid' else 'pending' end,
    case when v_free_now then null else v_now + c_hold end,
    case when v_free_now then v_now end,
    'comp10c:' || p_client_request_id::text,
    jsonb_build_object(
      'source', 'competition_registration',
      'registration_cart_id', v_cart_id,
      'client_request_id', p_client_request_id,
      'registration_mode', v_mode,
      'registering_studio_name', v_studio_name,
      'requires_signing', v_requires_signing,
      'buyer_user_id', p_actor_user_id,
      'price_snapshot', v_snapshot
    )
  ) returning id into v_order_id;

  update public.event_competition_registration_carts set order_id = v_order_id where id = v_cart_id;

  insert into public.event_registrations (
    studio_id, event_id, ticket_type_id, client_id, user_id, order_id, status, payment_status,
    attendee_first_name, attendee_last_name, attendee_email, attendee_phone,
    quantity, unit_price, total_price, total_amount, currency, registration_source, source, notes
  ) values (
    v_event.studio_id, p_event_id, null, v_actor_client, p_actor_user_id, v_order_id,
    case when v_free_now then 'confirmed' else 'pending' end,
    case when v_free_now then 'paid' else 'pending' end,
    coalesce(nullif(v_buyer_first, ''), 'Competition'), coalesce(nullif(v_buyer_last, ''), 'Registrant'),
    v_buyer_email, v_buyer_phone,
    1, (v_total::numeric / 100), (v_total::numeric / 100), (v_total::numeric / 100), v_quote->>'currency',
    'public_event_page', 'competition_registration',
    case when v_studio_name is not null then 'Studio: ' || v_studio_name end
  ) returning id into v_registration_id;

  -- People -> roster snapshot + canonical competitor + admission attendee (one per competitor).
  v_sort := 0;
  for v_person in select x from jsonb_array_elements(p_draft->'people') x loop
    v_sort := v_sort + 1;
    v_user := null; v_client := null; v_instructor := null;
    v_email := nullif(left(lower(btrim(coalesce(v_person->>'email', ''))), 254), '');
    if v_email is not null and position('@' in v_email) <= 1 then v_email := null; end if;
    v_dob := case when coalesce(v_person->>'dateOfBirth', '') ~ '^\d{4}-\d{2}-\d{2}$' then (v_person->>'dateOfBirth')::date end;
    v_person_type := coalesce(nullif(v_person->>'personType', ''), 'dancer');
    v_primary_role := nullif(v_person->>'primaryRole', '');

    if coalesce(v_person->'isSelf' = 'true'::jsonb, false) then
      -- "This is me": the verified account anchors the competitor (LAUNCH-SEC-1C rules). It can never
      -- be combined with a staff anchor (that would bind the actor's account to someone else).
      if public._comp10c_uuid(v_person->>'anchorClientId') is not null
         or public._comp10c_uuid(v_person->>'anchorInstructorId') is not null then
        raise exception 'COMP10C_INVALID: a roster person cannot be both you and a linked studio record.';
      end if;
      if p_actor_user_id is null then
        raise exception 'COMP10C_SIGN_IN_REQUIRED: sign in to register yourself to your DanceFlow account.';
      end if;
      if v_actor_verified_email is null then
        raise exception 'COMP10C_IDENTITY_UNVERIFIED: verify your email before linking this registration to your account.';
      end if;
      v_user := p_actor_user_id;
      v_client := v_actor_client;
      v_instructor := v_actor_instructor;
      v_email := v_actor_verified_email;
    end if;
    if public._comp10c_uuid(v_person->>'anchorClientId') is not null
       or public._comp10c_uuid(v_person->>'anchorInstructorId') is not null then
      -- Studio-side anchoring of someone else: only an event manager, only their own studio's records.
      if not v_is_manager then
        raise exception 'COMP10C_FORBIDDEN: only event staff can link roster people to studio records.' using errcode = '42501';
      end if;
      v_client := coalesce(public._comp10c_uuid(v_person->>'anchorClientId'), v_client);
      v_instructor := coalesce(public._comp10c_uuid(v_person->>'anchorInstructorId'), v_instructor);
    end if;

    v_competitor_id := public._comp10c_resolve_competitor(
      p_event_id, v_user, v_client, v_instructor,
      left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100), v_email, v_dob,
      v_primary_role,
      case when nullif(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), '') is not null
           then jsonb_build_object('wsdc_competitor_id', left(btrim(v_person->>'wsdcCompetitorId'), 40)) else '{}'::jsonb end,
      case when v_is_manager and (v_client is not null or v_instructor is not null) and v_user is null then 'staff' else 'registration' end,
      v_order_id);
    if v_competitor_map ? v_competitor_id::text then
      raise exception 'COMP10C_DUPLICATE_PERSON: the same person appears twice in the roster.';
    end if;
    v_competitor_map := v_competitor_map || jsonb_build_object(v_competitor_id::text, true);

    insert into public.event_competition_registration_cart_people (
      event_id, cart_id, first_name, last_name, email, phone, date_of_birth, person_type, sort_order,
      wsdc_competitor_id, primary_role, role_points_snapshot, competitor_id
    ) values (
      p_event_id, v_cart_id, left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100), v_email,
      nullif(left(btrim(coalesce(v_person->>'phone', '')), 40), ''), v_dob, v_person_type, v_sort,
      nullif(left(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), 40), ''), v_primary_role, '{}'::jsonb, v_competitor_id
    ) returning id into v_cart_person_id;

    insert into public.event_registration_attendees (
      registration_id, event_id, ticket_type_id, first_name, last_name, email, attendee_role, sort_order
    ) values (
      v_registration_id, p_event_id, null, left(btrim(v_person->>'firstName'), 100), left(btrim(v_person->>'lastName'), 100),
      v_email, 'competitor', v_sort
    ) returning id into v_attendee_id;

    v_person_map := v_person_map || jsonb_build_object(v_person->>'clientId', jsonb_build_object(
      'cart_person_id', v_cart_person_id, 'competitor_id', v_competitor_id, 'attendee_id', v_attendee_id,
      'name', btrim(v_person->>'firstName') || ' ' || btrim(v_person->>'lastName'),
      'primary_role', v_primary_role, 'wsdc', nullif(btrim(coalesce(v_person->>'wsdcCompetitorId', '')), '')));
  end loop;

  -- Entries -> cart entry + order item + canonical entry + participants + dances.
  v_sort := 0;
  for v_entry in select x from jsonb_array_elements(p_draft->'entries') x loop
    v_sort := v_sort + 1;
    select c.id, c.name, c.entry_format into v_contest from public.event_competition_contests c
    where c.id = (v_entry->>'contestId')::uuid;
    select d.id, d.name, d.program_id into v_division from public.event_competition_divisions d
    where d.id = (v_entry->>'divisionId')::uuid;

    select coalesce(array_agg(v_person_map->(p)->>'name' order by o), '{}') into v_names
    from (select p, min(o) o from jsonb_array_elements_text(v_entry->'participantIds') with ordinality s(p, o) group by p) q;
    v_display := left(case
      when v_contest.entry_format = 'team' then btrim(v_entry->>'teamName')
      when cardinality(v_names) > 0 then array_to_string(v_names, ' / ')
      else v_contest.name || ' — ' || v_division.name end, 240);

    select coalesce(jsonb_agg(l), '[]'::jsonb), coalesce(sum((l->>'lineCents')::bigint), 0)
      into v_entry_lines, v_entry_cents
    from jsonb_array_elements(v_quote->'lines') l
    where l->>'clientEntryId' = v_entry->>'clientId' and l->>'lineType' <> 'discount';

    insert into public.event_competition_registration_cart_entries (
      event_id, cart_id, program_id, contest_id, division_id, display_name, routine_title, routine_duration_seconds,
      music_title, music_artist, notes, status, sort_order
    ) values (
      p_event_id, v_cart_id, v_division.program_id, v_contest.id, v_division.id, v_display,
      nullif(left(btrim(coalesce(v_entry->>'routineTitle', '')), 200), ''),
      case when coalesce(v_entry->>'routineDurationSeconds', '') ~ '^\d+$' and (v_entry->>'routineDurationSeconds')::bigint between 1 and 86400
           then (v_entry->>'routineDurationSeconds')::int end,
      nullif(left(btrim(coalesce(v_entry->>'musicTitle', '')), 200), ''),
      nullif(left(btrim(coalesce(v_entry->>'musicArtist', '')), 200), ''),
      nullif(left(btrim(coalesce(v_entry->>'notes', '')), 1000), ''),
      case when v_free_now then 'submitted' else 'checkout_pending' end, v_sort
    ) returning id into v_cart_entry_id;
    v_cart_entry_map := v_cart_entry_map || jsonb_build_object(v_entry->>'clientId', v_cart_entry_id);

    v_entry_id := gen_random_uuid();
    insert into public.event_order_items (
      order_id, event_id, item_type, reference_id, ticket_type_id, coach_slot_id, description, quantity,
      unit_price, total_price, currency, attendee_names, metadata
    ) values (
      v_order_id, p_event_id, 'competition_entry', v_entry_id, null, null,
      left(v_event.name || ' — ' || v_contest.name || ' — ' || v_division.name, 500), 1,
      (v_entry_cents::numeric / 100), (v_entry_cents::numeric / 100), v_quote->>'currency', to_jsonb(v_names),
      jsonb_build_object('revenue_class', 'competition_entry', 'registration_id', v_registration_id,
        'registration_cart_id', v_cart_id, 'cart_entry_id', v_cart_entry_id, 'contest_id', v_contest.id,
        'division_id', v_division.id, 'price_lines', v_entry_lines)
    ) returning id into v_item_id;

    insert into public.event_competition_entries (
      id, event_id, program_id, division_id, registration_id, order_id, order_item_id, registration_cart_id,
      display_name, represented_studio_name, status, eligibility_status, registration_channel,
      submitted_by_user_id, submitted_at, confirmed_at, sort_order, metadata
    ) values (
      v_entry_id, p_event_id, v_division.program_id, v_division.id, v_registration_id, v_order_id, v_item_id, v_cart_id,
      v_display, v_studio_name, case when v_free_now then 'confirmed' else 'pending' end, 'unverified',
      case when v_mode = 'studio' then 'studio' else 'student_self' end,
      p_actor_user_id, v_now, case when v_free_now then v_now end, v_sort,
      jsonb_build_object('cart_entry_id', v_cart_entry_id, 'contest_id', v_contest.id,
        'team_name', case when v_contest.entry_format = 'team' then btrim(v_entry->>'teamName') end,
        'routine_title', nullif(btrim(coalesce(v_entry->>'routineTitle', '')), ''),
        'routine_duration_seconds', case when coalesce(v_entry->>'routineDurationSeconds', '') ~ '^\d+$' then (v_entry->>'routineDurationSeconds')::bigint end,
        'music_title', nullif(btrim(coalesce(v_entry->>'musicTitle', '')), ''),
        'music_artist', nullif(btrim(coalesce(v_entry->>'musicArtist', '')), ''))
    );
    update public.event_competition_registration_cart_entries set official_entry_id = v_entry_id where id = v_cart_entry_id;
    v_entry_map := v_entry_map || jsonb_build_object(v_entry->>'clientId', v_entry_id);

    v_idx := 0;
    for v_pid in select p from (select p, min(o) o from jsonb_array_elements_text(v_entry->'participantIds') with ordinality s(p, o) group by p) q order by o loop
      v_idx := v_idx + 1;
      v_role := coalesce(nullif(v_entry->'participantRoles'->>v_pid, ''), 'dancer');
      v_dance := nullif(v_entry->'participantDanceRoles'->>v_pid, '');
      insert into public.event_competition_registration_cart_entry_people (
        event_id, cart_id, cart_entry_id, cart_person_id, participant_role, dance_role, sort_order
      ) values (
        p_event_id, v_cart_id, v_cart_entry_id, (v_person_map->v_pid->>'cart_person_id')::uuid, v_role, v_dance, v_idx
      );
      insert into public.event_competition_entry_participants (
        event_id, entry_id, competitor_id, registration_attendee_id, participant_role, dance_role, display_name,
        registry_member_id, competition_role_type, role_level_snapshot, sort_order
      ) values (
        p_event_id, v_entry_id, (v_person_map->v_pid->>'competitor_id')::uuid, (v_person_map->v_pid->>'attendee_id')::uuid,
        v_role, v_dance, left(v_person_map->v_pid->>'name', 200), v_person_map->v_pid->>'wsdc',
        case when v_dance is not null and v_person_map->v_pid->>'primary_role' is not null
             then case when v_person_map->v_pid->>'primary_role' = v_dance then 'primary' else 'secondary' end end,
        jsonb_build_object('primary_role', v_person_map->v_pid->>'primary_role', 'registered_role', v_dance), v_idx
      );
    end loop;

    v_idx := 0;
    for v_offering in select jsonb_array_elements_text(coalesce(v_quote->'effective'->(v_entry->>'clientId'), '[]'::jsonb)) loop
      v_idx := v_idx + 1;
      insert into public.event_competition_registration_cart_entry_dances (event_id, cart_id, cart_entry_id, division_dance_id)
      values (p_event_id, v_cart_id, v_cart_entry_id, v_offering::uuid);
      -- dance_key/label/fee/currency are copied from the offering by validate_competition_entry_dance_offering.
      insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label, status, sort_order)
      values (p_event_id, v_entry_id, v_offering::uuid, 'offering', 'Offering',
        case when v_free_now then 'confirmed' else 'registered' end, v_idx);
    end loop;
  end loop;

  -- Immutable price lines (fee rule details copied into metadata; fee_rule_id may later be nulled).
  insert into public.event_competition_registration_cart_price_lines (
    event_id, cart_id, cart_entry_id, fee_rule_id, line_type, description, quantity, unit_amount, line_amount, currency, metadata
  )
  select p_event_id, v_cart_id,
    case when l->>'clientEntryId' is not null then (v_cart_entry_map->>(l->>'clientEntryId'))::uuid end,
    (l->>'feeRuleId')::uuid, l->>'lineType', left(l->>'description', 500), (l->>'quantity')::int,
    ((l->>'unitCents')::numeric / 100), ((l->>'lineCents')::numeric / 100), l->>'currency',
    coalesce(l->'metadata', '{}'::jsonb) || jsonb_build_object('feeRuleId', l->>'feeRuleId', 'unitCents', (l->>'unitCents')::bigint,
      'lineCents', (l->>'lineCents')::bigint)
  from jsonb_array_elements(v_quote->'lines') l;

  -- Cart-level fee and discount lines as order items (existing add_on convention: discount totals 0).
  insert into public.event_order_items (
    order_id, event_id, item_type, reference_id, ticket_type_id, coach_slot_id, description, quantity,
    unit_price, total_price, currency, attendee_names, metadata
  )
  select v_order_id, p_event_id, 'add_on', null, null, null, left(v_event.name || ' — ' || (l->>'description'), 500),
    (l->>'quantity')::int,
    case when l->>'lineType' = 'discount' then 0 else ((l->>'unitCents')::numeric / 100) end,
    case when l->>'lineType' = 'discount' then 0 else ((l->>'lineCents')::numeric / 100) end,
    l->>'currency', '[]'::jsonb,
    jsonb_build_object('revenue_class', 'competition_entry', 'fee_rule_id', l->>'feeRuleId', 'line_type', l->>'lineType',
      'discount_amount', case when l->>'lineType' = 'discount' then ((l->>'lineCents')::numeric / 100) else 0 end,
      'price_line', l)
  from jsonb_array_elements(v_quote->'lines') l
  where l->>'clientEntryId' is null;

  -- Receipt-level registration items mirror the order items.
  insert into public.event_registration_items (registration_id, ticket_type_id, ticket_name_snapshot, quantity, unit_price, line_total)
  select v_registration_id, null, left(oi.description, 500), oi.quantity, oi.unit_price, oi.total_price
  from public.event_order_items oi where oi.order_id = v_order_id;

  return public._comp10c_result(v_cart_id, false);
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 5. create_competition_draft
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_competition_draft(p_event_id uuid, p_spec jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_event record;
  v_profile record;
  v_defaults jsonb;
  v_limits jsonb;
  v_request text;
  v_hash text;
  v_ids uuid[];
  v_mismatch integer;
  v_purpose text;
  v_programs jsonb;
  v_prog jsonb;
  v_prog_ix integer;
  v_prog_key text;
  v_prog_keys text[] := '{}';
  v_template jsonb;
  v_regular_count integer := 0;
  v_special_count integer := 0;
  v_prog_adjudication text;
  v_cat_adjudication text;
  v_cat_judging_key text;
  v_cat_judging jsonb;
  v_cat_label text;
  v_allowed jsonb;
  v_judging_key text;
  v_judging jsonb;
  v_name text;
  v_names text[] := '{}';
  v_pool jsonb;
  v_dance jsonb;
  v_dance_ix integer;
  v_dance_key text;
  v_dance_name text;
  v_dance_keys text[];
  v_used text[];
  v_cat jsonb;
  v_cat_ix integer;
  v_cat_key text;
  v_cat_def jsonb;
  v_cat_seen text[];
  v_style_key text;
  v_style jsonb;
  v_div jsonb;
  v_div_ix integer;
  v_div_seen text[];
  v_div_name text;
  v_total_divisions integer := 0;
  v_model text;
  v_amount numeric;
  v_needs_fee boolean;
  v_fee numeric;
  v_max_price numeric;
  v_opens timestamptz;
  v_closes timestamptz;
  v_account boolean;
  v_page jsonb;
  v_ops text[];
  v_new_start date;
  v_new_end date;
  v_new_start_time time;
  v_new_end_time time;
  v_program_id uuid;
  v_contest_id uuid;
  v_division_id uuid;
  v_dance_id uuid;
  v_dance_ids jsonb;
  v_round jsonb;
  v_round_ix integer;
  v_pending boolean;
  v_any_pending boolean := false;
  v_created uuid[] := '{}';
begin
  if v_actor is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.id, e.name, e.studio_id, e.organizer_id, e.start_date, e.end_date, e.start_time, e.end_time
    into v_event from public.events e where e.id = p_event_id;
  if v_event.id is null then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    raise exception 'A competition setup is required.';
  end if;

  select p.profile_key, p.version, p.defaults, p.status into v_profile
  from public.competition_rules_profiles p
  where p.profile_key = p_spec->>'profile_key'
    and p.version = case when p_spec->>'profile_version' ~ '^[0-9]{1,6}$' then (p_spec->>'profile_version')::integer end;
  if v_profile.profile_key is null or v_profile.status <> 'active' or v_profile.defaults->>'schema' is distinct from '2' then
    raise exception 'Unsupported competition profile.';
  end if;
  -- Referenced profiles are immutable: a superseded version keeps serving the programs created from it, but new
  -- setups use the current one (studio_simple@3 replaced the never-released studio_simple@2).
  if v_profile.profile_key = 'studio_simple' and v_profile.version < 3 then
    raise exception 'These competition rules have been replaced. Reload the page and start the setup again.';
  end if;
  v_defaults := v_profile.defaults;
  v_limits := v_defaults->'limits';
  v_max_price := (v_limits->>'maxPrice')::numeric;

  v_request := p_spec->>'request_key';
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'A request key is required.';
  end if;
  -- jsonb text is canonical (sorted keys, normalized spacing), so equal requests hash equally.
  v_hash := md5(p_spec::text);

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':simple_competition'));

  select array_agg(p.id order by p.sort_order, p.created_at),
         count(*) filter (where p.configuration #>> '{setup,request_hash}' is distinct from v_hash)
    into v_ids, v_mismatch
  from public.event_competition_programs p
  where p.event_id = p_event_id and p.configuration #>> '{simple,request_key}' = v_request;
  if v_ids is not null then
    if v_mismatch > 0 then
      raise exception 'This setup was already submitted with different choices. Reload the page to see the competition that was created.';
    end if;
    return jsonb_build_object('program_ids', to_jsonb(v_ids), 'replayed', true);
  end if;
  if exists (select 1 from public.event_competition_programs p where p.event_id = p_event_id) then
    raise exception 'This event already has competition setup. Use Advanced settings or restart the setup first.';
  end if;

  v_purpose := p_spec->>'purpose';
  if v_purpose is null or v_purpose not in ('competition', 'showcase', 'competition_showcase') then
    raise exception 'Choose what you are creating.';
  end if;
  -- Registration basics (timestamps are computed by the server from the event time zone).
  if jsonb_typeof(p_spec->'registration') is distinct from 'object'
    or jsonb_typeof(p_spec #> '{registration,account_required}') is distinct from 'boolean' then
    raise exception 'Registration details are required.';
  end if;
  begin
    v_opens := case when jsonb_typeof(p_spec #> '{registration,opens_at}') = 'string' then (p_spec #>> '{registration,opens_at}')::timestamptz end;
    v_closes := case when jsonb_typeof(p_spec #> '{registration,closes_at}') = 'string' then (p_spec #>> '{registration,closes_at}')::timestamptz end;
  exception when others then
    raise exception 'Registration dates must be valid dates.';
  end;
  if coalesce(jsonb_typeof(p_spec #> '{registration,opens_at}'), 'null') not in ('string', 'null')
    or coalesce(jsonb_typeof(p_spec #> '{registration,closes_at}'), 'null') not in ('string', 'null') then
    raise exception 'Registration dates must be valid dates.';
  end if;
  if v_opens is not null and v_closes is not null and v_closes <= v_opens then
    raise exception 'Registration cannot close before it opens.';
  end if;
  v_account := (p_spec #>> '{registration,account_required}')::boolean;

  -- Event page (optional): only the fields the organizer changed. Venue, dates and slug stay with the event.
  v_page := coalesce(p_spec->'event', '{}'::jsonb);
  if jsonb_typeof(v_page) <> 'object'
    or exists (select 1 from jsonb_object_keys(v_page) k
               where k not in ('name', 'summary', 'description', 'cover_image_url', 'highlights', 'registration_info',
                               'venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code',
                               'start_date', 'end_date', 'start_time', 'end_time', 'timezone')) then
    raise exception 'The event page details are not valid.';
  end if;
  -- Venue, address, dates, times and time zone: owner/admin roles only, valid values, nothing depending on them.
  v_ops := array(select k from jsonb_object_keys(v_page) k
                 where k in ('venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code',
                             'start_date', 'end_date', 'start_time', 'end_time', 'timezone'));
  if cardinality(v_ops) > 0 then
    if not public.can_edit_competition_event_operations(p_event_id) then
      raise exception 'Only studio owners and admins, and organizer owners and admins, can change the venue, dates, times or time zone.'
        using errcode = '42501';
    end if;
    if exists (select 1 from unnest(v_ops) k where jsonb_typeof(v_page->k) not in ('string', 'null'))
      or (v_page ? 'start_date' and jsonb_typeof(v_page->'start_date') <> 'string')
      or (v_page ? 'timezone' and jsonb_typeof(v_page->'timezone') <> 'string') then
      raise exception 'The venue, dates or time zone are not valid.';
    end if;
    if exists (select 1 from (values ('venue_name', 200), ('address_line_1', 200), ('address_line_2', 200), ('city', 120), ('postal_code', 20)) f(k, max_length)
               where v_page ? f.k and length(coalesce(v_page->>f.k, '')) > f.max_length)
      or (v_page ? 'state' and coalesce(v_page->>'state', '') !~ '^([A-Z]{2})?$') then
      raise exception 'The venue or address is not valid.';
    end if;
    if (v_page ? 'timezone' and not exists (select 1 from pg_timezone_names tz where tz.name = v_page->>'timezone'))
      or exists (select 1 from unnest(array['start_date', 'end_date']) k
                 where v_page ? k and coalesce(v_page->>k, '') <> '' and v_page->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or exists (select 1 from unnest(array['start_time', 'end_time']) k
                 where v_page ? k and coalesce(v_page->>k, '') <> '' and v_page->>k !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'Enter valid dates, times and a time zone.';
    end if;
    begin
      v_new_start := case when v_page ? 'start_date' then (v_page->>'start_date')::date else v_event.start_date end;
      v_new_end := case when v_page ? 'end_date' then nullif(v_page->>'end_date', '')::date else v_event.end_date end;
      v_new_start_time := case when v_page ? 'start_time' then nullif(v_page->>'start_time', '')::time else v_event.start_time end;
      v_new_end_time := case when v_page ? 'end_time' then nullif(v_page->>'end_time', '')::time else v_event.end_time end;
    exception when others then
      raise exception 'Enter valid dates, times and a time zone.';
    end;
    if v_new_start is null or (v_new_end is not null and v_new_end < v_new_start) then
      raise exception 'The end date cannot be before the start date.';
    end if;
    if v_new_start_time is not null and v_new_end_time is not null and coalesce(v_new_end, v_new_start) = v_new_start
      and v_new_end_time <= v_new_start_time then
      raise exception 'On a one-day event the end time must be after the start time.';
    end if;
    -- Never move or strand what depends on the venue and dates: registrants are notified only by Edit event.
    if exists (select 1 from public.event_registrations r where r.event_id = p_event_id
               and r.status in ('pending', 'confirmed', 'waitlisted', 'checked_in')) then
      raise exception 'This event already has registrations; change its venue, dates or time zone in Edit event, which notifies registrants.';
    end if;
    if v_ops && array['venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code']
      and exists (select 1 from public.event_locations l where l.event_id = p_event_id and l.active) then
      raise exception 'This event lists additional locations; change its venue in Edit event.';
    end if;
    if v_ops && array['start_date', 'end_date', 'start_time', 'end_time', 'timezone']
      and (exists (select 1 from public.event_schedule_items si where si.event_id = p_event_id)
           or exists (select 1 from public.event_location_sessions ls where ls.event_id = p_event_id)
           or exists (select 1 from public.event_sessions es where es.event_id = p_event_id)
           or exists (select 1 from public.event_competition_schedule_sessions cs where cs.event_id = p_event_id)) then
      raise exception 'This event already has dated schedule items or sessions; change its dates or time zone in Edit event.';
    end if;
  end if;
  if v_page ? 'name' and (jsonb_typeof(v_page->'name') <> 'string' or length(btrim(v_page->>'name')) not between 1 and 160) then
    raise exception 'Enter an event title of 1 to 160 characters.';
  end if;
  if exists (select 1 from (values ('summary', 300), ('description', 10000), ('registration_info', 2000)) f(k, max_length)
             where v_page ? f.k and (jsonb_typeof(v_page->f.k) not in ('string', 'null') or length(coalesce(v_page->>f.k, '')) > f.max_length)) then
    raise exception 'The event page text is too long.';
  end if;
  if v_page ? 'cover_image_url' and jsonb_typeof(v_page->'cover_image_url') <> 'null'
    and (jsonb_typeof(v_page->'cover_image_url') <> 'string' or length(v_page->>'cover_image_url') > 2048
         or v_page->>'cover_image_url' !~ ('^https://[^[:space:]/]+/storage/v1/object/public/event-media/' || v_event.studio_id::text || '/[^[:space:]]+$')) then
    raise exception 'Upload the cover image again.';
  end if;
  if v_page ? 'highlights'
    and (jsonb_typeof(v_page->'highlights') <> 'array' or jsonb_array_length(v_page->'highlights') > 6
         or exists (select 1 from jsonb_array_elements(v_page->'highlights') h(value)
                    where jsonb_typeof(h.value) <> 'string' or length(btrim(h.value #>> '{}')) not between 1 and 120)) then
    raise exception 'Use up to 6 highlights of 1 to 120 characters each.';
  end if;

  v_programs := p_spec->'programs';
  if jsonb_typeof(v_programs) is distinct from 'array'
    or jsonb_array_length(v_programs) < 1 or jsonb_array_length(v_programs) > (v_limits->>'programs')::integer then
    raise exception 'Choose between 1 and % programs.', v_limits->>'programs';
  end if;

  -- ---- validation pass: nothing is written until the whole request is valid ----
  for v_prog in select value from jsonb_array_elements(v_programs) loop
    if jsonb_typeof(v_prog) <> 'object' then raise exception 'Each program must be an object.'; end if;
    v_prog_key := v_prog->>'key';
    v_template := v_defaults->'programs'->v_prog_key;
    if v_prog_key is null or v_template is null then
      raise exception 'Program % is not available.', coalesce(v_prog_key, '(none)');
    end if;
    if v_prog_key = any (v_prog_keys) then raise exception 'Each program can be added once.'; end if;
    v_prog_keys := v_prog_keys || v_prog_key;
    -- Style-level adjudication: the default every ordinary entry format inherits.
    v_prog_adjudication := v_prog->>'adjudication';
    if v_prog_adjudication is null or v_prog_adjudication not in ('adjudicated', 'non_adjudicated') then
      raise exception 'Choose Adjudicated or Non-Adjudicated for %.', v_template->>'label';
    end if;
    v_allowed := case when v_prog_adjudication = 'adjudicated'
                      then v_template->'judging_options'
                      else jsonb_build_array(v_defaults #>> '{adjudication,non_adjudicated,judging}') end;
    v_judging_key := v_prog->>'judging';
    if v_judging_key is null or not coalesce(v_allowed ? v_judging_key, false) or v_defaults->'judging'->v_judging_key is null then
      raise exception 'Choose how % is judged.', v_template->>'label';
    end if;

    v_name := btrim(coalesce(v_prog->>'name', ''));
    if length(v_name) < 1 or length(v_name) > 160 then
      raise exception 'Each program name must be 1 to 160 characters.';
    end if;
    if lower(v_name) = any (v_names) then raise exception 'Program names must be unique (%).', v_name; end if;
    v_names := v_names || lower(v_name);

    -- Program dances: from the profile pool, or organizer-defined when the program allows it.
    v_pool := v_defaults->'dancePools'->(v_template->>'dance_pool');
    if jsonb_typeof(v_prog->'dances') is distinct from 'array' or jsonb_array_length(v_prog->'dances') > (v_limits->>'programDances')::integer then
      raise exception 'Choose % dances or fewer for %.', v_limits->>'programDances', v_template->>'label';
    end if;
    v_dance_keys := '{}';
    for v_dance in select value from jsonb_array_elements(v_prog->'dances') loop
      v_dance_key := v_dance->>'key';
      if jsonb_typeof(v_dance) <> 'object' or v_dance_key is null then raise exception 'Each dance needs a key.'; end if;
      if not exists (select 1 from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key) then
        v_dance_name := btrim(coalesce(v_dance->>'name', ''));
        if not (v_template->>'custom_dances')::boolean or v_dance_key !~ '^custom_[a-z0-9_]{1,40}$'
          or length(v_dance_name) < 1 or length(v_dance_name) > 80 then
          raise exception 'Dance % is not available for %.', v_dance_key, v_template->>'label';
        end if;
      end if;
      if v_dance_key = any (v_dance_keys) then raise exception 'Each dance can be listed once per program.'; end if;
      v_dance_keys := v_dance_keys || v_dance_key;
    end loop;

    if jsonb_typeof(v_prog->'categories') is distinct from 'array'
      or jsonb_array_length(v_prog->'categories') < 1 or jsonb_array_length(v_prog->'categories') > (v_limits->>'categories')::integer then
      raise exception 'Choose between 1 and % categories for %.', v_limits->>'categories', v_template->>'label';
    end if;
    v_cat_seen := '{}';
    v_used := '{}';
    v_needs_fee := false;
    for v_cat in select value from jsonb_array_elements(v_prog->'categories') loop
      if jsonb_typeof(v_cat) <> 'object' then raise exception 'Each entry format must be an object.'; end if;
      v_cat_key := v_cat->>'type';
      v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
      if v_cat_key is null or v_cat_def is null or not (v_template->'formats' ? v_cat_key) then
        raise exception 'Entry format % is not available for %.', coalesce(v_cat_key, '(none)'), v_template->>'label';
      end if;
      -- A styled offering (e.g. Ballroom Pro/Am) is entered per dance style: one category per (offering, style).
      v_style_key := v_cat->>'style';
      v_style := null;
      if coalesce((v_cat_def->>'uses_styles')::boolean, false) then
        select st.value into v_style from jsonb_array_elements(coalesce(v_template->'styles', '[]'::jsonb)) st(value)
        where st.value->>'key' = v_style_key;
        if jsonb_typeof(v_cat->'style') is distinct from 'string' or v_style is null
          or (v_cat_def ? 'style_keys' and not coalesce(v_cat_def->'style_keys' ? v_style_key, false)) then
          raise exception 'Choose an available style for %.', v_cat_def->>'label';
        end if;
      elsif coalesce(jsonb_typeof(v_cat->'style'), 'null') <> 'null' then
        raise exception '% is not entered per style.', v_cat_def->>'label';
      end if;
      if v_cat_key || ':' || coalesce(v_style_key, '') = any (v_cat_seen) then
        raise exception 'Each entry format can be added once per style in a program.';
      end if;
      v_cat_seen := v_cat_seen || (v_cat_key || ':' || coalesce(v_style_key, ''));
      -- Showcase / Performance offers only special (routine / performance) formats.
      if v_purpose = 'showcase' and v_cat_def->>'kind' is distinct from 'special' then
        raise exception '% is not a Showcase / Performance offering.', v_cat_def->>'label';
      end if;
      if v_cat_def->>'kind' = 'special' then v_special_count := v_special_count + 1;
      else v_regular_count := v_regular_count + 1; end if;
      -- A format may differ from its style's adjudication only where the profile allows it.
      v_cat_adjudication := coalesce(v_cat->>'adjudication', 'inherit');
      if v_cat_adjudication not in ('inherit', 'adjudicated', 'non_adjudicated')
        or (v_cat_adjudication <> 'inherit' and not coalesce((v_cat_def->>'adjudication_override')::boolean, false)) then
        raise exception '% follows the style''s adjudication.', v_cat_def->>'label';
      end if;

      if jsonb_typeof(v_cat->'divisions') is distinct from 'array'
        or jsonb_array_length(v_cat->'divisions') < 1 or jsonb_array_length(v_cat->'divisions') > (v_limits->>'divisions')::integer then
        raise exception 'Add between 1 and % divisions for %.', v_limits->>'divisions', v_cat_def->>'label';
      end if;
      v_div_seen := '{}';
      for v_div in select value from jsonb_array_elements(v_cat->'divisions') loop
        if jsonb_typeof(v_div) <> 'object' then raise exception 'Each division must be an object.'; end if;
        v_div_name := btrim(coalesce(v_div->>'name', ''));
        if length(v_div_name) < 1 or length(v_div_name) > (v_limits->>'nameLength')::integer then
          raise exception 'Each division needs a name of 1 to % characters.', v_limits->>'nameLength';
        end if;
        if lower(v_div_name) = any (v_div_seen) then raise exception 'Division names must be unique (%).', v_div_name; end if;
        if coalesce(jsonb_typeof(v_div->'axes'), 'object') <> 'object'
          or exists (select 1 from jsonb_each(coalesce(v_div->'axes', '{}'::jsonb)) a
                     where a.key not in ('skill_level', 'age_group', 'style', 'proficiency', 'contest_type', 'custom')
                        or jsonb_typeof(a.value) <> 'string' or length(btrim(a.value #>> '{}')) not between 1 and 80) then
          raise exception 'Division % has invalid division details.', v_div_name;
        end if;
        v_div_seen := v_div_seen || lower(v_div_name);
      end loop;
      v_total_divisions := v_total_divisions + jsonb_array_length(v_cat->'divisions');

      if (v_cat_def->>'uses_dances')::boolean then
        if jsonb_typeof(v_cat->'dances') is distinct from 'array'
          or jsonb_array_length(v_cat->'dances') < 1 or jsonb_array_length(v_cat->'dances') > (v_limits->>'dances')::integer then
          raise exception 'Choose at least one dance for %.', v_cat_def->>'label';
        end if;
        v_dance_keys := '{}';
        for v_dance_key in select value from jsonb_array_elements_text(v_cat->'dances') loop
          if not exists (select 1 from jsonb_array_elements(v_prog->'dances') d(value) where d.value->>'key' = v_dance_key) then
            raise exception 'Dance % is not part of %.', v_dance_key, v_template->>'label';
          end if;
          -- A styled category holds only its style's dances (or organizer-added dances where the style allows them).
          if v_style is not null and not coalesce(v_style->'dances' ? v_dance_key, false)
            and not (coalesce((v_style->>'allow_custom_dances')::boolean, false) and v_dance_key ~ '^custom_[a-z0-9_]{1,40}$'
                     and not exists (select 1 from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key)) then
            raise exception 'Dance % is not part of the % style.', v_dance_key, v_style->>'label';
          end if;
          if v_dance_key = any (v_dance_keys) then raise exception 'Dances can be chosen once per entry format.'; end if;
          -- A Multi-Dance set is danced in its style's order (NDCA IX.A.1).
          if v_cat_def->>'event_form' = 'multi_dance' and cardinality(v_dance_keys) > 0
            and (select st.n from jsonb_array_elements_text(v_style->'dances') with ordinality st(k, n) where st.k = v_dance_key)
                <= (select st.n from jsonb_array_elements_text(v_style->'dances') with ordinality st(k, n) where st.k = v_dance_keys[cardinality(v_dance_keys)]) then
            raise exception '% dances must be listed in the % order.', v_cat_def->>'label', v_style->>'label';
          end if;
          v_dance_keys := v_dance_keys || v_dance_key;
          if not (v_dance_key = any (v_used)) then v_used := v_used || v_dance_key; end if;
        end loop;
      elsif coalesce(v_cat->'dances', '[]'::jsonb) not in ('[]'::jsonb, 'null'::jsonb) then
        raise exception '% does not use individual dances.', v_cat_def->>'label';
      end if;
      if v_cat_def->>'event_form' = 'multi_dance' then
        if jsonb_array_length(v_cat->'dances') < coalesce((v_cat_def->>'min_dances')::integer, 2) then
          raise exception 'A Multi-Dance set needs at least % dances (%).', coalesce(v_cat_def->>'min_dances', '2'), v_cat_def->>'label';
        end if;
        -- NDCA X.B.4: an Open Amateur division dances every dance of the style.
        if exists (select 1
                   from jsonb_array_elements(v_cat->'divisions') d(value),
                        jsonb_each_text(coalesce(d.value->'axes', '{}'::jsonb)) a(axis, label),
                        jsonb_array_elements(v_defaults #> array['divisionSchemes', v_template #>> array['division_schemes', v_cat_key], 'axes']) sa(value),
                        jsonb_array_elements(sa.value->'values') sv(value)
                   where sa.value->>'key' = a.axis and sv.value->>'label' = a.label
                     and coalesce((sv.value->>'requires_all_style_dances')::boolean, false))
          and exists (select 1 from jsonb_array_elements_text(v_style->'dances') sd(k) where not (v_cat->'dances' ? sd.k)) then
          raise exception 'Open Amateur dances every % dance: choose all of them for %.', v_style->>'label', v_cat_def->>'label';
        end if;
      end if;

      v_model := v_cat #>> '{pricing,model}';
      if v_model is null or not coalesce(v_cat_def->'pricing_models' ? v_model, false) then
        raise exception 'Choose how % is priced.', v_cat_def->>'label';
      end if;
      if v_model in ('per_dance', 'per_entry') then
        if jsonb_typeof(v_cat #> '{pricing,amount}') is distinct from 'number' then
          raise exception 'Enter a price for %.', v_cat_def->>'label';
        end if;
        v_amount := (v_cat #>> '{pricing,amount}')::numeric;
        if v_amount <= 0 or v_amount > v_max_price or v_amount <> round(v_amount, 2) then
          raise exception 'Enter a valid price for %.', v_cat_def->>'label';
        end if;
      elsif coalesce(jsonb_typeof(v_cat #> '{pricing,amount}'), 'null') <> 'null' then
        raise exception 'A price is only entered for per-dance or per-entry pricing (%).', v_cat_def->>'label';
      end if;
      if v_model = 'included' then v_needs_fee := true; end if;
    end loop;

    if exists (select 1 from jsonb_array_elements(v_prog->'dances') d(value) where not (d.value->>'key' = any (v_used))) then
      raise exception 'Remove dances that no entry format in % uses.', v_template->>'label';
    end if;
    if v_needs_fee then
      if jsonb_typeof(v_prog->'registration_fee') is distinct from 'number' then
        raise exception 'Enter the % registration fee.', v_template->>'label';
      end if;
      v_fee := (v_prog->>'registration_fee')::numeric;
      if v_fee <= 0 or v_fee > v_max_price or v_fee <> round(v_fee, 2) then
        raise exception 'Enter a valid % registration fee.', v_template->>'label';
      end if;
    elsif coalesce(jsonb_typeof(v_prog->'registration_fee'), 'null') <> 'null' then
      raise exception 'A registration fee is only used when entries are included in it (%).', v_template->>'label';
    end if;
  end loop;

  if v_total_divisions > (v_limits->>'totalDivisions')::integer then
    raise exception 'This setup has % divisions; use % or fewer.', v_total_divisions, v_limits->>'totalDivisions';
  end if;
  if v_purpose = 'competition_showcase' and (v_regular_count < 1 or v_special_count < 1) then
    raise exception 'Competition + Showcase / Performance needs a competition entry format and a showcase or performance offering.';
  end if;

  -- ---- writes ----
  -- 10C.5 registration isolation: competition setup never changes the event's ordinary registration settings
  -- (registration_required, account_required_for_registration, registration_opens_at / registration_closes_at drive
  -- ordinary ticket checkout and the public event page). The competition registration window and account
  -- requirement are stored on each program (configuration.setup.registration). The event row is only written when
  -- the organizer changed its page, venue or dates.
  if v_page <> '{}'::jsonb then
  update public.events
  set name = case when v_page ? 'name' then btrim(v_page->>'name') else name end,
      short_description = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else short_description end,
      public_summary = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else public_summary end,
      description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else description end,
      public_description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else public_description end,
      cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else cover_image_url end,
      public_cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else public_cover_image_url end,
      public_highlights = case when v_page ? 'highlights'
                               then array(select btrim(h.value) from jsonb_array_elements_text(v_page->'highlights') with ordinality h(value, n) order by h.n)
                               else public_highlights end,
      public_registration_info = case when v_page ? 'registration_info' then nullif(btrim(coalesce(v_page->>'registration_info', '')), '') else public_registration_info end,
      venue_name = case when v_page ? 'venue_name' then nullif(btrim(coalesce(v_page->>'venue_name', '')), '') else venue_name end,
      address_line_1 = case when v_page ? 'address_line_1' then nullif(btrim(coalesce(v_page->>'address_line_1', '')), '') else address_line_1 end,
      address_line_2 = case when v_page ? 'address_line_2' then nullif(btrim(coalesce(v_page->>'address_line_2', '')), '') else address_line_2 end,
      city = case when v_page ? 'city' then nullif(btrim(coalesce(v_page->>'city', '')), '') else city end,
      state = case when v_page ? 'state' then nullif(btrim(coalesce(v_page->>'state', '')), '') else state end,
      postal_code = case when v_page ? 'postal_code' then nullif(btrim(coalesce(v_page->>'postal_code', '')), '') else postal_code end,
      start_date = case when v_page ? 'start_date' then v_new_start else start_date end,
      end_date = case when v_page ? 'end_date' then v_new_end else end_date end,
      start_time = case when v_page ? 'start_time' then v_new_start_time else start_time end,
      end_time = case when v_page ? 'end_time' then v_new_end_time else end_time end,
      timezone = case when v_page ? 'timezone' then v_page->>'timezone' else timezone end
  where id = p_event_id;
  end if;

  for v_prog, v_prog_ix in select value, ordinality from jsonb_array_elements(v_programs) with ordinality loop
    v_prog_key := v_prog->>'key';
    v_template := v_defaults->'programs'->v_prog_key;
    v_prog_adjudication := v_prog->>'adjudication';
    v_judging_key := v_prog->>'judging';
    v_judging := v_defaults->'judging'->v_judging_key;
    v_pool := v_defaults->'dancePools'->(v_template->>'dance_pool');
    v_fee := case when jsonb_typeof(v_prog->'registration_fee') = 'number' then (v_prog->>'registration_fee')::numeric end;

    insert into public.event_competition_programs (
      event_id, studio_id, organizer_id, name, discipline_family, competition_mode, scoring_method,
      advancement_method, feedback_policy, status, sort_order, rules_profile_key, rules_profile_version, configuration, created_by
    ) values (
      p_event_id, v_event.studio_id, v_event.organizer_id, btrim(v_prog->>'name'), v_template->>'discipline_family',
      v_judging->>'competition_mode', v_judging #>> '{engine,key}', v_judging->>'advancement_method', 'none', 'draft',
      v_prog_ix * 10, v_profile.profile_key, v_profile.version,
      jsonb_build_object(
        'simple', jsonb_build_object('request_key', v_request, 'judging', v_judging_key, 'created_with', 'setup_wizard'),
        'setup', jsonb_build_object('request_hash', v_hash, 'program_key', v_prog_key, 'purpose', v_purpose,
                                    'registration', jsonb_build_object('opens_at', v_opens, 'closes_at', v_closes, 'account_required', v_account),
                                    'adjudication', v_prog_adjudication, 'judging', v_judging_key, 'registration_fee', v_fee,
                                    'programming', v_template->'programming',
                                    'answers', coalesce(p_spec->'answers', '{}'::jsonb))),
      v_actor
    ) returning id into v_program_id;
    v_created := v_created || v_program_id;

    v_dance_ids := '{}'::jsonb;
    for v_dance, v_dance_ix in select value, ordinality from jsonb_array_elements(v_prog->'dances') with ordinality loop
      v_dance_key := v_dance->>'key';
      select pd.value into v_dance from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key;
      if v_dance is null then
        select d.value into v_dance from jsonb_array_elements(v_prog->'dances') d(value) where d.value->>'key' = v_dance_key;
        v_dance := jsonb_build_object('name', btrim(v_dance->>'name'), 'category', 'Custom');
      end if;
      insert into public.event_competition_dances (event_id, program_id, dance_key, name, category_label, sort_order)
      values (p_event_id, v_program_id, v_dance_key, v_dance->>'name', v_dance->>'category', v_dance_ix * 10)
      returning id into v_dance_id;
      v_dance_ids := v_dance_ids || jsonb_build_object(v_dance_key, v_dance_id);
    end loop;

    for v_cat, v_cat_ix in select value, ordinality from jsonb_array_elements(v_prog->'categories') with ordinality loop
      v_cat_key := v_cat->>'type';
      v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
      v_model := v_cat #>> '{pricing,model}';
      v_amount := case when v_model in ('per_dance', 'per_entry') then (v_cat #>> '{pricing,amount}')::numeric else 0 end;
      v_pending := v_model = 'later';
      v_any_pending := v_any_pending or v_pending;
      -- Inherit the style's judging, or apply the Showcase / Spotlight override.
      v_cat_adjudication := coalesce(v_cat->>'adjudication', 'inherit');
      v_cat_judging_key := case
        when v_cat_adjudication = 'inherit' then v_judging_key
        when v_cat_adjudication = 'non_adjudicated' then v_defaults #>> '{adjudication,non_adjudicated,judging}'
        when v_prog_adjudication = 'adjudicated' then v_judging_key
        else v_template #>> '{judging_options,0}'
      end;
      v_cat_judging := v_defaults->'judging'->v_cat_judging_key;
      v_style_key := v_cat->>'style';
      v_style := null;
      if v_style_key is not null then
        select st.value into v_style from jsonb_array_elements(v_template->'styles') st(value) where st.value->>'key' = v_style_key;
      end if;
      v_cat_label := coalesce(v_template #>> array['format_labels', v_cat_key], v_cat_def->>'label')
                     || coalesce(' — ' || (v_style->>'label'), '');

      insert into public.event_competition_contests (event_id, program_id, name, contest_type, entry_format, sort_order, configuration)
      values (p_event_id, v_program_id, v_cat_label, v_cat_def->>'contest_type', v_cat_def->>'entry_format', v_cat_ix * 10,
              jsonb_build_object(
                'simple', jsonb_build_object('category_type', v_cat_key),
                'setup', jsonb_build_object('pricing_model', v_model, 'pricing_pending', v_pending, 'style', v_style_key,
                                            'event_form', v_cat_def->'event_form', 'registration_hold', v_cat_def #> '{registration_hold,key}',
                                            'adjudication', case when v_cat_adjudication = 'inherit' then v_prog_adjudication else v_cat_adjudication end,
                                            'adjudication_source', case when v_cat_adjudication = 'inherit' then 'style' else 'override' end,
                                            'judging', v_cat_judging_key,
                                            'kind', v_cat_def->'kind', 'music_source', v_cat_def->'music_source',
                                            'floor_mode', v_cat_def->'floor_mode', 'program_placement', v_cat_def->'program_placement',
                                            'participant_roles', v_cat_def->'participant_roles', 'dance_roles', v_cat_def->'dance_roles')))
      returning id into v_contest_id;

      update public.event_competition_contest_registration_rules set
        dance_selection_mode = v_cat_def->>'dance_selection_mode',
        pricing_method = case when v_model = 'per_dance' then 'per_dance' else 'flat_entry' end,
        base_entry_fee = case when v_model = 'per_entry' then v_amount else 0 end,
        currency = v_defaults->>'currency',
        minimum_dances = case when v_cat_def->>'dance_selection_mode' = 'individual' then 1 else null end,
        maximum_dances = null,
        minimum_participants = (v_cat_def->>'minimum_participants')::integer,
        maximum_participants = (v_cat_def->>'maximum_participants')::integer,
        terminology = v_defaults->'terminology',
        registration_open = false
      where contest_id = v_contest_id and event_id = p_event_id;
      if not found then
        raise exception 'Category registration rules were not created.';
      end if;

      for v_div, v_div_ix in select value, ordinality from jsonb_array_elements(v_cat->'divisions') with ordinality loop
        insert into public.event_competition_divisions (event_id, program_id, contest_id, name, skill_label, age_label, sort_order, configuration)
        values (p_event_id, v_program_id, v_contest_id, btrim(v_div->>'name'),
                nullif(btrim(coalesce(v_div->>'skill_label', '')), ''), nullif(btrim(coalesce(v_div->>'age_label', '')), ''),
                v_div_ix * 10,
                jsonb_build_object('setup', jsonb_build_object('axes', coalesce(v_div->'axes', '{}'::jsonb))))
        returning id into v_division_id;

        for v_round, v_round_ix in select value, ordinality from jsonb_array_elements(v_cat_judging->'rounds') with ordinality loop
          insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method, pairing_mode)
          values (p_event_id, v_program_id, v_division_id, v_round->>'name', v_round->>'round_type', v_round_ix,
                  v_round->>'scoring_method', v_cat_def->>'pairing_mode');
        end loop;

        if (v_cat_def->>'uses_dances')::boolean then
          for v_dance_key, v_dance_ix in select value, ordinality from jsonb_array_elements_text(v_cat->'dances') with ordinality loop
            insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
            values (p_event_id, v_program_id, v_division_id, (v_dance_ids->>v_dance_key)::uuid,
                    case when v_model = 'per_dance' then v_amount else 0 end, v_defaults->>'currency',
                    v_cat_def->>'dance_selection_mode' <> 'individual', v_dance_ix * 10);
          end loop;
        end if;
      end loop;
    end loop;

    if v_fee is not null then
      insert into public.event_competition_fee_rules (event_id, program_id, name, calculation_type, amount, currency, configuration)
      values (p_event_id, v_program_id, left(btrim(v_prog->>'name'), 160) || ' registration fee', 'flat_per_person', v_fee,
              v_defaults->>'currency', jsonb_build_object('setup', jsonb_build_object('kind', 'registration_fee', 'request_key', v_request)));
    end if;
  end loop;

  return jsonb_build_object('program_ids', to_jsonb(v_created), 'replayed', false, 'pricing_pending', v_any_pending);
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 6. Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if md5(pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) <> '6c3f5d9eb7f2dec1035cb9277202175b'
    or md5(pg_get_functiondef('public.competition_registration_program_open(uuid,uuid)'::regprocedure)) <> '7c779b76affb6e6087c0cfbc4af34b73'
    or md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> 'a2613a416c6e57fe8a4dc41476772cb9'
    or md5(pg_get_functiondef('public.start_competition_registration(uuid,uuid,jsonb,uuid)'::regprocedure)) <> 'bb57ffe0ba7ec742885cd08d1a84171e' then
    raise exception 'Phase 10C.5 registration isolation postflight: a function is not the generated definition.';
  end if;
  if has_function_privilege('anon', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.open_competition_registration(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.start_competition_registration(uuid, uuid, jsonb, uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.start_competition_registration(uuid, uuid, jsonb, uuid)', 'EXECUTE')
    or not has_function_privilege('anon', 'public.competition_registration_program_open(uuid, uuid)', 'EXECUTE')
    or not has_function_privilege('anon', 'public.competition_registration_account_required(uuid)', 'EXECUTE') then
    raise exception 'Phase 10C.5 registration isolation postflight: function privileges are wrong.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_programs'::regclass
                 and tgname = 'protect_competition_program_registration_settings' and tgenabled = 'O') then
    raise exception 'Phase 10C.5 registration isolation postflight: the program registration settings guard is missing.';
  end if;
end $$;
