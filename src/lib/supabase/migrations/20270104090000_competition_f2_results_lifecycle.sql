-- 20270104090000_competition_f2_results_lifecycle.sql
--
-- PHASE 10 -- F2: results lifecycle (K0 sections 3, 4, 6 corrections, 8 unified audit; slot 20270104090000).
-- Stacks on E1 (20270101090000), E2 (20270102090000) and O1 (20270106090000). F3 publication (20270105090000) is NOT here.
--
-- New tables (RLS on; managers read all, assigned scorers read versions/rows, nobody else reads anything):
--   event_competition_result_versions   insert-only except `status` transitions made by the RPCs below
--   event_competition_result_rows       insert-only, written in the transaction that created the version
--   event_competition_result_approvals  insert-only, one per version
--   event_competition_result_events     append-only audit (fixed kinds, one request id per operation)
--
-- Writer RPCs (SECURITY DEFINER, row lock on the round, idempotent on a request id, one result_events row each):
--   calculate_competition_round         ballots_locked -> calculated        manager | assigned scorer
--   approve_competition_round_result    calculated -> approved              manager; approver <> calculator, or audited override (D3)
--   complete_competition_round          published -> complete               manager; FAILS CLOSED until F3 publications exist
--   open_competition_round_correction   calculated|approved|published -> ballots_locked   manager + reason; refused by O5
-- Reads: competition_round_calculation_input (evidence + hash for the app), competition_round_results_review,
--        competition_audit_log (unified audit over E1 + O1 + E2 + F2 audit tables).
--
-- Hash binding. input_hash = sha256(canonical JSON of the "evidence input" document built in SQL from the CURRENT
-- ballots by _compf2_evidence). The same document is built and hashed app-side (src/lib/competition/results/evidence.ts,
-- golden vector shared with the SQL suite); calculate/approve refuse when the stored hash is not the hash of the
-- current ballots (COMP_RESULT_STALE). trace_hash is app-computed and only shape-checked here (a trace may carry decimals
-- whose JSON text differs between engines and Postgres); the trace itself is stored so anyone can recompute it.
--
-- Engine pin. REG (method registry) is not merged: _compf2_engine_pin is the single function to replace. Until then only
-- ordinal_majority -> studio_ordinal_majority@1 and callback_tally -> studio_callback_tally@1 are accepted; every other
-- scoring method fails closed (COMP_ENGINE_NOT_AVAILABLE).
--
-- Correction extension of E2 (its header says "F2's correction path may relax that when it exists"). E2 accepts ballots
-- only while a round is `active`. K0 section 4 corrections run calculated|approved|published -> ballots_locked and then
-- a corrected ballot, so F2 adds event_competition_rounds.correction_open (set only by the status trigger on exactly
-- those edges, cleared on any other status change) and relaxes exactly ONE condition in each of E2's
-- _compe2_guard_ballot_insert and _compe2_insert_ballot: `active` OR (`ballots_locked` AND correction_open). The rewrite
-- reads the installed function definition, asserts the E2 text occurs exactly once, and fails otherwise. Nothing else
-- of E2 or O1 changes. O1's static edge list already contains every F2 edge.
--
-- Rollback: rollback/20270104090000_competition_f2_results_lifecycle_rollback.sql (refuses while any evidence exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_result_versions') is not null
     or to_regclass('public.event_competition_result_rows') is not null
     or to_regclass('public.event_competition_result_approvals') is not null
     or to_regclass('public.event_competition_result_events') is not null
     or to_regprocedure('public._compf2_evidence(uuid,text,text)') is not null then
    raise exception 'F2 preflight: an F2 table or function already exists (roll back or clean up a partial earlier run first).';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'event_competition_rounds' and column_name = 'correction_open') then
    raise exception 'F2 preflight: event_competition_rounds.correction_open already exists.';
  end if;
  if to_regclass('public.event_competition_ballots') is null
     or to_regprocedure('public._compe2_round_blockers(uuid)') is null
     or to_regprocedure('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)') is null
     or to_regprocedure('public._compe2_guard_ballot_insert()') is null then
    raise exception 'F2 preflight: E2 ballots are missing.';
  end if;
  if to_regclass('public.event_competition_official_events') is null then
    raise exception 'F2 preflight: E1 officials are missing.';
  end if;
  -- O1 (slot 20270106) sorts AFTER F2, so it is optional here: its static edge list already holds every F2 edge, and the
  -- audit read includes its transition table only when it exists.
  if to_regprocedure('public.set_competition_heat_lock_state(uuid,text,text)') is null
     or to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null then
    raise exception 'F2 preflight: 10A competition authority is missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
alter table public.event_competition_rounds add column correction_open boolean not null default false;

create table public.event_competition_result_versions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  version integer not null,
  engine_key text not null,
  engine_version text not null,
  rules_profile_key text,
  rules_profile_version integer,
  input_hash text not null,
  trace_hash text not null,
  input jsonb not null,
  trace jsonb not null,
  warnings jsonb not null default '[]'::jsonb,
  calculated_by uuid not null,
  calculated_at timestamptz not null default now(),
  status text not null default 'calculated',
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_result_versions_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_result_versions_status_check check (status in ('calculated', 'approved', 'stale', 'superseded')),
  constraint event_competition_result_versions_version_check check (version >= 1),
  constraint event_competition_result_versions_hash_check check (input_hash ~ '^[0-9a-f]{64}$' and trace_hash ~ '^[0-9a-f]{64}$'),
  constraint event_competition_result_versions_trace_check check (jsonb_typeof(trace) = 'array' and jsonb_typeof(warnings) = 'array'),
  constraint event_competition_result_versions_engine_check check (engine_key ~ '^[a-z][a-z0-9_]{1,63}$' and length(engine_version) between 1 and 32),
  unique (id, event_id),
  unique (round_id, version),
  unique (request_id)
);
create index event_competition_result_versions_round_idx on public.event_competition_result_versions(round_id, status);

