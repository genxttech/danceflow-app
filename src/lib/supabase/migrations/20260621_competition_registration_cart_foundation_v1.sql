-- Competition Registration Cart Foundation V1
-- Discipline-aware registration profiles, studio rosters, entry drafts, and authoritative quote lines.
-- Save in: src/lib/supabase/migrations/20260621_competition_registration_cart_foundation_v1.sql

begin;

create table if not exists public.event_competition_contest_registration_rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  contest_id uuid not null,
  registration_open boolean not null default false,
  dance_selection_mode text not null,
  pricing_method text not null,
  base_entry_fee numeric(10, 2) not null default 0,
  currency text not null default 'USD',
  minimum_dances integer,
  maximum_dances integer,
  minimum_participants integer not null default 1,
  maximum_participants integer not null default 1,
  requires_routine_title boolean not null default false,
  requires_music boolean not null default false,
  requires_duration boolean not null default false,
  public_description text,
  terminology jsonb not null default '{}'::jsonb,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_contest_registration_rules_contest_fk
    foreign key (contest_id, program_id, event_id)
    references public.event_competition_contests(id, program_id, event_id) on delete cascade,
  constraint event_competition_contest_registration_rules_dance_mode_check
    check (dance_selection_mode in ('individual', 'prescribed_set', 'choose_count', 'routine', 'none')),
  constraint event_competition_contest_registration_rules_pricing_check
    check (pricing_method in ('per_dance', 'flat_entry', 'base_plus_dance', 'included_set', 'custom')),
  constraint event_competition_contest_registration_rules_fee_check check (base_entry_fee >= 0),
  constraint event_competition_contest_registration_rules_dance_count_check
    check (
      (minimum_dances is null or minimum_dances >= 0)
      and (maximum_dances is null or maximum_dances >= 1)
      and (minimum_dances is null or maximum_dances is null or maximum_dances >= minimum_dances)
    ),
  constraint event_competition_contest_registration_rules_participant_count_check
    check (minimum_participants > 0 and maximum_participants >= minimum_participants),
  unique (contest_id),
  unique (id, event_id)
);

create table if not exists public.event_competition_fee_rules (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid,
  contest_id uuid,
  division_id uuid,
  name text not null,
  calculation_type text not null,
  registration_mode text not null default 'both',
  amount numeric(10, 2) not null default 0,
  percentage numeric(7, 4),
  currency text not null default 'USD',
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  priority integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_fee_rules_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_fee_rules_contest_fk
    foreign key (contest_id, program_id, event_id)
    references public.event_competition_contests(id, program_id, event_id) on delete cascade,
  constraint event_competition_fee_rules_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id) on delete cascade,
  constraint event_competition_fee_rules_name_check check (length(btrim(name)) between 1 and 180),
  constraint event_competition_fee_rules_type_check
    check (calculation_type in ('flat_per_cart', 'flat_per_person', 'flat_per_entry', 'flat_per_dance', 'percentage', 'discount_flat', 'discount_percentage')),
  constraint event_competition_fee_rules_mode_check check (registration_mode in ('individual', 'studio', 'both')),
  constraint event_competition_fee_rules_amount_check check (amount >= 0),
  constraint event_competition_fee_rules_percentage_check check (percentage is null or (percentage >= 0 and percentage <= 100)),
  constraint event_competition_fee_rules_window_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint event_competition_fee_rules_scope_check check (
    (contest_id is null or program_id is not null)
    and (division_id is null or program_id is not null)
  ),
  unique (id, event_id)
);

