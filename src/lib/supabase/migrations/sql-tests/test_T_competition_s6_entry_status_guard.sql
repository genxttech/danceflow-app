-- Competition S6 -- event_competition_entries guard (20270301141000) and the lifecycle RPC (20270301140000).
-- Run as a SUPERUSER (supabase_admin) on a database carrying the chain through BOTH S6 migrations. One transaction, synthetic fixtures (UUID block ...-cf1032XXXXXX), rolled back.
-- Callers are simulated with SET LOCAL ROLE (anon, authenticated with a manager JWT claim, service_role, and a probe role that is a member of authenticated): this reproduces table
-- privileges, RLS and trigger behaviour but is NOT an HTTP/PostgREST request.
-- Section P covers the owner decision of 2026-11-26 (option A). Not covered here: ON DELETE SET NULL / cascade referential actions of registrations and orders (no registration fixture), and a PostgREST request.
-- The final block ALWAYS raises: "COMPETITION S6 ENTRY STATUS GUARD SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text := 'OK';
begin
  execute format('set local role %I', p_role);
  begin execute p_sql; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  reset role;
  return v;
end $$;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

-- fixtures (session_replication_role = replica only places rows; the guard is exercised afterwards with it reset)
set local session_replication_role = replica;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1032000001', 't-cf1032-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1032000001', 't-cf1032-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1032a00001', 'CF1 U18 Studio', 't-cf1032-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1032000001', '00000000-0000-0000-0000-cf1032a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032a00001', 'U18', 't-cf1032-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1032002001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1032c00001', '00000000-0000-0000-0000-cf1032e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1032006001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1032009001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1032d00001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1032002001', '00000000-0000-0000-0000-cf1032c00001', '00000000-0000-0000-0000-cf1032009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1032800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1032900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032d00001',
       ('00000000-0000-0000-0000-cf1032800' || lpad(i::text, 3, '0'))::uuid, i, case when i = 4 then 'danced' else 'scheduled' end
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000001","role":"authenticated"}', true);

