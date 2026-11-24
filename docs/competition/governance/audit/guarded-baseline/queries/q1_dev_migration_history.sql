select jsonb_build_object(
 'now_utc', now(),
 'db', current_database(),
 'migrations_ge_20270215', (select coalesce(jsonb_agg(version order by version),'[]'::jsonb) from supabase_migrations.schema_migrations where version >= '20270210'),
 'migrations_total', (select count(*) from supabase_migrations.schema_migrations),
 'u18_u18s_jc1_history', (select coalesce(jsonb_agg(version order by version),'[]'::jsonb) from supabase_migrations.schema_migrations where version in ('20270215092000','20270215093000','20270215094000')),
 'embeds_20270216090000_history', (select count(*) from supabase_migrations.schema_migrations where version='20270216090000')
) as r;
