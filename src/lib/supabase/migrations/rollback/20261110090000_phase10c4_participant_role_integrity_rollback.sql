-- rollback/20261110090000_phase10c4_participant_role_integrity_rollback.sql
--
-- Reverts 10C.4: restores the 10C functions and participant_role checks verbatim, folds dance_role
-- back into participant_role where the 10C model can hold it (couple, mixed_amateur, random_partner,
-- professional), and drops dance_role. REFUSES (no data loss) if any row carries a dance_role the 10C
-- model cannot represent (pro_am, pro_pro, solo, custom, team ...), or if a pro_pro participant uses
-- the 10C.4 'instructor' relationship. Release order: roll the APP back first.

begin;

do $$
declare
  v_blocked_participants int;
  v_blocked_cart int;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'event_competition_entry_participants' and column_name = 'dance_role') then
    raise exception '10C.4 rollback: dance_role is absent (10C.4 not applied).';
  end if;

  select count(*) into v_blocked_participants
  from public.event_competition_entry_participants p
  left join public.event_competition_entries e on e.id = p.entry_id and e.event_id = p.event_id
  left join public.event_competition_divisions d on d.id = e.division_id and d.event_id = e.event_id
  left join public.event_competition_contests c on c.id = d.contest_id and c.event_id = d.event_id
  where (p.dance_role is not null and coalesce(c.entry_format, '') not in ('couple', 'mixed_amateur', 'random_partner', 'professional'))
     or (c.entry_format = 'pro_pro' and p.participant_role = 'instructor');

  select count(*) into v_blocked_cart
  from public.event_competition_registration_cart_entry_people cp
  left join public.event_competition_registration_cart_entries ce on ce.id = cp.cart_entry_id
  left join public.event_competition_contests c on c.id = ce.contest_id
  where (cp.dance_role is not null and coalesce(c.entry_format, '') not in ('couple', 'mixed_amateur', 'random_partner', 'professional'))
     or (c.entry_format = 'pro_pro' and cp.participant_role = 'instructor');

  if v_blocked_participants > 0 or v_blocked_cart > 0 then
    raise exception '10C.4 rollback refused: % participant row(s) and % cart row(s) hold lead/follow or ProPro roles the 10C model cannot represent.',
      v_blocked_participants, v_blocked_cart;
  end if;
end $$;

alter table public.event_competition_entry_participants drop constraint event_competition_entry_participants_role_check;
alter table public.event_competition_entry_participants
  add constraint event_competition_entry_participants_role_check
  check (participant_role in ('dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other'));
alter table public.event_competition_registration_cart_entry_people drop constraint event_competition_registration_cart_entry_people_role_check;
alter table public.event_competition_registration_cart_entry_people
  add constraint event_competition_registration_cart_entry_people_role_check
  check (participant_role in ('dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other'));

update public.event_competition_entry_participants
set participant_role = dance_role, updated_at = now()
where dance_role is not null;
update public.event_competition_registration_cart_entry_people
set participant_role = dance_role
where dance_role is not null;