-- helpers. Rule used throughout: the statement that RUNS a client action is separate from the statement that ASSERTS on its effect, because a statement cannot see writes made by a function
-- it is itself calling (statement snapshot); asserting in the same statement would be vacuous or wrong.
create temp table t_r (k text primary key, r text) on commit drop;
create or replace function pg_temp.run(p_k text, p_role text, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  v := pg_temp.try_as(p_role, p_sql);
  insert into t_r values (p_k, v) on conflict (k) do update set r = excluded.r;
end $$;
create or replace function pg_temp.r(p_k text) returns text language sql as $$ select r from t_r where k = p_k $$;
create or replace function pg_temp.id(p_suffix text) returns uuid language sql as $$ select ('00000000-0000-0000-0000-cf1032' || p_suffix)::uuid $$;
create or replace function pg_temp.st(p_suffix text) returns text language sql as $$ select status from public.event_competition_entries where id = pg_temp.id(p_suffix) $$;
create or replace function pg_temp.hs(p_suffix text) returns text language sql as $$ select status from public.event_competition_heat_entries where id = pg_temp.id(p_suffix) $$;
create or replace function pg_temp.aud(p_suffix text) returns bigint language sql as $$ select count(*) from public.event_competition_entry_changes where entry_id = pg_temp.id(p_suffix) $$;
create or replace function pg_temp.ver(p_suffix text) returns integer language sql as $$ select lifecycle_version::integer from public.event_competition_entries where id = pg_temp.id(p_suffix) $$;
create or replace function pg_temp.lc(p_suffix text, p_status text, p_reason text, p_fee text default 'retain') returns text language sql as $$
  select format('select public.change_competition_entry_lifecycle(%L, %L, %L, %L)', pg_temp.id(p_suffix), p_status, p_reason, p_fee) $$;
create or replace function pg_temp.upd(p_suffix text, p_set text) returns text language sql as $$
  select format('update public.event_competition_entries set %s where id = %L', p_set, pg_temp.id(p_suffix)) $$;

-- extra fixtures: seven matrix entries and a second user with no studio role
set local session_replication_role = replica;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.id('810' || lpad(i::text, 3, '0')), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'm' || i, 'confirmed', 'eligible', '70' || i from generate_series(1, 7) i;
insert into auth.users (id, email) values (pg_temp.id('000002'), 't-cf1032-outsider@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.id('000002'), 't-cf1032-outsider@example.test', 'CF1032 outsider');
set local session_replication_role = origin;
create role cf1032_probe nologin;
grant authenticated to cf1032_probe;

-- A. every status value x every client role: refused, unchanged, no audit row, no participation-class change ---------------------------------------------
create temp table t_m (target text, as_role text, outcome text, start_status text, status_after text, audits_before bigint, audits_after bigint, class_before text, class_after text) on commit drop;
do $m$
declare t text; r text; e uuid; s text; i int := 0; v text; b bigint; cb text;
begin
  foreach t in array array['pending','confirmed','waitlisted','scratched','withdrawn','disqualified','complete'] loop
    i := i + 1;
    e := pg_temp.id('810' || lpad(i::text, 3, '0'));
    s := case when t = 'confirmed' then 'pending' else 'confirmed' end;
    foreach r in array array['authenticated','service_role','anon','cf1032_probe'] loop
      update public.event_competition_entries set status = s where id = e;          -- owner reset (allowed)
      b := (select count(*) from public.event_competition_entry_changes where entry_id = e);
      cb := public._r2_entry_participation_class(e);
      v := pg_temp.try_as(r, format('update public.event_competition_entries set status = %L where id = %L', t, e));
      insert into t_m values (t, r, v, s, (select status from public.event_competition_entries where id = e), b,
        (select count(*) from public.event_competition_entry_changes where entry_id = e), cb, public._r2_entry_participation_class(e));
    end loop;
    update public.event_competition_entries set status = 'confirmed' where id = e;
  end loop;
end $m$;
select pg_temp.chk('A1 ' || target || ' by ' || as_role || ': refused 42501 COMP_S6, status unchanged, no audit row, R2 class unchanged',
  outcome like '42501 COMP_S6_ENTRY_STATUS_WRITER%' and status_after = start_status and audits_after = audits_before and class_after is not distinct from class_before, outcome)
from t_m where as_role in ('authenticated', 'service_role', 'cf1032_probe');
select pg_temp.chk('A1 ' || target || ' by anon: no effect (row-level security gives anon no row; this is not a guard proof), status unchanged, no audit row',
  status_after = start_status and audits_after = audits_before, outcome)
from t_m where as_role = 'anon';

-- B. leaving any non-confirmed status is refused too ------------------------------------------------------------------------------------------------------
create temp table t_b (start_status text, as_role text, outcome text, status_after text) on commit drop;
do $b$
declare s text; r text; e uuid := pg_temp.id('810001'); v text;
begin
  foreach s in array array['pending','waitlisted','scratched','withdrawn','disqualified','complete'] loop
    foreach r in array array['authenticated','service_role'] loop
      update public.event_competition_entries set status = s where id = e;
      v := pg_temp.try_as(r, format('update public.event_competition_entries set status = %L where id = %L', 'confirmed', e));
      insert into t_b values (s, r, v, (select status from public.event_competition_entries where id = e));
    end loop;
  end loop;
  update public.event_competition_entries set status = 'confirmed' where id = e;
end $b$;
select pg_temp.chk('B ' || start_status || ' -> confirmed by ' || as_role || ' refused and unchanged', outcome like '42501 COMP_S6%' and status_after = start_status, outcome) from t_b;

-- C. what is NOT affected
select pg_temp.run('c1', 'authenticated', pg_temp.upd('810001', $s$display_name = 'renamed', entry_number = '799'$s$));
select pg_temp.chk('C1 a manager can still edit other columns (display_name, entry_number)',
  pg_temp.r('c1') = 'OK' and (select display_name = 'renamed' and entry_number = '799' from public.event_competition_entries where id = pg_temp.id('810001')), pg_temp.r('c1'));
select pg_temp.run('c2', 'authenticated', pg_temp.upd('810001', $s$status = 'confirmed'$s$));
select pg_temp.chk('C2 re-writing the same status value is not a change (allowed)', pg_temp.r('c2') = 'OK', pg_temp.r('c2'));
update public.event_competition_entries set status = 'disqualified' where id = pg_temp.id('810002');
select pg_temp.chk('C3a the owner session can still write disqualified', pg_temp.st('810002') = 'disqualified');
update public.event_competition_entries set status = 'confirmed' where id = pg_temp.id('810002');
select pg_temp.chk('C3b the owner session can still clear it', pg_temp.st('810002') = 'confirmed');

-- D. INSERT paths
select pg_temp.run('ins_confirmed', 'authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x1', 'confirmed', 'unverified', '801')$q$);
select pg_temp.run('ins_disq', 'service_role', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820002', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x2', 'disqualified', 'unverified', '802')$q$);
select pg_temp.run('ins_pending', 'authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820003', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x3', 'pending', 'unverified', '803')$q$);
select pg_temp.chk('D1 client INSERT of a confirmed or disqualified entry is refused and no row appears',
  pg_temp.r('ins_confirmed') like '42501 COMP_S6%' and pg_temp.r('ins_disq') like '42501 COMP_S6%'
  and not exists (select 1 from public.event_competition_entries where id in (pg_temp.id('820001'), pg_temp.id('820002'))), pg_temp.r('ins_confirmed') || ' | ' || pg_temp.r('ins_disq'));
select pg_temp.chk('D2 a manager can still INSERT an unlinked pending entry', pg_temp.r('ins_pending') = 'OK', pg_temp.r('ins_pending'));

-- D3. indirect paths: registration / order links and identity (a re-pointed entry would be confirmed or withdrawn by the owner-run registration sync). One column at a time, cleared to null
-- so that neither the link validator nor a foreign key can be the thing that refuses.
do $d$
declare c text; r text; v text;
begin
  foreach c in array array['registration_id','order_id','order_item_id','registration_cart_id'] loop
    foreach r in array array['authenticated','service_role'] loop
      perform set_config('session_replication_role', 'replica', true);
      execute format('update public.event_competition_entries set %I = gen_random_uuid() where id = %L', c, pg_temp.id('810005'));
      perform set_config('session_replication_role', 'origin', true);
      v := pg_temp.try_as(r, format('update public.event_competition_entries set %I = null where id = %L', c, pg_temp.id('810005')));
      insert into t_r values ('link_' || c || '_' || r, v);
      perform set_config('session_replication_role', 'replica', true);
      execute format('update public.event_competition_entries set %I = null where id = %L', c, pg_temp.id('810005'));
      perform set_config('session_replication_role', 'origin', true);
    end loop;
  end loop;
end $d$;
select pg_temp.chk('D3 ' || k || ': refused with COMP_S6_ENTRY_LINK_WRITER', r like '42501 COMP_S6_ENTRY_LINK_WRITER%', r) from t_r where k like 'link\_%';
select pg_temp.run('id_change', 'authenticated', pg_temp.upd('810005', 'id = gen_random_uuid()'));
select pg_temp.run('event_change', 'service_role', pg_temp.upd('810005', 'event_id = gen_random_uuid()'));
select pg_temp.chk('D3b the entry id and event_id cannot be changed by a client', pg_temp.r('id_change') like '42501 COMP_S6_ENTRY_LINK_WRITER%' and pg_temp.r('event_change') like '42501 COMP_S6_ENTRY_LINK_WRITER%',
  pg_temp.r('id_change') || ' | ' || pg_temp.r('event_change'));

-- D4. DELETE: entries with a protected status, protected history or a confirmed payment link cannot be erased and re-created; others still can
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.id('83000' || i), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'del' || i, 'confirmed', 'eligible', '81' || i from generate_series(1, 4) i;
update public.event_competition_entries set status = 'complete' where id = pg_temp.id('830001');
update public.event_competition_entries set status = 'scratched' where id = pg_temp.id('830002');
update public.event_competition_entries set status = 'confirmed' where id = pg_temp.id('830002');
set local session_replication_role = replica;
update public.event_competition_entries set registration_id = gen_random_uuid() where id = pg_temp.id('830003');
set local session_replication_role = origin;
update public.event_competition_entries set eligibility_status = 'needs_review' where id = pg_temp.id('830004');
select pg_temp.run('del_complete', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('830001')));
select pg_temp.run('del_complete_svc', 'service_role', format('delete from public.event_competition_entries where id = %L', pg_temp.id('830001')));
select pg_temp.run('del_history', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('830002')));
select pg_temp.run('del_linked', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('830003')));
select pg_temp.run('del_plain', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('830004')));
select pg_temp.run('del_pending', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('820003')));
select pg_temp.chk('D4a a complete entry (manager and service_role), an entry with scratched history and a confirmed linked entry cannot be deleted, and all stay',
  pg_temp.r('del_complete') like '42501 COMP_S6_ENTRY_DELETE_WRITER%' and pg_temp.r('del_complete_svc') like '42501 COMP_S6_ENTRY_DELETE_WRITER%'
  and pg_temp.r('del_history') like '42501 COMP_S6_ENTRY_DELETE_WRITER%' and pg_temp.r('del_linked') like '42501 COMP_S6_ENTRY_DELETE_WRITER%'
  and (select count(*) from public.event_competition_entries where id in (pg_temp.id('830001'), pg_temp.id('830002'), pg_temp.id('830003'))) = 3,
  (select string_agg(k || '=' || r, ' | ') from t_r where k like 'del\_%'));
