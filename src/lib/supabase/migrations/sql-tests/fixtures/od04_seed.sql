-- Test-only fixture helper (never part of a migration): defines session-level pg_temp functions that place ONE synthetic row in any table.
--
--   cat sql-tests/fixtures/od04_seed.sql sql-tests/<suite>.sql | psql ...      (the suite starts its own `begin;`)
--
-- pg_temp.od04_seed(p_table text, p_event uuid, p_override jsonb default '{}') returns uuid
--   Inserts one row into public.<p_table> with event_id = p_event. Every NOT NULL column without a default gets a value chosen by its type
--   (uuid: a fresh uuid, text: 'x', numbers: 1, boolean: false, timestamps: now(), date: current_date, json: '{}', arrays: '{}'), and
--   p_override (a jsonb object of column -> value) replaces or adds any column. The insert runs with session_replication_role = replica
--   (foreign-key triggers off, like the other competition suites' fixtures) and restores the previous setting. NOT NULL and CHECK constraints
--   stay enforced, so a table whose CHECKs need real values gets them through p_override. Returns the new row's id when the table has one.
--   OTHER packages' ENABLE ALWAYS / ENABLE REPLICA triggers on <p_table> still fire in replica mode (later competition guards refuse synthetic rows),
--   so they are switched off for this one insert and restored to exactly their previous mode. Never for public.events: the guards under test are
--   never touched. Use only inside a transaction that is rolled back, or on a disposable database.
--   Must run as a superuser.

create or replace function pg_temp.od04_default_value(p_type text) returns text
language sql immutable as $$
  select case
    when p_type = 'uuid' then 'gen_random_uuid()'
    when p_type in ('text', 'character varying', 'character', 'citext') then $q$'x'$q$
    when p_type in ('integer', 'bigint', 'smallint', 'numeric') or p_type like 'numeric(%' then '1'
    when p_type = 'boolean' then 'false'
    when p_type like 'timestamp%' then 'now()::text'
    when p_type = 'date' then 'current_date::text'
    when p_type in ('jsonb', 'json') then $q$'{}'$q$
    when p_type like '%[]' then $q$'{}'$q$
    when p_type = 'bytea' then $q$'\x00'$q$
    else null
  end
$$;

create or replace function pg_temp.od04_restore_triggers(p_rel regclass, p_off jsonb) returns void
language plpgsql as $$
declare
  v record;
begin
  for v in select key, value from jsonb_each_text(p_off) loop
    execute format('alter table %s enable %s trigger %I', p_rel, v.value, v.key);
  end loop;
end $$;

create or replace function pg_temp.od04_seed(p_table text, p_event uuid, p_override jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare
  v_rel regclass := to_regclass('public.' || quote_ident(p_table));
  v_col record;
  v_cols text[] := '{}';
  v_vals text[] := '{}';
  v_expr text;
  v_check text;
  v_has_id boolean;
  v_id uuid;
  v_prev text := current_setting('session_replication_role');
  v_trg record;
  v_off jsonb := '{}'::jsonb;
begin
  if v_rel is null then raise exception 'od04_seed: table % does not exist', p_table; end if;
  if v_rel = 'public.events'::regclass then raise exception 'od04_seed: public.events is never seeded through this helper'; end if;
  for v_col in
    select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity
    from pg_attribute a
    where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
    order by a.attnum
  loop
    if v_col.attname = 'event_id' then
      v_cols := array_append(v_cols, 'event_id'::text); v_vals := array_append(v_vals, quote_literal(p_event::text) || '::uuid');
    elsif p_override ? v_col.attname then
      v_cols := array_append(v_cols, quote_ident(v_col.attname));
      v_vals := array_append(v_vals, case when jsonb_typeof(p_override -> v_col.attname) = 'null' then 'null'
                               else format('%L::%s', p_override ->> v_col.attname, v_col.typ) end);
    elsif v_col.attnotnull and not v_col.atthasdef then
      v_check := null;
      v_expr := pg_temp.od04_default_value(v_col.typ);
      -- a single-column CHECK of the form col = ANY (ARRAY['a', ...]): use its first literal
      select quote_literal((regexp_match(pg_get_constraintdef(c.oid), '\(+' || v_col.attname || '(\)?::text)? = ANY \(+ARRAY\[''([^'']+)'''))[2]) into v_check
        from pg_constraint c where c.conrelid = v_rel and c.contype = 'c'
         and pg_get_constraintdef(c.oid) ~ ('\(+' || v_col.attname || '(\)?::text)? = ANY \(+ARRAY\[''') limit 1;
      if v_expr is null then raise exception 'od04_seed: no default value for %.% (type %); pass an override', p_table, v_col.attname, v_col.typ; end if;
      v_cols := array_append(v_cols, quote_ident(v_col.attname));
      v_vals := array_append(v_vals, format('(%s)::%s', coalesce(v_check, v_expr), v_col.typ));
    end if;
  end loop;
  select exists (select 1 from pg_attribute where attrelid = v_rel and attname = 'id' and not attisdropped) into v_has_id;
  for v_trg in select tgname, tgenabled from pg_trigger where tgrelid = v_rel and not tgisinternal and tgenabled in ('A', 'R') loop
    execute format('alter table %s disable trigger %I', v_rel, v_trg.tgname);
    v_off := v_off || jsonb_build_object(v_trg.tgname, case v_trg.tgenabled when 'A' then 'always' else 'replica' end);
  end loop;
  perform set_config('session_replication_role', 'replica', true);
  begin
    if v_has_id then
      execute format('insert into %s (%s) values (%s) returning id', v_rel, array_to_string(v_cols, ', '), array_to_string(v_vals, ', ')) into v_id;
    else
      execute format('insert into %s (%s) values (%s)', v_rel, array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
    end if;
  exception when others then
    perform set_config('session_replication_role', v_prev, true);
    perform pg_temp.od04_restore_triggers(v_rel, v_off);
    raise;
  end;
  perform set_config('session_replication_role', v_prev, true);
  perform pg_temp.od04_restore_triggers(v_rel, v_off);
  return v_id;
end $$;
