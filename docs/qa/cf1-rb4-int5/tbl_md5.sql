create or replace function pg_temp.tbl_md5() returns table(t text, n bigint, h text) language plpgsql as $f$
declare r record;
begin
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1 loop
    return query execute format('select %L::text, count(*)::bigint, md5(coalesce(string_agg(md5(x::text), '''' order by md5(x::text)), '''')) from public.%I x', r.relname, r.relname);
  end loop;
end $f$;
select t || '|' || n || '|' || h from pg_temp.tbl_md5();