select pg_temp.chk('D4b an unlinked confirmed entry with only eligibility history, and an unused pending entry, can still be deleted (existing behaviour)',
  pg_temp.r('del_plain') = 'OK' and pg_temp.r('del_pending') = 'OK'
  and not exists (select 1 from public.event_competition_entries where id in (pg_temp.id('830004'), pg_temp.id('820003'))), pg_temp.r('del_plain') || ' | ' || pg_temp.r('del_pending'));
delete from public.event_competition_entries where id = pg_temp.id('830001');
select pg_temp.chk('D4c the owner can still delete a protected entry', not exists (select 1 from public.event_competition_entries where id = pg_temp.id('830001')));

-- D3c. INSERT cannot create a linked entry or planted evidence (the link rule fires before any foreign-key check, so the refusal is the guard's)
select pg_temp.run('inslink_' || c, 'authenticated', format('insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, %I) values (%L, %L, %L, %L, %L, %L, %L, %L, gen_random_uuid())',
  c, gen_random_uuid(), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'lk', 'pending', 'unverified', 'L' || c))
from unnest(array['registration_id','order_id','order_item_id','registration_cart_id']) c;
select pg_temp.chk('D3c ' || k || ': a client INSERT of a pending entry with this link is refused', r like '42501 COMP_S6_ENTRY_LINK_WRITER%', r) from t_r where k like 'inslink\_%';
select pg_temp.run('insev', 'service_role', format('insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, scratch_reason) values (%L, %L, %L, %L, %L, %L, %L, %L, %L)',
  gen_random_uuid(), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'ev', 'pending', 'unverified', 'EV1', 'planted'));
select pg_temp.chk('D3c a client INSERT cannot plant scratch evidence', pg_temp.r('insev') like '42501 COMP_S6_ENTRY_EVIDENCE_WRITER%', pg_temp.r('insev'));
-- D3d. lifecycle evidence cannot be edited or erased; the invoker late-entry function still works
select pg_temp.run('ev_' || c, 'authenticated', pg_temp.upd('810006', c || ' = ' || v))
from (values ('scratched_at', 'now()'), ('scratch_reason', '''x'''), ('withdrawn_at', 'now()'), ('withdrawal_reason', '''x'''), ('confirmed_at', 'now()'), ('lifecycle_version', 'lifecycle_version + 1')) u(c, v);
select pg_temp.chk('D3d ' || k || ': a manager cannot write this lifecycle evidence column', r like '42501 COMP_S6_ENTRY_EVIDENCE_WRITER%', r) from t_r where k like 'ev\_%';
select pg_temp.run('late', 'authenticated', format('select public.mark_competition_entry_late(%L, %L)', pg_temp.id('810007'), 'late'));
select pg_temp.chk('D3d the invoker function mark_competition_entry_late still works for a manager', pg_temp.r('late') = 'OK'
  and (select late_entry from public.event_competition_entries where id = pg_temp.id('810007')), pg_temp.r('late'));
-- D4d. each delete rule on its own: current status without history, waitlisted, each link on its own, product confirmation, a pending linked entry, a non-scheduled heat entry
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.id('84000' || i), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'dd' || i, s, 'eligible', '82' || i
from unnest(array['disqualified','waitlisted','confirmed','confirmed','confirmed','pending','confirmed']) with ordinality u(s, i);
set local session_replication_role = replica;
update public.event_competition_entries set order_id = gen_random_uuid() where id = pg_temp.id('840003');
update public.event_competition_entries set order_item_id = gen_random_uuid() where id = pg_temp.id('840004');
update public.event_competition_entries set registration_cart_id = gen_random_uuid() where id = pg_temp.id('840005');
update public.event_competition_entries set registration_id = gen_random_uuid() where id = pg_temp.id('840006');
update public.event_competition_entries set confirmed_at = now() where id = pg_temp.id('840007');
set local session_replication_role = origin;
select pg_temp.run('dd_' || n, 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id(n)))
from unnest(array['840001','840002','840003','840004','840005','840006','840007','800004']) n;
select pg_temp.chk('D4d ' || k || ': refused (' || case k when 'dd_840001' then 'disqualified without history' when 'dd_840002' then 'waitlisted' when 'dd_840003' then 'order link' when 'dd_840004' then 'order item link'
    when 'dd_840005' then 'cart link' when 'dd_840006' then 'pending with registration link' when 'dd_840007' then 'confirmed through the product' else 'danced heat entry' end || ')',
  r like '42501 COMP_S6_ENTRY_DELETE_WRITER%', r) from t_r where k like 'dd\_%';