create or replace function public._comp10c_allowed_roles(p_entry_format text)
returns text[]
language sql
immutable
as $$
  select case
    when p_entry_format = 'pro_am' then array['student', 'professional']
    when p_entry_format = 'pro_pro' then array['professional']
    when p_entry_format in ('couple', 'mixed_amateur', 'professional') then array['leader', 'follower']
    when p_entry_format = 'random_partner' then array['leader', 'follower']
    when p_entry_format = 'team' then array['team_member']
    else array['dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'alternate', 'other']
  end;
$$;

create or replace function public._comp10c_quote(p_event_id uuid, p_draft jsonb, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_errors text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_effective jsonb := '{}'::jsonb;
  v_currency text := '';
  v_mode text := coalesce(p_draft->>'registrationMode', '');
  v_people jsonb := coalesce(p_draft->'people', '[]'::jsonb);
  v_entries jsonb := coalesce(p_draft->'entries', '[]'::jsonb);
  v_person_ids text[] := '{}';
  v_entry jsonb;
  v_contest record;
  v_division record;
  v_rule record;
  v_offering record;
  v_fee record;
  v_ids text[];
  v_id text;
  v_role text;
  v_roles text[];
  v_available text[];
  v_required text[];
  v_submitted text[];
  v_effective_ids text[];
  v_entry_currency text;
  v_base_cents bigint;
  v_unit_cents bigint;
  v_line_cents bigint;
  v_qty int;
  v_scoped boolean;
  v_matching text[];
  v_matching_people text[];
  v_matching_dances int;
  v_current_subtotal bigint;
  v_rule_currency text;
  v_line_type text;
  v_subtotal bigint;
  v_discount bigint;
  v_self_count int := 0;
  v_entry_ok boolean;
begin
  if jsonb_typeof(v_people) <> 'array' or jsonb_typeof(v_entries) <> 'array' then
    return jsonb_build_object('valid', false, 'errors', jsonb_build_array('Registration details are malformed.'),
      'lines', '[]'::jsonb, 'subtotal_cents', 0, 'discount_cents', 0, 'total_cents', 0, 'currency', 'USD', 'effective', '{}'::jsonb);
  end if;

  if v_mode not in ('individual', 'studio') then v_errors := array_append(v_errors, 'Choose individual or studio registration.'); end if;
  if btrim(coalesce(p_draft->>'buyerName', '')) = '' then v_errors := array_append(v_errors, 'Buyer name is required.'); end if;
  if btrim(coalesce(p_draft->>'buyerEmail', '')) = '' or position('@' in coalesce(p_draft->>'buyerEmail', '')) = 0 then
    v_errors := array_append(v_errors, 'A valid buyer email is required.');
  end if;
  if v_mode = 'studio' and btrim(coalesce(p_draft->>'registeringStudioName', '')) = '' then
    v_errors := array_append(v_errors, 'Studio name is required for studio registration.');
  end if;
  if jsonb_array_length(v_people) = 0 then v_errors := array_append(v_errors, 'Add at least one dancer or instructor.'); end if;
  if jsonb_array_length(v_entries) = 0 then v_errors := array_append(v_errors, 'Add at least one competition entry.'); end if;
  if jsonb_array_length(v_people) > 100 or jsonb_array_length(v_entries) > 100 then
    v_errors := array_append(v_errors, 'One registration can include at most 100 people and 100 entries.');
  end if;

  select coalesce(array_agg(x->>'clientId'), '{}') into v_person_ids from jsonb_array_elements(v_people) x;
  if (select count(distinct id) from unnest(v_person_ids) id) <> cardinality(v_person_ids)
     or exists (select 1 from unnest(v_person_ids) id where coalesce(id, '') = '') then
    v_errors := array_append(v_errors, 'Each roster person needs a unique id.');
  end if;
  -- Entry ids key the per-entry price lines, order items and snapshot: they must be unique too.
  if (select count(distinct coalesce(x->>'clientId', '')) from jsonb_array_elements(v_entries) x) <> jsonb_array_length(v_entries)
     or exists (select 1 from jsonb_array_elements(v_entries) x where coalesce(x->>'clientId', '') = '') then
    v_errors := array_append(v_errors, 'Each entry needs a unique id.');
  end if;
  for v_entry in select x from jsonb_array_elements(v_people) x loop
    if length(btrim(coalesce(v_entry->>'firstName', ''))) not between 1 and 100
       or length(btrim(coalesce(v_entry->>'lastName', ''))) not between 1 and 100 then
      v_errors := array_append(v_errors, 'Each person needs a first and last name.');
    end if;
    if coalesce(v_entry->>'personType', 'dancer') not in ('dancer', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other') then
      v_errors := array_append(v_errors, 'Choose a valid person type.');
    end if;
    if coalesce(v_entry->>'dateOfBirth', '') <> '' and (v_entry->>'dateOfBirth') !~ '^\d{4}-\d{2}-\d{2}$' then
      v_errors := array_append(v_errors, 'Enter dates of birth as YYYY-MM-DD.');
    end if;
    if coalesce(v_entry->>'primaryRole', '') not in ('', 'leader', 'follower') then
      v_errors := array_append(v_errors, 'Choose Leader or Follower as the primary role.');
    end if;
    if coalesce(v_entry->'isSelf' = 'true'::jsonb, false) then v_self_count := v_self_count + 1; end if;
  end loop;
  if v_self_count > 1 then v_errors := array_append(v_errors, 'Only one roster person can be you.'); end if;

  for v_entry in select x from jsonb_array_elements(v_entries) x loop
    select c.id, c.name, c.entry_format into v_contest
    from public.event_competition_contests c
    where c.id = public._comp10c_uuid(v_entry->>'contestId')
      and c.program_id = public._comp10c_uuid(v_entry->>'programId')
      and c.event_id = p_event_id
      and public.competition_contest_registrable(c.id);
    select d.id, d.name into v_division
    from public.event_competition_divisions d
    where d.id = public._comp10c_uuid(v_entry->>'divisionId')
      and d.contest_id = v_contest.id and d.program_id = public._comp10c_uuid(v_entry->>'programId')
      and d.event_id = p_event_id and public.competition_division_registrable(d.id);
    select r.* into v_rule
    from public.event_competition_contest_registration_rules r
    where r.contest_id = v_contest.id and r.event_id = p_event_id and r.registration_open;
    if v_contest.id is null or v_division.id is null or v_rule.id is null then
      v_errors := array_append(v_errors, 'One entry references a competition option that is no longer available.');
      continue;
    end if;

    select coalesce(array_agg(distinct x), '{}') into v_ids
    from jsonb_array_elements_text(coalesce(v_entry->'participantIds', '[]'::jsonb)) x;
    if exists (select 1 from unnest(v_ids) i where not (i = any(v_person_ids))) then
      v_errors := array_append(v_errors, (v_division.name || ': select valid roster participants.'));
    end if;
    if cardinality(v_ids) < v_rule.minimum_participants or cardinality(v_ids) > v_rule.maximum_participants then
      v_errors := array_append(v_errors, (v_division.name || ': select '
        || case when v_rule.minimum_participants = v_rule.maximum_participants then v_rule.minimum_participants::text
                else v_rule.minimum_participants::text || '-' || v_rule.maximum_participants::text end
        || ' participants.'));
    end if;
    if v_contest.entry_format = 'random_partner' then
      v_role := case when cardinality(v_ids) = 1 then coalesce(v_entry->'participantRoles'->>v_ids[1], '') else '' end;
      if v_role not in ('leader', 'follower') then
        v_errors := array_append(v_errors, (v_division.name || ': select Leader or Follower for this entry.'));
      end if;
    end if;
    v_roles := public._comp10c_allowed_roles(v_contest.entry_format);
    if exists (select 1 from unnest(v_ids) i
               where not (coalesce(v_entry->'participantRoles'->>i, 'dancer') = any(v_roles))) then
      v_errors := array_append(v_errors, (v_division.name || ': choose a valid role for each participant.'));
    end if;
    if v_contest.entry_format = 'team' and btrim(coalesce(v_entry->>'teamName', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': team name is required.'));
    end if;
    if v_rule.requires_routine_title and btrim(coalesce(v_entry->>'routineTitle', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': routine title is required.'));
    end if;
    if v_rule.requires_music and btrim(coalesce(v_entry->>'musicTitle', '')) = '' then
      v_errors := array_append(v_errors, (v_division.name || ': music title is required.'));
    end if;
    if v_rule.requires_duration and not (coalesce(nullif(v_entry->>'routineDurationSeconds', ''), '0') ~ '^\d+$'
         and (v_entry->>'routineDurationSeconds')::bigint > 0) then
      v_errors := array_append(v_errors, (v_division.name || ': routine duration is required.'));
    end if;

    select coalesce(array_agg(dd.id::text order by dd.sort_order, dd.id), '{}'),
           coalesce(array_agg(dd.id::text order by dd.sort_order, dd.id) filter (where dd.required), '{}')
      into v_available, v_required
    from public.event_competition_division_dances dd
    join public.event_competition_dances dn on dn.id = dd.dance_id and dn.event_id = dd.event_id
    where dd.division_id = v_division.id and dd.event_id = p_event_id and public.competition_offering_registrable(dd.id);

    select coalesce(array_agg(x order by o), '{}') into v_submitted
    from (
      select x, min(o) o
      from jsonb_array_elements_text(coalesce(v_entry->'selectedOfferingIds', '[]'::jsonb)) with ordinality s(x, o)
      where x = any(v_available)
      group by x
    ) q;

    if v_rule.dance_selection_mode in ('prescribed_set', 'routine') then
      v_effective_ids := v_available;
    elsif v_rule.dance_selection_mode = 'none' then
      v_effective_ids := '{}';
    else
      v_effective_ids := v_required;
      foreach v_id in array v_submitted loop
        if not (v_id = any(v_effective_ids)) then v_effective_ids := v_effective_ids || v_id; end if;
      end loop;
    end if;
    v_effective := v_effective || jsonb_build_object(v_entry->>'clientId', to_jsonb(v_effective_ids));

    if v_rule.dance_selection_mode in ('individual', 'choose_count') then
      if v_rule.minimum_dances is not null and cardinality(v_effective_ids) < v_rule.minimum_dances then
        v_errors := array_append(v_errors, (v_division.name || ': select at least ' || v_rule.minimum_dances || ' dances.'));
      end if;
      if v_rule.maximum_dances is not null and cardinality(v_effective_ids) > v_rule.maximum_dances then
        v_errors := array_append(v_errors, (v_division.name || ': select no more than ' || v_rule.maximum_dances || ' dances.'));
      end if;
    end if;

    v_entry_currency := upper(coalesce(nullif(v_rule.currency, ''), 'USD'));
    if v_currency <> '' and v_entry_currency <> v_currency then
      v_errors := array_append(v_errors, (v_division.name || ': all competition entries in one checkout must use ' || v_currency || '.'));
    end if;
    if v_currency = '' then v_currency := v_entry_currency; end if;

    if v_rule.pricing_method in ('flat_entry', 'base_plus_dance', 'included_set', 'custom') then
      v_base_cents := greatest(0, round(v_rule.base_entry_fee * 100))::bigint;
      v_lines := v_lines || jsonb_build_object(
        'clientEntryId', v_entry->>'clientId', 'feeRuleId', null, 'lineType', 'base_entry',
        'description', v_contest.name || ' — ' || v_division.name, 'quantity', 1,
        'unitCents', v_base_cents, 'lineCents', v_base_cents, 'currency', v_currency,
        'metadata', jsonb_build_object('contestId', v_contest.id, 'divisionId', v_division.id,
          'ruleId', v_rule.id, 'pricingMethod', v_rule.pricing_method));
    end if;
    if v_rule.pricing_method in ('per_dance', 'base_plus_dance') then
      foreach v_id in array v_effective_ids loop
        select dd.id, dd.entry_fee, dd.currency, dn.name as dance_name into v_offering
        from public.event_competition_division_dances dd
        join public.event_competition_dances dn on dn.id = dd.dance_id
        where dd.id = v_id::uuid;
        if v_offering.id is null then continue; end if;
        if upper(coalesce(nullif(v_offering.currency, ''), v_currency)) <> v_currency then
          v_errors := array_append(v_errors, (v_division.name || ': all fees must use ' || v_currency || '.'));
        end if;
        v_unit_cents := greatest(0, round(v_offering.entry_fee * 100))::bigint;
        v_lines := v_lines || jsonb_build_object(
          'clientEntryId', v_entry->>'clientId', 'feeRuleId', null, 'lineType', 'dance',
          'description', v_contest.name || ' — ' || v_division.name || ' — ' || coalesce(v_offering.dance_name, 'Dance'),
          'quantity', 1, 'unitCents', v_unit_cents, 'lineCents', v_unit_cents, 'currency', v_currency,
          'metadata', jsonb_build_object('contestId', v_contest.id, 'divisionId', v_division.id, 'offeringId', v_offering.id));
      end loop;
    end if;
  end loop;

  -- Fee rules: registrable, active, inside their window at p_now, matching the mode; applied in
  -- (priority, name, id) order -- percentage rules see the lines produced before them.
  for v_fee in
    select f.* from public.event_competition_fee_rules f
    where f.event_id = p_event_id and f.active
      and (f.starts_at is null or f.starts_at <= p_now)
      and (f.ends_at is null or f.ends_at > p_now)
      and f.registration_mode in ('both', v_mode)
      and case when f.program_id is null then public.competition_registration_event_open(p_event_id)
               else public.competition_registration_program_open(p_event_id, f.program_id) end
    order by f.priority, f.name collate "C", f.id
  loop
    select coalesce(array_agg(x->>'clientId'), '{}') into v_matching
    from jsonb_array_elements(v_entries) x
    where (v_fee.program_id is null or x->>'programId' = v_fee.program_id::text)
      and (v_fee.contest_id is null or x->>'contestId' = v_fee.contest_id::text)
      and (v_fee.division_id is null or x->>'divisionId' = v_fee.division_id::text);
    v_scoped := v_fee.program_id is not null or v_fee.contest_id is not null or v_fee.division_id is not null;
    if v_scoped and cardinality(v_matching) = 0 then continue; end if;

    v_rule_currency := upper(coalesce(nullif(v_fee.currency, ''), nullif(v_currency, ''), 'USD'));
    if v_currency = '' then v_currency := v_rule_currency; end if;
    if v_rule_currency <> v_currency then
      v_errors := array_append(v_errors, (v_fee.name || ': all fees must use ' || v_currency || '.'));
      continue;
    end if;

    select coalesce(sum(jsonb_array_length(coalesce(v_effective->(m), '[]'::jsonb))), 0) into v_matching_dances
    from unnest(v_matching) m;
    select coalesce(array_agg(distinct p), '{}') into v_matching_people
    from jsonb_array_elements(v_entries) x, jsonb_array_elements_text(coalesce(x->'participantIds', '[]'::jsonb)) p
    where x->>'clientId' = any(v_matching);
    select coalesce(sum((l->>'lineCents')::bigint), 0) into v_current_subtotal
    from jsonb_array_elements(v_lines) l
    where l->>'lineType' <> 'discount'
      and (not v_scoped or (l->>'clientEntryId' is not null and l->>'clientEntryId' = any(v_matching)));

    v_qty := 1;
    v_unit_cents := greatest(0, round(v_fee.amount * 100))::bigint;
    if v_fee.calculation_type = 'flat_per_person' then
      v_qty := case when cardinality(v_matching_people) > 0 then cardinality(v_matching_people) else jsonb_array_length(v_people) end;
    elsif v_fee.calculation_type = 'flat_per_entry' then
      v_qty := case when cardinality(v_matching) > 0 then cardinality(v_matching) else jsonb_array_length(v_entries) end;
    elsif v_fee.calculation_type = 'flat_per_dance' then
      v_qty := v_matching_dances;
    elsif v_fee.calculation_type in ('percentage', 'discount_percentage') then
      v_unit_cents := round(v_current_subtotal::numeric * greatest(0, coalesce(v_fee.percentage, 0)) / 100)::bigint;
      v_qty := 1;
    end if;
    v_line_cents := v_unit_cents * greatest(0, v_qty);
    v_line_type := case when v_fee.calculation_type in ('discount_flat', 'discount_percentage') then 'discount' else 'fee' end;
    if v_line_cents > 0 then
      v_lines := v_lines || jsonb_build_object(
        'clientEntryId', null, 'feeRuleId', v_fee.id, 'lineType', v_line_type, 'description', v_fee.name,
        'quantity', greatest(1, v_qty), 'unitCents', v_unit_cents, 'lineCents', v_line_cents, 'currency', v_currency,
        'metadata', jsonb_build_object('calculationType', v_fee.calculation_type, 'amount', v_fee.amount,
          'percentage', v_fee.percentage, 'startsAt', v_fee.starts_at, 'endsAt', v_fee.ends_at,
          'priority', v_fee.priority, 'scope', jsonb_build_object('programId', v_fee.program_id,
            'contestId', v_fee.contest_id, 'divisionId', v_fee.division_id)));
    end if;
  end loop;

  select coalesce(sum((l->>'lineCents')::bigint) filter (where l->>'lineType' <> 'discount'), 0),
         coalesce(sum((l->>'lineCents')::bigint) filter (where l->>'lineType' = 'discount'), 0)
    into v_subtotal, v_discount
  from jsonb_array_elements(v_lines) l;
  v_discount := least(v_subtotal, v_discount);

  return jsonb_build_object(
    'valid', cardinality(v_errors) = 0,
    'errors', to_jsonb(v_errors),
    'lines', v_lines,
    'subtotal_cents', v_subtotal,
    'discount_cents', v_discount,
    'total_cents', v_subtotal - v_discount,
    'currency', coalesce(nullif(v_currency, ''), 'USD'),
    'effective', v_effective,
    'priced_at', p_now
  );
end;
$$;

create or replace function public.start_competition_registration(
  p_event_id uuid,
  p_client_request_id uuid,
  p_draft jsonb,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
-- extensions: the attendee ticket-code trigger (set_event_attendee_ticket_code) calls gen_random_bytes unqualified.
set search_path = public, extensions, pg_temp
as $$
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
  if v_event.account_required_for_registration and p_actor_user_id is null then
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
      insert into public.event_competition_registration_cart_entry_people (
        event_id, cart_id, cart_entry_id, cart_person_id, participant_role, sort_order
      ) values (
        p_event_id, v_cart_id, v_cart_entry_id, (v_person_map->v_pid->>'cart_person_id')::uuid, v_role, v_idx
      );
      insert into public.event_competition_entry_participants (
        event_id, entry_id, competitor_id, registration_attendee_id, participant_role, display_name,
        registry_member_id, competition_role_type, role_level_snapshot, sort_order
      ) values (
        p_event_id, v_entry_id, (v_person_map->v_pid->>'competitor_id')::uuid, (v_person_map->v_pid->>'attendee_id')::uuid,
        v_role, left(v_person_map->v_pid->>'name', 200), v_person_map->v_pid->>'wsdc',
        case when v_role in ('leader', 'follower') and v_person_map->v_pid->>'primary_role' is not null
             then case when v_person_map->v_pid->>'primary_role' = v_role then 'primary' else 'secondary' end end,
        jsonb_build_object('primary_role', v_person_map->v_pid->>'primary_role', 'registered_role', v_role), v_idx
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
$$;

drop function public._comp10c4_participant_shape_errors(text, text, text[], text[]);

alter table public.event_competition_entry_participants drop column dance_role;
alter table public.event_competition_registration_cart_entry_people drop column dance_role;

do $$
begin
  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.event_competition_entry_participants'::regclass
        and conname = 'event_competition_entry_participants_role_check') is distinct from $c$CHECK ((participant_role = ANY (ARRAY['dancer'::text, 'leader'::text, 'follower'::text, 'student'::text, 'professional'::text, 'instructor'::text, 'team_member'::text, 'alternate'::text, 'other'::text])))$c$ then
    raise exception '10C.4 rollback postflight: participant_role check not restored.';
  end if;
end $$;

commit;