create table public.event_competition_result_rows (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  result_version_id uuid not null,
  entry_id uuid not null,
  placement integer,
  tie_group text,
  advanced boolean,
  rating_band text,
  output jsonb not null default '{}'::jsonb,
  constraint event_competition_result_rows_version_fk
    foreign key (result_version_id, event_id) references public.event_competition_result_versions(id, event_id) on delete cascade,
  constraint event_competition_result_rows_entry_fk
    foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id),
  constraint event_competition_result_rows_placement_check check (placement is null or placement >= 1),
  constraint event_competition_result_rows_text_check check (length(coalesce(tie_group, '')) <= 64 and length(coalesce(rating_band, '')) <= 64),
  constraint event_competition_result_rows_output_check check (jsonb_typeof(output) = 'object'),
  unique (result_version_id, entry_id)
);

create table public.event_competition_result_approvals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  result_version_id uuid not null,
  approved_by uuid not null,
  calculated_by uuid not null,
  approved_at timestamptz not null default now(),
  override_reason text,
  request_id uuid not null,
  constraint event_competition_result_approvals_version_fk
    foreign key (result_version_id, event_id) references public.event_competition_result_versions(id, event_id) on delete cascade,
  constraint event_competition_result_approvals_override_check check (
    (approved_by <> calculated_by and override_reason is null)
    or (approved_by = calculated_by and length(btrim(coalesce(override_reason, ''))) between 1 and 500)
  ),
  unique (result_version_id),
  unique (request_id)
);

create table public.event_competition_result_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  result_version_id uuid,
  kind text not null,
  actor_user_id uuid not null,
  from_state text,
  to_state text,
  request_id uuid not null,
  reason text,
  refs jsonb not null default '{}'::jsonb,
  transaction_id bigint not null default txid_current(),
  occurred_at timestamptz not null default now(),
  constraint event_competition_result_events_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_result_events_version_fk
    foreign key (result_version_id, event_id) references public.event_competition_result_versions(id, event_id) on delete cascade,
  -- Fixed kinds (K0 RESULT_EVENT_KINDS). F3 adds its publication kinds in its own migration by replacing this check.
  constraint event_competition_result_events_kind_check check (kind in (
    'round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated')),
  constraint event_competition_result_events_reason_check check (reason is null or length(reason) <= 500)
);
create unique index event_competition_result_events_request_idx on public.event_competition_result_events(request_id);
create index event_competition_result_events_round_idx on public.event_competition_result_events(round_id, occurred_at);
create index event_competition_result_events_txn_idx on public.event_competition_result_events(transaction_id, round_id);

comment on table public.event_competition_result_versions is
  'F2: one row per calculation of a round. Insert-only except status (calculated -> approved | stale | superseded) written by the lifecycle RPCs. Draft, calculated and approved results are readable by result managers (and assigned scorers) only.';
comment on table public.event_competition_result_events is
  'F2: append-only audit of result transitions (calculate, approve, override, invalidate, correction, complete). Shared with F3.';

-- ---------------------------------------------------------------------------
-- 2. Immutability and guards
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['event_competition_result_rows', 'event_competition_result_approvals', 'event_competition_result_events'] loop
    execute format('create trigger protect_%1$s_history before update or delete on public.%1$I
                    for each row execute function public.protect_competition_history_evidence()', t);
  end loop;
  foreach t in array array['event_competition_result_versions', 'event_competition_result_rows',
                           'event_competition_result_approvals', 'event_competition_result_events'] loop
    execute format('create trigger protect_%1$s_history_truncate before truncate on public.%1$I
                    for each statement execute function public.protect_competition_history_evidence()', t);
  end loop;
end $$;
create trigger protect_event_competition_result_versions_history_delete
  before delete on public.event_competition_result_versions
  for each row execute function public.protect_competition_history_evidence();

-- Versions: only `status` may change, and each edge needs its audit row written in the same transaction.
create function public._compf2_guard_version_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'COMPF2_VERSION_IMMUTABLE: a result version is insert-only; only its status moves.' using errcode = '42501';
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status, new.status) not in (('calculated', 'approved'), ('calculated', 'stale'), ('calculated', 'superseded'),
                                      ('approved', 'stale'), ('approved', 'superseded'), ('stale', 'superseded')) then
    raise exception 'COMPF2_VERSION_EDGE: result version % -> % is not allowed.', old.status, new.status using errcode = '23514';
  end if;
  if new.status = 'approved' then
    if not exists (select 1 from public.event_competition_result_events e
                   where e.result_version_id = old.id and e.event_id = old.event_id
                     and e.kind in ('result_approved', 'result_approval_override') and e.transaction_id = txid_current()) then
      raise exception 'COMPF2_VERSION_WRITER: approval is written only by approve_competition_round_result.' using errcode = '42501';
    end if;
  elsif new.status = 'stale' then
    if not exists (select 1 from public.event_competition_result_events e
                   where e.round_id = old.round_id and e.event_id = old.event_id
                     and e.kind in ('result_invalidated', 'round_state_changed') and e.transaction_id = txid_current()
                     and e.refs -> 'version_ids' ? old.id::text) then
      raise exception 'COMPF2_VERSION_WRITER: invalidation needs its audit row in the same transaction.' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from public.event_competition_result_events e
                   where e.round_id = old.round_id and e.event_id = old.event_id
                     and e.kind = 'result_calculated' and e.transaction_id = txid_current()
                     and e.refs -> 'superseded_version_ids' ? old.id::text) then
      raise exception 'COMPF2_VERSION_WRITER: superseding is written only by calculate_competition_round.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._compf2_guard_version_update() from public, anon, authenticated, service_role;
create trigger compf2_guard_version_update
  before update on public.event_competition_result_versions
  for each row execute function public._compf2_guard_version_update();

create function public._compf2_guard_version_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'calculated' then
    raise exception 'COMPF2_VERSION_WRITER: a result version starts as calculated.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._compf2_guard_version_insert() from public, anon, authenticated, service_role;
