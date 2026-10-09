-- 20261108090000_phase10b_competition_profiles.sql
--
-- PHASE 10 -- 10B: Simple Creation + Competition Workspace -- rules profile and publish lock.
--
-- Adds the smallest durable foundation for "a competition follows a versioned rules profile and
-- that profile/version/configuration is frozen when the competition is published":
--
--   1. competition_rules_profiles (global, read-only to clients, append-only versions) seeded
--      with studio_simple@1 -- DanceFlow's generic studio competition profile. It is NOT a
--      sanctioning-organization profile: sanction status is "none" and cannot be claimed.
--   2. event_competition_programs gains rules_profile_key / rules_profile_version (composite FK
--      to the profile) and profile_locked_at. Pre-10B programs are NOT backfilled: a NULL
--      profile means "unprofiled / advanced", never studio_simple. Clients can no longer write
--      these three columns directly (column privileges); only the SECURITY DEFINER functions
--      below can. The frozen configuration snapshot lives in its own manager-only, append-only
--      table (event_competition_program_locks), so it is never exposed through the public
--      registration read policies that make program rows visible.
--   3. Scoring-engine keys for the studio profile (ordinal_majority, proficiency_rating,
--      callback_tally) are added to the existing programs/rounds scoring_method checks, so the
--      engine is stored in the canonical column instead of opaque configuration.
--   4. create_simple_competition(event, spec): ONE transaction that turns a validated organizer
--      spec into the existing canonical rows (program, categories = contests, divisions,
--      dances, division dance offerings, registration rules, rounds). Idempotent per
--      request_key; refuses an event that already has competition setup.
--   5. publish_competition_program(program): validates the minimum structure, builds a
--      configuration snapshot (profile + defaults + chosen judging + structure), stores it with
--      the profile key/version, and moves the program to 'configured'. After that the profile
--      columns are immutable (trigger) and the program cannot return to draft.
--   6. add_competition_division / remove_competition_division (SECURITY INVOKER, RLS applies):
--      right-side-panel edits that keep the final-round and dance-offering structure of a
--      category consistent.
--
-- Registration stays off: nothing here opens registration, touches checkout, or enables the
-- NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED feature flag.

begin;

-- ---------------------------------------------------------------------------
-- Preflight: 10A state is present and 10B is absent
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_heat_lock_events') is null then
    raise exception 'Phase 10B preflight: Phase 10A must be applied first.';
  end if;
  if to_regclass('public.competition_rules_profiles') is not null then
    raise exception 'Phase 10B preflight: competition_rules_profiles already exists.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'event_competition_programs'
      and column_name in ('rules_profile_key', 'rules_profile_version', 'profile_locked_at')
  ) then
    raise exception 'Phase 10B preflight: program profile columns already exist.';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.event_competition_programs'::regclass and conname = 'event_competition_programs_scoring_check')
     <> $c$CHECK ((scoring_method = ANY (ARRAY['skating'::text, 'majority_rules'::text, 'wsdc_callback'::text, 'relative_placement'::text, 'round_specific'::text, 'proficiency'::text, 'cumulative_points'::text, 'feedback_only'::text, 'custom'::text, 'none'::text])))$c$ then
    raise exception 'Phase 10B preflight: programs scoring_method check is not the reviewed definition.';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.event_competition_rounds'::regclass and conname = 'event_competition_rounds_scoring_method_check')
     <> $c$CHECK ((scoring_method = ANY (ARRAY['skating'::text, 'majority_rules'::text, 'wsdc_callback'::text, 'relative_placement'::text, 'proficiency'::text, 'cumulative_points'::text, 'feedback_only'::text, 'custom'::text, 'none'::text])))$c$ then
    raise exception 'Phase 10B preflight: rounds scoring_method check is not the reviewed definition.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Rules profiles (global, versioned, append-only)