-- E. bypass attempts
select set_config('app.competition_entry_change_type', 'scratch', true), set_config('app.competition_entry_change_reason', 'forged marker', true);
select pg_temp.run('e1a', 'authenticated', pg_temp.upd('810003', $s$status = 'scratched'$s$));
select pg_temp.run('e1b', 'authenticated', pg_temp.upd('810003', $s$status = 'withdrawn'$s$));
select set_config('app.competition_entry_change_type', '', true), set_config('app.competition_entry_change_reason', '', true);
select pg_temp.chk('E1 forging the U18-S style workflow marker does not unlock a direct parent scratch or withdrawal',
  pg_temp.r('e1a') like '42501 COMP_S6%' and pg_temp.r('e1b') like '42501 COMP_S6%' and pg_temp.st('810003') = 'confirmed', pg_temp.r('e1a'));
select pg_temp.run('e2', 'authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032810004', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'u', 'pending', 'unverified', '890')
  on conflict (id) do update set status = 'disqualified'$q$);
select pg_temp.chk('E2 INSERT ... ON CONFLICT (id) DO UPDATE cannot change status', pg_temp.r('e2') like '42501 COMP_S6%' and pg_temp.st('810004') = 'confirmed', pg_temp.r('e2'));
select pg_temp.run('e3', 'authenticated', format('update public.event_competition_entries set status = %L where id in (%L, %L, %L)', 'withdrawn', pg_temp.id('810005'), pg_temp.id('810006'), pg_temp.id('810007')));
select pg_temp.chk('E3 a bulk UPDATE touching several entries is refused as a whole (nothing changed)',
  pg_temp.r('e3') like '42501 COMP_S6%' and pg_temp.st('810005') = 'confirmed' and pg_temp.st('810006') = 'confirmed' and pg_temp.st('810007') = 'confirmed', pg_temp.r('e3'));
select pg_temp.chk('E4 no client role is a member of an owner role, so a client session cannot SET ROLE to one (checked by membership: inside this suite SET ROLE is authorized against the superuser session)',
  not exists (select 1 from unnest(array['anon','authenticated','service_role','cf1032_probe']) c, unnest(array['postgres','supabase_admin']) o where pg_has_role(c, o, 'member')));
select pg_temp.chk('E5 TRIGGER privilege on the entries table is gone for anon, authenticated and service_role',
  not has_table_privilege('anon', 'public.event_competition_entries', 'TRIGGER') and not has_table_privilege('authenticated', 'public.event_competition_entries', 'TRIGGER') and not has_table_privilege('service_role', 'public.event_competition_entries', 'TRIGGER'));
create function pg_temp.zz_trg() returns trigger language plpgsql as 'begin return new; end';
grant execute on function pg_temp.zz_trg() to public;
select pg_temp.run('e6_' || c, c, 'create trigger zz_probe_' || c || ' before update on public.event_competition_entries for each row execute function pg_temp.zz_trg()')
from unnest(array['authenticated','service_role','cf1032_probe']) c;
select pg_temp.chk('E6 ' || k || ': a client cannot create a trigger on the entries table even with an executable trigger function', r like '42501 permission denied for table%', r) from t_r where k like 'e6\_%';
select pg_temp.run('e7a', 'authenticated', 'alter table public.event_competition_entries disable trigger cf1_s6_guard_entry_status');
select pg_temp.run('e7b', 'service_role', 'drop trigger cf1_s6_guard_entry_status on public.event_competition_entries');
select pg_temp.run('e7c', 'authenticated', $q$create or replace function public.cf1_s6_guard_entry_status() returns trigger language plpgsql as 'begin return new; end'$q$);
select pg_temp.chk('E7 a client cannot disable, drop or replace the guard', pg_temp.r('e7a') like '42501%' and pg_temp.r('e7b') like '42501%' and pg_temp.r('e7c') like '42501%', pg_temp.r('e7a') || ' | ' || pg_temp.r('e7b') || ' | ' || pg_temp.r('e7c'));
select pg_temp.run('e8', 'authenticated', 'set session_replication_role = replica');
select pg_temp.chk('E8 a client cannot set session_replication_role; three row triggers are ENABLE ALWAYS: status AFTER, links and delete BEFORE',
  pg_temp.r('e8') like '42501%'
  and (select count(*) from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgenabled = 'A' and (tgtype & 1) = 1
        and ((tgname = 'cf1_s6_guard_entry_status' and (tgtype & 2) = 0) or (tgname in ('cf1_s6_guard_entry_links', 'cf1_s6_guard_entry_delete') and (tgtype & 2) = 2))) = 3, pg_temp.r('e8'));