create trigger compf2_guard_version_insert
  before insert on public.event_competition_result_versions
  for each row execute function public._compf2_guard_version_insert();
-- At most one live (calculated or approved) version per round.
create unique index event_competition_result_versions_live_idx
  on public.event_competition_result_versions(round_id) where status in ('calculated', 'approved');

-- Owner O5, inverse side: no ballot may be written in a round while an earlier round of its division has an open correction.
create function public._compf2_guard_ballot_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.event_competition_rounds cur
             join public.event_competition_rounds earlier on earlier.event_id = cur.event_id and earlier.division_id = cur.division_id
               and earlier.sequence_number < cur.sequence_number
             where cur.id = new.round_id and cur.event_id = new.event_id and earlier.correction_open) then
    raise exception 'COMP_CORRECTION_EARLIER_ROUND_OPEN: an earlier round of this division has an open correction (owner O5).' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._compf2_guard_ballot_order() from public, anon, authenticated, service_role;
create trigger compf2_guard_ballot_order
  before insert on public.event_competition_ballots
  for each row execute function public._compf2_guard_ballot_order();

-- Rows exist only in the transaction that created their version, for entries of that version's round (K0 section 9 #3).
create function public._compf2_guard_row_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.event_competition_result_versions;
begin
  select * into v from public.event_competition_result_versions x where x.id = new.result_version_id and x.event_id = new.event_id;
  if not found or v.transaction_id <> txid_current() then
    raise exception 'COMPF2_ROW_IMMUTABLE: result rows can only be written together with their version.' using errcode = '42501';
  end if;
  if not (new.entry_id = any (public._compe2_round_entries(v.round_id))) then
    raise exception 'COMPF2_ROW_ENTRY: the entry does not belong to the version''s round.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public._compf2_guard_row_insert() from public, anon, authenticated, service_role;
create trigger compf2_guard_row_insert
  before insert on public.event_competition_result_rows
  for each row execute function public._compf2_guard_row_insert();

-- Approvals exist only in the transaction of an approval audit row of the same version.
create function public._compf2_guard_approval_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.event_competition_result_events e
                 where e.result_version_id = new.result_version_id and e.event_id = new.event_id
                   and e.kind in ('result_approved', 'result_approval_override') and e.transaction_id = txid_current()
                   and e.actor_user_id = new.approved_by) then
    raise exception 'COMPF2_APPROVAL_WRITER: approvals are written only by approve_competition_round_result.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._compf2_guard_approval_insert() from public, anon, authenticated, service_role;
create trigger compf2_guard_approval_insert
  before insert on public.event_competition_result_approvals
  for each row execute function public._compf2_guard_approval_insert();

-- Round status: the F2 edges are written only by their RPCs (audit row in the same transaction); correction_open is derived.
create function public._compf2_guard_round_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.correction_open := false;
    return new;
  end if;
  if new.status is not distinct from old.status then
    new.correction_open := old.correction_open;
    return new;
  end if;
  if (old.status, new.status) in (('ballots_locked', 'calculated'), ('calculated', 'approved'), ('published', 'complete'),
                                  ('calculated', 'ballots_locked'), ('approved', 'ballots_locked'), ('published', 'ballots_locked')) then
    if not exists (
      select 1 from public.event_competition_result_events e
      where e.round_id = old.id and e.event_id = old.event_id
        and e.from_state = old.status and e.to_state = new.status
        and e.transaction_id = txid_current()
    ) then
      raise exception 'COMPF2_ROUND_WRITER: % -> % is written only by its F2 lifecycle function.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;
  new.correction_open := new.status = 'ballots_locked' and old.status in ('calculated', 'approved', 'published');
  return new;
end;
$$;
revoke all on function public._compf2_guard_round_status() from public, anon, authenticated, service_role;
create trigger compf2_guard_round_status
  before insert or update on public.event_competition_rounds
  for each row execute function public._compf2_guard_round_status();

-- ---------------------------------------------------------------------------
-- 3. E2 correction extension (exactly one condition in each of two E2 functions)
-- ---------------------------------------------------------------------------
create function public._compf2_correction_open(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select r.status = 'ballots_locked' and r.correction_open
                   from public.event_competition_rounds r where r.id = p_round_id), false);
$$;
revoke all on function public._compf2_correction_open(uuid) from public, anon, authenticated, service_role;

do $$
declare
  v_def text;
  v_new text;
  v_old_a constant text := 'if v_status is distinct from ''active'' then';
  v_new_a constant text := 'if v_status is distinct from ''active'' and not public._compf2_correction_open(new.round_id) then';
  v_old_b constant text := 'if v_round.status <> ''active'' then' || E'\n' || '    raise exception ''COMP_BALLOT_ROUND_NOT_ACTIVE: ballots are accepted only while the round is active';
  v_new_b constant text := 'if v_round.status <> ''active'' and not (v_round.status = ''ballots_locked'' and v_round.correction_open) then' || E'\n' || '    raise exception ''COMP_BALLOT_ROUND_NOT_ACTIVE: ballots are accepted only while the round is active';
begin
  v_def := pg_get_functiondef('public._compe2_guard_ballot_insert()'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old_a, ''))) / length(v_old_a) <> 1 then
    raise exception 'F2 preflight: E2 _compe2_guard_ballot_insert does not contain the expected round-status condition exactly once.';
  end if;
  execute replace(v_def, v_old_a, v_new_a);

  v_def := pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure);
  v_def := replace(v_def, E'\r\n', E'\n');
  if (length(v_def) - length(replace(v_def, v_old_b, ''))) / length(v_old_b) <> 1 then
    raise exception 'F2 preflight: E2 _compe2_insert_ballot does not contain the expected round-status condition exactly once.';
  end if;
  v_new := replace(v_def, v_old_b, v_new_b);
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Hashing, evidence, engine pin (internal)
-- ---------------------------------------------------------------------------
-- Canonical JSON: object keys sorted bytewise, arrays in order, scalars as JSON text. Mirrors canonicalJson in
-- src/lib/competition/results/contract.ts for documents holding strings, integers, booleans and nulls only.
create function public._compf2_canon(p jsonb)
returns text
language plpgsql
immutable
as $$
declare
  t text := jsonb_typeof(p);
