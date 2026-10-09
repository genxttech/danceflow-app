-- Phase 9C: compensation rule change history, authoritative validation and
-- an atomic, studio-scoped save.
--
-- One current operational rule per (studio, instructor) stays in
-- public.instructor_compensation_rules and stays the only source the earning
-- calculation reads. No effective dating, no future-dated rules, no
-- recalculation: a rule change never touches existing earnings, approval
-- snapshots, payment evidence or export evidence (those freeze their own
-- values).
--
--   1. public.instructor_compensation_rule_history: a dedicated, typed,
--      append-only change log (one row per material rule change): studio,
--      instructor, rule id, change type (created / updated / cleared),
--      changed_at, actor id + display name + email + acting role copied at
--      the time of the change (no foreign key to profiles, instructors or
--      rules, so profile or instructor deletion can never null or remove
--      evidence), the list of changed fields and the full previous / new rule
--      values. The existing compensation_activity_history is deliberately NOT
--      reused: it is an earnings / period / batch activity log whose actor and
--      subject columns are nullable foreign keys (ON DELETE SET NULL) and
--      which has no rule columns or immutability guard.
--   2. public.save_instructor_compensation_rule(...) is the canonical writer.
--      SECURITY DEFINER, explicitly studio-scoped: the caller must be an active
--      owner or admin of the named studio (platform admins are NOT granted rule
--      writes here: that is unchanged behaviour, the table has always been
--      owner/admin only), and the instructor must belong to that studio
--      (unknown and cross-studio instructors fail identically). It validates,
--      normalizes, upserts the rule and appends the history row in one
--      transaction (both succeed or both roll back), and a save that changes
--      nothing writes neither a rule update nor a history row.
--   3. Validation (authoritative, in the RPC): supported modes only; required
--      amount for the selected mode; percentages 0..100 inclusive; amounts,
--      duration amounts and per-attendee amounts non-negative; non-finite
--      numbers rejected; notes capped. Fields that are irrelevant for the
--      selected mode (for example a percentage on a flat rule, duration
--      buckets when duration rates are off or the mode is not flat) are
--      NORMALIZED to 0 / false on save, so a stored rule can never carry a
--      contradictory configuration. Range validation applies to every
--      supplied value before normalization.
--   4. Existing rows: CHECK constraints for percentage and amount ranges are
--      added and then VALIDATED in this migration, so in the final state they
--      are fully validated (convalidated = true) and hold for every row, old
--      and new. The migration never rewrites existing rows. It fails closed:
--      a count-only preflight raises 'Phase 9C preflight: legacy compensation
--      rules violate ...' and aborts the whole transaction if any legacy rule
--      is out of range (the 9C range audit found none on PROD), and
--      VALIDATE CONSTRAINT would reject the same rows if it were reached.
--   5. Direct writes to the rules table are closed: INSERT / UPDATE / DELETE
--      privileges and the INSERT / UPDATE policies are removed for API roles,
--      so the RPC is the only API write path (owner/admin SELECT stays).
--      Nothing else in the application writes rules.
--   6. The history table is RLS-protected, SELECT-only for active owner/admin
--      of the same studio, no write policies or grants, and UPDATE / DELETE /
--      TRUNCATE are refused for everyone by trigger.
--
-- Not in this slice: shared CSV helper (9D), studio-local earning_date and
-- broad payroll UX (9E), platform-admin permission changes, Gusto.
--
-- No existing function is replaced. Preflight fails closed unless the
-- functions this slice depends on are byte-identical to the reviewed DEV ==
-- PROD definitions and the 9C objects do not exist yet. Rollback:
-- rollback/20261104090000_phase9c_compensation_history_rollback.sql.

begin;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================

do $$
declare
  v_expected constant jsonb := jsonb_build_object(
    '_landmark1a_assert_worker_row_same_studio', '7bc3f1ca68126ec79d18500f1939bd83',
    'payroll_actor_role', '586438d56a5925319416258126df2f88'
  );
  r record;
  v_md5 text;
  v_count int;
