set transaction read only;
select 'trigger ' || c.relname || '.' || t.tgname k,
       format('%s fn=%s enabled=%s flags=%s',
              case when t.tgtype & 2 = 2 then 'BEFORE' when t.tgtype & 64 = 64 then 'INSTEAD' else 'AFTER' end,
              p.oid::regprocedure::text, t.tgenabled,
              coalesce(nullif(concat_ws(',',
                case when p.prosrc ~* 'pg_notify|\mnotify\M' then 'notify' end,
                case when p.prosrc ~* 'dblink' then 'dblink' end,
                case when p.prosrc ~* '\mnet\.|http_(post|get|request)|supabase_functions' then 'http' end,
                case when p.prosrc ~* 'pg_background' then 'background' end,
                case when p.prosrc ~* 'nextval|setval' then 'sequence' end,
                case when p.prosrc ~* '\mcopy\M|lo_import|lo_export|pg_file' then 'file' end,
                case when p.prosecdef then 'secdef' end), ''), 'none')) v
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
where c.relnamespace = 'public'::regnamespace and c.relname in ('studios', 'clients', 'appointments') and not t.tgisinternal
union all select 'rules_on_fixture_tables', coalesce((select string_agg(tablename || '.' || rulename, ' ') from pg_rules where schemaname = 'public' and tablename in ('studios', 'clients', 'appointments')), '<none>')
union all select 'publications_with_fixture_tables', coalesce((select string_agg(pubname || ':' || tablename, ' ' order by pubname, tablename) from pg_publication_tables where schemaname = 'public' and tablename in ('studios', 'clients', 'appointments')), '<none>')
union all select 'event_trigger ' || e.evtname, format('%s enabled=%s fn=%s flags=%s', e.evtevent, e.evtenabled, p.oid::regprocedure::text,
              coalesce(nullif(concat_ws(',', case when p.prosrc ~* 'pg_notify|\mnotify\M' then 'notify' end, case when p.prosrc ~* 'dblink' then 'dblink' end,
                case when p.prosrc ~* '\mnet\.|http_' then 'http' end), ''), 'none'))
  from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid
union all select 'extensions_installed', (select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension)
union all select 'sequences_owned_by_fixture_tables', coalesce((select string_agg(s.relname, ' ') from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a','i') join pg_class t on t.oid = d.refobjid
    where s.relkind = 'S' and t.relnamespace = 'public'::regnamespace and t.relname in ('studios', 'clients', 'appointments')), '<none>');