begin
  if t = 'object' then
    return '{' || coalesce((select string_agg(to_jsonb(k.key)::text || ':' || public._compf2_canon(k.value), ',' order by k.key collate "C")
                            from jsonb_each(p) k), '') || '}';
  elsif t = 'array' then
    return '[' || coalesce((select string_agg(public._compf2_canon(e.value), ',' order by e.ord)
                            from jsonb_array_elements(p) with ordinality e(value, ord)), '') || ']';
  elsif t = 'null' or p is null then
    return 'null';
  end if;
  return p::text;
end;
$$;
revoke all on function public._compf2_canon(jsonb) from public, anon, authenticated, service_role;

create function public._compf2_sha256(p text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex');
$$;
revoke all on function public._compf2_sha256(text) from public, anon, authenticated, service_role;

-- The single place that decides which engine may calculate a round. Replace with the REG pin lookup when it exists.
create function public._compf2_engine_pin(p_round_id uuid)
returns table(engine_key text, engine_version text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.engine_key, v.engine_version
  from public.event_competition_rounds r
  join (values ('ordinal_majority', 'studio_ordinal_majority', '1'),
               ('callback_tally', 'studio_callback_tally', '1')) v(scoring, engine_key, engine_version)
    on v.scoring = r.scoring_method
  where r.id = p_round_id;
$$;
revoke all on function public._compf2_engine_pin(uuid) from public, anon, authenticated, service_role;

-- Current ballots covering the round (same filter as E2's lock audit): not superseded, in a ballot heat or round-level.
create function public._compf2_evidence(p_round_id uuid, p_engine_key text, p_engine_version text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cur as (
    select b.*
    from public.event_competition_ballots b
    where b.round_id = p_round_id
      and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)
      and (b.heat_id is null or b.heat_id in (select h.heat_id from public._compe2_round_heats(p_round_id) h))
  )
  select jsonb_build_object(
    'engineKey', p_engine_key,
    'engineVersion', p_engine_version,
    'round', jsonb_build_object('id', r.id, 'roundType', r.round_type, 'targetAdvancementCount', r.target_advancement_count,
                                'advancementMethod', (select pg.advancement_method from public.event_competition_programs pg where pg.id = r.program_id and pg.event_id = r.event_id)),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('entryId', x) order by x::text collate "C")
                         from unnest(public._compe2_round_entries(r.id)) x), '[]'::jsonb),
    'judges', coalesce((select jsonb_agg(jsonb_build_object('officialId', j.official_id, 'letter', j.judge_letter)
                                         order by j.official_id::text collate "C")
                        from public._compe2_round_judges(r.id) j
                        where not public._compe2_is_absent(r.id, j.official_id)), '[]'::jsonb),
    'ballots', coalesce((select jsonb_agg(jsonb_build_object('ballotId', c.id, 'heatId', c.heat_id, 'officialId', c.official_id, 'version', c.version)
                                          order by c.id::text collate "C")
                         from cur c), '[]'::jsonb),
    'marks', coalesce((select jsonb_agg(jsonb_build_object('officialId', c.official_id, 'entryId', m.entry_id, 'heatId', c.heat_id,
                                                           'role', null::text, 'value', m.mark)
                                        order by c.official_id::text collate "C", m.entry_id::text collate "C", coalesce(c.heat_id::text, '') collate "C")
                       from cur c join public.event_competition_marks m on m.ballot_id = c.id and m.event_id = c.event_id), '[]'::jsonb)
  )
  from public.event_competition_rounds r
  where r.id = p_round_id;
$$;
revoke all on function public._compf2_evidence(uuid, text, text) from public, anon, authenticated, service_role;