-- ---------------------------------------------------------------------------
create table public.competition_rules_profiles (
  profile_key text not null,
  version integer not null,
  name text not null,
  description text,
  status text not null default 'active',
  defaults jsonb not null,
  created_at timestamptz not null default now(),
  constraint competition_rules_profiles_pkey primary key (profile_key, version),
  constraint competition_rules_profiles_key_check check (profile_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint competition_rules_profiles_version_check check (version > 0),
  constraint competition_rules_profiles_status_check check (status in ('active', 'retired')),
  constraint competition_rules_profiles_defaults_check check (jsonb_typeof(defaults) = 'object')
);

alter table public.competition_rules_profiles enable row level security;
create policy competition_rules_profiles_read on public.competition_rules_profiles
  for select to authenticated using (true);
revoke all on public.competition_rules_profiles from public, anon, authenticated, service_role;
grant select on public.competition_rules_profiles to authenticated, service_role;

create or replace function public.protect_competition_rules_profile()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.profile_key = old.profile_key and new.version = old.version
    and new.name = old.name and new.description is not distinct from old.description
    and new.defaults = old.defaults and new.created_at = old.created_at
    and old.status = 'active' and new.status = 'retired' then
    return new;
  end if;
  raise exception 'Rules profile versions are append-only; publish a new version instead.'
    using errcode = '42501';
end;
$$;

create trigger protect_competition_rules_profile
  before update or delete on public.competition_rules_profiles
  for each row execute function public.protect_competition_rules_profile();
create trigger protect_competition_rules_profile_truncate
  before truncate on public.competition_rules_profiles
  for each statement execute function public.protect_competition_rules_profile();

comment on table public.competition_rules_profiles is
  'Versioned competition rules/format profiles. A version is immutable once created (it may only be retired). studio_simple is a DanceFlow generic profile, not a sanctioning organization.';

insert into public.competition_rules_profiles (profile_key, version, name, description, status, defaults)
values (
  'studio_simple', 1, 'Studio Competition',
  'DanceFlow''s generic studio competition and showcase profile. Not a sanctioning organization profile.',
  'active',
  $studio_simple_v1${
  "schema": 1,
  "label": "Studio Competition",
  "sanction": {
    "status": "none",
    "claimable": false
  },
  "roundsDefault": "final_only",
  "currency": "USD",
  "terminology": {
    "division_label": "Division",
    "skill_label": "Level",
    "age_label": "Age group",
    "partner_label": "Partner",
    "dance_label": "Dance"
  },
  "judging": {
    "placements": {
      "label": "Placements",
      "description": "Judges rank the dancers in each division and the best-ranked dancer places first.",
      "engine": {
        "key": "ordinal_majority",
        "version": 1
      },
      "competition_mode": "relative",
      "advancement_method": "none",
      "rounds": [
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "ordinal_majority"
        }
      ]
    },
    "ratings": {
      "label": "Ratings",
      "description": "Judges rate each performance, so every dancer can earn a rating instead of a place.",
      "engine": {
        "key": "proficiency_rating",
        "version": 1
      },
      "competition_mode": "proficiency",
      "advancement_method": "none",
      "bands": [
        "Gold",
        "Silver",
        "Bronze"
      ],
      "rounds": [
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "proficiency_rating"
        }
      ]
    },
    "callbacks": {
      "label": "Callbacks + Final",
      "description": "Judges call the best dancers back from a first round into the final. Best for large divisions.",
      "engine": {
        "key": "callback_tally",
        "version": 1
      },
      "competition_mode": "relative",
      "advancement_method": "promote_callback",
      "rounds": [
        {
          "round_type": "preliminary",
          "name": "Callback round",
          "scoring_method": "callback_tally"
        },
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "ordinal_majority"
        }
      ]
    }
  },
  "categoryTypes": {
    "pro_am": {
      "label": "ProAm",
      "description": "A student dances with a professional.",
      "contest_type": "single_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed"
    },
    "couples": {
      "label": "Couples",
      "description": "Two dancers compete as a couple.",
      "contest_type": "single_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed"
    },
    "solo": {
      "label": "Solo",
      "description": "One dancer performs a routine.",
      "contest_type": "showdance",
      "entry_format": "solo",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "individual"
    },
    "showcase": {
      "label": "Showcase",
      "description": "A routine performed for the audience, alone or as a duo.",
      "contest_type": "showdance",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 2,
      "pairing_mode": "fixed"
    },
    "jack_and_jill": {
      "label": "Jack & Jill",
      "description": "Dancers enter alone and are paired with a random partner.",
      "contest_type": "jack_and_jill",
      "entry_format": "random_partner",
      "uses_dances": true,
      "dance_selection_mode": "prescribed_set",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "random_final_pair"
    },
    "team": {
      "label": "Team",
      "description": "A group performs a routine together.",
      "contest_type": "team",
      "entry_format": "team",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 100,
      "pairing_mode": "team"
    }
  },
  "dancePools": {
    "general": [
      {
        "key": "waltz",
        "name": "Waltz",
        "category": "Ballroom"
      },
      {
        "key": "foxtrot",
        "name": "Foxtrot",
        "category": "Ballroom"
      },
      {
        "key": "tango",
        "name": "Tango",
        "category": "Ballroom"
      },
      {
        "key": "viennese_waltz",
        "name": "Viennese Waltz",
        "category": "Ballroom"
      },
      {
        "key": "cha_cha",
        "name": "Cha Cha",
        "category": "Latin and Rhythm"
      },
      {
        "key": "rumba",
        "name": "Rumba",
        "category": "Latin and Rhythm"
      },
      {
        "key": "swing",
        "name": "Swing",
        "category": "Latin and Rhythm"
      },
      {
        "key": "bolero",
        "name": "Bolero",
        "category": "Latin and Rhythm"
      },
      {
        "key": "mambo",
        "name": "Mambo",
        "category": "Latin and Rhythm"
      },
      {
        "key": "salsa",
        "name": "Salsa",
        "category": "Social"
      },
      {
        "key": "hustle",
        "name": "Hustle",
        "category": "Social"
      },
      {
        "key": "two_step",
        "name": "Two Step",
        "category": "Social"
      }
    ],
    "ballroom": [
      {
        "key": "smooth_waltz",
        "name": "Waltz",
        "category": "American Smooth"
      },
      {
        "key": "smooth_tango",
        "name": "Tango",
        "category": "American Smooth"
      },
      {
        "key": "smooth_foxtrot",
        "name": "Foxtrot",
        "category": "American Smooth"
      },
      {
        "key": "smooth_viennese_waltz",
        "name": "Viennese Waltz",
        "category": "American Smooth"
      },
      {
        "key": "rhythm_cha_cha",
        "name": "Cha Cha",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_rumba",
        "name": "Rumba",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_swing",
        "name": "Swing",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_bolero",
        "name": "Bolero",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_mambo",
        "name": "Mambo",
        "category": "American Rhythm"
      }
    ],
    "country": [
      {
        "key": "two_step",
        "name": "Two Step",
        "category": "Partner"
      },
      {
        "key": "waltz",
        "name": "Waltz",
        "category": "Partner"
      },
      {
        "key": "triple_two",
        "name": "Triple Two",
        "category": "Partner"
      },
      {
        "key": "polka",
        "name": "Polka",
        "category": "Partner"
      },
      {
        "key": "east_coast_swing",
        "name": "East Coast Swing",
        "category": "Partner"
      },
      {
        "key": "west_coast_swing",
        "name": "West Coast Swing",
        "category": "Partner"
      },
      {
        "key": "nightclub",
        "name": "Nightclub",
        "category": "Partner"
      },
      {
        "key": "cha_cha",
        "name": "Cha Cha",
        "category": "Partner"
      }
    ],
    "west_coast_swing": [
      {
        "key": "west_coast_swing",
        "name": "West Coast Swing",
        "category": "Swing"
      }
    ]
  },
  "presets": {
    "studio_competition": {
      "label": "Studio Competition",
      "description": "ProAm, couples, solo and group entries for your own students.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase",
        "jack_and_jill",
        "team"
      ],
      "default_categories": [
        "pro_am",
        "solo"
      ],
      "default_dances": [
        "waltz",
        "foxtrot",
        "cha_cha",
        "rumba"
      ],
      "default_judging": "placements",
      "division_preset": "levels_newcomer_gold"
    },
    "showcase": {
      "label": "Showcase",
      "description": "Performances for an audience, usually rated rather than ranked.",
      "discipline_family": "showcase",
      "dance_pool": "general",
      "category_types": [
        "solo",
        "showcase",
        "team"
      ],
      "default_categories": [
        "showcase"
      ],
      "default_dances": [],
      "default_judging": "ratings",
      "division_preset": "open"
    },
    "ballroom": {
      "label": "Ballroom",
      "description": "Smooth and rhythm dances for ProAm and couples.",
      "discipline_family": "ballroom",
      "dance_pool": "ballroom",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase"
      ],
      "default_categories": [
        "pro_am",
        "couples"
      ],
      "default_dances": [
        "smooth_waltz",
        "smooth_foxtrot",
        "rhythm_cha_cha",
        "rhythm_rumba"
      ],
      "default_judging": "placements",
      "division_preset": "levels_newcomer_gold"
    },
    "country": {
      "label": "Country",
      "description": "Country partner dances for ProAm, couples, solo and team entries.",
      "discipline_family": "country",
      "dance_pool": "country",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "team"
      ],
      "default_categories": [
        "couples"
      ],
      "default_dances": [
        "two_step",
        "waltz",
        "cha_cha"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    },
    "west_coast_swing": {
      "label": "West Coast Swing",
      "description": "Jack & Jill and partner swing entries.",
      "discipline_family": "west_coast_swing",
      "dance_pool": "west_coast_swing",
      "category_types": [
        "jack_and_jill",
        "couples",
        "pro_am",
        "showcase"
      ],
      "default_categories": [
        "jack_and_jill"
      ],
      "default_dances": [
        "west_coast_swing"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    },
    "custom": {
      "label": "Custom",
      "description": "Start from a blank structure and choose everything yourself.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase",
        "jack_and_jill",
        "team"
      ],
      "default_categories": [
        "solo"
      ],
      "default_dances": [
        "waltz"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    }
  },
  "divisionPresets": {
    "levels_newcomer_gold": {
      "label": "Newcomer, Bronze, Silver, Gold",
      "levels": [
        "Newcomer",
        "Bronze",
        "Silver",
        "Gold"
      ]
    },
    "levels_basic": {
      "label": "Beginner, Intermediate, Advanced",
      "levels": [
        "Beginner",
        "Intermediate",
        "Advanced"
      ]
    },
    "open": {
      "label": "One open division",
      "levels": [
        "Open"
      ]
    }
  },
  "ageBands": [
    "Youth",
    "Adult",
    "Senior"
  ],
  "limits": {
    "categories": 6,
    "divisions": 60,
    "nameLength": 200,
    "maxPrice": 100000
  }
}$studio_simple_v1$::jsonb
);

