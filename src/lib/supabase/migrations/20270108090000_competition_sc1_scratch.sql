-- SC1 -- Competition scratch workflow (moves no money).
--
-- Owner direction 2026-10-23 (docs/competition/scratch-policy-and-competition-credit.md, PR #301):
--   * "Scratch" is the competition-facing term (stored statuses scratched / withdrawn both stay: S-D1).
--   * A scratch never moves money and never creates or reserves a refund. fee_handling is always 'retain'.
--   * The organizer's financial-resolution policy (no_refund default / credit / refund) is respected; choosing a
--     different resolution is an exception that needs an authorized official and a reason.
--   * An authorized official may scratch an entry in a LOCKED but not yet danced heat without reopening it,
--     with a mandatory reason and an immutable audit record (S-D2).
--   * Danced and certified placements are never scratched here; they go through the K0 correction workflow.
--
-- Objects:
--   1. event_competition_scratch_policies     per-program override of the resolution default
--   2. competition_scratch_policy_defaults    studio / organizer standard policy
--   3. event_competition_scratches            append-only scratch audit (one row per scratch)
--   4. scratch_competition_entry(...)         the scratch RPC
--   5. set_competition_scratch_policy(...) / set_competition_scratch_policy_default(...)
--   6. protect_locked_competition_heat_children(): one narrow exception -- a status-only scratch of a placement in
--      a LOCKED heat, authorized by an official scratch row written in the same transaction (the same
--      "ledger row in this transaction" pattern as event_competition_heat_lock_events).
--
-- Not changed: change_competition_entry_lifecycle, sync_competition_entries_from_registration (owned by R2),
-- any payment, refund, settlement or accounting object.
--
-- Rollback: rollback/20270108090000_competition_sc1_scratch_rollback.sql
-- Tests:    sql-tests/test_T_competition_sc1_scratch.sql

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight: the guard we replace is exactly the reviewed 10A body
-- ---------------------------------------------------------------------------
do $$
declare
  v_actual text;
begin
  select md5(replace(prosrc, E'\r\n', E'\n')) into v_actual
  from pg_proc where oid = 'public.protect_locked_competition_heat_children()'::regprocedure;
  if v_actual is distinct from '7997313d6effc4af94caf5fe4fd055c9' then
    raise exception 'SC1 preflight: protect_locked_competition_heat_children body is % (expected 7997313d...); re-review before applying.',
      coalesce(v_actual, 'missing');
  end if;
  if to_regprocedure('public._paywh1_actor_can_manage_event(uuid)') is null then
    raise exception 'SC1 preflight: _paywh1_actor_can_manage_event(uuid) (PAY-WH-1) is required.';
  end if;
  if to_regclass('public.event_competition_scratches') is not null then
    raise exception 'SC1 preflight: event_competition_scratches already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1-2. Policies
-- ---------------------------------------------------------------------------
create table public.competition_scratch_policy_defaults (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  default_resolution text not null default 'no_refund',
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint competition_scratch_policy_defaults_issuer_check check ((studio_id is null) <> (organizer_id is null)),
  constraint competition_scratch_policy_defaults_resolution_check
    check (default_resolution in ('no_refund', 'credit', 'refund'))
);
create unique index competition_scratch_policy_defaults_studio_idx
  on public.competition_scratch_policy_defaults(studio_id) where studio_id is not null;
create unique index competition_scratch_policy_defaults_organizer_idx
  on public.competition_scratch_policy_defaults(organizer_id) where organizer_id is not null;

create table public.event_competition_scratch_policies (
  program_id uuid primary key,
  event_id uuid not null,
  default_resolution text not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint event_competition_scratch_policies_program_fk
    foreign key (program_id, event_id) references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_scratch_policies_resolution_check
    check (default_resolution in ('no_refund', 'credit', 'refund'))
);

alter table public.competition_scratch_policy_defaults enable row level security;
alter table public.event_competition_scratch_policies enable row level security;
revoke all on public.competition_scratch_policy_defaults from public, anon, authenticated, service_role;
revoke all on public.event_competition_scratch_policies from public, anon, authenticated, service_role;
grant select on public.competition_scratch_policy_defaults to authenticated, service_role;
grant select on public.event_competition_scratch_policies to authenticated, service_role;

create policy competition_scratch_policy_defaults_read on public.competition_scratch_policy_defaults
  for select to authenticated using (
    exists (select 1 from public.user_studio_roles usr
            where usr.studio_id = competition_scratch_policy_defaults.studio_id and usr.user_id = auth.uid() and usr.active
              and usr.role in ('studio_owner', 'studio_admin'))
    or exists (select 1 from public.organizer_users ou
               where ou.organizer_id = competition_scratch_policy_defaults.organizer_id and ou.user_id = auth.uid() and ou.active)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin'));
create policy event_competition_scratch_policies_read on public.event_competition_scratch_policies
  for select to authenticated using (public.can_manage_event_competition(event_id));

-- Append-only history of every policy change (who, when, old -> new, reason).
create table public.competition_scratch_policy_changes (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid,
  studio_id uuid,
  organizer_id uuid,
  previous_resolution text,
  new_resolution text,
  reason text,
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  constraint competition_scratch_policy_changes_scope_check check (scope in ('program', 'standard'))
);
create index competition_scratch_policy_changes_event_idx on public.competition_scratch_policy_changes(event_id, changed_at desc);
alter table public.competition_scratch_policy_changes enable row level security;
revoke all on public.competition_scratch_policy_changes from public, anon, authenticated, service_role;
grant select on public.competition_scratch_policy_changes to authenticated, service_role;
create policy competition_scratch_policy_changes_read on public.competition_scratch_policy_changes
  for select to authenticated using (public.can_manage_event_competition(event_id));

-- The policy belongs to the event's issuer: organizer owners/admins for an organizer-run event, studio
-- owners/admins for a studio-run event, platform admins either. Host-studio roles cannot override an
-- organizer's policy (program override or standard).
create function public._sc1_actor_owns_policy(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
        or (e.organizer_id is not null and exists (
              select 1 from public.organizer_users ou
              where ou.organizer_id = e.organizer_id and ou.user_id = auth.uid() and ou.active
                and ou.role in ('organizer_owner', 'organizer_admin')))
        or (e.organizer_id is null and exists (
              select 1 from public.user_studio_roles usr
              where usr.studio_id = e.studio_id and usr.user_id = auth.uid() and usr.active
                and usr.role in ('studio_owner', 'studio_admin')))
      ));
$$;
revoke all on function public._sc1_actor_owns_policy(uuid) from public, anon;
grant execute on function public._sc1_actor_owns_policy(uuid) to authenticated, service_role;

-- Effective policy: program override, else the event's issuer default (organizer when the event has one,
-- else studio), else no_refund. Null for callers who cannot manage the event.
create function public.competition_scratch_effective_policy(p_program_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when not public.can_manage_event_competition(
                (select event_id from public.event_competition_programs where id = p_program_id))
              then null
              else coalesce(
    (select sp.default_resolution from public.event_competition_scratch_policies sp where sp.program_id = p_program_id),
    (select d.default_resolution
     from public.event_competition_programs pr
     join public.events e on e.id = pr.event_id
     join public.competition_scratch_policy_defaults d
       on (e.organizer_id is not null and d.organizer_id = e.organizer_id)
       or (e.organizer_id is null and d.studio_id = e.studio_id)
     where pr.id = p_program_id
     limit 1),
    'no_refund') end;
$$;
-- Internal (no caller check): used by the scratch RPC after it has authorized the actor.
create function public._sc1_policy_for(p_program_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select sp.default_resolution from public.event_competition_scratch_policies sp where sp.program_id = p_program_id),
    (select d.default_resolution
     from public.event_competition_programs pr
     join public.events e on e.id = pr.event_id
     join public.competition_scratch_policy_defaults d
       on (e.organizer_id is not null and d.organizer_id = e.organizer_id)
       or (e.organizer_id is null and d.studio_id = e.studio_id)
     where pr.id = p_program_id
     limit 1),
    'no_refund');
