-- Competition NS1: heat no-shows (K1 X-5: scratched AND no-show entries are excluded from calculation, never placed last).
--
-- Stacks on E2 (20270102090000), O1 (20270106090000), REG (20270113090000) and F2 (20270114090000, whose evidence reads
-- competition_heat_no_show_entries(round) when it exists). Git-only until applied by the owner.
--
-- Record. Two append-only tables (the history-protection trigger blocks UPDATE, so a void is its own row):
--   event_competition_heat_no_shows        one row per mark (heat entry, entry, reason, actor, time, request id)
--   event_competition_heat_no_show_voids   at most one void per mark (reason, actor, time, request id)
-- A no-show is ACTIVE while its mark has no void. A heat entry can be marked again after a void (a new mark row).
--
-- RPCs (SECURITY DEFINER, tenant-checked, idempotent by request id, authenticated only):
--   mark_competition_heat_no_show(heat_entry_id, reason, request_id)
--   void_competition_heat_no_show(heat_entry_id, reason, request_id)
--   competition_round_no_shows(round_id)           read for officials and the round's panel judges
--   competition_round_floor_entries(round_id)      floor view (heats, entries, no-show state, window) for manager | chair; the ballot desk uses it
-- Authority = E2's lock authority (_compe2_round_role in manager | chair). Window: heat `active` or `complete`, round `active`
-- (ballots open). After ballots_locked (and during an F2 correction, which is a ballots_locked round) the correction path applies.
-- Refused for scratched / danced / disqualified entries. The round row is locked FOR UPDATE, so a mark/void serializes with lock
-- (which also locks the round FOR UPDATE) and with ballot submits (which share-lock it).
--
-- Internal readers (no API grants; F2 and E2 definer functions call them):
--   competition_heat_entry_is_no_show(heat_entry_id) boolean         per heat entry
--   competition_heat_no_show_entries(round_id) table(entry_id)       entries that are no-show in EVERY non-scratched heat entry of
--                                                                    the round (the F2 hook; same rule as _compe2_round_entries)
--
-- E2 redefinition (exact md5 pins of pg_get_functiondef with CRs removed, taken after F2 20270114; rollback restores them exactly).
-- In each function the single text  he.status <> 'scratched'  becomes
--   he.status <> 'scratched' and not public.competition_heat_entry_is_no_show(he.id)
--   _compe2_round_heats(uuid)         a heat needs an entry that is neither scratched nor no-show to be a ballot heat
--   _compe2_heat_entries(uuid)        the REQUIRED RANKING SET of a heat (D-OM-5: full 1..N over these)
--   _compe2_round_entries(uuid)       the callback ELIGIBLE set (D-CT-2: exactly T of these; T >= count => not danced)
--   _compe2_guard_mark_insert()       a mark for a no-show entry is refused (defence in depth)
--   competition_round_ballot_status(uuid), competition_judge_ballot_sheet(uuid)   no-show entries leave the judge forms
-- Stale rule (E2 _compe2_round_blockers, NOT edited): a current ballot is stale when its mark count differs from
-- _compe2_heat_entries, or one of its marks is not in that set, or (callback) its count differs from T / marks outside
-- _compe2_round_entries. A no-show marked after a judge submitted therefore makes that ballot stale and lock refuses
-- (COMP_BALLOTS_STALE) until the judge/scorer submits a corrected ballot version. A void works the same way in reverse
-- (the entry returns to the required set; the old ballot lacks its mark and is stale). Fails closed.
--
-- Rollback: rollback/20270115090000_competition_ns1_heat_no_shows_rollback.sql (refuses while any no-show row exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_heat_no_shows') is not null
     or to_regclass('public.event_competition_heat_no_show_voids') is not null
     or to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is not null then
    raise exception 'NS1 preflight: an NS1 table or function already exists (roll back or clean up a partial earlier run first).';
  end if;
  if to_regclass('public.event_competition_ballots') is null
     or to_regprocedure('public._compe2_round_role(uuid)') is null
     or to_regprocedure('public._compe2_round_heats(uuid)') is null
     or to_regprocedure('public._compe2_heat_entries(uuid)') is null
     or to_regprocedure('public._compe2_round_entries(uuid)') is null
     or to_regprocedure('public._compe2_guard_mark_insert()') is null
     or to_regprocedure('public.competition_round_ballot_status(uuid)') is null
     or to_regprocedure('public.competition_judge_ballot_sheet(uuid)') is null then
    raise exception 'NS1 preflight: E2 ballots (20270102) are missing.';
  end if;
  if to_regprocedure('public._compo1_guard_heat_status()') is null then
    raise exception 'NS1 preflight: O1 day-of (20270106) is missing.';
  end if;
  if to_regprocedure('public.protect_competition_history_evidence()') is null then
    raise exception 'NS1 preflight: 10A competition authority is missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.event_competition_heat_no_shows (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  heat_id uuid not null,
  heat_entry_id uuid not null references public.event_competition_heat_entries(id),
  entry_id uuid not null,
  reason text not null,
  marked_by uuid not null,
  marked_at timestamptz not null default now(),
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_heat_no_shows_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_heat_no_shows_reason_check check (length(btrim(reason)) between 1 and 500),
  unique (request_id)
);
create index event_competition_heat_no_shows_he_idx on public.event_competition_heat_no_shows(heat_entry_id);
create index event_competition_heat_no_shows_round_idx on public.event_competition_heat_no_shows(round_id);