create function public._compf2_input_hash(p_round_id uuid, p_engine_key text, p_engine_version text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._compf2_sha256(public._compf2_canon(public._compf2_evidence(p_round_id, p_engine_key, p_engine_version)));
$$;
revoke all on function public._compf2_input_hash(uuid, text, text) from public, anon, authenticated, service_role;

create function public._compf2_event(
  p_event_id uuid, p_round_id uuid, p_version_id uuid, p_kind text, p_actor uuid, p_from text, p_to text,
  p_request_id uuid, p_reason text, p_refs jsonb
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.event_competition_result_events
    (event_id, round_id, result_version_id, kind, actor_user_id, from_state, to_state, request_id, reason, refs)
  values (p_event_id, p_round_id, p_version_id, p_kind, p_actor, p_from, p_to, p_request_id, p_reason, coalesce(p_refs, '{}'::jsonb));
$$;
revoke all on function public._compf2_event(uuid, uuid, uuid, text, uuid, text, text, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- A new ballot version makes every unpublished result version of its round stale (K0 section 4, invalidation).
create function public._compf2_invalidate_on_ballot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb;
begin
  select coalesce(jsonb_agg(v.id order by v.version), '[]'::jsonb) into v_ids
  from public.event_competition_result_versions v
  where v.round_id = new.round_id and v.event_id = new.event_id and v.status in ('calculated', 'approved');
  if jsonb_array_length(v_ids) > 0 then
    perform public._compf2_event(new.event_id, new.round_id, null, 'result_invalidated', new.submitted_by, null, null, gen_random_uuid(),
      null, jsonb_build_object('version_ids', v_ids, 'ballot_id', new.id, 'ballot_version', new.version));
    update public.event_competition_result_versions v set status = 'stale'
    where v.round_id = new.round_id and v.event_id = new.event_id and v.status in ('calculated', 'approved');
  end if;
  return null;
end;
$$;
revoke all on function public._compf2_invalidate_on_ballot() from public, anon, authenticated, service_role;
create trigger compf2_invalidate_on_ballot
  after insert on public.event_competition_ballots
  for each row execute function public._compf2_invalidate_on_ballot();

-- ---------------------------------------------------------------------------
-- 5. RLS and grants (K0 reader matrix: manager all; assigned scorer versions + rows; nobody else)
-- ---------------------------------------------------------------------------
alter table public.event_competition_result_versions enable row level security;
alter table public.event_competition_result_rows enable row level security;
alter table public.event_competition_result_approvals enable row level security;
alter table public.event_competition_result_events enable row level security;

create policy competition_result_versions_manager_read on public.event_competition_result_versions
  for select to authenticated using (public.can_manage_event_competition(event_id));
create policy competition_result_versions_scorer_read on public.event_competition_result_versions
  for select to authenticated using (public.competition_is_round_scorer(round_id));
create policy competition_result_rows_read on public.event_competition_result_rows
  for select to authenticated
  using (exists (select 1 from public.event_competition_result_versions v
                 where v.id = event_competition_result_rows.result_version_id and v.event_id = event_competition_result_rows.event_id));
create policy competition_result_approvals_manager_read on public.event_competition_result_approvals
  for select to authenticated using (public.can_manage_event_competition(event_id));
create policy competition_result_events_manager_read on public.event_competition_result_events
  for select to authenticated using (public.can_manage_event_competition(event_id));

revoke all on public.event_competition_result_versions from public, anon, authenticated, service_role;
revoke all on public.event_competition_result_rows from public, anon, authenticated, service_role;
revoke all on public.event_competition_result_approvals from public, anon, authenticated, service_role;
revoke all on public.event_competition_result_events from public, anon, authenticated, service_role;
grant select on public.event_competition_result_versions to authenticated;
grant select on public.event_competition_result_rows to authenticated;
grant select on public.event_competition_result_approvals to authenticated;
grant select on public.event_competition_result_events to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reads
-- ---------------------------------------------------------------------------
-- Evidence + hash for the app server action (manager or assigned scorer). Only while ballots are locked.
create function public.competition_round_calculation_input(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_key text;
  v_ver text;
  v_ev jsonb;
begin
  if coalesce(v_role, '') not in ('manager', 'scorer') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  select p.engine_key, p.engine_version into v_key, v_ver from public._compf2_engine_pin(p_round_id) p;
  if v_key is null then
    return jsonb_build_object('available', false, 'status', v_round.status, 'scoring_method', v_round.scoring_method,
                              'code', 'COMP_ENGINE_NOT_AVAILABLE');
  end if;
  v_ev := public._compf2_evidence(p_round_id, v_key, v_ver);
  return jsonb_build_object('available', true, 'status', v_round.status, 'scoring_method', v_round.scoring_method,
    'engine_key', v_key, 'engine_version', v_ver, 'evidence', v_ev,
    'input_hash', public._compf2_sha256(public._compf2_canon(v_ev)),
    'blockers', public._compe2_round_blockers(p_round_id));
end;
$$;

-- Manager / assigned-scorer review board: versions with rows, approval, staleness against the current ballots.
create function public.competition_round_results_review(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
begin
  if coalesce(v_role, '') not in ('manager', 'scorer') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  return jsonb_build_object(
    'viewer_role', v_role,
    'viewer_id', auth.uid(),
    'round', jsonb_build_object('id', v_round.id, 'name', v_round.name, 'status', v_round.status, 'scoring_method', v_round.scoring_method,
                                'correction_open', v_round.correction_open, 'event_id', v_round.event_id),
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'version', v.version, 'status', v.status, 'engine_key', v.engine_key, 'engine_version', v.engine_version,
        'input_hash', v.input_hash, 'trace_hash', v.trace_hash, 'warnings', v.warnings,
        'calculated_by', v.calculated_by,
        'calculated_by_name', coalesce(nullif(btrim(p.full_name), ''), 'A manager'),
        'calculated_at', v.calculated_at,
        'stale', v.status in ('calculated', 'approved')
                 and v.input_hash is distinct from public._compf2_input_hash(v.round_id, v.engine_key, v.engine_version),
        'approval', (select jsonb_build_object('approved_by', a.approved_by, 'approved_at', a.approved_at, 'override_reason', a.override_reason)
                     from public.event_competition_result_approvals a where a.result_version_id = v.id),
        'rows', coalesce((
          select jsonb_agg(jsonb_build_object('entry_id', rr.entry_id, 'entry_number', e.entry_number, 'display_name', e.display_name,
                                              'placement', rr.placement, 'tie_group', rr.tie_group, 'advanced', rr.advanced,
                                              'rating_band', rr.rating_band)
                           order by rr.placement nulls last, e.entry_number, rr.entry_id)
          from public.event_competition_result_rows rr
          join public.event_competition_entries e on e.id = rr.entry_id and e.event_id = rr.event_id
          where rr.result_version_id = v.id and rr.event_id = v.event_id), '[]'::jsonb))
        order by v.version desc)
      from public.event_competition_result_versions v
      left join public.profiles p on p.id = v.calculated_by
      where v.round_id = p_round_id and v.event_id = v_round.event_id), '[]'::jsonb),
    'blockers', public._compe2_round_blockers(p_round_id));
end;
$$;

-- Unified audit (K0 section 8 amendment): E1 officials, O1 round transitions, E2 ballots and F2 results in one stream.
-- Result managers only; entrants, judges and the public read nothing here (results reach them through F3).
create function public.competition_audit_log(p_event_id uuid, p_round_id uuid default null, p_limit integer default 200)
returns table(
  occurred_at timestamptz, source text, kind text, actor_user_id uuid, round_id uuid,
  from_state text, to_state text, reason text, refs jsonb, record_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_o1 text := '';
begin
  if auth.uid() is null or p_event_id is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  -- O1 (round transitions) sorts after F2 in the slot order, so its branch exists only when its table does.
  if to_regclass('public.event_competition_round_transition_events') is not null then
    v_o1 := 'union all
    select t.created_at, ''round'', t.kind, t.actor, t.round_id, t.from_state, t.to_state, t.reason,
           t.refs || jsonb_build_object(''heat_id'', t.heat_id), t.id
    from public.event_competition_round_transition_events t
    where t.event_id = $1 and ($2 is null or t.round_id = $2)';
  end if;
  return query execute '
  select u.occurred_at, u.source, u.kind, u.actor_user_id, u.round_id, u.from_state, u.to_state, u.reason, u.refs, u.record_id
  from (
    select e.occurred_at, ''results''::text as source, e.kind, e.actor_user_id, e.round_id, e.from_state, e.to_state, e.reason,
           e.refs || jsonb_build_object(''result_version_id'', e.result_version_id) as refs, e.id as record_id
    from public.event_competition_result_events e
    where e.event_id = $1 and ($2 is null or e.round_id = $2)
    union all
    select b.occurred_at, ''ballots'', b.kind, b.actor_user_id, b.round_id, b.from_state, b.to_state, b.reason,
           b.refs || jsonb_build_object(''heat_id'', b.heat_id, ''official_id'', b.official_id, ''ballot_id'', b.ballot_id), b.id
    from public.event_competition_ballot_events b
    where b.event_id = $1 and ($2 is null or b.round_id = $2)
    union all
    select o.occurred_at, ''officials'', o.kind, o.actor_user_id, o.round_id, null::text, null::text, o.reason,
           o.refs || jsonb_build_object(''official_id'', o.official_id), o.id
    from public.event_competition_official_events o
    where o.event_id = $1 and ($2 is null or o.round_id = $2)
    ' || v_o1 || '
  ) u
  order by u.occurred_at desc, u.source, u.record_id
  limit ' || least(greatest(coalesce(p_limit, 200), 1), 1000)::text using p_event_id, p_round_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Writer RPCs
-- ---------------------------------------------------------------------------
create function public.calculate_competition_round(
  p_round_id uuid, p_engine_key text, p_engine_version text, p_input_hash text, p_trace_hash text,
  p_trace jsonb, p_rows jsonb, p_warnings jsonb, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_pin_key text;
  v_pin_ver text;
  v_block jsonb;
  v_evidence jsonb;
  v_hash text;
  v_fp text;
  v_entries uuid[];
  v_el jsonb;
  v_entry uuid;
  v_seen uuid[] := '{}';
  v_placement integer;
  v_version public.event_competition_result_versions;
  v_next integer;
  v_super jsonb;
  v_warnings jsonb := coalesce(p_warnings, '[]'::jsonb);
begin
  if v_uid is null or coalesce(v_role, '') not in ('manager', 'scorer') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  v_fp := public._compf2_sha256(coalesce(p_engine_key, '') || '|' || coalesce(p_engine_version, '') || '|' || coalesce(p_input_hash, '')
                                || '|' || coalesce(p_trace_hash, '') || '|' || coalesce(md5(p_trace::text), '') || '|' || coalesce(p_rows::text, '') || '|' || coalesce(v_warnings::text, ''));
  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'result_calculated' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id
       and (v_prev.refs ->> 'fp') is not distinct from v_fp then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'result_version_id', v_prev.result_version_id,
                                'version', (v_prev.refs ->> 'version')::integer, 'status', 'calculated');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'ballots_locked' then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: only a round with locked ballots can be calculated (round is %).', v_round.status using errcode = 'P0001';
  end if;

  -- Method must be approved and pinned; anything else fails closed.
  select p.engine_key, p.engine_version into v_pin_key, v_pin_ver from public._compf2_engine_pin(p_round_id) p;
  if v_pin_key is null or p_engine_key is distinct from v_pin_key or p_engine_version is distinct from v_pin_ver then
    raise exception 'COMP_ENGINE_NOT_AVAILABLE: scoring method "%" has no approved pinned engine (%@% requested).',
      coalesce(v_round.scoring_method, 'null'), coalesce(p_engine_key, 'null'), coalesce(p_engine_version, 'null') using errcode = 'P0001';
  end if;

  v_block := public._compe2_round_blockers(p_round_id);
  if not coalesce((v_block ->> 'ready')::boolean, false) then
    raise exception 'COMP_BALLOTS_INCOMPLETE: the round''s current ballots are not complete for calculation.' using errcode = 'P0001', detail = v_block::text;
  end if;

  v_evidence := public._compf2_evidence(p_round_id, v_pin_key, v_pin_ver);
  v_hash := public._compf2_sha256(public._compf2_canon(v_evidence));
  if p_input_hash is distinct from v_hash then
    raise exception 'COMP_RESULT_STALE: the engine input does not match the current locked ballots (re-read the calculation input and re-run).' using errcode = 'P0001';
  end if;
  if p_trace_hash is null or p_trace_hash !~ '^[0-9a-f]{64}$' or p_trace is null or jsonb_typeof(p_trace) <> 'array'
     or octet_length(p_trace::text) > 4000000 or jsonb_typeof(v_warnings) <> 'array' then
    raise exception 'COMP_ENGINE_INVALID_INPUT: the trace must be a JSON array with a sha256 hex trace_hash.' using errcode = 'P0001';
  end if;
  -- The server recomputes the trace hash (K0 section 5). Engines keep traces to strings, booleans, nulls and plain
  -- numbers: exponent-form numbers are the one place JavaScript and jsonb text differ.
  if p_trace_hash <> public._compf2_sha256(public._compf2_canon(p_trace)) then
    raise exception 'COMP_ENGINE_INVALID_INPUT: trace_hash is not the canonical hash of the trace.' using errcode = 'P0001';
  end if;

  -- Rows: exactly one per round entry, nothing else.
  v_entries := public._compe2_round_entries(p_round_id);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) <> coalesce(array_length(v_entries, 1), 0) then
    raise exception 'COMP_ENGINE_INVALID_INPUT: the result must hold exactly one row per round entry.' using errcode = 'P0001';
  end if;
  for v_el in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'COMP_ENGINE_INVALID_INPUT: each result row must be an object.' using errcode = 'P0001';
    end if;
    begin
      v_entry := (v_el ->> 'entry_id')::uuid;
    exception when others then
      v_entry := null;
    end;
    if v_entry is null or not (v_entry = any (v_entries)) or v_entry = any (v_seen) then
      raise exception 'COMP_ENGINE_INVALID_INPUT: result row entry % is unknown or duplicated.', coalesce(v_el ->> 'entry_id', 'null') using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_entry;
    if jsonb_typeof(coalesce(v_el -> 'placement', 'null'::jsonb)) not in ('number', 'null')
       or jsonb_typeof(coalesce(v_el -> 'advanced', 'null'::jsonb)) not in ('boolean', 'null')
       or jsonb_typeof(coalesce(v_el -> 'tie_group', 'null'::jsonb)) not in ('string', 'null')
       or jsonb_typeof(coalesce(v_el -> 'rating_band', 'null'::jsonb)) not in ('string', 'null')
       or jsonb_typeof(coalesce(v_el -> 'output', '{}'::jsonb)) <> 'object' then
      raise exception 'COMP_ENGINE_INVALID_INPUT: a result row field has the wrong type.' using errcode = 'P0001';
    end if;
    if jsonb_typeof(coalesce(v_el -> 'placement', 'null'::jsonb)) = 'number' then
      v_placement := null;
      begin
        v_placement := (v_el ->> 'placement')::integer;
      exception when others then
        v_placement := null;
      end;
      if v_placement is null or v_placement < 1 or (v_el ->> 'placement') !~ '^[0-9]+$' then
        raise exception 'COMP_ENGINE_INVALID_INPUT: placement must be a positive whole number.' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  select coalesce(max(v.version), 0) + 1 into v_next from public.event_competition_result_versions v where v.round_id = p_round_id;
  select coalesce(jsonb_agg(v.id order by v.version), '[]'::jsonb) into v_super
  from public.event_competition_result_versions v where v.round_id = p_round_id and v.status <> 'superseded';

  insert into public.event_competition_result_versions
    (event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, warnings, calculated_by, request_id)
  values (v_round.event_id, p_round_id, v_next, v_pin_key, v_pin_ver, v_hash, p_trace_hash, v_evidence, p_trace, v_warnings, v_uid, p_request_id)
  returning * into v_version;

  perform public._compf2_event(v_round.event_id, p_round_id, v_version.id, 'result_calculated', v_uid, 'ballots_locked', 'calculated',
    p_request_id, null, jsonb_build_object('fp', v_fp, 'version', v_next, 'engine', v_pin_key || '@' || v_pin_ver, 'input_hash', v_hash,
      'trace_hash', p_trace_hash, 'superseded_version_ids', v_super, 'actor_role', v_role, 'rows', jsonb_array_length(p_rows)));

  update public.event_competition_result_versions v set status = 'superseded'
  where v.round_id = p_round_id and v.id <> v_version.id and v.status <> 'superseded';

  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement, tie_group, advanced, rating_band, output)
  select v_round.event_id, v_version.id, (r ->> 'entry_id')::uuid, (r ->> 'placement')::integer, r ->> 'tie_group',
         (r ->> 'advanced')::boolean, r ->> 'rating_band', coalesce(r -> 'output', '{}'::jsonb)
  from jsonb_array_elements(p_rows) r;

  update public.event_competition_rounds set status = 'calculated', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'result_version_id', v_version.id, 'version', v_next, 'status', 'calculated');