$$;
revoke all on function public._sc1_policy_for(uuid) from public, anon, authenticated;
revoke all on function public.competition_scratch_effective_policy(uuid) from public, anon;
grant execute on function public.competition_scratch_effective_policy(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Scratch audit (append-only)
-- ---------------------------------------------------------------------------
create table public.event_competition_scratches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  program_id uuid not null,
  entry_id uuid not null,
  request_id uuid not null,
  path text not null,
  locked_heat_ids uuid[] not null default '{}',
  policy_resolution text not null,
  requested_resolution text not null,
  is_exception boolean not null,
  reason text,
  previous_status text not null,
  performed_by uuid not null,
  performed_at timestamptz not null default now(),
  transaction_id bigint not null default txid_current(),
  constraint event_competition_scratches_entry_fk
    foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id) on delete cascade,
  constraint event_competition_scratches_program_fk
    foreign key (program_id, event_id) references public.event_competition_programs(id, event_id) on delete cascade,
  constraint event_competition_scratches_request_key unique (event_id, request_id),
  constraint event_competition_scratches_path_check check (path in ('normal', 'official_locked')),
  constraint event_competition_scratches_resolution_check
    check (policy_resolution in ('no_refund', 'credit', 'refund') and requested_resolution in ('no_refund', 'credit', 'refund')),
  constraint event_competition_scratches_reason_check
    check ((path = 'normal' and not is_exception) or nullif(btrim(coalesce(reason, '')), '') is not null),
  constraint event_competition_scratches_locked_check
    check ((path = 'official_locked') = (cardinality(locked_heat_ids) > 0))
);
create index event_competition_scratches_entry_idx on public.event_competition_scratches(entry_id, performed_at desc);
create index event_competition_scratches_txn_idx on public.event_competition_scratches(transaction_id, entry_id);