create table if not exists public.event_competition_registration_carts (
  id uuid primary key default gen_random_uuid(),
  public_token uuid not null default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  registration_mode text not null,
  buyer_name text,
  buyer_email text,
  buyer_phone text,
  registering_studio_name text,
  registering_studio_id uuid references public.studios(id) on delete set null,
  status text not null default 'draft',
  currency text not null default 'USD',
  quoted_subtotal numeric(10, 2) not null default 0,
  quoted_discount numeric(10, 2) not null default 0,
  quoted_total numeric(10, 2) not null default 0,
  quote_checksum text,
  quoted_at timestamptz,
  order_id uuid references public.event_orders(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  submitted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_registration_carts_mode_check check (registration_mode in ('individual', 'studio')),
  constraint event_competition_registration_carts_status_check
    check (status in ('draft', 'checkout_pending', 'submitted', 'expired', 'cancelled')),
  constraint event_competition_registration_carts_amount_check
    check (quoted_subtotal >= 0 and quoted_discount >= 0 and quoted_total >= 0),
  unique (public_token),
  unique (id, event_id)
);

create table if not exists public.event_competition_registration_cart_people (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cart_id uuid not null,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  date_of_birth date,
  person_type text not null default 'dancer',
  roster_label text,
  classification_data jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_registration_cart_people_cart_fk
    foreign key (cart_id, event_id)
    references public.event_competition_registration_carts(id, event_id) on delete cascade,
  constraint event_competition_registration_cart_people_name_check
    check (length(btrim(first_name)) between 1 and 100 and length(btrim(last_name)) between 1 and 100),
  constraint event_competition_registration_cart_people_type_check
    check (person_type in ('dancer', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other')),
  unique (id, cart_id, event_id)
);

create table if not exists public.event_competition_registration_cart_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cart_id uuid not null,
  program_id uuid not null,
  contest_id uuid not null,
  division_id uuid not null,
  display_name text not null,
  routine_title text,
  routine_duration_seconds integer,
  music_title text,
  music_artist text,
  notes text,
  status text not null default 'draft',
  sort_order integer not null default 0,
  official_entry_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_registration_cart_entries_cart_fk
    foreign key (cart_id, event_id)
    references public.event_competition_registration_carts(id, event_id) on delete cascade,
  constraint event_competition_registration_cart_entries_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id) on delete restrict,
  constraint event_competition_registration_cart_entries_contest_fk
    foreign key (contest_id, program_id, event_id)
    references public.event_competition_contests(id, program_id, event_id) on delete restrict,
  constraint event_competition_registration_cart_entries_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id) on delete restrict,
  constraint event_competition_registration_cart_entries_name_check check (length(btrim(display_name)) between 1 and 240),
  constraint event_competition_registration_cart_entries_duration_check
    check (routine_duration_seconds is null or routine_duration_seconds > 0),
  constraint event_competition_registration_cart_entries_status_check
    check (status in ('draft', 'quoted', 'checkout_pending', 'submitted', 'cancelled')),
  unique (id, cart_id, event_id)
);

create table if not exists public.event_competition_registration_cart_entry_people (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cart_id uuid not null,
  cart_entry_id uuid not null,
  cart_person_id uuid not null,
  participant_role text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint event_competition_registration_cart_entry_people_entry_fk
    foreign key (cart_entry_id, cart_id, event_id)
    references public.event_competition_registration_cart_entries(id, cart_id, event_id) on delete cascade,
  constraint event_competition_registration_cart_entry_people_person_fk
    foreign key (cart_person_id, cart_id, event_id)
    references public.event_competition_registration_cart_people(id, cart_id, event_id) on delete cascade,
  constraint event_competition_registration_cart_entry_people_role_check
    check (participant_role in ('dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other')),
  unique (cart_entry_id, cart_person_id, participant_role)
);

create table if not exists public.event_competition_registration_cart_entry_dances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cart_id uuid not null,
  cart_entry_id uuid not null,
  division_dance_id uuid not null,
  created_at timestamptz not null default now(),
  constraint event_competition_registration_cart_entry_dances_entry_fk
    foreign key (cart_entry_id, cart_id, event_id)
    references public.event_competition_registration_cart_entries(id, cart_id, event_id) on delete cascade,
  constraint event_competition_registration_cart_entry_dances_offering_fk
    foreign key (division_dance_id, event_id)
    references public.event_competition_division_dances(id, event_id) on delete restrict,
  unique (cart_entry_id, division_dance_id)
);

