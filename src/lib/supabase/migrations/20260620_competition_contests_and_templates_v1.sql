-- Competition Contests and Starter Templates V1
-- Adds the industry-level Competition Event/Contest layer and neutral starter templates.
-- Save in: src/lib/supabase/migrations/20260620_competition_contests_and_templates_v1.sql

begin;

create table if not exists public.event_competition_contests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  name text not null,
  code text,
  contest_type text not null,
  entry_format text not null,
  status text not null default 'draft',
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_contests_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_contests_name_check
    check (length(btrim(name)) between 1 and 200),
  constraint event_competition_contests_type_check
    check (contest_type in ('single_dance', 'multi_dance', 'scholarship', 'showdance', 'cabaret', 'formation', 'line_dance', 'team', 'spotlight', 'jack_and_jill', 'strictly', 'exhibition', 'custom')),
  constraint event_competition_contests_entry_format_check
    check (entry_format in ('solo', 'couple', 'pro_am', 'pro_pro', 'mixed_amateur', 'professional', 'team', 'random_partner', 'custom')),
  constraint event_competition_contests_status_check
    check (status in ('draft', 'open', 'closed', 'active', 'complete', 'cancelled')),
  unique (id, event_id),
  unique (id, program_id, event_id)
);

create index if not exists event_competition_contests_program_sort_idx
  on public.event_competition_contests(program_id, sort_order, created_at);

alter table public.event_competition_divisions
  add column if not exists contest_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_competition_divisions_contest_fk'
  ) then
    alter table public.event_competition_divisions
      add constraint event_competition_divisions_contest_fk
      foreign key (contest_id, program_id, event_id)
      references public.event_competition_contests(id, program_id, event_id)
      on delete cascade;
  end if;
end $$;

create index if not exists event_competition_divisions_contest_sort_idx
  on public.event_competition_divisions(contest_id, sort_order, created_at)
  where contest_id is not null;

drop trigger if exists set_event_competition_updated_at
  on public.event_competition_contests;
create trigger set_event_competition_updated_at
before update on public.event_competition_contests
for each row execute function public.set_event_competition_updated_at();

alter table public.event_competition_contests enable row level security;
drop policy if exists competition_manage on public.event_competition_contests;
create policy competition_manage
  on public.event_competition_contests
  for all
  to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

create table if not exists public.competition_configuration_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  name text not null,
  discipline_family text not null,
  version integer not null default 1,
  status text not null default 'active',
  description text,
  blueprint jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competition_configuration_templates_key_check
    check (length(btrim(template_key)) between 1 and 100),
  constraint competition_configuration_templates_discipline_check
    check (discipline_family in ('ballroom', 'country', 'custom')),
  constraint competition_configuration_templates_version_check
    check (version > 0),
  constraint competition_configuration_templates_status_check
    check (status in ('draft', 'active', 'retired')),
  unique (template_key, version)
);

create index if not exists competition_configuration_templates_active_idx
  on public.competition_configuration_templates(discipline_family, status, version desc);

drop trigger if exists set_event_competition_updated_at
  on public.competition_configuration_templates;
create trigger set_event_competition_updated_at
before update on public.competition_configuration_templates
for each row execute function public.set_event_competition_updated_at();

alter table public.competition_configuration_templates enable row level security;
drop policy if exists competition_templates_read on public.competition_configuration_templates;
create policy competition_templates_read
  on public.competition_configuration_templates
  for select
  to authenticated
  using (status = 'active');

