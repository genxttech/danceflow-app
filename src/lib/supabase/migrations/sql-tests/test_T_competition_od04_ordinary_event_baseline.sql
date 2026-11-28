-- OD-04: ordinary (non-competition) event deletion must be unchanged by the guard.
-- Run the SAME script before and after the OD-04 migration (and after its rollback) on the same chain and diff the output: it must be identical.
--   cat sql-tests/fixtures/od04_seed.sql sql-tests/test_T_competition_od04_ordinary_event_baseline.sql | psql -U supabase_admin -At -q
-- For every non-competition table that references events, one synthetic row is placed on a workshop event; the event is then deleted and the
-- outcome per table is printed (rows left, or the error). Ends with ROLLBACK, nothing persists.
begin;
create temp table t_out (line text) on commit drop;
do $$
declare
  v_studio uuid := gen_random_uuid();
  v_ev uuid := gen_random_uuid();
  r record;
  v_n bigint;
  v_err text;
begin
  insert into public.studios (id, name, slug) values (v_studio, 'OD04 base', 't-od04-base');
  insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
    values (v_ev, v_studio, 'OD04 ordinary baseline', 't-od04-base-e', 'workshop', current_date + 30, current_date + 30, 'published', 'public', false);
  for r in
    select k.relname from pg_class k
    where k.relnamespace = 'public'::regnamespace and k.relkind = 'r' and k.relname !~ 'competition'
      and exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = k.oid and c.confrelid = 'public.events'::regclass and c.confdeltype = 'c')
    order by k.relname
  loop
    begin
      perform pg_temp.od04_seed(r.relname, v_ev, '{}'::jsonb);
      insert into t_out values (r.relname || ': seeded');
    exception when others then
      insert into t_out values (r.relname || ': seed skipped (' || sqlstate || ')');
    end;
  end loop;
  begin
    delete from public.events where id = v_ev;
    get diagnostics v_n = row_count;
    insert into t_out values ('DELETE event: ' || v_n || ' row(s) deleted');
  exception when others then
    insert into t_out values ('DELETE event: ERROR ' || sqlstate);
  end;
  for r in
    select k.relname from pg_class k
    where k.relnamespace = 'public'::regnamespace and k.relkind = 'r' and k.relname !~ 'competition'
      and exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = k.oid and c.confrelid = 'public.events'::regclass and c.confdeltype = 'c')
    order by k.relname
  loop
    execute format('select count(*) from public.%I where event_id = %L', r.relname, v_ev) into v_n;
    insert into t_out values (r.relname || ': ' || v_n || ' left');
  end loop;
end $$;
select line from t_out order by line;
rollback;