create table if not exists public.event_competition_registration_cart_price_lines (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cart_id uuid not null,
  cart_entry_id uuid,
  fee_rule_id uuid references public.event_competition_fee_rules(id) on delete set null,
  line_type text not null,
  description text not null,
  quantity integer not null default 1,
  unit_amount numeric(10, 2) not null default 0,
  line_amount numeric(10, 2) not null default 0,
  currency text not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint event_competition_registration_cart_price_lines_cart_fk
    foreign key (cart_id, event_id)
    references public.event_competition_registration_carts(id, event_id) on delete cascade,
  constraint event_competition_registration_cart_price_lines_entry_fk
    foreign key (cart_entry_id, cart_id, event_id)
    references public.event_competition_registration_cart_entries(id, cart_id, event_id) on delete cascade,
  constraint event_competition_registration_cart_price_lines_type_check
    check (line_type in ('base_entry', 'dance', 'fee', 'discount')),
  constraint event_competition_registration_cart_price_lines_quantity_check check (quantity > 0),
  constraint event_competition_registration_cart_price_lines_amount_check
    check (unit_amount >= 0 and line_amount >= 0)
);

create index if not exists event_competition_registration_carts_event_idx
  on public.event_competition_registration_carts(event_id, status, created_at desc);
create index if not exists event_competition_registration_carts_token_idx
  on public.event_competition_registration_carts(public_token);
create index if not exists event_competition_registration_cart_people_cart_idx
  on public.event_competition_registration_cart_people(cart_id, sort_order, created_at);
create index if not exists event_competition_registration_cart_entries_cart_idx
  on public.event_competition_registration_cart_entries(cart_id, sort_order, created_at);
create index if not exists event_competition_registration_cart_price_lines_cart_idx
  on public.event_competition_registration_cart_price_lines(cart_id, created_at);

alter table public.event_competition_entries
  add column if not exists registration_cart_id uuid references public.event_competition_registration_carts(id) on delete set null;
create index if not exists event_competition_entries_registration_cart_idx
  on public.event_competition_entries(registration_cart_id)
  where registration_cart_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'event_competition_registration_cart_entries_official_entry_fk'
  ) then
    alter table public.event_competition_registration_cart_entries
      add constraint event_competition_registration_cart_entries_official_entry_fk
      foreign key (official_entry_id, event_id)
      references public.event_competition_entries(id, event_id) on delete restrict;
  end if;
end $$;

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
  participant_min := case when contest_row.entry_format = 'solo' then 1 when contest_row.entry_format = 'team' then 2 else 2 end;
  participant_max := case when contest_row.entry_format = 'solo' then 1 when contest_row.entry_format = 'team' then 100 else 2 end;
  terminology_value := case
    when discipline = 'ballroom' then '{"division_label":"Division","skill_label":"Level","age_label":"Age Category","partner_label":"Partner","dance_label":"Dance"}'::jsonb
    when discipline = 'country' then '{"division_label":"Division","skill_label":"Skill Division","age_label":"Age Division","partner_label":"Dance Partner","dance_label":"Dance"}'::jsonb
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

create or replace function public.create_default_competition_registration_rule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.default_competition_registration_rule(new.id);
  return new;
end;
$$;

drop trigger if exists create_default_competition_registration_rule on public.event_competition_contests;
create trigger create_default_competition_registration_rule
after insert on public.event_competition_contests
for each row execute function public.create_default_competition_registration_rule();

