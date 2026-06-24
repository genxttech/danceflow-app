-- West Coast Swing Competition Foundation V1
-- Save in: src/lib/supabase/migrations/20260622_west_coast_swing_foundation_v1.sql

begin;

alter table public.event_competition_programs
  drop constraint if exists event_competition_programs_discipline_check;
alter table public.event_competition_programs
  add constraint event_competition_programs_discipline_check
  check (discipline_family in ('showcase', 'ballroom', 'country', 'west_coast_swing', 'collegiate_amateur', 'custom'));

alter table public.competition_configuration_templates
  drop constraint if exists competition_configuration_templates_discipline_check;
alter table public.competition_configuration_templates
  add constraint competition_configuration_templates_discipline_check
  check (discipline_family in ('ballroom', 'country', 'west_coast_swing', 'custom'));

alter table public.event_competition_programs
  drop constraint if exists event_competition_programs_scoring_check;
alter table public.event_competition_programs
  add constraint event_competition_programs_scoring_check
  check (scoring_method in ('skating', 'majority_rules', 'wsdc_callback', 'relative_placement', 'round_specific', 'proficiency', 'cumulative_points', 'feedback_only', 'custom', 'none'));

alter table public.event_competition_rounds
  add column if not exists scoring_method text not null default 'none',
  add column if not exists pairing_mode text not null default 'fixed',
  add column if not exists score_roles_separately boolean not null default false,
  add column if not exists minimum_panel_size integer,
  add column if not exists chief_judge_tiebreak boolean not null default false;

alter table public.event_competition_rounds
  drop constraint if exists event_competition_rounds_scoring_method_check;
alter table public.event_competition_rounds
  add constraint event_competition_rounds_scoring_method_check
  check (scoring_method in ('skating', 'majority_rules', 'wsdc_callback', 'relative_placement', 'proficiency', 'cumulative_points', 'feedback_only', 'custom', 'none'));
alter table public.event_competition_rounds
  drop constraint if exists event_competition_rounds_pairing_mode_check;
alter table public.event_competition_rounds
  add constraint event_competition_rounds_pairing_mode_check
  check (pairing_mode in ('fixed', 'random_rotation', 'random_final_pair', 'individual', 'team', 'none'));
alter table public.event_competition_rounds
  drop constraint if exists event_competition_rounds_panel_size_check;
alter table public.event_competition_rounds
  add constraint event_competition_rounds_panel_size_check
  check (minimum_panel_size is null or minimum_panel_size > 0);

alter table public.event_competition_registration_cart_people
  add column if not exists wsdc_competitor_id text,
  add column if not exists primary_role text,
  add column if not exists role_points_snapshot jsonb not null default '{}'::jsonb;

alter table public.event_competition_registration_cart_people
  drop constraint if exists event_competition_registration_cart_people_primary_role_check;
alter table public.event_competition_registration_cart_people
  add constraint event_competition_registration_cart_people_primary_role_check
  check (primary_role is null or primary_role in ('leader', 'follower'));
alter table public.event_competition_entry_participants
  add column if not exists registry_member_id text,
  add column if not exists competition_role_type text,
  add column if not exists role_level_snapshot jsonb not null default '{}'::jsonb;

alter table public.event_competition_entry_participants
  drop constraint if exists event_competition_entry_participants_competition_role_check;
alter table public.event_competition_entry_participants
  add constraint event_competition_entry_participants_competition_role_check
  check (competition_role_type is null or competition_role_type in ('primary', 'secondary', 'age_based', 'open'));

create table if not exists public.event_competition_wsdc_program_profiles (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  rules_edition text not null default '2026.1C',
  registry_status text not null default 'not_declared',
  registry_event_name text,
  competitor_surcharge numeric(10, 2) not null default 0,
  surcharge_currency text not null default 'USD',
  results_reporting_required boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_wsdc_program_profiles_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_wsdc_program_profiles_status_check
    check (registry_status in ('not_declared', 'trial', 'approved', 'not_applicable')),
  constraint event_competition_wsdc_program_profiles_surcharge_check
    check (competitor_surcharge >= 0),
  unique (program_id),
  unique (id, event_id)
);