begin
  for r in select key, value from jsonb_each_text(v_expected) loop
    select count(*), max(md5(p.prosrc)) into v_count, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.key;
    if v_count <> 1 or v_md5 is distinct from r.value then
      raise exception 'Phase 9C preflight: public.% is not the reviewed definition (count %, md5 %).', r.key, v_count, v_md5;
    end if;
  end loop;

  if to_regclass('public.instructor_compensation_rule_history') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname in ('save_instructor_compensation_rule', 'prevent_compensation_rule_history_change'))
     or exists (select 1 from pg_constraint where conrelid = 'public.instructor_compensation_rules'::regclass
                and conname in ('instructor_compensation_rules_percentages_check', 'instructor_compensation_rules_amounts_check')) then
    raise exception 'Phase 9C preflight: Phase 9C objects already exist.';
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules'
        and policyname in ('instructor_compensation_rules_select', 'instructor_compensation_rules_insert', 'instructor_compensation_rules_update')) <> 3
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules'
                and policyname not in ('instructor_compensation_rules_select', 'instructor_compensation_rules_insert', 'instructor_compensation_rules_update')) then
    raise exception 'Phase 9C preflight: unexpected policies on instructor_compensation_rules.';
  end if;

  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'instructor_compensation_rules'
        and column_name in ('private_lesson_pay_mode', 'private_lesson_flat_amount', 'private_lesson_percentage',
          'private_lesson_duration_rates_enabled', 'private_lesson_30_min_flat_amount', 'private_lesson_45_min_flat_amount',
          'private_lesson_60_min_flat_amount', 'group_class_pay_mode', 'group_class_flat_amount', 'group_class_percentage',
          'group_class_per_attendee_amount', 'active', 'notes', 'created_by', 'studio_id', 'instructor_id')) <> 16 then
    raise exception 'Phase 9C preflight: instructor_compensation_rules columns are not as reviewed.';
  end if;

  if (select string_agg(column_name, ',' order by column_name) from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name in ('email', 'full_name')) is distinct from 'email,full_name' then
    raise exception 'Phase 9C preflight: profiles.full_name / profiles.email are missing.';
  end if;
end
$$;

-- ============================================================================
-- 1. HISTORY TABLE (append-only)
-- ============================================================================

create table public.instructor_compensation_rule_history (
  id uuid primary key default gen_random_uuid(),
  change_seq bigint generated always as identity,
  studio_id uuid not null references public.studios(id),
  instructor_id uuid not null,
  rule_id uuid not null,
  change_type text not null check (change_type in ('created', 'updated', 'cleared')),
  changed_at timestamptz not null default clock_timestamp(),
  changed_by uuid,
  changed_by_name text,
  changed_by_email text,
  changed_by_role text not null check (changed_by_role in ('studio_owner', 'studio_admin')),
  changed_fields text[] not null check (cardinality(changed_fields) > 0),
  previous_values jsonb,
  new_values jsonb not null,
  constraint instructor_compensation_rule_history_values_shape check (
    jsonb_typeof(new_values) = 'object'
    and (previous_values is null or jsonb_typeof(previous_values) = 'object')
    and ((change_type = 'created') = (previous_values is null)))
);
create index instructor_compensation_rule_history_lookup_idx
  on public.instructor_compensation_rule_history (studio_id, instructor_id, changed_at desc, change_seq desc);

create function public.prevent_compensation_rule_history_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Compensation rule history is immutable.';
end;
$$;
revoke all on function public.prevent_compensation_rule_history_change() from public, anon, authenticated;

create trigger trg_instructor_compensation_rule_history_immutable
  before update or delete on public.instructor_compensation_rule_history
  for each row execute function public.prevent_compensation_rule_history_change();
create trigger trg_instructor_compensation_rule_history_no_truncate
  before truncate on public.instructor_compensation_rule_history
  for each statement execute function public.prevent_compensation_rule_history_change();

alter table public.instructor_compensation_rule_history enable row level security;
revoke all on public.instructor_compensation_rule_history from public, anon, authenticated;
grant all on public.instructor_compensation_rule_history to service_role;
grant select on public.instructor_compensation_rule_history to authenticated;
create policy instructor_compensation_rule_history_select on public.instructor_compensation_rule_history
  for select to authenticated using (
    exists (select 1 from public.user_studio_roles usr
            where usr.studio_id = instructor_compensation_rule_history.studio_id
              and usr.user_id = auth.uid() and usr.active = true
              and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])));

-- ============================================================================
-- 2. RULES TABLE: VALIDATED RANGE CHECKS AND CLOSED DIRECT WRITES
-- ============================================================================

-- Count-only preflight: fail closed with a clear message before touching the
-- table if any legacy rule is out of range. No row values are read or shown.
do $$
declare
  v_pct int;
  v_amt int;