create table public.event_competition_heat_no_show_voids (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  no_show_id uuid not null references public.event_competition_heat_no_shows(id),
  reason text not null,
  voided_by uuid not null,
  voided_at timestamptz not null default now(),
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_heat_no_show_voids_reason_check check (length(btrim(reason)) between 1 and 500),
  unique (no_show_id),
  unique (request_id)
);

comment on table public.event_competition_heat_no_shows is
  'NS1: append-only record of heat no-shows (K1 X-5). Written only by mark_competition_heat_no_show. Active while no void row exists.';
comment on table public.event_competition_heat_no_show_voids is
  'NS1: append-only audited void of a no-show mark. Written only by void_competition_heat_no_show.';

do $$
declare
  t text;
begin
  foreach t in array array['event_competition_heat_no_shows', 'event_competition_heat_no_show_voids'] loop
    execute format('create trigger protect_%1$s_history before update or delete on public.%1$I
                    for each row execute function public.protect_competition_history_evidence()', t);
    execute format('create trigger protect_%1$s_history_truncate before truncate on public.%1$I
                    for each statement execute function public.protect_competition_history_evidence()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Internal readers
-- ---------------------------------------------------------------------------
create function public.competition_heat_entry_is_no_show(p_heat_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_competition_heat_no_shows n
                 where n.heat_entry_id = p_heat_entry_id
                   and not exists (select 1 from public.event_competition_heat_no_show_voids v where v.no_show_id = n.id));
$$;
revoke all on function public.competition_heat_entry_is_no_show(uuid) from public, anon, authenticated, service_role;

-- Entries with an active no-show in some heat of the round and no other heat entry in the round that is neither scratched nor
-- no-show. Heats are the round's non-cancelled heats in a published / live schedule version (as E2's _compe2_round_heats, but
-- WITHOUT its entry requirement, so a heat whose only entries are no-shows still reports them).
create function public.competition_heat_no_show_entries(p_round_id uuid)
returns table(entry_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with rh as (
    select h.id
    from public.event_competition_heats h
    where h.round_id = p_round_id and h.status <> 'cancelled'
      and exists (select 1 from public.event_competition_schedule_versions v
                  where v.id = h.schedule_version_id and v.event_id = h.event_id and v.status in ('published', 'live'))
  )
  select distinct he.entry_id
  from public.event_competition_heat_entries he
  where he.heat_id in (select id from rh)
    and public.competition_heat_entry_is_no_show(he.id)
    and not exists (select 1 from public.event_competition_heat_entries he2
                    where he2.entry_id = he.entry_id and he2.heat_id in (select id from rh)
                      and he2.status <> 'scratched' and not public.competition_heat_entry_is_no_show(he2.id));
$$;
revoke all on function public.competition_heat_no_show_entries(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. E2 redefinitions (pinned)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
  v_old constant text := 'he.status <> ''scratched''';
  v_new constant text := 'he.status <> ''scratched'' and not public.competition_heat_entry_is_no_show(he.id)';
begin
  for r in select * from (values
    ('public._compe2_round_heats(uuid)', '588b53f7e7662cb0df46554310312426'),
    ('public._compe2_heat_entries(uuid)', '280a98ecd18f3cac6a332312dae4c8f8'),
    ('public._compe2_round_entries(uuid)', '5733a9f338621b983a0b771570ad4833'),
    ('public._compe2_guard_mark_insert()', '007fd7de4aa3dd6ca1ba25962b6f3b61'),
    ('public.competition_round_ballot_status(uuid)', '6ed6628d3da9444ec24d25c36fd1d4c2'),
    ('public.competition_judge_ballot_sheet(uuid)', 'f89262a01859317442be13c8d6be0239')
  ) as t(sig, pin) loop
    v_def := replace(pg_get_functiondef(r.sig::regprocedure), E'\r', '');
    if md5(v_def) <> r.pin then
      raise exception 'NS1 preflight: % differs from the pinned E2/F2 text (md5 %); coordinate before changing it.', r.sig, md5(v_def);
    end if;
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
      raise exception 'NS1 preflight: % does not contain the expected scratched condition exactly once.', r.sig;
    end if;
    execute replace(v_def, v_old, v_new);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------------
create function public.mark_competition_heat_no_show(p_heat_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_he public.event_competition_heat_entries;
  v_heat public.event_competition_heats;
  v_round public.event_competition_rounds;
  v_role text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev public.event_competition_heat_no_shows;
  v_row public.event_competition_heat_no_shows;
begin
  if v_uid is null or p_heat_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_he from public.event_competition_heat_entries he where he.id = p_heat_entry_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_heat from public.event_competition_heats h where h.id = v_he.heat_id and h.event_id = v_he.event_id;
  if not found or v_heat.round_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_role := public._compe2_round_role(v_heat.round_id);
  if coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'COMP_NO_SHOW_REASON_REQUIRED: a no-show needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;

  -- Serializes with lock (FOR UPDATE), reopen and ballot submits (FOR SHARE).
  select * into v_round from public.event_competition_rounds r where r.id = v_heat.round_id for update;

  select * into v_prev from public.event_competition_heat_no_shows n where n.request_id = p_request_id;
  if found then
    if v_prev.marked_by = v_uid and v_prev.heat_entry_id = p_heat_entry_id and v_prev.reason = v_reason then
      return jsonb_build_object('replayed', true, 'no_show_id', v_prev.id, 'heat_entry_id', p_heat_entry_id);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_heat_no_show_voids v where v.request_id = p_request_id) then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'active' then
    raise exception 'COMP_NO_SHOW_WINDOW: a no-show can be recorded only while the round is active and its ballots are open (round is %); after lock a manager must reopen the ballots first.', v_round.status
      using errcode = 'P0001';
  end if;
  -- No heat lock: the {active, complete} window has no exit (O1 cancels only draft/scheduled heats) and locking the heat after the round
  -- would deadlock with advance_competition_floor_heat (heat FOR UPDATE, then round FOR KEY SHARE).
  select * into v_heat from public.event_competition_heats h where h.id = v_he.heat_id;
  if v_heat.status not in ('active', 'complete') then
    raise exception 'COMP_NO_SHOW_WINDOW: a no-show can be recorded only for an active or complete heat (heat is %).', v_heat.status using errcode = 'P0001';
  end if;
  select * into v_he from public.event_competition_heat_entries he where he.id = p_heat_entry_id for update;
  if v_he.status in ('scratched', 'danced', 'disqualified') then
    raise exception 'COMP_NO_SHOW_ENTRY_STATE: a % entry cannot be marked no-show.', v_he.status using errcode = 'P0001';
  end if;
  if public.competition_heat_entry_is_no_show(p_heat_entry_id) then
    raise exception 'COMP_NO_SHOW_ALREADY: this entry is already marked no-show.' using errcode = 'P0001';
  end if;

  insert into public.event_competition_heat_no_shows(event_id, round_id, heat_id, heat_entry_id, entry_id, reason, marked_by, request_id)
  values (v_he.event_id, v_round.id, v_he.heat_id, v_he.id, v_he.entry_id, v_reason, v_uid, p_request_id)
  returning * into v_row;
  return jsonb_build_object('replayed', false, 'no_show_id', v_row.id, 'heat_entry_id', p_heat_entry_id);
end;
$$;

create function public.void_competition_heat_no_show(p_heat_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_he public.event_competition_heat_entries;
  v_heat public.event_competition_heats;
  v_round public.event_competition_rounds;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev public.event_competition_heat_no_show_voids;
  v_mark public.event_competition_heat_no_shows;
  v_row public.event_competition_heat_no_show_voids;
begin
  if v_uid is null or p_heat_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_he from public.event_competition_heat_entries he where he.id = p_heat_entry_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_heat from public.event_competition_heats h where h.id = v_he.heat_id and h.event_id = v_he.event_id;
  if not found or v_heat.round_id is null
     or coalesce(public._compe2_round_role(v_heat.round_id), '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'COMP_NO_SHOW_REASON_REQUIRED: voiding a no-show needs a reason (1-500 characters).' using errcode = 'P0001';
  end if;

  select * into v_round from public.event_competition_rounds r where r.id = v_heat.round_id for update;

  select * into v_prev from public.event_competition_heat_no_show_voids v where v.request_id = p_request_id;
  if found then
    select * into v_mark from public.event_competition_heat_no_shows n where n.id = v_prev.no_show_id;
    if v_prev.voided_by = v_uid and v_mark.heat_entry_id = p_heat_entry_id and v_prev.reason = v_reason then
      return jsonb_build_object('replayed', true, 'void_id', v_prev.id, 'heat_entry_id', p_heat_entry_id);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_heat_no_shows n where n.request_id = p_request_id) then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'active' then
    raise exception 'COMP_NO_SHOW_WINDOW: a no-show can be voided only while the round is active and its ballots are open (round is %); after lock a manager must reopen the ballots first.', v_round.status
      using errcode = 'P0001';
  end if;
  -- No heat lock: the {active, complete} window has no exit (O1 cancels only draft/scheduled heats) and locking the heat after the round
  -- would deadlock with advance_competition_floor_heat (heat FOR UPDATE, then round FOR KEY SHARE).
  select * into v_heat from public.event_competition_heats h where h.id = v_he.heat_id;
  if v_heat.status not in ('active', 'complete') then
    raise exception 'COMP_NO_SHOW_WINDOW: a no-show can be voided only for an active or complete heat (heat is %).', v_heat.status using errcode = 'P0001';
  end if;
  perform 1 from public.event_competition_heat_entries he where he.id = p_heat_entry_id for update;
  select * into v_mark from public.event_competition_heat_no_shows n
   where n.heat_entry_id = p_heat_entry_id
     and not exists (select 1 from public.event_competition_heat_no_show_voids v where v.no_show_id = n.id);
  if not found then
    raise exception 'COMP_NO_SHOW_NOT_FOUND: this heat entry has no active no-show.' using errcode = 'P0001';
  end if;
  insert into public.event_competition_heat_no_show_voids(event_id, no_show_id, reason, voided_by, request_id)
  values (v_mark.event_id, v_mark.id, v_reason, v_uid, p_request_id)
  returning * into v_row;
  return jsonb_build_object('replayed', false, 'void_id', v_row.id, 'no_show_id', v_mark.id, 'heat_entry_id', p_heat_entry_id);
end;
$$;

-- Read for officials (manager / chair / assigned scorer) and the round's panel judges: every no-show of the round with its state.
create function public.competition_round_no_shows(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid;
begin
  if v_uid is null or p_round_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select r.event_id into v_event from public.event_competition_rounds r where r.id = p_round_id;
  if v_event is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public._compe2_round_role(p_round_id) is null
     and not exists (select 1 from public.event_competition_officials o
                     join public.event_competition_panel_assignments a on a.official_id = o.id and a.event_id = o.event_id
                     where o.event_id = v_event and o.user_id = v_uid and o.status = 'active'
                       and o.role in ('judge', 'chair') and a.round_id = p_round_id and a.judge_letter is not null) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'no_show_id', n.id, 'heat_id', n.heat_id, 'heat_number', h.heat_number, 'heat_entry_id', n.heat_entry_id, 'entry_id', n.entry_id,
      'entry_number', e.entry_number, 'display_name', e.display_name,
      'reason', n.reason, 'marked_at', n.marked_at,
      'voided', v.id is not null, 'void_reason', v.reason, 'voided_at', v.voided_at)
      order by n.marked_at, n.id)
    from public.event_competition_heat_no_shows n
    left join public.event_competition_heat_no_show_voids v on v.no_show_id = n.id
    join public.event_competition_heats h on h.id = n.heat_id
    join public.event_competition_entries e on e.id = n.entry_id and e.event_id = n.event_id
    where n.round_id = p_round_id), '[]'::jsonb);
end;
$$;

-- Floor view for the officials who can mark (manager | chair): every heat of the round with its entries, no-show state and whether the
-- no-show window is open. Needed because the E2 board hides no-shows and carries no heat entry ids. Chairs reach it from the ballot desk.
create function public.competition_round_floor_entries(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
begin
  if auth.uid() is null or p_round_id is null or coalesce(public._compe2_round_role(p_round_id), '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  return jsonb_build_object(
    'round_status', v_round.status,
    'heats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'heat_id', h.id, 'heat_number', h.heat_number, 'heat_status', h.status,
        'window_open', v_round.status = 'active' and h.status in ('active', 'complete'),
        'entries', coalesce((
          select jsonb_agg(jsonb_build_object(
            'heat_entry_id', he.id, 'entry_id', e.id, 'entry_number', e.entry_number, 'display_name', e.display_name, 'status', he.status,
            'no_show', public.competition_heat_entry_is_no_show(he.id),
            'no_show_reason', (select n.reason from public.event_competition_heat_no_shows n
                               where n.heat_entry_id = he.id
                                 and not exists (select 1 from public.event_competition_heat_no_show_voids v where v.no_show_id = n.id)
                               order by n.marked_at desc limit 1))
            order by he.floor_order, e.entry_number, e.id)
          from public.event_competition_heat_entries he
          join public.event_competition_entries e on e.id = he.entry_id and e.event_id = he.event_id
          where he.heat_id = h.id), '[]'::jsonb))
        order by h.heat_number)
      from public.event_competition_heats h
      where h.round_id = p_round_id and h.status <> 'cancelled'
        and exists (select 1 from public.event_competition_schedule_versions sv
                    where sv.id = h.schedule_version_id and sv.event_id = h.event_id and sv.status in ('published', 'live'))), '[]'::jsonb));
end;
$$;

revoke all on function public.mark_competition_heat_no_show(uuid, text, uuid) from public, anon;
revoke all on function public.void_competition_heat_no_show(uuid, text, uuid) from public, anon;
revoke all on function public.competition_round_no_shows(uuid) from public, anon;
revoke all on function public.competition_round_floor_entries(uuid) from public, anon;
grant execute on function public.mark_competition_heat_no_show(uuid, text, uuid) to authenticated;
grant execute on function public.void_competition_heat_no_show(uuid, text, uuid) to authenticated;
grant execute on function public.competition_round_no_shows(uuid) to authenticated;
grant execute on function public.competition_round_floor_entries(uuid) to authenticated;

commit;
