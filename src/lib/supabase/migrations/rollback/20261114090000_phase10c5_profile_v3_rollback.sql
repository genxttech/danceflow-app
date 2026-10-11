-- Rollback for 20261114090000_phase10c5_profile_v3.sql.
--
-- Refuses while any category carries a registration hold (the guard it removes would otherwise let a Multi-Dance
-- category open registration). Restores the 20261113090000 create_competition_draft and open_competition_registration
-- byte-for-byte, drops the event operations guard, and RETIRES (never deletes) studio_simple@3: programs created from
-- it keep their profile reference, and v3 can only be reactivated with identical content by re-applying the file.
-- studio_simple@1 and @2 are not touched. To return to the pre-10C.5 state, run this rollback and then the
-- 20261113090000 rollback.

do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> '040ed4e9444af229b40842ade65bf5e8' then
    raise exception 'Phase 10C.5 v3 rollback: open_competition_registration is not the 20261114090000 definition.';
  end if;
  if exists (select 1 from public.event_competition_contests c where c.configuration #>> '{setup,registration_hold}' is not null) then
    raise exception 'Phase 10C.5 v3 rollback: remove the categories with a registration hold (Multi-Dance) first.';
  end if;
end $$;

create or replace function public.create_competition_draft(p_event_id uuid, p_spec jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select e.id, e.name, e.studio_id, e.organizer_id into v_event from public.events e where e.id = p_event_id;
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
               where k not in ('name', 'summary', 'description', 'cover_image_url', 'highlights', 'registration_info')) then
    raise exception 'The event page details are not valid.';
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
          v_dance_keys := v_dance_keys || v_dance_key;
          if not (v_dance_key = any (v_used)) then v_used := v_used || v_dance_key; end if;
        end loop;
      elsif coalesce(v_cat->'dances', '[]'::jsonb) not in ('[]'::jsonb, 'null'::jsonb) then
        raise exception '% does not use individual dances.', v_cat_def->>'label';
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
  update public.events
  set registration_required = true, account_required_for_registration = v_account,
      registration_opens_at = v_opens, registration_closes_at = v_closes,
      name = case when v_page ? 'name' then btrim(v_page->>'name') else name end,
      short_description = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else short_description end,
      public_summary = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else public_summary end,
      description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else description end,
      public_description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else public_description end,
      cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else cover_image_url end,
      public_cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else public_cover_image_url end,
      public_highlights = case when v_page ? 'highlights'
                               then array(select btrim(h.value) from jsonb_array_elements_text(v_page->'highlights') with ordinality h(value, n) order by h.n)
                               else public_highlights end,
      public_registration_info = case when v_page ? 'registration_info' then nullif(btrim(coalesce(v_page->>'registration_info', '')), '') else public_registration_info end
  where id = p_event_id;

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
$$;

revoke all on function public.create_competition_draft(uuid, jsonb) from public, anon;
grant execute on function public.create_competition_draft(uuid, jsonb) to authenticated, service_role;


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
  if not v_event.registration_required then
    raise exception 'COMP10C_EVENT_REGISTRATION_OFF: turn on event registration before opening competition registration.';
  end if;
  -- 10C.5: a category whose pricing was deferred ("Configure later") blocks opening until it is priced.
  if exists (select 1 from public.event_competition_contests c
             where c.program_id = v_program.id and c.event_id = v_program.event_id and c.status in ('draft', 'open')
               and coalesce(c.configuration #>> '{setup,pricing_pending}', 'false') = 'true') then
    raise exception 'COMP10C_PRICING_PENDING: Pricing requires completion before registration can open.';
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

drop trigger protect_competition_event_operations on public.events;
drop function public.protect_competition_event_operations();
drop function public.can_edit_competition_event_operations(uuid);

update public.competition_rules_profiles set status = 'retired'
where profile_key = 'studio_simple' and version = 3 and status = 'active';

do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> 'abe6b1940de5b96fd931cdddebfd9bed'
    or md5(pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) <> '694b78b1d51d219f0fb4ce0f4b5f32d7' then
    raise exception 'Phase 10C.5 v3 rollback: the 20261113090000 functions were not restored exactly.';
  end if;
end $$;