begin
  select count(*) filter (where not (private_lesson_percentage >= 0 and private_lesson_percentage <= 100
                                     and group_class_percentage >= 0 and group_class_percentage <= 100)),
         count(*) filter (where not (private_lesson_flat_amount >= 0 and private_lesson_30_min_flat_amount >= 0
                                     and private_lesson_45_min_flat_amount >= 0 and private_lesson_60_min_flat_amount >= 0
                                     and group_class_flat_amount >= 0 and group_class_per_attendee_amount >= 0))
    into v_pct, v_amt
  from public.instructor_compensation_rules;
  if v_pct > 0 or v_amt > 0 then
    raise exception 'Phase 9C preflight: legacy compensation rules violate the range checks (% percentage, % amount); correct them before applying.', v_pct, v_amt;
  end if;
end
$$;

alter table public.instructor_compensation_rules
  add constraint instructor_compensation_rules_percentages_check check (
    private_lesson_percentage >= 0 and private_lesson_percentage <= 100
    and group_class_percentage >= 0 and group_class_percentage <= 100) not valid,
  add constraint instructor_compensation_rules_amounts_check check (
    private_lesson_flat_amount >= 0 and private_lesson_30_min_flat_amount >= 0
    and private_lesson_45_min_flat_amount >= 0 and private_lesson_60_min_flat_amount >= 0
    and group_class_flat_amount >= 0 and group_class_per_attendee_amount >= 0) not valid;

alter table public.instructor_compensation_rules
  validate constraint instructor_compensation_rules_percentages_check;
alter table public.instructor_compensation_rules
  validate constraint instructor_compensation_rules_amounts_check;

drop policy instructor_compensation_rules_insert on public.instructor_compensation_rules;
drop policy instructor_compensation_rules_update on public.instructor_compensation_rules;
revoke all on public.instructor_compensation_rules from public, anon, authenticated;
grant select on public.instructor_compensation_rules to authenticated;

-- ============================================================================
-- 3. CANONICAL SAVE
-- ============================================================================