end;
$$;

create function public.approve_competition_round_result(
  p_round_id uuid, p_result_version_id uuid, p_override_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_ver public.event_competition_result_versions;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_override boolean;
  v_hash text;
  v_heat record;
  v_certified jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_role is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind in ('result_approved', 'result_approval_override') and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id
       and v_prev.result_version_id is not distinct from p_result_version_id then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'result_version_id', p_result_version_id,
                                'status', 'approved', 'override', v_prev.kind = 'result_approval_override');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'calculated' then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: only a calculated round can be approved (round is %).', v_round.status using errcode = 'P0001';
  end if;
  select * into v_ver from public.event_competition_result_versions v
  where v.id = p_result_version_id and v.round_id = p_round_id and v.event_id = v_round.event_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if v_ver.status <> 'calculated' or v_ver.version <> (select max(x.version) from public.event_competition_result_versions x where x.round_id = p_round_id) then
    raise exception 'COMP_RESULT_STALE: this result version is not the round''s latest calculated version (status %).', v_ver.status using errcode = 'P0001';
  end if;
  v_hash := public._compf2_input_hash(p_round_id, v_ver.engine_key, v_ver.engine_version);
  if v_hash is distinct from v_ver.input_hash then
    raise exception 'COMP_RESULT_STALE: the ballots changed after this calculation; recalculate before approving.' using errcode = 'P0001';
  end if;

  -- Owner D3: a second person approves; the calculator may approve only with a reason, and that is audited as an override.
  v_override := v_ver.calculated_by = v_uid;
  if v_override and (v_reason is null or length(v_reason) > 500) then
    raise exception 'COMP_SECOND_APPROVER_REQUIRED: a second manager must approve; the calculator may approve only with an override reason (1-500 characters).'
      using errcode = 'P0001';
  end if;
  if not v_override then
    v_reason := null;
  end if;

  perform public._compf2_event(v_round.event_id, p_round_id, v_ver.id,
    case when v_override then 'result_approval_override' else 'result_approved' end, v_uid, 'calculated', 'approved',
    p_request_id, v_reason, jsonb_build_object('version', v_ver.version, 'input_hash', v_ver.input_hash, 'calculated_by', v_ver.calculated_by,
      'override', v_override));
  insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, override_reason, request_id)
  values (v_round.event_id, v_ver.id, v_uid, v_ver.calculated_by, v_reason, p_request_id);
  update public.event_competition_result_versions set status = 'approved' where id = v_ver.id;

  -- Certification is a consequence of approval (K0 section 4.1): every locked heat of the round becomes certified.
  for v_heat in
    select h.id from public.event_competition_heats h
    where h.round_id = p_round_id and h.event_id = v_round.event_id and h.status <> 'cancelled' and h.lock_state = 'locked'
    order by h.id
  loop
    perform public.set_competition_heat_lock_state(v_heat.id, 'certified', 'Round result approved');
    v_certified := v_certified || to_jsonb(v_heat.id);
  end loop;

  update public.event_competition_rounds set status = 'approved', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'result_version_id', v_ver.id, 'status', 'approved',
                            'override', v_override, 'certified_heat_ids', v_certified);