-- ---------------------------------------------------------------------------
-- 2. Program profile columns, scoring-engine keys, lock enforcement
-- ---------------------------------------------------------------------------
alter table public.event_competition_programs
  add column rules_profile_key text,
  add column rules_profile_version integer,
  add column profile_locked_at timestamptz;

alter table public.event_competition_programs
  add constraint event_competition_programs_profile_fk
    foreign key (rules_profile_key, rules_profile_version)
    references public.competition_rules_profiles(profile_key, version) on delete restrict,
  add constraint event_competition_programs_profile_pair_check
    check ((rules_profile_key is null) = (rules_profile_version is null)),
  add constraint event_competition_programs_profile_lock_check
    check (profile_locked_at is null or rules_profile_key is not null);

alter table public.event_competition_programs drop constraint event_competition_programs_scoring_check;
alter table public.event_competition_programs add constraint event_competition_programs_scoring_check
  check (scoring_method = any (array['skating', 'majority_rules', 'wsdc_callback', 'relative_placement', 'round_specific',
    'proficiency', 'cumulative_points', 'feedback_only', 'custom', 'none',
    'ordinal_majority', 'proficiency_rating', 'callback_tally']));

alter table public.event_competition_rounds drop constraint event_competition_rounds_scoring_method_check;
alter table public.event_competition_rounds add constraint event_competition_rounds_scoring_method_check
  check (scoring_method = any (array['skating', 'majority_rules', 'wsdc_callback', 'relative_placement',
    'proficiency', 'cumulative_points', 'feedback_only', 'custom', 'none',
    'ordinal_majority', 'proficiency_rating', 'callback_tally']));