create function public.save_instructor_compensation_rule(
  p_studio_id uuid,
  p_instructor_id uuid,
  p_private_lesson_pay_mode text,
  p_private_lesson_flat_amount numeric,
  p_private_lesson_percentage numeric,
  p_private_lesson_duration_rates_enabled boolean,
  p_private_lesson_30_min_flat_amount numeric,
  p_private_lesson_45_min_flat_amount numeric,
  p_private_lesson_60_min_flat_amount numeric,
  p_group_class_pay_mode text,
  p_group_class_flat_amount numeric,
  p_group_class_percentage numeric,
  p_group_class_per_attendee_amount numeric,
  p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_keys constant text[] := array['private_lesson_pay_mode', 'private_lesson_flat_amount', 'private_lesson_percentage',
    'private_lesson_duration_rates_enabled', 'private_lesson_30_min_flat_amount', 'private_lesson_45_min_flat_amount',
    'private_lesson_60_min_flat_amount', 'group_class_pay_mode', 'group_class_flat_amount', 'group_class_percentage',
    'group_class_per_attendee_amount', 'active', 'notes'];
  v_role text;
  v_actor record;
  v_val record;
  v_old public.instructor_compensation_rules%rowtype;
  v_existed boolean;
  v_pm text := p_private_lesson_pay_mode;
  v_gm text := p_group_class_pay_mode;
  v_pflat numeric;
  v_ppct numeric;
  v_pdur boolean;
  v_p30 numeric;
  v_p45 numeric;
  v_p60 numeric;
  v_gflat numeric;
  v_gpct numeric;
  v_gper numeric;
  v_notes text := nullif(trim(p_notes), '');
  v_prev jsonb;
  v_new jsonb;
  v_fields text[];
  v_type text;
  v_rule_id uuid;
  v_history_id uuid;
begin
  if auth.uid() is null or p_studio_id is null then
    raise exception 'Payroll access denied.' using errcode = '42501';
  end if;

  select case when bool_or(usr.role = 'studio_owner') then 'studio_owner'
              when bool_or(usr.role = 'studio_admin') then 'studio_admin' end into v_role
  from public.user_studio_roles usr
  where usr.studio_id = p_studio_id and usr.user_id = auth.uid() and usr.active = true;
  if v_role is null then
    raise exception 'Payroll access denied.' using errcode = '42501';
  end if;

  if p_instructor_id is null
     or not exists (select 1 from public.instructors i where i.id = p_instructor_id and i.studio_id = p_studio_id) then
    raise exception 'Instructor not found for this studio.' using errcode = 'P0002';
  end if;

  -- Supported modes only.
  if v_pm is null or v_pm not in ('none', 'flat', 'percentage') then
    raise exception 'Unsupported private lesson pay mode.' using errcode = '22023';
  end if;
  if v_gm is null or v_gm not in ('none', 'flat', 'percentage', 'per_attendee') then
    raise exception 'Unsupported group class pay mode.' using errcode = '22023';
  end if;
  if length(coalesce(v_notes, '')) > 1000 then
    raise exception 'Compensation rule notes are too long.' using errcode = '22023';
  end if;

  -- Ranges apply to every supplied value, before irrelevant fields are normalized.
  for v_val in select * from (values
      (p_private_lesson_flat_amount, false), (p_private_lesson_30_min_flat_amount, false),
      (p_private_lesson_45_min_flat_amount, false), (p_private_lesson_60_min_flat_amount, false),
      (p_group_class_flat_amount, false), (p_group_class_per_attendee_amount, false),
      (p_private_lesson_percentage, true), (p_group_class_percentage, true)) as t(val, is_percentage) loop
    if v_val.val is null then continue; end if;
    if v_val.val in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Compensation rule amounts must be valid numbers.' using errcode = '22023';
    end if;
    if v_val.val < 0 then
      raise exception 'Compensation rule amounts cannot be negative.' using errcode = '22023';
    end if;
    if v_val.is_percentage and v_val.val > 100 then
      raise exception 'Compensation rule percentages must be between 0 and 100.' using errcode = '22023';
    end if;
  end loop;

  -- The selected mode's amount is required.
  if (v_pm = 'flat' and p_private_lesson_flat_amount is null)
     or (v_pm = 'percentage' and p_private_lesson_percentage is null)
     or (v_gm = 'flat' and p_group_class_flat_amount is null)
     or (v_gm = 'percentage' and p_group_class_percentage is null)
     or (v_gm = 'per_attendee' and p_group_class_per_attendee_amount is null) then
    raise exception 'Compensation rule is missing a required amount.' using errcode = '22023';
  end if;

  -- Normalize mode-irrelevant fields so no contradictory configuration is stored.
  v_pflat := case when v_pm = 'flat' then p_private_lesson_flat_amount else 0 end;
  v_ppct := case when v_pm = 'percentage' then p_private_lesson_percentage else 0 end;
  v_pdur := case when v_pm = 'flat' then coalesce(p_private_lesson_duration_rates_enabled, false) else false end;
  v_p30 := case when v_pdur then coalesce(p_private_lesson_30_min_flat_amount, 0) else 0 end;
  v_p45 := case when v_pdur then coalesce(p_private_lesson_45_min_flat_amount, 0) else 0 end;
  v_p60 := case when v_pdur then coalesce(p_private_lesson_60_min_flat_amount, 0) else 0 end;
  v_gflat := case when v_gm = 'flat' then p_group_class_flat_amount else 0 end;
  v_gpct := case when v_gm = 'percentage' then p_group_class_percentage else 0 end;
  v_gper := case when v_gm = 'per_attendee' then p_group_class_per_attendee_amount else 0 end;

  v_new := jsonb_build_object(
    'private_lesson_pay_mode', v_pm, 'private_lesson_flat_amount', v_pflat, 'private_lesson_percentage', v_ppct,
    'private_lesson_duration_rates_enabled', v_pdur, 'private_lesson_30_min_flat_amount', v_p30,
    'private_lesson_45_min_flat_amount', v_p45, 'private_lesson_60_min_flat_amount', v_p60,
    'group_class_pay_mode', v_gm, 'group_class_flat_amount', v_gflat, 'group_class_percentage', v_gpct,
    'group_class_per_attendee_amount', v_gper, 'active', true, 'notes', v_notes);

  -- One writer at a time per instructor rule (first-save races, concurrent edits).
  perform pg_advisory_xact_lock(hashtextextended('instructor_compensation_rule:' || p_studio_id::text || ':' || p_instructor_id::text, 0));

  select * into v_old from public.instructor_compensation_rules r
  where r.studio_id = p_studio_id and r.instructor_id = p_instructor_id
  for update;
  v_existed := found;

  if v_existed then
    select jsonb_object_agg(e.key, e.value) into v_prev
    from jsonb_each(to_jsonb(v_old)) e where e.key = any (v_keys);
    select coalesce(array_agg(k order by k), '{}'::text[]) into v_fields
    from unnest(v_keys) k where v_prev -> k is distinct from v_new -> k;
    if cardinality(v_fields) = 0 then
      return jsonb_build_object('changed', false, 'rule_id', v_old.id);
    end if;
    v_rule_id := v_old.id;
    v_type := case when v_pm = 'none' and v_gm = 'none'
                        and (v_old.private_lesson_pay_mode <> 'none' or v_old.group_class_pay_mode <> 'none')
                   then 'cleared' else 'updated' end;
    update public.instructor_compensation_rules set
      private_lesson_pay_mode = v_pm, private_lesson_flat_amount = v_pflat, private_lesson_percentage = v_ppct,
      private_lesson_duration_rates_enabled = v_pdur, private_lesson_30_min_flat_amount = v_p30,
      private_lesson_45_min_flat_amount = v_p45, private_lesson_60_min_flat_amount = v_p60,
      group_class_pay_mode = v_gm, group_class_flat_amount = v_gflat, group_class_percentage = v_gpct,
      group_class_per_attendee_amount = v_gper, active = true, notes = v_notes, updated_at = now()
    where id = v_old.id;
  else
    v_prev := null;
    v_fields := v_keys;
    v_type := 'created';
    insert into public.instructor_compensation_rules (
      studio_id, instructor_id, private_lesson_pay_mode, private_lesson_flat_amount, private_lesson_percentage,
      private_lesson_duration_rates_enabled, private_lesson_30_min_flat_amount, private_lesson_45_min_flat_amount,
      private_lesson_60_min_flat_amount, group_class_pay_mode, group_class_flat_amount, group_class_percentage,
      group_class_per_attendee_amount, active, notes, created_by)
    values (
      p_studio_id, p_instructor_id, v_pm, v_pflat, v_ppct, v_pdur, v_p30, v_p45, v_p60,
      v_gm, v_gflat, v_gpct, v_gper, true, v_notes, auth.uid())
    returning id into v_rule_id;
  end if;

  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), '')) as display_name,
         nullif(trim(p.email), '') as email into v_actor
  from public.profiles p where p.id = auth.uid();

  insert into public.instructor_compensation_rule_history (
    studio_id, instructor_id, rule_id, change_type, changed_by, changed_by_name, changed_by_email,
    changed_by_role, changed_fields, previous_values, new_values)
  values (
    p_studio_id, p_instructor_id, v_rule_id, v_type, auth.uid(), v_actor.display_name, v_actor.email,
    v_role, v_fields, v_prev, v_new)
  returning id into v_history_id;

  return jsonb_build_object('changed', true, 'change_type', v_type, 'rule_id', v_rule_id, 'history_id', v_history_id);
