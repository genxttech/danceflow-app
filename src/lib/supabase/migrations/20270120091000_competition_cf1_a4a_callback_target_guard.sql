-- Competition CF1 package A4a: callback-target lower bound (OD-21): a callback target below two is refused at setup and at publication.
--
-- Design: docs/competition/callback-to-final-advancement-design.md 3.4.3 (F2 setup guard, OD-21 lower bound), 4.6 b, A.9.1 / A.9.2 package A4a.
-- A4a adds NO object and NO trigger. A0 (20270120090000) already routes every F2 arm through one extension point,
-- _cf1_callback_target_check(T, capacity), and only for a callback configuration (a 'preliminary' round of a 'promote_callback'
-- program with a successor Final in the same division). A4a extends it in two narrow steps:
--   1. create or replace _cf1_callback_target_check: T < 2 -> COMP_CALLBACK_TARGET_BELOW_MINIMUM (checked first), T > capacity ->
--      COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY (as A0), null T -> no refusal (D-CT-5: set before ballots).
--   2. replace only the message FORMAT STRING in the three A0 functions that print the code (guard arms 1/2, program-lock arm,
--      reasoned capacity RPC) because A0's text ("does not fit the Final's capacity") is wrong for T < 2. Arguments and codes are
--      untouched. The replacement is exact-fragment, asserted to occur, and reversed by the rollback; no md5 pin (A0 may still change
--      elsewhere).
-- Scope guarantee: the check function is never called for a Final-only division, a non-callback program, a round that is not a
-- 'preliminary' round, or a round without a successor Final, so those are unaffected (U77). Existing rows are not retro-failed; a T below
-- two surfaces at the next write of T, of the Final's capacity, or at program lock.
--
-- Apply order: slot 20270120091000 after A0 (20270120090000). Apply as the role that owns the A0 functions (postgres).
-- Rollback: rollback/20270120091000_competition_cf1_a4a_callback_target_guard_rollback.sql, 5th of the CF1 rollbacks (before A0's).

begin;

do $$
declare
  v_def text;
  v_sig text;
  v_sigs constant text[] := array[
    'public.cf1_guard_callback_target_capacity()',
    'public.cf1_guard_callback_target_program_lock()',
    'public.set_competition_round_heat_capacity(uuid,integer,text,uuid)'];
  v_old constant text[] := array[
    $f$does not fit the Final''s capacity (%).$f$,
    $f$but its Final holds %; fix it before publishing.$f$,
    $f$does not fit capacity %.$f$];
  i integer;
begin
  if to_regprocedure('public._cf1_callback_target_check(integer,integer)') is null then
    raise exception 'CF1-A4a preflight: A0 (20270120090000) is not applied (_cf1_callback_target_check missing).';
  end if;
  if position('COMP_CALLBACK_TARGET_BELOW_MINIMUM' in pg_get_functiondef('public._cf1_callback_target_check(integer,integer)'::regprocedure)) > 0 then
    raise exception 'CF1-A4a preflight: already applied.';
  end if;
  for i in 1 .. array_length(v_sigs, 1) loop
    v_sig := v_sigs[i];
    if to_regprocedure(v_sig) is null then
      raise exception 'CF1-A4a preflight: % is missing.', v_sig;
    end if;
    v_def := pg_get_functiondef(v_sig::regprocedure);
    if position(v_old[i] in v_def) = 0 then
      raise exception 'CF1-A4a preflight: % does not contain the expected message fragment (A0 changed; re-read its contract).', v_sig;
    end if;
  end loop;
end;
$$;

create or replace function public._cf1_callback_target_check(p_t integer, p_capacity integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_t is null then null
    when p_t < 2 then 'COMP_CALLBACK_TARGET_BELOW_MINIMUM'
    when p_t > p_capacity then 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY'
    else null
  end;
$$;

do $$
declare
  v_def text;
  v_sig text;
  v_sigs constant text[] := array[
    'public.cf1_guard_callback_target_capacity()',
    'public.cf1_guard_callback_target_program_lock()',
    'public.set_competition_round_heat_capacity(uuid,integer,text,uuid)'];
  v_old constant text[] := array[
    $f$does not fit the Final''s capacity (%).$f$,
    $f$but its Final holds %; fix it before publishing.$f$,
    $f$does not fit capacity %.$f$];
  v_new constant text[] := array[
    $f$must be at least 2 and no more than the Final''s capacity (%).$f$,
    $f$but its Final holds %; a callback target must be at least 2 and no more than the Final''s capacity, so fix it before publishing.$f$,
    $f$must be at least 2 and no more than the capacity (%).$f$];
  i integer;
begin
  for i in 1 .. array_length(v_sigs, 1) loop
    v_sig := v_sigs[i];
    v_def := replace(pg_get_functiondef(v_sig::regprocedure), v_old[i], v_new[i]);
    if position(v_new[i] in v_def) = 0 then
      raise exception 'CF1-A4a: message replacement failed for %.', v_sig;
    end if;
    execute v_def;
  end loop;
end;
$$;

-- Postflight: the check function and the three raise sites carry the new behaviour.
do $$
begin
  if public._cf1_callback_target_check(1, 8) is distinct from 'COMP_CALLBACK_TARGET_BELOW_MINIMUM'
     or public._cf1_callback_target_check(0, 8) is distinct from 'COMP_CALLBACK_TARGET_BELOW_MINIMUM'
     or public._cf1_callback_target_check(2, 8) is not null
     or public._cf1_callback_target_check(8, 8) is not null
     or public._cf1_callback_target_check(null, 8) is not null
     or public._cf1_callback_target_check(9, 8) is distinct from 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY' then
    raise exception 'CF1-A4a postflight: _cf1_callback_target_check does not behave as specified.';
  end if;
  if position('does not fit' in pg_get_functiondef('public.cf1_guard_callback_target_capacity()'::regprocedure)) > 0
     or position('does not fit' in pg_get_functiondef('public.cf1_guard_callback_target_program_lock()'::regprocedure)) > 0
     or position('does not fit' in pg_get_functiondef('public.set_competition_round_heat_capacity(uuid,integer,text,uuid)'::regprocedure)) > 0 then
    raise exception 'CF1-A4a postflight: an old message fragment remains.';
  end if;
  if has_function_privilege('anon', 'public._cf1_callback_target_check(integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public._cf1_callback_target_check(integer,integer)', 'execute') then
    raise exception 'CF1-A4a postflight: the check function must have no client grant.';
  end if;
end;
$$;

commit;