comment on column public.event_competition_programs.rules_profile_key is
  'Rules profile this competition follows (NULL = unprofiled/advanced; pre-10B competitions are not backfilled). Never implies sanctioning.';
comment on column public.event_competition_programs.profile_locked_at is
  'Set once, by publish_competition_program, together with an event_competition_program_locks row holding the frozen snapshot. After that the profile key/version can never change.';

-- Only the SECURITY DEFINER functions below may write the three profile columns.
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = 'public.event_competition_programs'::regclass and attnum > 0 and not attisdropped
    and attname not in ('rules_profile_key', 'rules_profile_version', 'profile_locked_at');
  execute 'revoke insert, update on public.event_competition_programs from anon, authenticated';
  execute format('grant insert (%s), update (%s) on public.event_competition_programs to authenticated', v_cols, v_cols);
end $$;

-- The frozen snapshot: one append-only, manager-readable row per published competition.
create table public.event_competition_program_locks (
  program_id uuid not null,
  event_id uuid not null,
  rules_profile_key text not null,
  rules_profile_version integer not null,
  snapshot jsonb not null,
  locked_at timestamptz not null,
  locked_by uuid,
  constraint event_competition_program_locks_pkey primary key (program_id),
  constraint event_competition_program_locks_program_fk
    foreign key (program_id, event_id) references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_program_locks_profile_fk
    foreign key (rules_profile_key, rules_profile_version)
    references public.competition_rules_profiles(profile_key, version) on delete restrict,
  constraint event_competition_program_locks_snapshot_check
    check (jsonb_typeof(snapshot) = 'object'
           and snapshot #>> '{profile,key}' = rules_profile_key
           and (snapshot #>> '{profile,version}')::integer = rules_profile_version)
);

alter table public.event_competition_program_locks enable row level security;
create policy event_competition_program_locks_read on public.event_competition_program_locks
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_program_locks from public, anon, authenticated, service_role;
grant select on public.event_competition_program_locks to authenticated, service_role;

create or replace function public.protect_competition_program_lock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The only permitted removal is the cascade of a deleted competition (restart or event deletion).
  if tg_op = 'DELETE' and not exists (select 1 from public.event_competition_programs p where p.id = old.program_id) then
    return old;
  end if;
  raise exception 'Published competition locks are append-only evidence.' using errcode = '42501';
end;
$$;

create trigger protect_competition_program_lock
  before update or delete on public.event_competition_program_locks
  for each row execute function public.protect_competition_program_lock();
create trigger protect_competition_program_lock_truncate
  before truncate on public.event_competition_program_locks
  for each statement execute function public.protect_competition_program_lock();

comment on table public.event_competition_program_locks is
  'Frozen at publish: profile key/version, the profile defaults as they were, the chosen judging model and the published structure. Append-only; later profile changes never alter it. Manager-readable only.';

create or replace function public.protect_competition_program_profile()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.profile_locked_at is not null then
      raise exception 'The profile lock is set only by publish_competition_program.' using errcode = '42501';
    end if;
    if new.rules_profile_key is not null and new.status <> 'draft' then
      raise exception 'A competition with a rules profile starts as a draft.' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.profile_locked_at is not null then
    if new.rules_profile_key is distinct from old.rules_profile_key
      or new.rules_profile_version is distinct from old.rules_profile_version
      or new.profile_locked_at is distinct from old.profile_locked_at then
      raise exception 'The rules profile of a published competition is locked.' using errcode = '42501';
    end if;
    if new.status = 'draft' then
      raise exception 'A published competition cannot return to draft.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.profile_locked_at is not null then
    if new.rules_profile_key is null or new.status = 'draft' or not exists (
      select 1 from public.event_competition_program_locks l
      where l.program_id = new.id and l.rules_profile_key = new.rules_profile_key
        and l.rules_profile_version = new.rules_profile_version and l.locked_at = new.profile_locked_at
    ) then
      raise exception 'The profile lock is set only by publish_competition_program.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.rules_profile_key is not null and old.status = 'draft' and new.status <> 'draft' then
    raise exception 'Publish this competition with publish_competition_program before changing its status.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger protect_competition_program_profile
  before insert or update on public.event_competition_programs
  for each row execute function public.protect_competition_program_profile();

-- ---------------------------------------------------------------------------
-- 3. create_simple_competition
-- ---------------------------------------------------------------------------
create or replace function public.create_simple_competition(target_event_id uuid, spec jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event record;
  v_profile record;
  v_defaults jsonb;
  v_key text;
  v_version integer;
  v_request text;
  v_existing uuid;
  v_preset_key text;
  v_preset jsonb;
  v_judging_key text;
  v_judging jsonb;
  v_pool jsonb;
  v_limits jsonb;
  v_name text;
  v_program_id uuid;
  v_categories jsonb;
  v_divisions jsonb;
  v_cat jsonb;
  v_cat_key text;
  v_cat_def jsonb;
  v_cat_ix integer;
  v_cat_seen text[] := '{}';
  v_div jsonb;
  v_div_ix integer;
  v_div_seen text[] := '{}';
  v_div_name text;
  v_round jsonb;
  v_round_ix integer;
  v_dance_key text;
  v_dance jsonb;
  v_dance_ids jsonb := '{}'::jsonb;
  v_dance_keys text[];
  v_dance_ix integer;
  v_dance_id uuid;
  v_contest_id uuid;
  v_division_id uuid;
  v_price numeric;
  v_per_dance boolean;
begin
  if v_actor is null or not public.can_manage_event_competition(target_event_id) then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.id, e.name, e.studio_id, e.organizer_id into v_event from public.events e where e.id = target_event_id;
  if v_event.id is null then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  if spec is null or jsonb_typeof(spec) <> 'object' then
    raise exception 'A competition specification is required.';
  end if;

  v_key := spec->>'profile_key';
  v_version := case when spec->>'profile_version' ~ '^[0-9]{1,6}$' then (spec->>'profile_version')::integer end;
  select p.profile_key, p.version, p.name, p.defaults, p.status into v_profile
  from public.competition_rules_profiles p where p.profile_key = v_key and p.version = v_version;
  if v_profile.profile_key is null or v_profile.status <> 'active' then
    raise exception 'Unsupported competition profile.';
  end if;
  v_defaults := v_profile.defaults;
  v_limits := v_defaults->'limits';

  v_request := spec->>'request_key';
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'A request key is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text || ':simple_competition'));

  select p.id into v_existing from public.event_competition_programs p
  where p.event_id = target_event_id and p.configuration #>> '{simple,request_key}' = v_request;
  if v_existing is not null then
    return v_existing;
  end if;
  if exists (select 1 from public.event_competition_programs p where p.event_id = target_event_id) then
    raise exception 'This event already has competition setup. Use Advanced settings or restart the setup first.';
  end if;

  v_preset_key := spec->>'preset';
  v_preset := v_defaults->'presets'->v_preset_key;
  if v_preset is null then
    raise exception 'Unknown competition type.';
  end if;
  v_judging_key := spec->>'judging';
  v_judging := v_defaults->'judging'->v_judging_key;
  if v_judging is null then
    raise exception 'Unknown judging choice.';
  end if;
  v_pool := v_defaults->'dancePools'->(v_preset->>'dance_pool');

  v_name := coalesce(nullif(btrim(spec->>'name'), ''), v_event.name);
  if length(v_name) < 1 or length(v_name) > 160 then
    raise exception 'The competition name must be 1 to 160 characters.';
  end if;

  v_categories := spec->'categories';
  if v_categories is null or jsonb_typeof(v_categories) <> 'array'
    or jsonb_array_length(v_categories) < 1 or jsonb_array_length(v_categories) > (v_limits->>'categories')::integer then
    raise exception 'Choose between 1 and % categories.', v_limits->>'categories';
  end if;
  v_divisions := spec->'divisions';
  if v_divisions is null or jsonb_typeof(v_divisions) <> 'array'
    or jsonb_array_length(v_divisions) < 1 or jsonb_array_length(v_divisions) > (v_limits->>'divisions')::integer then
    raise exception 'Add between 1 and % divisions.', v_limits->>'divisions';
  end if;

  for v_div in select value from jsonb_array_elements(v_divisions) loop
    if jsonb_typeof(v_div) <> 'object' then raise exception 'Each division must be an object.'; end if;
    v_div_name := btrim(coalesce(v_div->>'name', ''));
    if length(v_div_name) < 1 or length(v_div_name) > (v_limits->>'nameLength')::integer then
      raise exception 'Each division needs a name of 1 to % characters.', v_limits->>'nameLength';
    end if;
    if lower(v_div_name) = any (v_div_seen) then
      raise exception 'Division names must be unique (%).', v_div_name;
    end if;
    v_div_seen := v_div_seen || lower(v_div_name);
  end loop;

  for v_cat in select value from jsonb_array_elements(v_categories) loop
    if jsonb_typeof(v_cat) <> 'object' then raise exception 'Each category must be an object.'; end if;
    v_cat_key := v_cat->>'type';
    v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
    if v_cat_def is null or not (v_preset->'category_types' ? v_cat_key) then
      raise exception 'Category type % is not available for this competition type.', coalesce(v_cat_key, '(none)');
    end if;
    if v_cat_key = any (v_cat_seen) then
      raise exception 'Each category type can be added once.';
    end if;
    v_cat_seen := v_cat_seen || v_cat_key;
    if coalesce(v_cat->>'price', '') !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$'
      or (v_cat->>'price')::numeric > (v_limits->>'maxPrice')::numeric then
      raise exception 'Enter a valid price for %.', v_cat_def->>'label';
    end if;
    if (v_cat_def->>'uses_dances')::boolean then
      if coalesce(jsonb_typeof(v_cat->'dances'), '') <> 'array' or jsonb_array_length(v_cat->'dances') < 1 or jsonb_array_length(v_cat->'dances') > 20 then
        raise exception 'Choose at least one dance for %.', v_cat_def->>'label';
      end if;
      v_dance_keys := '{}';
      for v_dance_key in select value from jsonb_array_elements_text(v_cat->'dances') loop
        if not exists (select 1 from jsonb_array_elements(v_pool) as pd(value) where pd.value->>'key' = v_dance_key) then
          raise exception 'Dance % is not available for this competition type.', v_dance_key;
        end if;
        if v_dance_key = any (v_dance_keys) then
          raise exception 'Dances can be chosen once per category.';
        end if;
        v_dance_keys := v_dance_keys || v_dance_key;
      end loop;
    end if;
  end loop;

  insert into public.event_competition_programs (
    event_id, studio_id, organizer_id, name, discipline_family, competition_mode, scoring_method,
    advancement_method, feedback_policy, status, rules_profile_key, rules_profile_version, configuration, created_by
  ) values (
    target_event_id, v_event.studio_id, v_event.organizer_id, v_name, v_preset->>'discipline_family',
    v_judging->>'competition_mode', v_judging #>> '{engine,key}', v_judging->>'advancement_method', 'none', 'draft',
    v_profile.profile_key, v_profile.version,
    jsonb_build_object('simple', jsonb_build_object(
      'request_key', v_request, 'preset', v_preset_key, 'judging', v_judging_key,
      'division_preset', spec->>'division_preset', 'created_with', 'simple_mode')),
    v_actor
  ) returning id into v_program_id;

  v_dance_ix := 0;
  for v_cat in select value from jsonb_array_elements(v_categories) loop
    if (v_defaults->'categoryTypes'->(v_cat->>'type')->>'uses_dances')::boolean then
      for v_dance_key in select value from jsonb_array_elements_text(v_cat->'dances') loop
        if not (v_dance_ids ? v_dance_key) then
          select pd.value into v_dance from jsonb_array_elements(v_pool) as pd(value) where pd.value->>'key' = v_dance_key;
          v_dance_ix := v_dance_ix + 10;
          insert into public.event_competition_dances (event_id, program_id, dance_key, name, category_label, sort_order)
          values (target_event_id, v_program_id, v_dance_key, v_dance->>'name', v_dance->>'category', v_dance_ix)
          returning id into v_dance_id;
          v_dance_ids := v_dance_ids || jsonb_build_object(v_dance_key, v_dance_id);
        end if;
      end loop;
    end if;
  end loop;

  for v_cat, v_cat_ix in select value, ordinality - 1 from jsonb_array_elements(v_categories) with ordinality loop
    v_cat_key := v_cat->>'type';
    v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
    v_price := (v_cat->>'price')::numeric;
    v_per_dance := v_cat_def->>'pricing_method' = 'per_dance';

    insert into public.event_competition_contests (event_id, program_id, name, contest_type, entry_format, sort_order, configuration)
    values (target_event_id, v_program_id, v_cat_def->>'label', v_cat_def->>'contest_type', v_cat_def->>'entry_format',
            (v_cat_ix + 1) * 10, jsonb_build_object('simple', jsonb_build_object('category_type', v_cat_key)))
    returning id into v_contest_id;

    update public.event_competition_contest_registration_rules set
      dance_selection_mode = v_cat_def->>'dance_selection_mode',
      pricing_method = v_cat_def->>'pricing_method',
      base_entry_fee = case when v_per_dance then 0 else v_price end,
      currency = v_defaults->>'currency',
      minimum_dances = case when v_cat_def->>'dance_selection_mode' = 'individual' then 1 else null end,
      maximum_dances = null,
      minimum_participants = (v_cat_def->>'minimum_participants')::integer,
      maximum_participants = (v_cat_def->>'maximum_participants')::integer,
      terminology = v_defaults->'terminology',
      registration_open = false
    where contest_id = v_contest_id and event_id = target_event_id;

    for v_div, v_div_ix in select value, ordinality - 1 from jsonb_array_elements(v_divisions) with ordinality loop
      insert into public.event_competition_divisions (event_id, program_id, contest_id, name, skill_label, age_label, sort_order)
      values (target_event_id, v_program_id, v_contest_id, btrim(v_div->>'name'),
              nullif(btrim(coalesce(v_div->>'skill_label', '')), ''), nullif(btrim(coalesce(v_div->>'age_label', '')), ''),
              (v_div_ix + 1) * 10)
      returning id into v_division_id;

      for v_round, v_round_ix in select value, ordinality from jsonb_array_elements(v_judging->'rounds') with ordinality loop
        insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method, pairing_mode)
        values (target_event_id, v_program_id, v_division_id, v_round->>'name', v_round->>'round_type', v_round_ix,
                v_round->>'scoring_method', v_cat_def->>'pairing_mode');
      end loop;

      if (v_cat_def->>'uses_dances')::boolean then
        v_dance_ix := 0;
        for v_dance_key in select value from jsonb_array_elements_text(v_cat->'dances') loop
          v_dance_ix := v_dance_ix + 10;
          insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
          values (target_event_id, v_program_id, v_division_id, (v_dance_ids->>v_dance_key)::uuid,
                  case when v_per_dance then v_price else 0 end, v_defaults->>'currency',
                  v_cat_def->>'dance_selection_mode' <> 'individual', v_dance_ix);
        end loop;
      end if;
    end loop;
  end loop;

  return v_program_id;
end;
$$;

revoke all on function public.create_simple_competition(uuid, jsonb) from public, anon;
grant execute on function public.create_simple_competition(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. publish_competition_program
-- ---------------------------------------------------------------------------
create or replace function public.publish_competition_program(target_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_program record;
  v_profile record;
  v_judging_key text;
  v_problems text[] := '{}';
  v_snapshot jsonb;
  v_rec record;
  v_now timestamptz := now();
begin
  select * into v_program from public.event_competition_programs where id = target_program_id for update;
  if v_actor is null or v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'Competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  if v_program.rules_profile_key is null then
    raise exception 'Only competitions created with a rules profile can be published here.';
  end if;
  if v_program.status <> 'draft' or v_program.profile_locked_at is not null then
    raise exception 'This competition is already published.';
  end if;

  select * into v_profile from public.competition_rules_profiles
  where profile_key = v_program.rules_profile_key and version = v_program.rules_profile_version;
  v_judging_key := v_program.configuration #>> '{simple,judging}';

  if not exists (select 1 from public.event_competition_contests c where c.program_id = v_program.id) then
    v_problems := v_problems || 'Add at least one category.';
  end if;
  for v_rec in
    select c.name as category, c.id as contest_id, r.dance_selection_mode
    from public.event_competition_contests c
    left join public.event_competition_contest_registration_rules r on r.contest_id = c.id
    where c.program_id = v_program.id
  loop
    if not exists (select 1 from public.event_competition_divisions d where d.contest_id = v_rec.contest_id) then
      v_problems := v_problems || format('%s needs at least one division.', v_rec.category);
    end if;
  end loop;
  for v_rec in
    select d.name as division, c.name as category, r.dance_selection_mode,
           exists (select 1 from public.event_competition_rounds rd where rd.division_id = d.id) as has_round,
           exists (select 1 from public.event_competition_division_dances dd where dd.division_id = d.id and dd.active) as has_offering
    from public.event_competition_divisions d
    join public.event_competition_contests c on c.id = d.contest_id
    left join public.event_competition_contest_registration_rules r on r.contest_id = c.id
    where d.program_id = v_program.id
  loop
    if not v_rec.has_round then
      v_problems := v_problems || format('%s (%s) needs a round.', v_rec.division, v_rec.category);
    end if;
    if v_rec.dance_selection_mode in ('individual', 'choose_count', 'prescribed_set') and not v_rec.has_offering then
      v_problems := v_problems || format('%s (%s) needs at least one dance.', v_rec.division, v_rec.category);
    end if;
  end loop;
  if exists (select 1 from public.event_competition_divisions d where d.program_id = v_program.id and d.contest_id is null) then
    v_problems := v_problems || 'Every division must belong to a category.';
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'This competition is not ready to publish: %', array_to_string(v_problems[1:3], ' ');
  end if;

  v_snapshot := jsonb_build_object(
    'snapshot_version', 1,
    'published_at', v_now,
    'published_by', v_actor,
    'profile', jsonb_build_object('key', v_profile.profile_key, 'version', v_profile.version, 'name', v_profile.name,
                                  'sanction', v_profile.defaults->'sanction'),
    'defaults', v_profile.defaults,
    'judging', jsonb_build_object('mode', v_judging_key, 'definition', v_profile.defaults->'judging'->v_judging_key),
    'program', jsonb_build_object('id', v_program.id, 'name', v_program.name, 'discipline_family', v_program.discipline_family,
                                  'competition_mode', v_program.competition_mode, 'scoring_method', v_program.scoring_method,
                                  'advancement_method', v_program.advancement_method),
    'structure', jsonb_build_object('categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'contest_type', c.contest_type, 'entry_format', c.entry_format,
        'registration', (select jsonb_build_object(
            'dance_selection_mode', r.dance_selection_mode, 'pricing_method', r.pricing_method, 'base_entry_fee', r.base_entry_fee,
            'currency', r.currency, 'minimum_participants', r.minimum_participants, 'maximum_participants', r.maximum_participants)
          from public.event_competition_contest_registration_rules r where r.contest_id = c.id),
        'divisions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', d.id, 'name', d.name, 'skill_label', d.skill_label, 'age_label', d.age_label,
            'rounds', coalesce((select jsonb_agg(jsonb_build_object('id', rd.id, 'name', rd.name, 'round_type', rd.round_type,
                'sequence_number', rd.sequence_number, 'scoring_method', rd.scoring_method, 'pairing_mode', rd.pairing_mode)
                order by rd.sequence_number) from public.event_competition_rounds rd where rd.division_id = d.id), '[]'::jsonb),
            'offerings', coalesce((select jsonb_agg(jsonb_build_object('dance_key', dn.dance_key, 'dance', dn.name,
                'entry_fee', dd.entry_fee, 'required', dd.required) order by dd.sort_order)
                from public.event_competition_division_dances dd join public.event_competition_dances dn on dn.id = dd.dance_id
                where dd.division_id = d.id and dd.active), '[]'::jsonb))
            order by d.sort_order, d.created_at)
          from public.event_competition_divisions d where d.contest_id = c.id), '[]'::jsonb))
        order by c.sort_order, c.created_at)
      from public.event_competition_contests c where c.program_id = v_program.id), '[]'::jsonb)));

  insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at, locked_by)
  values (v_program.id, v_program.event_id, v_program.rules_profile_key, v_program.rules_profile_version, v_snapshot, v_now, v_actor);

  update public.event_competition_programs set status = 'configured', profile_locked_at = v_now
  where id = v_program.id;

  return v_snapshot;