end;
$function$;
revoke all on function public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)
  from public, anon;
grant execute on function public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)
  to authenticated, service_role;

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================

do $$
declare
  t constant text := 'instructor_compensation_rule_history';
begin
  if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
    raise exception 'Phase 9C postflight: RLS is off on %.', t;
  end if;
  if (select count(*) from pg_trigger where tgrelid = ('public.' || t)::regclass and not tgisinternal and tgenabled = 'O') <> 2 then
    raise exception 'Phase 9C postflight: immutability triggers missing on %.', t;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
    raise exception 'Phase 9C postflight: % has a write policy.', t;
  end if;
  if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
     or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
     or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
     or has_table_privilege('anon', 'public.' || t, 'SELECT') then
    raise exception 'Phase 9C postflight: % grants are too broad.', t;
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.instructor_compensation_rules'::regclass
        and conname in ('instructor_compensation_rules_percentages_check', 'instructor_compensation_rules_amounts_check')
        and convalidated) <> 2 then
    raise exception 'Phase 9C postflight: range checks are not validated.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules' and cmd <> 'SELECT')
     or has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'INSERT')
     or has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'UPDATE')
     or has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'DELETE')
     or has_table_privilege('anon', 'public.instructor_compensation_rules', 'SELECT') then
    raise exception 'Phase 9C postflight: instructor_compensation_rules direct writes are still open.';
  end if;
  if has_function_privilege('anon', 'public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)', 'execute')
     or not (select prosecdef from pg_proc where oid = 'public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)'::regprocedure) then
    raise exception 'Phase 9C postflight: save RPC grants or security mode are wrong.';
  end if;
end
$$;

commit;
