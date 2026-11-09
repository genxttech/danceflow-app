-- Competition CF1 A0 review fixes (independent security review of PR #370, P2-1, P2-2, P3-3). Stacked on 20270120090000 (A0 migration is unchanged, its md5 pin is untouched).
--   P2-1  cf1_guard_final_heat_entry: DELETE of a roster row of an advanced Final heat is refused unless apply / revoke / cancel is running or the heat/event is already gone (cascade).
--         cf1_guard_final_heat_dance: when heat_id changes, the OLD heat's round is checked too.
--   P2-2  _cf1_revoke_advancement: no coalesce(auth.uid(), applied_by); a null actor fails closed (COMP_ADVANCEMENT_REVOKE_ACTOR_REQUIRED).
--   P3-3  set_competition_round_heat_capacity: a replayed request id must also carry the same reason, otherwise COMP_REQUEST_REUSED (exact-fragment replace, compatible with A4a in either order).
-- create or replace keeps owner, ACL and the ENABLE ALWAYS triggers; the entry trigger is re-created to add DELETE.
-- Rollback restores the A0 bodies (rollback/20270120101000_..._rollback.sql).

begin;

do $$
declare
  v_def text;
  v_old constant text := 'and v_prev.new_capacity = p_capacity then';
  v_new constant text := 'and v_prev.new_capacity = p_capacity and v_prev.reason = v_reason then';
begin
  v_def := pg_get_functiondef('public.set_competition_round_heat_capacity(uuid,integer,text,uuid)'::regprocedure);
  if position(v_old in v_def) = 0 or position(v_new in v_def) > 0 then
    raise exception 'CF1-A0 review fixes preflight: the capacity RPC replay fragment is missing or already replaced.';
  end if;
  -- Exact-fragment replace (like A4a), not a whole-body redefinition: A4a replaces other fragments of the same function in either order.
  v_def := replace(v_def, v_old, v_new);
  if position(v_new in v_def) = 0 then
    raise exception 'CF1-A0 review fixes: the replay replacement failed.';
  end if;
  execute v_def;
end $$;

create or replace function public.cf1_guard_final_heat_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round uuid;
  v_old_round uuid;
begin
  if tg_op = 'DELETE' then
    -- Review P2-1: a roster row of an advanced Final heat is removed only by apply / revoke / cancel, or when the heat (or event) is already gone (cascade).
    if not exists (select 1 from public.event_competition_heats h where h.id = old.heat_id)
       or not exists (select 1 from public.events ev where ev.id = old.event_id) then
      return old;
    end if;
    select h.round_id into v_old_round from public.event_competition_heats h where h.id = old.heat_id;
    if v_old_round is not null and public._cf1_has_advancement(v_old_round)
       and not (public._cf1_auth_apply(v_old_round) or public._cf1_auth_revoke(v_old_round) or public._cf1_auth_cancel(v_old_round)) then
      raise exception 'COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: a roster row of an advanced Final heat is removed only by the correction path or a round cancel.' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.heat_id = new.heat_id and old.entry_id = new.entry_id then
    return new;
  end if;
  select h.round_id into v_round from public.event_competition_heats h where h.id = new.heat_id;
  if v_round is not null and (public._cf1_has_advancement(v_round) or public._cf1_is_callback_final(v_round)) then
    if not public._cf1_auth_apply(v_round)
       or not exists (select 1 from public.event_competition_round_advancement_entries ae
                      join public.event_competition_round_advancements a on a.id = ae.advancement_id
                      where a.target_round_id = v_round and a.transaction_id = txid_current()
                        and ae.entry_id = new.entry_id and ae.carried_withdrawal_id is null) then
      raise exception 'COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: the roster of a callback Final is written only by apply_competition_round_advancement, from the advanced list.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.heat_id is distinct from new.heat_id then
    select h.round_id into v_old_round from public.event_competition_heats h where h.id = old.heat_id;
    if v_old_round is not null and (public._cf1_has_advancement(v_old_round) or public._cf1_is_callback_final(v_old_round))
       and not public._cf1_auth_apply(v_old_round) then
      raise exception 'COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: a roster row of a callback Final cannot be moved out.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.cf1_guard_final_heat_dance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_heat uuid := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  v_round uuid;
  v_old_round uuid;
begin
  if tg_op = 'UPDATE' and old.heat_id is distinct from new.heat_id then
    -- Review P2-1: moving a dance slot out of an advanced Final heat is checked against the OLD heat's round as well.
    select h.round_id into v_old_round from public.event_competition_heats h where h.id = old.heat_id;
    if v_old_round is not null and public._cf1_has_advancement(v_old_round)
       and not (public._cf1_auth_apply(v_old_round) or public._cf1_auth_revoke(v_old_round) or public._cf1_auth_cancel(v_old_round)) then
      raise exception 'COMP_ADVANCEMENT_FINAL_DANCE_WRITER: a dance slot of an advanced Final heat cannot be moved out.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.heat_id = new.heat_id and old.dance_id is not distinct from new.dance_id then
    if (old.status, old.sequence_number, old.dance_key) is not distinct from (new.status, new.sequence_number, new.dance_key) then
      return new;
    end if;
    -- status / order / key of a dance slot of an advanced Final heat: apply, the correction path or a round cancel only
    select h.round_id into v_round from public.event_competition_heats h where h.id = v_heat;
    if v_round is not null and public._cf1_has_advancement(v_round)
       and not (public._cf1_auth_apply(v_round) or public._cf1_auth_revoke(v_round) or public._cf1_auth_cancel(v_round)) then
      raise exception 'COMP_ADVANCEMENT_FINAL_DANCE_WRITER: the dances of an advanced Final heat are changed only by apply_competition_round_advancement or the correction path.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and (not exists (select 1 from public.events e where e.id = old.event_id)
                           or not exists (select 1 from public.event_competition_heats h where h.id = old.heat_id)) then
    return old;
  end if;
  select h.round_id into v_round from public.event_competition_heats h where h.id = v_heat;
  if v_round is not null and public._cf1_has_advancement(v_round) and not public._cf1_auth_apply(v_round) then
    raise exception 'COMP_ADVANCEMENT_FINAL_DANCE_WRITER: the dances of an advanced Final heat are written only by apply_competition_round_advancement.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public._cf1_revoke_advancement(p_source_round_id uuid, p_reason text, p_cause text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.event_competition_round_advancements;
  v_id uuid;
  v_actor uuid;
  v_heats uuid[];
  v_corr uuid;