end;
$$;

revoke all on function public.publish_competition_program(uuid) from public, anon;
grant execute on function public.publish_competition_program(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Right-side-panel division edits (SECURITY INVOKER; RLS applies)
-- ---------------------------------------------------------------------------
create or replace function public.add_competition_division(
  target_contest_id uuid,
  division_name text,
  skill_label text default null,
  age_label text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_contest record;
  v_program_status text;
  v_template uuid;
  v_new uuid;
  v_name text := btrim(coalesce(division_name, ''));
  v_sort integer;
  v_scoring text;
begin
  select c.id, c.event_id, c.program_id into v_contest from public.event_competition_contests c where c.id = target_contest_id;
  if v_contest.id is null or not public.can_manage_event_competition(v_contest.event_id) then
    raise exception 'Category was not found or cannot be managed.' using errcode = '42501';
  end if;
  select status, scoring_method into v_program_status, v_scoring from public.event_competition_programs where id = v_contest.program_id;
  if v_program_status not in ('draft', 'configured') then
    raise exception 'Divisions cannot be added once the competition is running.';
  end if;
  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'A division name of 1 to 200 characters is required.';
  end if;
  if exists (select 1 from public.event_competition_divisions d where d.contest_id = target_contest_id and lower(d.name) = lower(v_name)) then
    raise exception 'This category already has a division named %.', v_name;
  end if;

  select d.id into v_template from public.event_competition_divisions d
  where d.contest_id = target_contest_id order by d.sort_order, d.created_at limit 1;
  select coalesce(max(d.sort_order), 0) + 10 into v_sort from public.event_competition_divisions d where d.contest_id = target_contest_id;

  insert into public.event_competition_divisions (event_id, program_id, contest_id, name, skill_label, age_label, sort_order)
  values (v_contest.event_id, v_contest.program_id, target_contest_id, v_name,
          nullif(btrim(coalesce(skill_label, '')), ''), nullif(btrim(coalesce(age_label, '')), ''), v_sort)
  returning id into v_new;

  if v_template is not null then
    insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number,
                                                 target_advancement_count, scoring_method, pairing_mode, score_roles_separately,
                                                 minimum_panel_size, chief_judge_tiebreak)
    select event_id, program_id, v_new, name, round_type, sequence_number, target_advancement_count, scoring_method,
           pairing_mode, score_roles_separately, minimum_panel_size, chief_judge_tiebreak
    from public.event_competition_rounds where division_id = v_template;
    insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, active, sort_order)
    select event_id, program_id, v_new, dance_id, entry_fee, currency, required, active, sort_order
    from public.event_competition_division_dances where division_id = v_template;
  else
    insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
    values (v_contest.event_id, v_contest.program_id, v_new, 'Final', 'final', 1,
            case when v_scoring in ('ordinal_majority', 'proficiency_rating') then v_scoring else 'none' end);
  end if;
  return v_new;