select pg_temp.chk('E9 the guard function is SECURITY INVOKER and not executable by clients',
  (select not prosecdef from pg_proc where proname = 'cf1_s6_guard_entry_status')
  and not has_function_privilege('anon', 'public.cf1_s6_guard_entry_status()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.cf1_s6_guard_entry_status()', 'EXECUTE') and not has_function_privilege('service_role', 'public.cf1_s6_guard_entry_status()', 'EXECUTE'));

-- F. legitimate operations
select pg_temp.run('f1', 'authenticated', pg_temp.lc('800001', 'scratched', 'S6 scratch'));
select pg_temp.chk('F1 lifecycle RPC: manager scratches an entry; parent and heat entry scratched, one audit row with reason and actor',
  pg_temp.r('f1') = 'OK' and pg_temp.st('800001') = 'scratched' and pg_temp.hs('900001') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = pg_temp.id('800001') and change_type = 'scratch' and reason = 'S6 scratch' and performed_by = pg_temp.id('000001')) = 1, pg_temp.r('f1'));
select pg_temp.run('f2', 'authenticated', pg_temp.lc('800002', 'withdrawn', 'S6 withdraw', 'refund'));
select pg_temp.chk('F2 lifecycle RPC: manager withdraws an entry; parent withdrawn, heat entry scratched, one withdraw audit row',
  pg_temp.r('f2') = 'OK' and pg_temp.st('800002') = 'withdrawn' and pg_temp.hs('900002') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = pg_temp.id('800002') and change_type = 'withdraw') = 1, pg_temp.r('f2'));
select pg_temp.run('f3a', 'authenticated', pg_temp.lc('800003', 'disqualified', 'x'));
select pg_temp.run('f3b', 'authenticated', pg_temp.lc('800003', 'complete', 'x'));
select pg_temp.chk('F3 the RPC cannot write other statuses', pg_temp.r('f3a') like '%Lifecycle action must be scratch or withdraw%' and pg_temp.r('f3b') like '%Lifecycle action must be scratch or withdraw%' and pg_temp.st('800003') = 'confirmed', pg_temp.r('f3a'));
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000002","role":"authenticated"}', true);
select pg_temp.run('f4', 'authenticated', pg_temp.lc('800003', 'scratched', 'outsider'));
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000001","role":"authenticated"}', true);
select pg_temp.chk('F4 a user who does not manage the event is refused by the RPC and nothing changes', pg_temp.r('f4') like '%cannot be managed%' and pg_temp.st('800003') = 'confirmed' and pg_temp.hs('900003') = 'scheduled', pg_temp.r('f4'));
select pg_temp.chk('F5 the lifecycle RPC is SECURITY DEFINER, owned by an owner role, executable by authenticated only',
  not has_function_privilege('anon', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE') and not has_function_privilege('service_role', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE')
  and (select prosecdef and pg_get_userbyid(proowner) in ('postgres', 'supabase_admin') from pg_proc where oid = 'public.change_competition_entry_lifecycle(uuid,text,text,text)'::regprocedure));
set local session_replication_role = replica;
update public.event_competition_heats set lock_state = 'locked' where id = pg_temp.id('d00001');
set local session_replication_role = origin;
create temp table t_x (x text) on commit drop;
insert into t_x select xmax::text from public.event_competition_entries where id = pg_temp.id('800003');
select pg_temp.run('f6', 'authenticated', pg_temp.lc('800003', 'scratched', 'locked'));
select pg_temp.chk('F6 the locked-heat refusal is preserved, changes nothing and takes no row lock on the entry (xmax unchanged)',
  pg_temp.r('f6') like '%locked or certified heat%' and pg_temp.st('800003') = 'confirmed' and (select xmax::text from public.event_competition_entries where id = pg_temp.id('800003')) = (select x from t_x), pg_temp.r('f6'));
select pg_temp.run('f7', 'postgres', format('select public._r2_withdraw_entry(%L, %L, %L)', pg_temp.id('800005'), 'S6 R2', 'retain'));
select pg_temp.chk('F7 the real R2 withdrawal definer still withdraws an entry for its owner', pg_temp.r('f7') = 'OK' and pg_temp.st('800005') = 'withdrawn', pg_temp.r('f7'));
create function pg_temp.definer_writer(p_status text) returns void language plpgsql security definer as $$
begin update public.event_competition_entries set status = p_status where id = '00000000-0000-0000-0000-cf1032810003'; end $$;
grant execute on function pg_temp.definer_writer(text) to authenticated;
select pg_temp.run('f8_' || s, 'authenticated', format('select pg_temp.definer_writer(%L)', s)) from unnest(array['pending','waitlisted','scratched','withdrawn','disqualified','complete','confirmed']) u(s);
select pg_temp.chk('F8 an owner-run SECURITY DEFINER function called by a client can still move an entry through every status (finalize / sync style)',
  (select count(*) from t_r where k like 'f8\_%' and r = 'OK') = 7 and pg_temp.st('810003') = 'confirmed', (select string_agg(k || '=' || r, ' | ') from t_r where k like 'f8\_%'));