begin
  select * into v_a from public.event_competition_round_advancements a
  where a.source_round_id = p_source_round_id
    and not exists (select 1 from public.event_competition_round_advancement_revocations r where r.advancement_id = a.id)
  order by a.generation desc limit 1;
  if not found then
    return null;
  end if;
  begin
    select coalesce(array_agg(h.id order by h.id), '{}') into v_heats from (
      select h2.id from public.event_competition_heats h2 where h2.round_id = v_a.target_round_id and h2.status <> 'cancelled' order by h2.id for update nowait) h;
  exception when lock_not_available then
    raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: a Final heat is being changed; the correction was not opened. Try again.' using errcode = '55P03';
  end;
  -- Fail closed: a revocation is attributed to the person who opened the correction. No fallback to the applier (review P2-2).
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'COMP_ADVANCEMENT_REVOKE_ACTOR_REQUIRED: a correction that revokes an advancement needs an authenticated actor.' using errcode = '42501';
  end if;
  select e.request_id into v_corr from public.event_competition_result_events e
  where e.round_id = p_source_round_id and e.transaction_id = txid_current() and e.kind = 'round_state_changed' and e.to_state = 'ballots_locked'
    -- INT5-SECFIX-3: only the correction-opening edge (from a calculated / approved / published round); the normal lock (active) and a U66 recovery (ballots_locked) never qualify.
    and e.from_state in ('calculated', 'approved', 'published')
  order by e.occurred_at desc, e.id limit 1;
  insert into public.event_competition_round_advancement_revocations (advancement_id, event_id, revoked_by, reason, cause, request_id)
  values (v_a.id, v_a.event_id, v_actor, left(coalesce(nullif(btrim(p_reason), ''), 'correction opened'), 500), p_cause, gen_random_uuid())
  returning id into v_id;
  update public.event_competition_heats set status = 'cancelled', updated_at = now()
  where id = any (v_heats);
  perform public._compf2_event(v_a.event_id, p_source_round_id, v_a.source_result_version_id, 'advancement_revoked', v_actor, null, null, gen_random_uuid(),
    left(nullif(btrim(p_reason), ''), 500),
    jsonb_build_object('advancement_id', v_a.id, 'generation', v_a.generation, 'source_result_version_id', v_a.source_result_version_id,
                       'entry_count', v_a.advanced_count, 'heat_ids', to_jsonb(v_heats), 'request_id', v_corr, 'cause', p_cause));
  return v_id;
end;
$$;

drop trigger cf1_guard_final_heat_entry on public.event_competition_heat_entries;
create trigger cf1_guard_final_heat_entry before insert or update of heat_id, entry_id or delete on public.event_competition_heat_entries
  for each row execute function public.cf1_guard_final_heat_entry();
alter table public.event_competition_heat_entries enable always trigger cf1_guard_final_heat_entry;

do $$
begin
  if not exists (select 1 from pg_trigger t where t.tgname = 'cf1_guard_final_heat_entry' and not t.tgisinternal and t.tgenabled = 'A' and (t.tgtype & 8) <> 0) then
    raise exception 'CF1-A0 review fixes postflight: cf1_guard_final_heat_entry is missing, not ENABLE ALWAYS or has no DELETE event.';
  end if;
end $$;

commit;