create table if not exists public.event_competition_wsdc_division_rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  division_id uuid not null,
  category_type text not null,
  skill_level text,
  minimum_age integer,
  maximum_age integer,
  age_as_of text not null default 'event_close',
  registry_points_eligible boolean not null default true,
  minimum_finalists_per_role integer not null default 5,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_wsdc_division_rules_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id) on delete cascade,
  constraint event_competition_wsdc_division_rules_category_check
    check (category_type in ('skill', 'age', 'open', 'non_registry')),
  constraint event_competition_wsdc_division_rules_skill_check
    check (skill_level is null or skill_level in ('newcomer', 'novice', 'intermediate', 'advanced', 'all_star', 'champions')),
  constraint event_competition_wsdc_division_rules_age_check
    check ((minimum_age is null or minimum_age >= 0) and (maximum_age is null or maximum_age >= minimum_age)),
  unique (division_id),
  unique (id, event_id)
);

create table if not exists public.competition_wsdc_tier_rules (
  id uuid primary key default gen_random_uuid(),
  rules_edition text not null,
  tier_number integer not null,
  minimum_competitors_per_role integer not null,
  maximum_competitors_per_role integer,
  points_by_placement jsonb not null,
  round_policy jsonb not null,
  created_at timestamptz not null default now(),
  constraint competition_wsdc_tier_rules_tier_check check (tier_number between 1 and 6),
  constraint competition_wsdc_tier_rules_count_check check (
    minimum_competitors_per_role >= 5
    and (maximum_competitors_per_role is null or maximum_competitors_per_role >= minimum_competitors_per_role)
  ),
  unique (rules_edition, tier_number)
);

insert into public.competition_wsdc_tier_rules (
  rules_edition, tier_number, minimum_competitors_per_role, maximum_competitors_per_role,
  points_by_placement, round_policy
) values
  ('2026.1C', 1, 5, 10,  '{"1":3,"2":2,"3":1}',                                  '{"final":true,"preliminary":"uneven_only"}'),
  ('2026.1C', 2, 11, 19, '{"1":6,"2":4,"3":3,"4":2,"5":1}',                    '{"final":true,"preliminary":"optional"}'),
  ('2026.1C', 3, 20, 39, '{"1":10,"2":8,"3":6,"4":4,"5":2,"6-10":1}',         '{"final":true,"preliminary":true,"semifinal":"optional"}'),
  ('2026.1C', 4, 40, 79, '{"1":15,"2":12,"3":10,"4":8,"5":6,"6-12":1}',       '{"final":true,"preliminary":true,"quarterfinal":"optional","semifinal":true}'),
  ('2026.1C', 5, 80, 129,'{"1":20,"2":16,"3":14,"4":12,"5":10,"6-15":2}',     '{"final":true,"preliminary":true,"quarterfinal":"encouraged","semifinal":true}'),
  ('2026.1C', 6, 130, null,'{"1":25,"2":22,"3":18,"4":15,"5":12,"6-15":2}',   '{"final":true,"preliminary":true,"quarterfinal":"encouraged","semifinal":true}')
on conflict (rules_edition, tier_number) do update set
  minimum_competitors_per_role = excluded.minimum_competitors_per_role,
  maximum_competitors_per_role = excluded.maximum_competitors_per_role,
  points_by_placement = excluded.points_by_placement,
  round_policy = excluded.round_policy;

create table if not exists public.event_competition_wsdc_petitions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  cart_person_id uuid references public.event_competition_registration_cart_people(id) on delete set null,
  registration_attendee_id uuid references public.event_registration_attendees(id) on delete set null,
  wsdc_competitor_id text,
  competitor_name text not null,
  role text not null,
  direction text not null,
  from_level text not null,
  requested_level text not null,
  status text not null default 'pending',
  authority text not null,
  effective_until date,
  evidence jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_wsdc_petitions_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_wsdc_petitions_role_check check (role in ('leader', 'follower')),
  constraint event_competition_wsdc_petitions_direction_check check (direction in ('up', 'down')),
  constraint event_competition_wsdc_petitions_level_check check (
    from_level in ('newcomer', 'novice', 'intermediate', 'advanced', 'all_star', 'champions')
    and requested_level in ('newcomer', 'novice', 'intermediate', 'advanced', 'all_star', 'champions')
  ),
  constraint event_competition_wsdc_petitions_status_check check (status in ('pending', 'approved', 'denied', 'expired', 'withdrawn')),
  constraint event_competition_wsdc_petitions_authority_check check (authority in ('event_chief_judge', 'wsdc_cjc')),
  unique (id, event_id)
);

