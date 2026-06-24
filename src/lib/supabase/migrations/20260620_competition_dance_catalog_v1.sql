-- Competition Dance Catalog V1
-- Adds structured dance/style offerings used by registration entries and heat generation.
-- Save in: src/lib/supabase/migrations/20260620_competition_dance_catalog_v1.sql

begin;

create table if not exists public.event_competition_dances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  dance_key text not null,
  name text not null,
  category_label text,
  active boolean not null default true,
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_dances_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_dances_key_check
    check (length(btrim(dance_key)) between 1 and 100),
  constraint event_competition_dances_name_check
    check (length(btrim(name)) between 1 and 160),
  unique (id, event_id),
  unique (id, program_id, event_id),
  unique (program_id, dance_key)
);

create table if not exists public.event_competition_division_dances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  division_id uuid not null,
  dance_id uuid not null,
  entry_fee numeric(10, 2) not null default 0,
  currency text not null default 'USD',
  required boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_division_dances_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_division_dances_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id)
    on delete cascade,
  constraint event_competition_division_dances_dance_fk
    foreign key (dance_id, program_id, event_id)
    references public.event_competition_dances(id, program_id, event_id)
    on delete cascade,
  constraint event_competition_division_dances_fee_check
    check (entry_fee >= 0),
  unique (id, event_id),
  unique (id, division_id, event_id),
  unique (division_id, dance_id)
);

create index if not exists event_competition_dances_program_sort_idx
  on public.event_competition_dances(program_id, active, sort_order, name);
create index if not exists event_competition_division_dances_division_sort_idx
  on public.event_competition_division_dances(division_id, active, sort_order);

alter table public.event_competition_entry_dances
  add column if not exists division_dance_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_competition_entry_dances_offering_fk'
  ) then
    alter table public.event_competition_entry_dances
      add constraint event_competition_entry_dances_offering_fk
      foreign key (division_dance_id, event_id)
      references public.event_competition_division_dances(id, event_id)
      on delete restrict;
  end if;
end $$;

create index if not exists event_competition_entry_dances_offering_idx
  on public.event_competition_entry_dances(division_dance_id)
  where division_dance_id is not null;

alter table public.event_competition_heats
  add column if not exists division_dance_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_competition_heats_offering_fk'
  ) then
    alter table public.event_competition_heats
      add constraint event_competition_heats_offering_fk
      foreign key (division_dance_id, division_id, event_id)
      references public.event_competition_division_dances(id, division_id, event_id)
      on delete restrict;
  end if;
end $$;

create index if not exists event_competition_heats_offering_idx
  on public.event_competition_heats(division_dance_id, round_id, heat_number)
  where division_dance_id is not null;

drop trigger if exists set_event_competition_updated_at
  on public.event_competition_dances;
create trigger set_event_competition_updated_at
before update on public.event_competition_dances
for each row execute function public.set_event_competition_updated_at();

drop trigger if exists set_event_competition_updated_at
  on public.event_competition_division_dances;
create trigger set_event_competition_updated_at
before update on public.event_competition_division_dances
for each row execute function public.set_event_competition_updated_at();

alter table public.event_competition_dances enable row level security;
alter table public.event_competition_division_dances enable row level security;

drop policy if exists competition_manage on public.event_competition_dances;
create policy competition_manage
  on public.event_competition_dances
  for all
  to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

drop policy if exists competition_manage on public.event_competition_division_dances;
create policy competition_manage
  on public.event_competition_division_dances
  for all
  to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

create or replace function public.validate_competition_entry_dance_offering()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  entry_division_id uuid;
  offering_division_id uuid;
  offering_dance_key text;
  offering_dance_name text;
  offering_fee numeric(10, 2);
  offering_currency text;
begin
  if new.division_dance_id is null then
    return new;
  end if;

  select e.division_id
  into entry_division_id
  from public.event_competition_entries e
  where e.id = new.entry_id
    and e.event_id = new.event_id;

  select dd.division_id, d.dance_key, d.name, dd.entry_fee, dd.currency
  into offering_division_id, offering_dance_key, offering_dance_name, offering_fee, offering_currency
  from public.event_competition_division_dances dd
  join public.event_competition_dances d on d.id = dd.dance_id
  where dd.id = new.division_dance_id
    and dd.event_id = new.event_id
    and dd.active = true
    and d.active = true;

  if entry_division_id is null or offering_division_id is distinct from entry_division_id then
    raise exception 'Selected dance is not offered for the competition entry division.';
  end if;

  new.dance_key = offering_dance_key;
  new.dance_label = offering_dance_name;
  new.fee_amount = offering_fee;
  new.currency = offering_currency;

  return new;
end;
$$;

drop trigger if exists validate_competition_entry_dance_offering
  on public.event_competition_entry_dances;
create trigger validate_competition_entry_dance_offering
before insert or update of event_id, entry_id, division_dance_id
on public.event_competition_entry_dances
for each row execute function public.validate_competition_entry_dance_offering();

comment on table public.event_competition_dances is
  'Neutral event dance/style catalog; names do not imply governing-organization affiliation.';
comment on table public.event_competition_division_dances is
  'Dance/style offerings and registration fees available within a competition division.';

notify pgrst, 'reload schema';

commit;