select pg_temp.run('f9', 'service_role', format('select public._r2_withdraw_entry(%L, %L, %L)', pg_temp.id('810001'), 'x', 'refund'));
select pg_temp.chk('F9 service_role cannot execute the internal R2 withdrawal functions',
  not has_function_privilege('service_role', 'public._r2_withdraw_entry(uuid,text,text)', 'EXECUTE') and not has_function_privilege('service_role', 'public._r2_apply_participation(uuid)', 'EXECUTE')
  and pg_temp.r('f9') like '42501 permission denied%', pg_temp.r('f9'));

-- H. lifecycle rules (20270301140000)
set local session_replication_role = replica;
update public.event_competition_heats set lock_state = 'open' where id = pg_temp.id('d00001');
set local session_replication_role = origin;
create temp table t_h (k text primary key, ver integer, aud bigint) on commit drop;
insert into t_h values ('h1', pg_temp.ver('800001'), pg_temp.aud('800001'));
select pg_temp.run('h1', 'authenticated', pg_temp.lc('800001', 'scratched', 'again'));
select pg_temp.chk('H1 repeating a scratch is a no-op: same version, same audit row count, still scratched',
  pg_temp.r('h1') = 'OK' and pg_temp.ver('800001') = (select ver from t_h where k = 'h1') and pg_temp.aud('800001') = (select aud from t_h where k = 'h1') and pg_temp.st('800001') = 'scratched', pg_temp.r('h1'));
set local session_replication_role = replica;
update public.event_competition_entries set status = 'scratched' where id = pg_temp.id('810003');
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
values (pg_temp.id('900071'), pg_temp.id('e00001'), pg_temp.id('003001'), pg_temp.id('d00001'), pg_temp.id('810003'), 71, 'scheduled');
set local session_replication_role = origin;
insert into t_h values ('h1b', pg_temp.ver('810003'), pg_temp.aud('810003'));
select pg_temp.run('h1b', 'authenticated', pg_temp.lc('810003', 'scratched', 'repair', 'not_applicable'));
select pg_temp.chk('H1b a repeat call completes a left-behind heat-entry cascade without a new audit row or version bump',
  pg_temp.r('h1b') = 'OK' and pg_temp.hs('900071') = 'scratched' and pg_temp.ver('810003') = (select ver from t_h where k = 'h1b') and pg_temp.aud('810003') = (select aud from t_h where k = 'h1b'), pg_temp.r('h1b'));
select pg_temp.run('h2', 'authenticated', pg_temp.lc('800001', 'withdrawn', 'x'));
select pg_temp.chk('H2 scratched -> withdrawn is refused (COMP_ENTRY_LIFECYCLE_STATE) and changes nothing', pg_temp.r('h2') like '%COMP_ENTRY_LIFECYCLE_STATE%' and pg_temp.st('800001') = 'scratched' and pg_temp.aud('800001') = (select aud from t_h where k = 'h1'), pg_temp.r('h2'));
update public.event_competition_entries set status = 'complete' where id = pg_temp.id('810004');
update public.event_competition_entries set status = 'disqualified' where id = pg_temp.id('810005');
select pg_temp.run('h3a', 'authenticated', pg_temp.lc('810004', 'scratched', 'x'));
select pg_temp.run('h3b', 'authenticated', pg_temp.lc('810005', 'withdrawn', 'x'));
select pg_temp.chk('H3 complete and disqualified entries are refused and unchanged', pg_temp.r('h3a') like '%COMP_ENTRY_LIFECYCLE_STATE%' and pg_temp.r('h3b') like '%COMP_ENTRY_LIFECYCLE_STATE%' and pg_temp.st('810004') = 'complete' and pg_temp.st('810005') = 'disqualified', pg_temp.r('h3a') || ' | ' || pg_temp.r('h3b'));
select pg_temp.run('h4', 'authenticated', pg_temp.lc('800004', 'scratched', 'x'));
select pg_temp.chk('H4 a danced heat entry in an unlocked heat is refused (COMP_ENTRY_LIFECYCLE_PLACED) and unchanged', pg_temp.r('h4') like '%COMP_ENTRY_LIFECYCLE_PLACED%' and pg_temp.st('800004') = 'confirmed' and pg_temp.hs('900004') = 'danced', pg_temp.r('h4'));
set local session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scheduled' where id = pg_temp.id('900004');
update public.event_competition_heat_entries set status = 'scheduled' where id = pg_temp.id('900071');
update public.event_competition_heats set status = 'active' where id = pg_temp.id('d00001');
set local session_replication_role = origin;
select pg_temp.run('h5', 'authenticated', pg_temp.lc('800004', 'scratched', 'x'));
select pg_temp.chk('H5 an entry in an ACTIVE heat is refused and unchanged', pg_temp.r('h5') like '%COMP_ENTRY_LIFECYCLE_PLACED%' and pg_temp.st('800004') = 'confirmed', pg_temp.r('h5'));
select pg_temp.run('h7', 'authenticated', pg_temp.lc('810003', 'scratched', 'repair-active'));
select pg_temp.chk('H7 the repeat call passes the same checks: a scratched parent with a scheduled heat entry in an active heat is refused, heat entry unchanged',
  pg_temp.r('h7') like '%COMP_ENTRY_LIFECYCLE_PLACED%' and pg_temp.hs('900071') = 'scheduled', pg_temp.r('h7'));