comment on table public.event_competition_scratches is
  'SC1 append-only scratch audit. A scratch never moves money: requested_resolution records what the organizer chose (refund/credit run as separate, separately authorized workflows). An official_locked row is the only authorization for scratching a placement in a locked heat in the same transaction.';

create function public._sc1_protect_scratches()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'SC1: event_competition_scratches is append-only.';
end;
$$;
revoke all on function public._sc1_protect_scratches() from public, anon, authenticated;
create trigger sc1_protect_scratches before update or delete on public.event_competition_scratches
  for each row execute function public._sc1_protect_scratches();

alter table public.event_competition_scratches enable row level security;
revoke all on public.event_competition_scratches from public, anon, authenticated, service_role;
grant select on public.event_competition_scratches to authenticated, service_role;
create policy event_competition_scratches_read on public.event_competition_scratches
  for select to authenticated using (public.can_manage_event_competition(event_id));

-- ---------------------------------------------------------------------------
-- 4. The scratch RPC
-- ---------------------------------------------------------------------------
create function public.scratch_competition_entry(
  p_entry_id uuid,
  p_request_id uuid,
  p_reason text default null,
  p_resolution text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_entry record;
  v_existing record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_policy text;
  v_resolution text;
  v_official boolean;
  v_locked uuid[];
  v_path text;
  v_exception boolean;
  v_id uuid;
begin
  if v_actor is null or p_entry_id is null or p_request_id is null then
    raise exception 'COMP_SC1_NOT_FOUND: entry was not found or cannot be managed.';
  end if;

  -- Authorize before taking any lock.
  select e.event_id into v_entry from public.event_competition_entries e where e.id = p_entry_id;
  if v_entry.event_id is null or not public.can_manage_event_competition(v_entry.event_id) then
    raise exception 'COMP_SC1_NOT_FOUND: entry was not found or cannot be managed.';
  end if;

  -- Lock order: entry, then its heats (FOR SHARE conflicts with set_competition_heat_lock_state's FOR UPDATE,
  -- so a concurrent lock/certify waits or we see its result), then its placements.
  select e.id, e.event_id, e.program_id, e.status into v_entry
  from public.event_competition_entries e where e.id = p_entry_id
  for update;
  perform 1 from public.event_competition_heats h
  where h.id in (select he.heat_id from public.event_competition_heat_entries he where he.entry_id = p_entry_id)
  order by h.id
  for share;
  perform 1 from public.event_competition_heat_entries he where he.entry_id = p_entry_id order by he.id for update;

  -- Idempotent replay of the same request.
  select s.id, s.entry_id into v_existing
  from public.event_competition_scratches s where s.event_id = v_entry.event_id and s.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.entry_id <> p_entry_id then
      raise exception 'COMP_SC1_REQUEST_REUSED: this request id was already used for another entry.';
    end if;
    return v_existing.id;
  end if;

  if v_entry.status in ('scratched', 'withdrawn') then
    raise exception 'COMP_SC1_ALREADY_SCRATCHED: this entry is already scratched.';
  end if;
  if v_entry.status not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'COMP_SC1_NOT_SCRATCHABLE: a % entry cannot be scratched.', v_entry.status;
  end if;

  -- Protected placements: certified heats and danced placements are results matters (K0 correction workflow).
  if exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
             where he.entry_id = p_entry_id and h.lock_state = 'certified' and he.status <> 'scratched') then
    raise exception 'COMP_SC1_CERTIFIED: this entry is in a certified heat; changes go through the results correction workflow.';
  end if;
  -- Danced: the placement says so, or its heat is on the floor / finished (placements are not yet marked
  -- danced anywhere, so the heat status is the authoritative signal).
  if exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
             where he.entry_id = p_entry_id
               and (he.status in ('danced', 'disqualified')
                    or (he.status <> 'scratched' and h.status in ('active', 'complete')))) then
    raise exception 'COMP_SC1_DANCED: this entry has already danced; changes go through the results correction workflow.';
  end if;

  select coalesce(array_agg(distinct he.heat_id), '{}') into v_locked
  from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
  where he.entry_id = p_entry_id and h.lock_state = 'locked' and he.status in ('scheduled', 'checked_in');

  v_official := public._paywh1_actor_can_manage_event(v_entry.event_id);
  v_policy := public._sc1_policy_for(v_entry.program_id);
  v_resolution := coalesce(nullif(btrim(coalesce(p_resolution, '')), ''), v_policy);
  if v_resolution not in ('no_refund', 'credit', 'refund') then
    raise exception 'COMP_SC1_RESOLUTION: choose No refund, Competition credit or Refund.';
  end if;
  if v_resolution = 'credit' then
    raise exception 'COMP_SC1_CREDIT_NOT_AVAILABLE: competition credit is not available yet; choose No refund or Refund.';
  end if;
  v_exception := v_resolution <> v_policy;
  v_path := case when cardinality(v_locked) > 0 then 'official_locked' else 'normal' end;

  if (v_exception or v_path = 'official_locked') and not v_official then
    raise exception 'COMP_SC1_OFFICIAL_REQUIRED: only a studio or organizer owner/admin can %.',
      case when v_path = 'official_locked' then 'scratch an entry in a locked heat' else 'override the scratch policy' end;
  end if;
  if (v_exception or v_path = 'official_locked') and v_reason is null then
    raise exception 'COMP_SC1_REASON_REQUIRED: a reason is required for this scratch.';
  end if;

  begin
    insert into public.event_competition_scratches (
      event_id, program_id, entry_id, request_id, path, locked_heat_ids, policy_resolution, requested_resolution,
      is_exception, reason, previous_status, performed_by
    ) values (
      v_entry.event_id, v_entry.program_id, p_entry_id, p_request_id, v_path, v_locked, v_policy, v_resolution,
      v_exception, v_reason, v_entry.status, v_actor
    ) returning id into v_id;
  exception when unique_violation then
    -- The same request id committed concurrently for another entry of this event.
    raise exception 'COMP_SC1_REQUEST_REUSED: this request id was already used for another entry.';
  end;

  -- Entry audit (event_competition_entry_changes) via the existing trigger. No money moves: always 'retain'.
  perform set_config('app.competition_entry_change_type', 'scratch', true);
  perform set_config('app.competition_entry_change_reason', coalesce(v_reason, 'Scratched'), true);
  perform set_config('app.competition_entry_fee_handling', 'retain', true);
  update public.event_competition_entries
  set status = 'scratched',
      scratched_at = now(),
      scratch_reason = v_reason,
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
  where id = p_entry_id;

  update public.event_competition_heat_entries
  set status = 'scratched', updated_at = now()
  where entry_id = p_entry_id and status in ('scheduled', 'checked_in');

  return v_id;
