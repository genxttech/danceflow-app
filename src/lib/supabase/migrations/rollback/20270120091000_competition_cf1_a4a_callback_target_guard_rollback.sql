-- Rollback for 20270120091000_competition_cf1_a4a_callback_target_guard.sql (CF1 rollback position 5: after A6, A5, A3, A2; before A0).
-- No data is created by A4a, so the rollback is unconditional. It restores A0's check function and A0's three message format strings.
-- Rows written with T = 1 after this rollback are not examined; the guard simply stops refusing them.

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
  v_new constant text[] := array[
    $f$must be at least 2 and no more than the Final''s capacity (%).$f$,
    $f$but its Final holds %; a callback target must be at least 2 and no more than the Final''s capacity, so fix it before publishing.$f$,
    $f$must be at least 2 and no more than the capacity (%).$f$];
  i integer;
begin
  if to_regprocedure('public._cf1_callback_target_check(integer,integer)') is null then
    raise exception 'CF1-A4a rollback refused: A0 objects are missing (roll back A4a before A0).';
  end if;
  for i in 1 .. array_length(v_sigs, 1) loop
    v_sig := v_sigs[i];
    if to_regprocedure(v_sig) is null then
      raise exception 'CF1-A4a rollback refused: % is missing.', v_sig;
    end if;
    v_def := pg_get_functiondef(v_sig::regprocedure);
    if position(v_new[i] in v_def) > 0 then
      execute replace(v_def, v_new[i], v_old[i]);
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
  select case when p_t is not null and p_t > p_capacity then 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY' else null end;
$$;

do $$
begin
  if public._cf1_callback_target_check(1, 8) is not null
     or public._cf1_callback_target_check(9, 8) is distinct from 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY' then
    raise exception 'CF1-A4a rollback postflight: A0 check function not restored.';
  end if;
end;
$$;

commit;