set local session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scratched' where id = pg_temp.id('900071');
set local session_replication_role = origin;
select set_config('app.competition_entry_change_type', '', true), set_config('app.competition_entry_change_reason', '', true), set_config('app.competition_entry_fee_handling', '', true);
update public.event_competition_entries set status = 'waitlisted' where id = pg_temp.id('810006');
update public.event_competition_entries set status = 'pending' where id = pg_temp.id('810007');
select pg_temp.run('h6a', 'authenticated', pg_temp.lc('810006', 'scratched', 'h6-w'));
select pg_temp.run('h6b', 'authenticated', pg_temp.lc('810007', 'withdrawn', 'h6-p', 'not_applicable'));
select pg_temp.chk('H6 waitlisted -> scratched and pending -> withdrawn through the RPC still work (one audit row each)',
  pg_temp.r('h6a') = 'OK' and pg_temp.r('h6b') = 'OK' and pg_temp.st('810006') = 'scratched' and pg_temp.st('810007') = 'withdrawn'
  and (select count(*) from public.event_competition_entry_changes where entry_id in (pg_temp.id('810006'), pg_temp.id('810007')) and reason in ('h6-w', 'h6-p')) = 2, pg_temp.r('h6a') || ' | ' || pg_temp.r('h6b'));

-- P. owner decision 2026-11-26 option A: started / completed participation blocks whole-entry scratch AND withdrawal, cannot be detached, and keeps its scoring / refund class
set local session_replication_role = replica;
update public.event_competition_heats set status = 'scheduled', lock_state = 'open' where id = pg_temp.id('d00001');
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.id('009002'), pg_temp.id('e00001'), pg_temp.id('c00001'), 2);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values (pg_temp.id('d00002'), pg_temp.id('e00001'), pg_temp.id('003001'), pg_temp.id('006001'), 2, 'complete', 'open', pg_temp.id('002001'), pg_temp.id('c00001'), pg_temp.id('009002'));
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.id('85000' || i), pg_temp.id('e00001'), pg_temp.id('001001'), pg_temp.id('003001'), 'p' || i, 'confirmed', 'eligible', '85' || i from generate_series(1, 4) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.id(he), pg_temp.id('e00001'), pg_temp.id('003001'), pg_temp.id(h), pg_temp.id(e), o, s
from (values ('951011', 'd00001', '850001', 91, 'scheduled'), ('951012', 'd00002', '850001', 91, 'scheduled'),
             ('951022', 'd00002', '850002', 92, 'scheduled'),
             ('951031', 'd00001', '850003', 93, 'scheduled'), ('951032', 'd00002', '850003', 93, 'scratched'),
             ('951041', 'd00001', '850004', 94, 'scheduled')) v(he, h, e, o, s);
set local session_replication_role = origin;
create temp table t_p (n text primary key, snap text) on commit drop;
create or replace function pg_temp.snap(p_e text) returns text language sql as $$
  select e.status || '|' || e.lifecycle_version || '|' || pg_temp.aud(p_e) || '|' || coalesce((select string_agg(h.heat_id::text || ':' || h.status, ',' order by h.id) from public.event_competition_heat_entries h where h.entry_id = e.id), '')
  from public.event_competition_entries e where e.id = pg_temp.id(p_e) $$;
