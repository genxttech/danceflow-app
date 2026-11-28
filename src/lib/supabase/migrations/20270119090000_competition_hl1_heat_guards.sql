-- Competition HL1: database guards for early heat locks and heat reopen.
--
-- HL1 lets a manager lock a heat before it is danced (so an official scratch stays possible, SC1) and reopen a locked heat. Review
-- found that 10A's set_competition_heat_lock_state (shared with O1 and F2, NOT redefined here) checks only role, the certified guard
-- and the reopen reason. Two additive triggers plus one Lock ballots blocker close the gaps:
--
--   1. trigger hl1_guard_heat_reopen (BEFORE UPDATE OF lock_state on event_competition_heats), locked -> open only:
--        - refused when the round is ballots_locked or later (ballots_locked, calculated, approved, published, complete, cancelled)
--        - refused when the heat is danced (status active/complete, or an entry placement danced/disqualified: SC1's rule; draft/cancelled are not danced)
--        - takes the round row FOR SHARE first, which conflicts with lock_competition_round_ballots' FOR UPDATE, so a reopen and
--          Lock ballots serialize: whichever commits first decides, the other sees it.
--   2. trigger hl1_guard_heat_lock (same table), open -> locked refused while the heat is `active` (mid-dance; a lock would strand
--      it because O1 refuses COMPO1_HEAT_LOCKED), and a locked -> locked no-op through the RPC refused (it only adds audit noise).
--      Locks of scheduled, staging and complete heats are unchanged.
--   3. lock_competition_round_ballots gains one blocker: every ballot heat must be on the floor / finished or have a danced
--      placement (COMP_HL1_HEAT_NOT_DANCED). Without it an early lock of every undanced heat reached ballots_locked and the results
--      chain with no floor events at all. Redefined by text-replace on the installed E2 -> F2 -> NS1 -> SS1 body (pinned md5, CRs
--      removed); the rollback reverses the single insertion and verifies the restored pin.
--
-- Apply order: after 20270118090000, SQL before the app. Rollback: app first, then the rollback file.

begin;

do $$
declare
  v_def text;
  v_anchor constant text := E'  select coalesce(jsonb_agg(j.official_id), ''[]''::jsonb) into v_absent';
  v_pin constant text := 'a10fc61528af902c0d7fd0e00caaa155';
begin
  if to_regprocedure('public.set_competition_heat_lock_state(uuid,text,text)') is null
     or to_regprocedure('public.lock_competition_round_ballots(uuid,uuid)') is null
     or to_regprocedure('public._compe2_round_heats(uuid)') is null then
    raise exception 'HL1 preflight: 10A / E2 functions are missing.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_competition_rounds' and column_name = 'correction_open')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_heats'::regclass and tgname = 'compo1_guard_heat_status') then
    raise exception 'HL1 preflight: F2 / O1 are not applied.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_heats'::regclass and tgname in ('hl1_guard_heat_reopen', 'hl1_guard_heat_lock')) then
    raise exception 'HL1 preflight: the HL1 triggers already exist.';
  end if;
  v_def := replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '');
  if md5(v_def) <> v_pin then
    raise exception 'HL1 preflight: lock_competition_round_ballots differs from the pinned text (md5 %); coordinate before changing it.', md5(v_def);
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'HL1 preflight: lock_competition_round_ballots does not contain the insertion anchor exactly once.';
  end if;
end $$;

-- SC1's danced rule, one definition: the heat is on the floor or finished (active/complete), or one of its placements is danced /
-- disqualified. A draft or cancelled heat is not danced.
create function public._hl1_heat_is_danced(p_heat_id uuid, p_status text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_status, '') in ('active', 'complete')
      or exists (select 1 from public.event_competition_heat_entries he where he.heat_id = p_heat_id and he.status in ('danced', 'disqualified'));
$$;
revoke all on function public._hl1_heat_is_danced(uuid, text) from public, anon, authenticated;
grant execute on function public._hl1_heat_is_danced(uuid, text) to service_role;

create function public._hl1_guard_heat_reopen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round_status text;
begin
  if old.lock_state = 'locked' and new.lock_state = 'open' then
    -- Serialize with lock_competition_round_ballots (FOR UPDATE on the round row).
    select r.status into v_round_status from public.event_competition_rounds r where r.id = old.round_id for share;
    if v_round_status in ('ballots_locked', 'calculated', 'approved', 'published', 'complete', 'cancelled') then
      raise exception 'COMP_HL1_REOPEN_ROUND_LOCKED: the round is % and its ballots are locked; a heat cannot be reopened.', v_round_status using errcode = 'P0001';
    end if;
    if public._hl1_heat_is_danced(old.id, old.status) then
      raise exception 'COMP_HL1_REOPEN_DANCED: this heat has been danced; changes go through the results correction workflow.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._hl1_guard_heat_reopen() from public, anon, authenticated;

create function public._hl1_guard_heat_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.lock_state = 'open' and new.lock_state = 'locked' and old.status = 'active' then
    raise exception 'COMP_HL1_LOCK_ACTIVE: this heat is on the floor; finish it before locking.' using errcode = 'P0001';
  end if;
  -- set_competition_heat_lock_state records its event before the update, so a no-op transition has an event in this transaction.
  if old.lock_state = 'locked' and new.lock_state = 'locked'
     and exists (select 1 from public.event_competition_heat_lock_events le
                 where le.heat_id = old.id and le.from_state = 'locked' and le.to_state = 'locked' and le.transaction_id = txid_current()) then
    raise exception 'COMP_HL1_ALREADY_LOCKED: this heat is already locked.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._hl1_guard_heat_lock() from public, anon, authenticated;

create trigger hl1_guard_heat_reopen
  before update of lock_state on public.event_competition_heats
  for each row execute function public._hl1_guard_heat_reopen();
create trigger hl1_guard_heat_lock
  before update of lock_state, locked_at on public.event_competition_heats
  for each row execute function public._hl1_guard_heat_lock();

-- Lock ballots blocker (text-replace on the installed body).
do $$
declare
  v_def text := replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '');
  v_anchor constant text := E'  select coalesce(jsonb_agg(j.official_id), ''[]''::jsonb) into v_absent';
  v_new constant text :=
    E'  -- HL1: every ballot heat must have been danced (on the floor / finished, or a danced placement); an early heat lock alone is not enough.\n' ||
    E'  if exists (select 1 from public._compe2_round_heats(p_round_id) bh join public.event_competition_heats hh on hh.id = bh.heat_id\n' ||
    E'               where public._hl1_heat_is_danced(hh.id, hh.status) is not true) then\n' ||
    E'    raise exception ''COMP_HL1_HEAT_NOT_DANCED: every heat of the round must be danced before its ballots can be locked.'' using errcode = ''P0001'', detail = v_block::text;\n' ||
    E'  end if;\n\n';
begin
  execute replace(v_def, v_anchor, v_new || v_anchor);
end $$;

commit;