end;
$$;

-- published -> complete. F3 owns publication; until its table exists this FAILS CLOSED and the round cannot complete.
create function public.complete_competition_round(p_round_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_ver public.event_competition_result_versions;
  v_pub boolean := false;
begin
  if v_uid is null or v_role is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.to_state = 'complete' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', 'complete');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'published' then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: only a published round can be completed (round is %).', v_round.status using errcode = 'P0001';
  end if;

  -- Publication precondition (fail closed): an unknown publication shape or table is a refusal, never a pass.
  if to_regclass('public.event_competition_result_publications') is null then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: publication (F3) is not installed, so a published result cannot be verified; completion is refused.'
      using errcode = 'P0001';
  end if;
  begin
    execute 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1 and p.withdrawn_at is null and p.superseded_by is null)'
      into v_pub using p_round_id;
  exception when others then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: publication state could not be verified; completion is refused.' using errcode = 'P0001';
  end;
  if not coalesce(v_pub, false) then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: the round has no current publication.' using errcode = 'P0001';
  end if;

  select * into v_ver from public.event_competition_result_versions v
  where v.round_id = p_round_id and v.status = 'approved' order by v.version desc limit 1;
  if not found then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: the round has no approved result version.' using errcode = 'P0001';
  end if;
  -- Advancement (K0 section 6): its writer (apply_competition_round_advancement) is a later slice, so a round whose result
  -- advances any entry cannot complete yet.
  if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is true) then
    raise exception 'COMP_ADVANCEMENT_NOT_APPROVED: this result advances entries and advancement has not been applied; completion is refused.' using errcode = 'P0001';
  end if;

  perform public._compf2_event(v_round.event_id, p_round_id, v_ver.id, 'round_state_changed', v_uid, 'published', 'complete', p_request_id, null,
    jsonb_build_object('version', v_ver.version, 'actor_role', v_role));
  update public.event_competition_rounds set status = 'complete', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'complete');
