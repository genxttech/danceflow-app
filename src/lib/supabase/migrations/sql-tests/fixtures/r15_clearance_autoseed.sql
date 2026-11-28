-- TEST-ONLY. ONE shared fixture for Competition suites and race scripts that seed couples as 'eligible' or 'waived' and then run them: it records the missing
-- clearance the way an organizer would, so the suite's own scenario runs under every R-15 guard. Never run it on DEV, PROD or any database that persists.
--
-- Install once per disposable database, AFTER the migrations, as the owner role, with the opt-in set in the same session:
--   set r15.install_test_autoseed = on;
--   \i fixtures/r15_clearance_autoseed.sql
-- Remove it with:  drop schema r15_testfixture cascade;
--
-- The whole file is one transaction: a refused opt-in installs nothing, with or without ON_ERROR_STOP.
--
-- What it does: when a participant row is written, or an entry is first placed in a heat, for an entry whose status is 'eligible' or 'waived' and that is not
-- cleared, it (1) adds one adult competitor as participant if the entry has none, then (2) calls public.set_competition_entry_eligibility as a studio
-- manager of the event, for the entry's CURRENT status with the required criteria.
-- A participant write also RENEWS a determination made stale by that roster change (suites build rosters one row at a time). A placement only records a FIRST
-- decision: a stale determination met at placement stays stale. Floor-state changes (check-in, danced) trigger nothing.
-- If an event has no studio manager at all, a throwaway fixture manager (address @r15-autoseed.test) is added for that one decision and removed again; the
-- determination keeps its id as actor.
-- What it never does: it disables, replaces or bypasses no guard; writes no determination row directly; changes no eligibility status; and touches no
-- 'unverified', 'needs_review' or 'ineligible' entry. A decision the database refuses (minor, unknown age, forbidden waiver, withdrawn entry) is left
-- refused, and the guard then stops the suite as it should. It needs the real S5 predicate.
-- Do NOT install it for suites that test eligibility itself (R-15, S5, OD-31 negative): they must see uncleared eligible entries.
-- Results of a suite run with it are labelled as such: it proves the suite's scenario for CLEARED couples, not that the suite exercises the clearance rules.

begin;

do $guard$
begin
  if coalesce(current_setting('r15.install_test_autoseed', true), '') <> 'on' then
    raise exception 'R15-AUTOSEED-REFUSED: set r15.install_test_autoseed = on to install this test-only fixture on a disposable database.';
  end if;
  if to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null
     or to_regprocedure('public._comp_participant_age_clearance(uuid)') is null then
    raise exception 'R15-AUTOSEED-REFUSED: apply 20270301110000 and 20270301120000 (the real S5 predicate) first.';
  end if;
end $guard$;

create schema r15_testfixture;

create function r15_testfixture.clear(p_entry uuid, p_renew boolean default false) returns void
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  e record;
  v_m record;
  v_comp uuid;
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_req text[];
  v_studio uuid;
  v_tmp uuid;
  v_found boolean := false;