insert into t_p select n, pg_temp.snap(n) from unnest(array['850001','850002']) n;
select pg_temp.run('p_' || n || '_' || s, 'authenticated', pg_temp.lc(n, s, 'policy')) from unnest(array['850001','850002']) n, unnest(array['scratched','withdrawn']) s;
select pg_temp.chk('P1-P2 ' || k || ': refused (one completed heat / a completed and a scheduled heat)', r like '%COMP_ENTRY_LIFECYCLE_PLACED%', r) from t_r where k like 'p\_85%';
select pg_temp.chk('P1-P2 every refused entry is unchanged: status, version, audit rows and every placement', (select bool_and(snap = pg_temp.snap(n)) from t_p));
-- P4 the detach routes
select pg_temp.run('x_del_he', 'authenticated', format('delete from public.event_competition_heat_entries where id = %L', pg_temp.id('951012')));
select pg_temp.run('x_del_he_svc', 'service_role', format('delete from public.event_competition_heat_entries where id = %L', pg_temp.id('951012')));
select pg_temp.run('x_move_he', 'authenticated', format('update public.event_competition_heat_entries set heat_id = %L where id = %L', pg_temp.id('d00001'), pg_temp.id('951022')));
select pg_temp.run('x_repoint_he', 'service_role', format('update public.event_competition_heat_entries set entry_id = %L where id = %L', pg_temp.id('850004'), pg_temp.id('951022')));
select pg_temp.run('x_scr_he', 'service_role', format('update public.event_competition_heat_entries set status = %L where id = %L', 'scratched', pg_temp.id('951022')));
select pg_temp.run('x_del_heat', 'authenticated', format('delete from public.event_competition_heats where id = %L', pg_temp.id('d00002')));
select pg_temp.run('x_del_entry', 'authenticated', format('delete from public.event_competition_entries where id = %L', pg_temp.id('850002')));
select pg_temp.chk('P4 ' || k || ': a client cannot remove, move, re-point or scratch a placement of a completed heat, nor delete that heat', r like '42501 COMP_S6_PARTICIPATION_WRITER%', r)
from t_r where k in ('x_del_he', 'x_del_he_svc', 'x_move_he', 'x_repoint_he', 'x_scr_he', 'x_del_heat');
select pg_temp.chk('P4 a client cannot delete an entry that took part in a completed heat', pg_temp.r('x_del_entry') like '42501 COMP_S6_ENTRY_DELETE_WRITER%', pg_temp.r('x_del_entry'));
set local session_replication_role = replica;
update public.event_competition_heat_entries set status = 'danced' where id = pg_temp.id('951041');
set local session_replication_role = origin;
select pg_temp.run('x_del_danced', 'authenticated', format('delete from public.event_competition_heat_entries where id = %L', pg_temp.id('951041')));
select pg_temp.run('x_del_heat_danced', 'authenticated', format('delete from public.event_competition_heats where id = %L', pg_temp.id('d00001')));
select pg_temp.chk('P4b a scheduled heat holding a danced placement cannot be deleted', pg_temp.r('x_del_heat_danced') like '42501 COMP_S6_PARTICIPATION_WRITER%', pg_temp.r('x_del_heat_danced'));
select pg_temp.chk('P4 a danced placement in a scheduled heat cannot be removed either', pg_temp.r('x_del_danced') like '42501 COMP_S6_PARTICIPATION_WRITER%', pg_temp.r('x_del_danced'));
select pg_temp.chk('P5 consequences preserved after every refusal: entries unchanged, completed-heat ranking set still includes them, R2 refund class still locked (the refund cascade itself is not executed here)',
  (select bool_and(snap = pg_temp.snap(n)) from t_p)
  and pg_temp.id('850001') = any (public._compe2_heat_entries(pg_temp.id('d00002'))) and pg_temp.id('850002') = any (public._compe2_heat_entries(pg_temp.id('d00002')))
  and public._r2_entry_participation_class(pg_temp.id('850001')) = 'locked' and public._r2_entry_participation_class(pg_temp.id('850002')) = 'locked');
-- P3 edge case, reported for an owner decision and NOT changed here: a confirmed entry whose placement in a completed heat is already SCRATCHED (and one scheduled placement). Neither the R2 class
-- nor the lifecycle function counts the scratched placement, so the whole-entry scratch is accepted; the scratched placement in the completed heat is left as it is.
select pg_temp.chk('P3a NOTE: the R2 class ignores a scratched placement: entry 850003 is classed open for refunds although one of its heats is completed',
  public._r2_entry_participation_class(pg_temp.id('850003')) = 'open', public._r2_entry_participation_class(pg_temp.id('850003')));
select pg_temp.run('p_edge', 'authenticated', pg_temp.lc('850003', 'scratched', 'edge'));
select pg_temp.chk('P3b CHARACTERIZATION (reported): that entry can be scratched; its completed-heat placement is unchanged (still scratched, still in that heat)',
  pg_temp.r('p_edge') = 'OK' and (select heat_id = pg_temp.id('d00002') and status = 'scratched' from public.event_competition_heat_entries where id = pg_temp.id('951032')), pg_temp.r('p_edge'));
-- P6 staging is not covered by the decision: record the current behaviour
set local session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scheduled' where id = pg_temp.id('951041');
update public.event_competition_heats set status = 'staging' where id = pg_temp.id('d00001');
set local session_replication_role = origin;
select pg_temp.run('p_staging', 'authenticated', pg_temp.lc('850004', 'scratched', 'staging probe'));
select pg_temp.chk('P6 CHARACTERIZATION (not covered by the owner decision): an entry whose only heat is STAGING can still be scratched', pg_temp.r('p_staging') = 'OK', pg_temp.r('p_staging'));

-- G. consistency and coexistence
select pg_temp.chk('G1 no fixture entry is scratched or withdrawn while one of its heat entries is still scheduled or checked_in',
  not exists (select 1 from public.event_competition_entries e join public.event_competition_heat_entries h on h.entry_id = e.id
              where e.id::text like '00000000-0000-0000-0000-cf1032%' and e.status in ('scratched', 'withdrawn') and h.status in ('scheduled', 'checked_in')));
select pg_temp.chk('G2 refused direct writes left the R2 class exactly as before (matrix rows)',
  not exists (select 1 from t_m where as_role in ('authenticated', 'service_role', 'cf1032_probe') and class_after is distinct from class_before));
select pg_temp.chk('G3 the existing triggers (audit, updated_at, link validator) are present and enabled alongside the three guards',
  (select count(*) from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and not tgisinternal and tgenabled <> 'D'
     and tgname in ('audit_competition_entry_change', 'set_event_competition_updated_at', 'validate_competition_entry_registration_links', 'cf1_s6_guard_entry_status', 'cf1_s6_guard_entry_links', 'cf1_s6_guard_entry_delete')) = 6);

select * from t_m order by target, as_role;
select name, ok, left(detail, 300) from t_results where not ok;
do $$
declare v_fail text; v_n integer;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_n, v_fail from t_results;
  if v_fail is null then raise exception 'COMPETITION S6 ENTRY STATUS GUARD SQL SUITE PASS (% checks)', v_n;
  else raise exception 'COMPETITION S6 ENTRY STATUS GUARD SQL SUITE FAIL: %', v_fail; end if;
end $$;
rollback;
