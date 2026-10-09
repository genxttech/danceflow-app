-- Rollback for 20261108090000_phase10b_competition_profiles.sql
--
-- Restores the exact pre-10B schema (programs columns, scoring checks, table privileges, no 10B
-- functions/tables). It REFUSES, changing nothing, when any competition already carries a rules
-- profile or uses a studio scoring-engine key: the profile key/version, the frozen snapshot and the
-- engine keys are the historical configuration of that competition and must not be dropped.
-- Roll the APPLICATION back first (the 10B app calls the functions removed here).
-- Operators who accept losing that configuration on a DEVELOPMENT database can put
--   set phase10b.allow_profile_loss = 'yes';
-- (a session-level SET, before this file's BEGIN) in the same session. A SET LOCAL before BEGIN has no
-- effect. The override only skips the refusal check below; every other statement and the postflight
-- still run, and re-adding the narrower scoring checks fails if any row still uses a studio engine key.
-- Never set it on PROD once a competition is published.

begin;

do $$
declare
  v_profiled int;
  v_engines int;
begin
  if coalesce(current_setting('phase10b.allow_profile_loss', true), '') = 'yes' then
    return;
  end if;
  select (select count(*) from public.event_competition_programs where rules_profile_key is not null or profile_locked_at is not null)
       + (select count(*) from public.event_competition_program_locks)
  into v_profiled;
  select (select count(*) from public.event_competition_programs where scoring_method in ('ordinal_majority', 'proficiency_rating', 'callback_tally'))
       + (select count(*) from public.event_competition_rounds where scoring_method in ('ordinal_majority', 'proficiency_rating', 'callback_tally'))
  into v_engines;
  if v_profiled > 0 or v_engines > 0 then
    raise exception 'Phase 10B rollback refused: % competitions carry a rules profile and % rows use a studio scoring engine; they are historical configuration.',
      v_profiled, v_engines;
  end if;
end $$;

drop function public.remove_competition_division(uuid);
drop function public.add_competition_division(uuid, text, text, text);
drop function public.publish_competition_program(uuid);
drop function public.create_simple_competition(uuid, jsonb);

drop trigger protect_competition_program_profile on public.event_competition_programs;
drop function public.protect_competition_program_profile();

-- The lock-table triggers refuse DELETE/TRUNCATE; remove them before dropping the table (the guard above
-- already proved it is empty unless the allow flag was set).
drop trigger protect_competition_program_lock on public.event_competition_program_locks;
drop trigger protect_competition_program_lock_truncate on public.event_competition_program_locks;
drop table public.event_competition_program_locks;
drop function public.protect_competition_program_lock();

-- Profile columns are dropped only when no competition carries a profile (or under the allow flag).
alter table public.event_competition_programs
  drop constraint event_competition_programs_profile_lock_check,
  drop constraint event_competition_programs_profile_pair_check,
  drop constraint event_competition_programs_profile_fk;

-- Restore table-level privileges exactly (clear the column-level grants first).
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = 'public.event_competition_programs'::regclass and attnum > 0 and not attisdropped
    and attname not in ('rules_profile_key', 'rules_profile_version', 'profile_locked_at');
  execute format('revoke insert (%s), update (%s) on public.event_competition_programs from authenticated', v_cols, v_cols);
  execute 'grant insert, update on public.event_competition_programs to anon, authenticated';
end $$;

alter table public.event_competition_programs
  drop column rules_profile_key,
  drop column rules_profile_version,
  drop column profile_locked_at;

alter table public.event_competition_programs drop constraint event_competition_programs_scoring_check;
alter table public.event_competition_programs add constraint event_competition_programs_scoring_check
  check ((scoring_method = any (array['skating'::text, 'majority_rules'::text, 'wsdc_callback'::text, 'relative_placement'::text, 'round_specific'::text,
    'proficiency'::text, 'cumulative_points'::text, 'feedback_only'::text, 'custom'::text, 'none'::text])));

alter table public.event_competition_rounds drop constraint event_competition_rounds_scoring_method_check;
alter table public.event_competition_rounds add constraint event_competition_rounds_scoring_method_check
  check ((scoring_method = any (array['skating'::text, 'majority_rules'::text, 'wsdc_callback'::text, 'relative_placement'::text,
    'proficiency'::text, 'cumulative_points'::text, 'feedback_only'::text, 'custom'::text, 'none'::text])));

-- The rules-profile triggers refuse DELETE/TRUNCATE; remove them before dropping the table.
drop trigger protect_competition_rules_profile on public.competition_rules_profiles;
drop trigger protect_competition_rules_profile_truncate on public.competition_rules_profiles;
drop table public.competition_rules_profiles;
drop function public.protect_competition_rules_profile();

do $$
begin
  if to_regclass('public.competition_rules_profiles') is not null
     or to_regclass('public.event_competition_program_locks') is not null
     or to_regprocedure('public.create_simple_competition(uuid, jsonb)') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public'
                and table_name = 'event_competition_programs' and column_name like 'profile\_%') then
    raise exception 'Phase 10B rollback postflight: 10B objects remain.';
  end if;
  if not has_table_privilege('authenticated', 'public.event_competition_programs', 'UPDATE')
     or not has_table_privilege('anon', 'public.event_competition_programs', 'INSERT') then
    raise exception 'Phase 10B rollback postflight: table privileges were not restored.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
