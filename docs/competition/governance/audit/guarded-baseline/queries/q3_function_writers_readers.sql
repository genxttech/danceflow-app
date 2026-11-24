select coalesce(jsonb_agg(jsonb_build_object('fn',p.proname,'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'md5',md5(p.prosrc),
 'writes_he', p.prosrc ~* 'update\s+(public\.)?event_competition_heat_entries|insert\s+into\s+(public\.)?event_competition_heat_entries|delete\s+from\s+(public\.)?event_competition_heat_entries',
 'mentions_disq', p.prosrc ilike '%disqualified%','mentions_danced', p.prosrc ilike '%danced%',
 'anon_x',has_function_privilege('anon',p.oid,'execute'),'auth_x',has_function_privilege('authenticated',p.oid,'execute'),'svc_x',has_function_privilege('service_role',p.oid,'execute')) order by p.proname),'[]'::jsonb) as r
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.prosrc ilike '%disqualified%' or p.prosrc ilike '%danced%' or p.prosrc ~* 'event_competition_heat_entries');