end;
$$;

create function public.open_competition_round_correction(p_round_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public._compe2_round_role(p_round_id);
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ids jsonb;
begin
  if v_uid is null or v_role is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'COMP_RESULT_REASON_REQUIRED: opening a correction needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.to_state = 'ballots_locked' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'status', 'ballots_locked');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('calculated', 'approved', 'published') then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: a correction opens only from calculated, approved or published (round is %).', v_round.status using errcode = 'P0001';
  end if;
  -- Owner O5: an earlier round cannot be corrected once a later round of the division holds any ballot. The later rounds are
  -- row-locked first, so a first ballot in a later round (which share-locks its own round) cannot commit concurrently.
  perform 1 from public.event_competition_rounds r2
   where r2.event_id = v_round.event_id and r2.division_id = v_round.division_id and r2.sequence_number > v_round.sequence_number for update;
  if exists (select 1 from public.event_competition_rounds r2
             join public.event_competition_ballots b on b.round_id = r2.id and b.event_id = r2.event_id
             where r2.event_id = v_round.event_id and r2.division_id = v_round.division_id and r2.sequence_number > v_round.sequence_number) then
    raise exception 'COMP_CORRECTION_LATER_ROUND_BALLOTS: a later round of this division already has ballots; the earlier round cannot be corrected (owner O5).'
      using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(v.id order by v.version), '[]'::jsonb) into v_ids
  from public.event_competition_result_versions v where v.round_id = p_round_id and v.status in ('calculated', 'approved');
  perform public._compf2_event(v_round.event_id, p_round_id, null, 'round_state_changed', v_uid, v_round.status, 'ballots_locked', p_request_id, v_reason,
    jsonb_build_object('correction', true, 'version_ids', v_ids, 'actor_role', v_role));
  update public.event_competition_result_versions v set status = 'stale'
  where v.round_id = p_round_id and v.status in ('calculated', 'approved');
  update public.event_competition_rounds set status = 'ballots_locked', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'status', 'ballots_locked', 'invalidated_version_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants (authenticated only; never anon)
-- ---------------------------------------------------------------------------
revoke all on function public.competition_round_calculation_input(uuid) from public, anon;
revoke all on function public.competition_round_results_review(uuid) from public, anon;
revoke all on function public.competition_audit_log(uuid, uuid, integer) from public, anon;
revoke all on function public.calculate_competition_round(uuid, text, text, text, text, jsonb, jsonb, jsonb, uuid) from public, anon;
revoke all on function public.approve_competition_round_result(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.complete_competition_round(uuid, uuid) from public, anon;
revoke all on function public.open_competition_round_correction(uuid, text, uuid) from public, anon;
grant execute on function public.competition_round_calculation_input(uuid) to authenticated;
grant execute on function public.competition_round_results_review(uuid) to authenticated;
grant execute on function public.competition_audit_log(uuid, uuid, integer) to authenticated;
grant execute on function public.calculate_competition_round(uuid, text, text, text, text, jsonb, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.approve_competition_round_result(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.complete_competition_round(uuid, uuid) to authenticated;
grant execute on function public.open_competition_round_correction(uuid, text, uuid) to authenticated;

commit;