end;
$$;
revoke all on function public.scratch_competition_entry(uuid, uuid, text, text) from public, anon;
grant execute on function public.scratch_competition_entry(uuid, uuid, text, text) to authenticated;

comment on function public.scratch_competition_entry(uuid, uuid, text, text) is
  'SC1 scratch. Never moves money (fee_handling retain; no refund or credit is created or reserved). Policy default applies; a different resolution or a locked-heat scratch needs a studio/organizer owner/admin and a reason. Danced and certified placements refuse. Idempotent on (event, request id).';

-- ---------------------------------------------------------------------------
-- 5. Policy setters (the event's issuer only; every change is kept in competition_scratch_policy_changes)
-- ---------------------------------------------------------------------------
create function public.set_competition_scratch_policy(p_program_id uuid, p_resolution text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
  v_previous text;
begin
  select event_id into v_event from public.event_competition_programs where id = p_program_id;
  if v_event is null or not public._sc1_actor_owns_policy(v_event) then
    raise exception 'COMP_SC1_NOT_FOUND: program was not found or its scratch policy cannot be managed.';
  end if;
  if p_resolution is not null and p_resolution not in ('no_refund', 'refund') then
    raise exception 'COMP_SC1_RESOLUTION: the scratch policy default must be No refund or Refund.';
  end if;
  select default_resolution into v_previous from public.event_competition_scratch_policies where program_id = p_program_id for update;
  if v_previous is not distinct from p_resolution then
    return;
  end if;
  if p_resolution is null then
    delete from public.event_competition_scratch_policies where program_id = p_program_id;
  else
    insert into public.event_competition_scratch_policies (program_id, event_id, default_resolution, updated_by)
    values (p_program_id, v_event, p_resolution, auth.uid())
    on conflict (program_id) do update
      set default_resolution = excluded.default_resolution, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.competition_scratch_policy_changes (scope, event_id, program_id, previous_resolution, new_resolution, reason, changed_by)
  values ('program', v_event, p_program_id, v_previous, p_resolution, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid());
end;
$$;
revoke all on function public.set_competition_scratch_policy(uuid, text, text) from public, anon;
grant execute on function public.set_competition_scratch_policy(uuid, text, text) to authenticated;

-- Standard policy of the event's issuer (organizer when the event has one, else studio).
create function public.set_competition_scratch_policy_default(p_event_id uuid, p_resolution text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event record;
  v_previous text;
begin
  select id, studio_id, organizer_id into v_event from public.events where id = p_event_id;
  if v_event.id is null or not public._sc1_actor_owns_policy(p_event_id) then
    raise exception 'COMP_SC1_NOT_FOUND: event was not found or its scratch policy cannot be managed.';
  end if;
  if p_resolution is null or p_resolution not in ('no_refund', 'refund') then
    raise exception 'COMP_SC1_RESOLUTION: the scratch policy default must be No refund or Refund.';
  end if;
  if v_event.organizer_id is not null then
    select default_resolution into v_previous from public.competition_scratch_policy_defaults where organizer_id = v_event.organizer_id for update;
    if v_previous is not distinct from p_resolution then return; end if;
    insert into public.competition_scratch_policy_defaults (organizer_id, default_resolution, updated_by)
    values (v_event.organizer_id, p_resolution, auth.uid())
    on conflict (organizer_id) where organizer_id is not null do update
      set default_resolution = excluded.default_resolution, updated_by = excluded.updated_by, updated_at = now();
  else
    select default_resolution into v_previous from public.competition_scratch_policy_defaults where studio_id = v_event.studio_id for update;
    if v_previous is not distinct from p_resolution then return; end if;
    insert into public.competition_scratch_policy_defaults (studio_id, default_resolution, updated_by)
    values (v_event.studio_id, p_resolution, auth.uid())
    on conflict (studio_id) where studio_id is not null do update
      set default_resolution = excluded.default_resolution, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.competition_scratch_policy_changes (scope, event_id, studio_id, organizer_id, previous_resolution, new_resolution, reason, changed_by)
  values ('standard', p_event_id, case when v_event.organizer_id is null then v_event.studio_id end, v_event.organizer_id,
          v_previous, p_resolution, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid());
end;
$$;
revoke all on function public.set_competition_scratch_policy_default(uuid, text, text) from public, anon;
grant execute on function public.set_competition_scratch_policy_default(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Close the older write paths that would bypass SC1 (no app code uses them)
-- ---------------------------------------------------------------------------
-- The June lifecycle RPC (security invoker) let any manager scratch/withdraw with any fee_handling label and no
-- SC1 policy, official or audit. Scratching goes through scratch_competition_entry; R2 and the registration
-- trigger keep their own security definer paths.
revoke execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) from public, anon, authenticated;

-- API roles (direct PostgREST writes) cannot move an entry into or out of scratched / withdrawn, or scratch a
-- placement. Security definer workflows (SC1, R2, the registration trigger) run as the function owner and are
-- unaffected. Other direct edits (eligibility, entry number, check-in states) stay as they are.
create function public._sc1_guard_api_scratch_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_table_name = 'event_competition_entries'
       and new.status is distinct from old.status
       and (new.status in ('scratched', 'withdrawn') or old.status in ('scratched', 'withdrawn')) then
      raise exception 'COMP_SC1_USE_SCRATCH: scratch entries through the scratch workflow.' using errcode = '42501';
    end if;
    if tg_table_name = 'event_competition_heat_entries'
       and new.status is distinct from old.status
       and (new.status = 'scratched' or old.status = 'scratched') then
      raise exception 'COMP_SC1_USE_SCRATCH: scratch entries through the scratch workflow.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._sc1_guard_api_scratch_writes() from public, anon, authenticated;
create trigger sc1_guard_api_scratch_entries before update of status on public.event_competition_entries
  for each row execute function public._sc1_guard_api_scratch_writes();
create trigger sc1_guard_api_scratch_heat_entries before update of status on public.event_competition_heat_entries
  for each row execute function public._sc1_guard_api_scratch_writes();

-- ---------------------------------------------------------------------------
-- 6. Locked-heat guard: one narrow, ledger-authorized exception
-- ---------------------------------------------------------------------------
create or replace function public.protect_locked_competition_heat_children()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_heat_id uuid;
  selected_lock_state text;
begin
  selected_heat_id := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  select lock_state into selected_lock_state
  from public.event_competition_heats where id = selected_heat_id;
  if selected_lock_state in ('locked', 'certified') then
    -- SC1 (S-D2): an official scratch of a placement in a LOCKED heat, recorded in this transaction,
    -- may change that placement's status to scratched and nothing else.
    if selected_lock_state = 'locked'
      and tg_op = 'UPDATE'
      and tg_table_name = 'event_competition_heat_entries'
      and new.status = 'scratched'
      and old.status in ('scheduled', 'checked_in')
      and (to_jsonb(new) - array['status', 'updated_at']) = (to_jsonb(old) - array['status', 'updated_at'])
      and exists (
        select 1 from public.event_competition_scratches s
        where s.entry_id = (to_jsonb(new) ->> 'entry_id')::uuid
          and s.path = 'official_locked'
          and selected_heat_id = any (s.locked_heat_ids)
          and s.transaction_id = txid_current()
      ) then
      return new;
    end if;
    raise exception 'Locked or certified heat details require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

commit;
