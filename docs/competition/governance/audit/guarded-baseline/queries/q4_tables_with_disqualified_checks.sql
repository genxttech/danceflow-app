select coalesce(jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'check',pg_get_constraintdef(c.oid),
  'policies',(select coalesce(jsonb_agg(jsonb_build_object('n',polname,'cmd',polcmd,'roles',(select array_agg(case when r=0 then 'public' else pg_get_userbyid(r) end) from unnest(polroles) r))),'[]'::jsonb) from pg_policy where polrelid=c.conrelid),
  'auth_upd',has_table_privilege('authenticated',c.conrelid,'update'),'auth_ins',has_table_privilege('authenticated',c.conrelid,'insert'),'svc_upd',has_table_privilege('service_role',c.conrelid,'update'),'anon_upd',has_table_privilege('anon',c.conrelid,'update'),'auth_trigger',has_table_privilege('authenticated',c.conrelid,'trigger'),
  'triggers',(select coalesce(jsonb_agg(t.tgname||':'||t.tgenabled::text||':'||(select case when p.prosecdef then 'SD' else 'INV' end from pg_proc p where p.oid=t.tgfoid)),'[]'::jsonb) from pg_trigger t where t.tgrelid=c.conrelid and not t.tgisinternal),
  'rows',(select reltuples::bigint from pg_class where oid=c.conrelid))),'[]'::jsonb) as r
from pg_constraint c where c.contype='c' and pg_get_constraintdef(c.oid) ilike '%disqualified%' and c.connamespace='public'::regnamespace;