insert into public.competition_configuration_templates (
  template_key,
  name,
  discipline_family,
  version,
  description,
  blueprint
)
values
(
  'ballroom_starter',
  'Ballroom Starter',
  'ballroom',
  1,
  'Editable ballroom category shells using neutral terminology.',
  '{
    "program": {
      "name": "Ballroom Competition",
      "competition_mode": "relative",
      "scoring_method": "skating",
      "advancement_method": "recall_count",
      "feedback_policy": "none",
      "rules_edition": "2026 Starter"
    },
    "dances": [
      {"key":"smooth_waltz","name":"Waltz","category":"American Smooth"},
      {"key":"smooth_tango","name":"Tango","category":"American Smooth"},
      {"key":"smooth_foxtrot","name":"Foxtrot","category":"American Smooth"},
      {"key":"smooth_viennese_waltz","name":"Viennese Waltz","category":"American Smooth"},
      {"key":"rhythm_cha_cha","name":"Cha Cha","category":"American Rhythm"},
      {"key":"rhythm_rumba","name":"Rumba","category":"American Rhythm"},
      {"key":"rhythm_swing","name":"Swing","category":"American Rhythm"},
      {"key":"rhythm_bolero","name":"Bolero","category":"American Rhythm"},
      {"key":"rhythm_mambo","name":"Mambo","category":"American Rhythm"},
      {"key":"ballroom_waltz","name":"Waltz","category":"International Ballroom"},
      {"key":"ballroom_tango","name":"Tango","category":"International Ballroom"},
      {"key":"ballroom_viennese_waltz","name":"Viennese Waltz","category":"International Ballroom"},
      {"key":"ballroom_foxtrot","name":"Foxtrot","category":"International Ballroom"},
      {"key":"ballroom_quickstep","name":"Quickstep","category":"International Ballroom"},
      {"key":"latin_cha_cha","name":"Cha Cha","category":"International Latin"},
      {"key":"latin_samba","name":"Samba","category":"International Latin"},
      {"key":"latin_rumba","name":"Rumba","category":"International Latin"},
      {"key":"latin_paso_doble","name":"Paso Doble","category":"International Latin"},
      {"key":"latin_jive","name":"Jive","category":"International Latin"},
      {"key":"showdance","name":"Showdance","category":"Performance"},
      {"key":"formation","name":"Formation Routine","category":"Performance"}
    ],
    "contests": [
      {"name":"American Smooth Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["smooth_waltz","smooth_tango","smooth_foxtrot","smooth_viennese_waltz"]},
      {"name":"American Rhythm Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["rhythm_cha_cha","rhythm_rumba","rhythm_swing","rhythm_bolero","rhythm_mambo"]},
      {"name":"International Ballroom Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["ballroom_waltz","ballroom_tango","ballroom_viennese_waltz","ballroom_foxtrot","ballroom_quickstep"]},
      {"name":"International Latin Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["latin_cha_cha","latin_samba","latin_rumba","latin_paso_doble","latin_jive"]},
      {"name":"Multi-Dance Championship","type":"multi_dance","entry_format":"couple","dance_keys":[]},
      {"name":"Scholarship","type":"scholarship","entry_format":"pro_am","dance_keys":[]},
      {"name":"Showdance / Cabaret","type":"showdance","entry_format":"couple","dance_keys":["showdance"]},
      {"name":"Formation","type":"formation","entry_format":"team","dance_keys":["formation"]}
    ]
  }'::jsonb
),
(
  'country_starter',
  'Country Starter',
  'country',
  1,
  'Editable country category shells using neutral terminology.',
  '{
    "program": {
      "name": "Country Competition",
      "competition_mode": "relative",
      "scoring_method": "majority_rules",
      "advancement_method": "promote_callback",
      "feedback_policy": "none",
      "rules_edition": "2026-2028 Starter"
    },
    "dances": [
      {"key":"two_step","name":"Two Step","category":"Partner"},
      {"key":"waltz","name":"Waltz","category":"Partner"},
      {"key":"triple_two","name":"Triple Two","category":"Partner"},
      {"key":"polka","name":"Polka","category":"Partner"},
      {"key":"east_coast_swing","name":"East Coast Swing","category":"Partner"},
      {"key":"west_coast_swing","name":"West Coast Swing","category":"Partner"},
      {"key":"nightclub","name":"Nightclub","category":"Partner"},
      {"key":"cha_cha","name":"Cha Cha","category":"Partner"},
      {"key":"solo_medley","name":"Solo Medley","category":"Showcase"},
      {"key":"line_routine","name":"Line Dance Routine","category":"Line Dance"},
      {"key":"team_routine","name":"Team Routine","category":"Team"},
      {"key":"spotlight","name":"Spotlight Routine","category":"Spotlight"}
    ],
    "contests": [
      {"name":"ProAm / ProPro Classic","type":"multi_dance","entry_format":"pro_am","dance_keys":["two_step","waltz","triple_two","polka","east_coast_swing","west_coast_swing","nightclub","cha_cha"]},
      {"name":"Couples Classic","type":"multi_dance","entry_format":"couple","dance_keys":["two_step","waltz","triple_two","polka","east_coast_swing","west_coast_swing","nightclub","cha_cha"]},
      {"name":"Line Dance","type":"line_dance","entry_format":"solo","dance_keys":["line_routine"]},
      {"name":"Teams","type":"team","entry_format":"team","dance_keys":["team_routine"]},
      {"name":"Spotlight","type":"spotlight","entry_format":"pro_am","dance_keys":["spotlight"]},
      {"name":"Showcase","type":"showdance","entry_format":"couple","dance_keys":["two_step","waltz","solo_medley"]},
      {"name":"Jack and Jill","type":"jack_and_jill","entry_format":"random_partner","dance_keys":["two_step","west_coast_swing"]},
      {"name":"Strictly","type":"strictly","entry_format":"couple","dance_keys":["two_step","west_coast_swing"]}
    ]
  }'::jsonb
)
on conflict (template_key, version)
do update set
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
  dance_key_value text;
  created_program_id uuid;
  created_contest_id uuid;
  created_division_id uuid;
  template_already_applied boolean;
begin
  if not public.can_manage_event_competition(target_event_id) then
    raise exception 'Not authorized to configure this competition.';
  end if;

  select * into event_row
  from public.events
  where id = target_event_id;

  if not found then
    raise exception 'Event not found.';
  end if;

  select * into template_row
  from public.competition_configuration_templates
  where template_key = selected_template_key
    and status = 'active'
  order by version desc
  limit 1;

  if not found then
    raise exception 'Competition template not found.';
  end if;

  select exists (
    select 1
    from public.event_competition_programs p
    where p.event_id = target_event_id
      and p.configuration->>'template_key' = template_row.template_key
      and p.configuration->>'template_version' = template_row.version::text
  ) into template_already_applied;

  if template_already_applied then
    raise exception 'This template version has already been applied to the event.';
  end if;

  program_json := template_row.blueprint->'program';

  insert into public.event_competition_programs (
    event_id,
    studio_id,
    organizer_id,
    name,
    discipline_family,
    competition_mode,
    scoring_method,
    advancement_method,
    feedback_policy,
    rules_edition,
    status,
    configuration,
    created_by
  ) values (
    target_event_id,
    event_row.studio_id,
    event_row.organizer_id,
    program_json->>'name',
    template_row.discipline_family,
    program_json->>'competition_mode',
    program_json->>'scoring_method',
    program_json->>'advancement_method',
    program_json->>'feedback_policy',
    program_json->>'rules_edition',
    'draft',
    jsonb_build_object(
      'template_key', template_row.template_key,
      'template_version', template_row.version,
      'template_name', template_row.name
    ),
    auth.uid()
  ) returning id into created_program_id;

  for dance_json in
    select value from jsonb_array_elements(template_row.blueprint->'dances')
  loop
    insert into public.event_competition_dances (
      event_id,
      program_id,
      dance_key,
      name,
      category_label
    ) values (
      target_event_id,
      created_program_id,
      dance_json->>'key',
      dance_json->>'name',
      dance_json->>'category'
    );
  end loop;

  for contest_json in
    select value from jsonb_array_elements(template_row.blueprint->'contests')
  loop
    insert into public.event_competition_contests (
      event_id,
      program_id,
      name,
      contest_type,
      entry_format,
      status,
      configuration
    ) values (
      target_event_id,
      created_program_id,
      contest_json->>'name',
      contest_json->>'type',
      contest_json->>'entry_format',
      'draft',
      jsonb_build_object('template_created', true)
    ) returning id into created_contest_id;

    insert into public.event_competition_divisions (
      event_id,
      program_id,
      contest_id,
      name,
      status,
      configuration
    ) values (
      target_event_id,
      created_program_id,
      created_contest_id,
      'Open - Configure age, skill, and role',
      'draft',
      jsonb_build_object('template_placeholder', true)
    ) returning id into created_division_id;

    for dance_key_value in
      select value
      from jsonb_array_elements_text(contest_json->'dance_keys')
    loop
      insert into public.event_competition_division_dances (
        event_id,
        program_id,
        division_id,
        dance_id,
        entry_fee,
        currency
      )
      select
        target_event_id,
        created_program_id,
        created_division_id,
        d.id,
        0,
        'USD'
      from public.event_competition_dances d
      where d.program_id = created_program_id
        and d.dance_key = dance_key_value;
    end loop;

    insert into public.event_competition_rounds (
      event_id,
      program_id,
      division_id,
      name,
      round_type,
      sequence_number,
      status,
      configuration
    ) values (
      target_event_id,
      created_program_id,
      created_division_id,
      'Final',
      case
        when program_json->>'competition_mode' = 'proficiency' then 'proficiency'
        when program_json->>'competition_mode' = 'feedback_only' then 'feedback'
        else 'final'
      end,
      1,
      'draft',
      jsonb_build_object('template_placeholder', true)
    );
  end loop;

  return created_program_id;
end;
$$;

revoke all on function public.apply_competition_configuration_template(uuid, text) from public;
grant execute on function public.apply_competition_configuration_template(uuid, text) to authenticated;

comment on table public.event_competition_contests is
  'Individual competition events/contests within the top-level hosted event.';
comment on table public.competition_configuration_templates is
  'Neutral, versioned configuration blueprints; applying a template copies editable records into an event.';

notify pgrst, 'reload schema';

commit;
