select jsonb_build_object('schema_migrations_table', to_regclass('supabase_migrations.schema_migrations')::text, 'now_utc', now()) as r;