begin
  select id, event_id, status, eligibility_status, display_name into e from public.event_competition_entries where id = p_entry;
  if not found or e.eligibility_status not in ('eligible', 'waived') or e.status not in ('pending', 'confirmed', 'waitlisted')
     or public._r15_entry_clearance_reason(p_entry) is null
     or (not p_renew and exists (select 1 from public.event_competition_eligibility_determinations d where d.entry_id = p_entry)) then
    return;
  end if;
  if not exists (select 1 from public.event_competition_entry_participants p where p.entry_id = p_entry) then
    insert into public.event_competition_competitors (event_id, studio_id, first_name, last_name, created_via, date_of_birth)
    values (e.event_id, (select ev.studio_id from public.events ev where ev.id = e.event_id), 'Fixture', 'Adult ' || e.id, 'staff', date '1985-06-15')
    returning id into v_comp;
    insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, display_name)
    values (e.event_id, e.id, v_comp, 'dancer', e.display_name);
    if public._r15_entry_clearance_reason(p_entry) is null then
      return;   -- the participant insert above already re-entered this function and recorded the decision
    end if;
  end if;
  v_req := public._r15_required_criteria(p_entry);
  for v_m in
    select r.user_id from public.user_studio_roles r join public.events ev on ev.studio_id = r.studio_id
    where ev.id = e.event_id and r.active order by r.role desc, r.user_id
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_m.user_id, 'role', 'authenticated')::text, true);
    v_found := public.can_manage_event_competition(e.event_id);
    exit when v_found;
  end loop;
  -- Some suites test predicates only and seed no manager at all. A fixture manager is then added for this one decision and removed again.
  if not v_found then
    select ev.studio_id into v_studio from public.events ev where ev.id = e.event_id;
    v_tmp := gen_random_uuid();
    insert into auth.users (id, email) values (v_tmp, v_tmp || '@r15-autoseed.test');
    insert into public.profiles (id, email, full_name) values (v_tmp, v_tmp || '@r15-autoseed.test', 'R15 autoseed fixture manager') on conflict (id) do nothing;
    insert into public.user_studio_roles (user_id, studio_id, role, active) values (v_tmp, v_studio, 'studio_owner', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_tmp, 'role', 'authenticated')::text, true);
  end if;
  begin
    perform public.set_competition_entry_eligibility(
      p_entry, e.eligibility_status,
      case e.eligibility_status when 'eligible' then 'criteria_verified_by_organizer' else 'waiver_event_policy_scheduling' end,
      case e.eligibility_status when 'eligible' then v_req else '{}'::text[] end,
      gen_random_uuid());
  -- only the function's own refusals are tolerated; lock, serialization and every other error propagates to the suite
  exception when check_violation or insufficient_privilege then
    raise notice 'R15 autoseed: the database refused clearance for one entry (%); the guards decide.', sqlstate;
  end;
  if v_tmp is not null then
    -- the management right must go; the throwaway account itself is removed where the database allows it
    begin
      delete from public.user_studio_roles where user_id = v_tmp;
    exception when others then
      update public.user_studio_roles set active = false where user_id = v_tmp;
    end;
    begin
      delete from public.profiles where id = v_tmp;
      delete from auth.users where id = v_tmp;
    exception when others then
      raise notice 'R15 autoseed: a throwaway fixture account was left behind (%).', sqlstate;
    end;
  end if;
  perform set_config('request.jwt.claims', v_claims, true);
end $f$;
revoke all on function r15_testfixture.clear(uuid, boolean) from public;

-- For entries that are neither placed nor given participants by the suite: clear every eligible/waived entry (of one event, or all).
create function r15_testfixture.clear_all(p_event uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in select id from public.event_competition_entries where eligibility_status in ('eligible', 'waived') and (p_event is null or event_id = p_event) order by id loop
    perform r15_testfixture.clear(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $f$;
revoke all on function r15_testfixture.clear_all(uuid) from public;

create function r15_testfixture.on_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  perform r15_testfixture.clear(new.entry_id, tg_table_name = 'event_competition_entry_participants');
  return new;
end $f$;
revoke all on function r15_testfixture.on_write() from public;

-- BEFORE the placement guard (BEFORE triggers fire alphabetically; 'a00_' sorts first). AFTER the participant row, so the fingerprint includes it.
create trigger a00_r15_test_autoseed before insert or update of entry_id, heat_id on public.event_competition_heat_entries
  for each row execute function r15_testfixture.on_write();
alter table public.event_competition_heat_entries enable always trigger a00_r15_test_autoseed;
create trigger zz_r15_test_autoseed after insert or update on public.event_competition_entry_participants
  for each row execute function r15_testfixture.on_write();
alter table public.event_competition_entry_participants enable always trigger zz_r15_test_autoseed;

commit;