do $$
declare contest_id_value uuid;
begin
  for contest_id_value in select id from public.event_competition_contests loop
    perform public.default_competition_registration_rule(contest_id_value);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_contest_registration_rules',
    'event_competition_fee_rules',
    'event_competition_registration_carts',
    'event_competition_registration_cart_people',
    'event_competition_registration_cart_entries'
  ] loop
    execute format('drop trigger if exists set_event_competition_updated_at on public.%I', table_name);
    execute format('create trigger set_event_competition_updated_at before update on public.%I for each row execute function public.set_event_competition_updated_at()', table_name);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_contest_registration_rules',
    'event_competition_fee_rules',
    'event_competition_registration_carts',
    'event_competition_registration_cart_people',
    'event_competition_registration_cart_entries',
    'event_competition_registration_cart_entry_people',
    'event_competition_registration_cart_entry_dances',
    'event_competition_registration_cart_price_lines'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end $$;

drop policy if exists competition_manage on public.event_competition_contest_registration_rules;
create policy competition_manage on public.event_competition_contest_registration_rules
  for all to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));
drop policy if exists competition_registration_rules_public_read on public.event_competition_contest_registration_rules;
create policy competition_registration_rules_public_read on public.event_competition_contest_registration_rules
  for select to public using (
    registration_open and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );

drop policy if exists competition_manage on public.event_competition_fee_rules;
create policy competition_manage on public.event_competition_fee_rules
  for all to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));
drop policy if exists competition_fee_rules_public_read on public.event_competition_fee_rules;
create policy competition_fee_rules_public_read on public.event_competition_fee_rules
  for select to public using (
    active and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_registration_carts',
    'event_competition_registration_cart_people',
    'event_competition_registration_cart_entries',
    'event_competition_registration_cart_entry_people',
    'event_competition_registration_cart_entry_dances',
    'event_competition_registration_cart_price_lines'
  ] loop
    execute format('drop policy if exists competition_cart_manager_read on public.%I', table_name);
    execute format('create policy competition_cart_manager_read on public.%I for select to authenticated using (public.can_manage_event_competition(event_id))', table_name);
  end loop;
end $$;

-- Public reads expose only configured registration choices for published events.
drop policy if exists competition_programs_public_registration_read on public.event_competition_programs;
create policy competition_programs_public_registration_read on public.event_competition_programs
  for select to public using (
    status in ('configured', 'active') and exists (
      select 1 from public.events e where e.id = event_id and e.status = 'published'
        and e.visibility in ('public', 'unlisted') and e.registration_required
    )
  );
drop policy if exists competition_contests_public_registration_read on public.event_competition_contests;
create policy competition_contests_public_registration_read on public.event_competition_contests
  for select to public using (
    status = 'open' and exists (
      select 1 from public.event_competition_contest_registration_rules r
      where r.contest_id = id and r.registration_open
    )
  );
drop policy if exists competition_divisions_public_registration_read on public.event_competition_divisions;
create policy competition_divisions_public_registration_read on public.event_competition_divisions
  for select to public using (
    status = 'open' and exists (
      select 1 from public.event_competition_contest_registration_rules r
      where r.contest_id = contest_id and r.registration_open
    )
  );
drop policy if exists competition_dances_public_registration_read on public.event_competition_dances;
create policy competition_dances_public_registration_read on public.event_competition_dances
  for select to public using (
    active and exists (
      select 1 from public.event_competition_programs p
      where p.id = program_id and p.status in ('configured', 'active')
    )
  );
drop policy if exists competition_division_dances_public_registration_read on public.event_competition_division_dances;
create policy competition_division_dances_public_registration_read on public.event_competition_division_dances
  for select to public using (
    active and exists (
      select 1 from public.event_competition_divisions d
      join public.event_competition_contest_registration_rules r on r.contest_id = d.contest_id
      where d.id = division_id and d.status = 'open' and r.registration_open
    )
  );

comment on table public.event_competition_contest_registration_rules is
  'Controls the discipline- and contest-specific registration form, terminology, participant model, dance selection, and base pricing.';
comment on table public.event_competition_registration_carts is
  'Server-managed individual or studio registration drafts that are authoritatively requoted before checkout.';
comment on table public.event_competition_registration_cart_price_lines is
  'Itemized authoritative quote lines used for the running total, order materialization, and accounting traceability.';

notify pgrst, 'reload schema';
commit;