end;
$$;

revoke all on function public.add_competition_division(uuid, text, text, text) from public, anon;
grant execute on function public.add_competition_division(uuid, text, text, text) to authenticated, service_role;

create or replace function public.remove_competition_division(target_division_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_division record;
  v_program_status text;
begin
  select d.id, d.event_id, d.program_id, d.contest_id into v_division
  from public.event_competition_divisions d where d.id = target_division_id;
  if v_division.id is null or not public.can_manage_event_competition(v_division.event_id) then
    raise exception 'Division was not found or cannot be managed.' using errcode = '42501';
  end if;
  select status into v_program_status from public.event_competition_programs where id = v_division.program_id;
  if v_program_status not in ('draft', 'configured') then
    raise exception 'Divisions cannot be removed once the competition is running.';
  end if;
  if exists (select 1 from public.event_competition_entries e where e.division_id = target_division_id)
     or exists (select 1 from public.event_competition_heats h where h.division_id = target_division_id) then
    raise exception 'This division already has entries or heats and cannot be removed.';
  end if;
  delete from public.event_competition_divisions where id = target_division_id;
end;
$$;

revoke all on function public.remove_competition_division(uuid) from public, anon;
grant execute on function public.remove_competition_division(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1 and status = 'active') then
    raise exception 'Phase 10B postflight: studio_simple@1 is missing.';
  end if;
  if has_column_privilege('authenticated', 'public.event_competition_programs', 'profile_locked_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.event_competition_programs', 'rules_profile_key', 'INSERT')
     or has_column_privilege('anon', 'public.event_competition_programs', 'rules_profile_version', 'UPDATE')
     or has_table_privilege('authenticated', 'public.event_competition_program_locks', 'INSERT')
     or has_table_privilege('anon', 'public.event_competition_program_locks', 'SELECT') then
    raise exception 'Phase 10B postflight: clients can still write profile columns.';
  end if;
  if not has_column_privilege('authenticated', 'public.event_competition_programs', 'name', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.event_competition_programs', 'status', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.event_competition_programs', 'event_id', 'INSERT') then
    raise exception 'Phase 10B postflight: authenticated lost ordinary program column privileges.';
  end if;
  if has_function_privilege('anon', 'public.create_simple_competition(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.publish_competition_program(uuid)', 'EXECUTE') then
    raise exception 'Phase 10B postflight: anon can execute a 10B function.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