create index if not exists event_competition_wsdc_petitions_event_idx
  on public.event_competition_wsdc_petitions(event_id, status, created_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_wsdc_program_profiles',
    'event_competition_wsdc_division_rules',
    'event_competition_wsdc_petitions'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists competition_manage on public.%I', table_name);
    execute format(
      'create policy competition_manage on public.%I for all to authenticated using (public.can_manage_event_competition(event_id)) with check (public.can_manage_event_competition(event_id))',
      table_name
    );
  end loop;
end $$;

alter table public.competition_wsdc_tier_rules enable row level security;
drop policy if exists competition_wsdc_tier_rules_read on public.competition_wsdc_tier_rules;
create policy competition_wsdc_tier_rules_read
  on public.competition_wsdc_tier_rules for select to authenticated using (true);

create or replace function public.default_competition_registration_rule(target_contest_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  contest_row record;
  discipline text;
  dance_mode text;
  pricing text;
  participant_min integer;
  participant_max integer;
  terminology_value jsonb;
begin
  select c.id, c.event_id, c.program_id, c.contest_type, c.entry_format, p.discipline_family
  into contest_row
  from public.event_competition_contests c
  join public.event_competition_programs p on p.id = c.program_id
  where c.id = target_contest_id;
  if not found then return; end if;

  discipline := contest_row.discipline_family;
  dance_mode := case
    when contest_row.contest_type = 'single_dance' then 'individual'
    when contest_row.contest_type in ('showdance', 'cabaret', 'formation', 'line_dance', 'team', 'spotlight') then 'routine'
    when contest_row.contest_type = 'exhibition' then 'none'
    else 'prescribed_set'
  end;
  pricing := case when dance_mode = 'individual' then 'per_dance' else 'flat_entry' end;
  participant_min := case
    when contest_row.entry_format in ('solo', 'random_partner') then 1
    when contest_row.entry_format = 'team' then 2
    else 2
  end;
  participant_max := case
    when contest_row.entry_format in ('solo', 'random_partner') then 1
    when contest_row.entry_format = 'team' then 100
    else 2
  end;
  terminology_value := case
    when discipline = 'ballroom' then '{"division_label":"Division","skill_label":"Level","age_label":"Age Category","partner_label":"Partner","dance_label":"Dance"}'::jsonb
    when discipline = 'country' then '{"division_label":"Division","skill_label":"Skill Division","age_label":"Age Division","partner_label":"Dance Partner","dance_label":"Dance"}'::jsonb
    when discipline = 'west_coast_swing' then '{"division_label":"Jack and Jill Division","skill_label":"WSDC Skill Level","age_label":"WSDC Age Division","partner_label":"Random Partner","dance_label":"West Coast Swing","role_label":"Leader or Follower","registry_id_label":"WSDC Competitor ID"}'::jsonb
    when discipline = 'showcase' then '{"division_label":"Showcase Category","skill_label":"Level","age_label":"Age Category","partner_label":"Performance Partner","dance_label":"Routine Style"}'::jsonb
    else '{}'::jsonb
  end;

  insert into public.event_competition_contest_registration_rules (
    event_id, program_id, contest_id, dance_selection_mode, pricing_method,
    minimum_dances, minimum_participants, maximum_participants,
    requires_routine_title, requires_music, requires_duration, terminology
  ) values (
    contest_row.event_id, contest_row.program_id, contest_row.id, dance_mode, pricing,
    case when dance_mode = 'individual' then 1 else null end,
    participant_min, participant_max,
    dance_mode = 'routine', dance_mode = 'routine', dance_mode = 'routine', terminology_value
  ) on conflict (contest_id) do nothing;
end;
$$;

insert into public.competition_configuration_templates (
  template_key, name, discipline_family, version, description, blueprint
) values (
  'west_coast_swing_starter',
  'West Coast Swing Starter',
  'west_coast_swing',
  1,
  'Editable West Coast Swing Jack and Jill shells with role-based registration and WSDC 2026 scoring metadata.',
  '{
    "program": {
      "name": "West Coast Swing Competition",
      "competition_mode": "relative",
      "scoring_method": "round_specific",
      "advancement_method": "promote_callback",
      "feedback_policy": "none",
      "rules_edition": "WSDC 2026.1C",
      "wsdc_profile": {"registry_status":"not_declared","results_reporting_required":false}
    },
    "dances": [
      {"key":"west_coast_swing","name":"West Coast Swing","category":"Swing"}
    ],
    "contests": [
      {
        "name":"WSDC Jack and Jill",
        "type":"jack_and_jill",
        "entry_format":"random_partner",
        "dance_keys":["west_coast_swing"],
        "configuration":{"registry_points_contest":true,"registration_unit":"individual","roles":["leader","follower"]},
        "divisions":[
          {"name":"Newcomer Jack and Jill","code":"WSDC-NC","category_type":"skill","skill_level":"newcomer","skill_label":"Newcomer","sort_order":10},
          {"name":"Novice Jack and Jill","code":"WSDC-NOV","category_type":"skill","skill_level":"novice","skill_label":"Novice","sort_order":20},
          {"name":"Intermediate Jack and Jill","code":"WSDC-INT","category_type":"skill","skill_level":"intermediate","skill_label":"Intermediate","sort_order":30},
          {"name":"Advanced Jack and Jill","code":"WSDC-ADV","category_type":"skill","skill_level":"advanced","skill_label":"Advanced","sort_order":40},
          {"name":"All Star Jack and Jill","code":"WSDC-AS","category_type":"skill","skill_level":"all_star","skill_label":"All Star","sort_order":50},
          {"name":"Champions Jack and Jill","code":"WSDC-CH","category_type":"skill","skill_level":"champions","skill_label":"Champions","sort_order":60},
          {"name":"Juniors Jack and Jill","code":"WSDC-JR","category_type":"age","age_label":"Juniors","maximum_age":17,"sort_order":70},
          {"name":"Sophisticated Jack and Jill","code":"WSDC-SOPH","category_type":"age","age_label":"Sophisticated","minimum_age":35,"sort_order":80},
          {"name":"Masters Jack and Jill","code":"WSDC-MAST","category_type":"age","age_label":"Masters","minimum_age":50,"sort_order":90}
        ]
      }
    ]
  }'::jsonb
)
on conflict (template_key, version) do update set
  name = excluded.name,
  discipline_family = excluded.discipline_family,
  description = excluded.description,
  blueprint = excluded.blueprint,
  status = 'active',
  updated_at = now();

create or replace function public.apply_competition_configuration_template(
  target_event_id uuid,
  selected_template_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  template_row public.competition_configuration_templates%rowtype;
  event_row public.events%rowtype;
  program_json jsonb;
  dance_json jsonb;
  contest_json jsonb;
  division_json jsonb;
  round_json jsonb;
  dance_key_value text;
  created_program_id uuid;
  created_contest_id uuid;
  created_division_id uuid;
  template_already_applied boolean;
begin
  if not public.can_manage_event_competition(target_event_id) then
    raise exception 'Not authorized to configure this competition.';
  end if;

  select * into event_row from public.events where id = target_event_id;
  if not found then raise exception 'Event not found.'; end if;

  select * into template_row
  from public.competition_configuration_templates
  where template_key = selected_template_key and status = 'active'
  order by version desc limit 1;
  if not found then raise exception 'Competition template not found.'; end if;

  select exists (
    select 1 from public.event_competition_programs p
    where p.event_id = target_event_id
      and p.configuration->>'template_key' = template_row.template_key
      and p.configuration->>'template_version' = template_row.version::text
  ) into template_already_applied;
  if template_already_applied then
    raise exception 'This template version has already been applied to the event.';
  end if;

  program_json := template_row.blueprint->'program';
  insert into public.event_competition_programs (
    event_id, studio_id, organizer_id, name, discipline_family, competition_mode,
    scoring_method, advancement_method, feedback_policy, rules_edition, status,
    configuration, created_by
  ) values (
    target_event_id, event_row.studio_id, event_row.organizer_id,
    program_json->>'name', template_row.discipline_family,
    program_json->>'competition_mode', program_json->>'scoring_method',
    program_json->>'advancement_method', program_json->>'feedback_policy',
    program_json->>'rules_edition', 'draft',
    jsonb_build_object('template_key', template_row.template_key, 'template_version', template_row.version, 'template_name', template_row.name),
    auth.uid()
  ) returning id into created_program_id;

  if template_row.discipline_family = 'west_coast_swing' then
    insert into public.event_competition_wsdc_program_profiles (
      event_id, program_id, rules_edition, registry_status, results_reporting_required, configuration
    ) values (
      target_event_id, created_program_id, '2026.1C',
      coalesce(program_json->'wsdc_profile'->>'registry_status', 'not_declared'),
      coalesce((program_json->'wsdc_profile'->>'results_reporting_required')::boolean, false),
      coalesce(program_json->'wsdc_profile', '{}'::jsonb)
    );
  end if;

  for dance_json in select value from jsonb_array_elements(template_row.blueprint->'dances') loop
    insert into public.event_competition_dances (event_id, program_id, dance_key, name, category_label)
    values (target_event_id, created_program_id, dance_json->>'key', dance_json->>'name', dance_json->>'category');
  end loop;

  for contest_json in select value from jsonb_array_elements(template_row.blueprint->'contests') loop
    insert into public.event_competition_contests (
      event_id, program_id, name, contest_type, entry_format, status, configuration
    ) values (
      target_event_id, created_program_id, contest_json->>'name', contest_json->>'type',
      contest_json->>'entry_format', 'draft',
      jsonb_build_object('template_created', true) || coalesce(contest_json->'configuration', '{}'::jsonb)
    ) returning id into created_contest_id;

    if jsonb_typeof(contest_json->'divisions') = 'array' and jsonb_array_length(contest_json->'divisions') > 0 then
      for division_json in select value from jsonb_array_elements(contest_json->'divisions') loop
        insert into public.event_competition_divisions (
          event_id, program_id, contest_id, name, code, age_label, skill_label,
          status, sort_order, configuration
        ) values (
          target_event_id, created_program_id, created_contest_id,
          division_json->>'name', division_json->>'code', division_json->>'age_label',
          division_json->>'skill_label', 'draft', coalesce((division_json->>'sort_order')::integer, 0),
          jsonb_build_object('template_created', true) || division_json
        ) returning id into created_division_id;

        if template_row.discipline_family = 'west_coast_swing' then
          insert into public.event_competition_wsdc_division_rules (
            event_id, program_id, division_id, category_type, skill_level,
            minimum_age, maximum_age, registry_points_eligible, configuration
          ) values (
            target_event_id, created_program_id, created_division_id,
            coalesce(division_json->>'category_type', 'open'), division_json->>'skill_level',
            (division_json->>'minimum_age')::integer, (division_json->>'maximum_age')::integer,
            coalesce((division_json->>'registry_points_eligible')::boolean, true), division_json
          );
        end if;

        for dance_key_value in select value from jsonb_array_elements_text(contest_json->'dance_keys') loop
          insert into public.event_competition_division_dances (
            event_id, program_id, division_id, dance_id, entry_fee, currency, required
          ) select target_event_id, created_program_id, created_division_id, d.id, 0, 'USD', true
            from public.event_competition_dances d
            where d.program_id = created_program_id and d.dance_key = dance_key_value;
        end loop;

        insert into public.event_competition_rounds (
          event_id, program_id, division_id, name, round_type, sequence_number,
          scoring_method, pairing_mode, score_roles_separately, minimum_panel_size,
          chief_judge_tiebreak, status, configuration
        ) values (
          target_event_id, created_program_id, created_division_id, 'Final', 'final', 1,
          case when template_row.discipline_family = 'west_coast_swing' then 'relative_placement' else program_json->>'scoring_method' end,
          case when template_row.discipline_family = 'west_coast_swing' then 'random_final_pair' else 'fixed' end,
          false,
          case when template_row.discipline_family = 'west_coast_swing' then 5 else null end,
          template_row.discipline_family = 'west_coast_swing', 'draft',
          jsonb_build_object('template_created', true, 'tier_derived_rounds_required', template_row.discipline_family = 'west_coast_swing')
        );
      end loop;
    else
      insert into public.event_competition_divisions (
        event_id, program_id, contest_id, name, status, configuration
      ) values (
        target_event_id, created_program_id, created_contest_id,
        'Open - Configure age, skill, and role', 'draft', jsonb_build_object('template_placeholder', true)
      ) returning id into created_division_id;

      for dance_key_value in select value from jsonb_array_elements_text(contest_json->'dance_keys') loop
        insert into public.event_competition_division_dances (
          event_id, program_id, division_id, dance_id, entry_fee, currency
        ) select target_event_id, created_program_id, created_division_id, d.id, 0, 'USD'
          from public.event_competition_dances d
          where d.program_id = created_program_id and d.dance_key = dance_key_value;
      end loop;

      insert into public.event_competition_rounds (
        event_id, program_id, division_id, name, round_type, sequence_number, scoring_method,
        status, configuration
      ) values (
        target_event_id, created_program_id, created_division_id, 'Final',
        case when program_json->>'competition_mode' = 'proficiency' then 'proficiency'
             when program_json->>'competition_mode' = 'feedback_only' then 'feedback'
             else 'final' end,
        1,
        case when program_json->>'scoring_method' = 'round_specific' then 'none' else program_json->>'scoring_method' end,
        'draft', jsonb_build_object('template_placeholder', true)
      );
    end if;
  end loop;

  return created_program_id;
end;
$$;

revoke all on function public.apply_competition_configuration_template(uuid, text) from public;
grant execute on function public.apply_competition_configuration_template(uuid, text) to authenticated;

notify pgrst, 'reload schema';

commit;
