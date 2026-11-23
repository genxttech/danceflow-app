set transaction read only;
select 'pgcrypto' k, coalesce((select e.extname || ' ' || e.extversion || ' schema=' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'), '<missing>') v
union all select 'extensions.digest(text,text)', coalesce(to_regprocedure('extensions.digest(text,text)')::text, '<missing>')
union all select 'extensions.digest(bytea,text)', coalesce(to_regprocedure('extensions.digest(bytea,text)')::text, '<missing>')
union all select 'postgres_can_execute_digest', coalesce(has_function_privilege('postgres', to_regprocedure('extensions.digest(text,text)'), 'EXECUTE')::text, '<n/a>')
union all select 'postgres_usage_on_extensions_schema', has_schema_privilege('postgres', 'extensions', 'USAGE')::text
union all select 'gen_random_uuid', coalesce(to_regprocedure('pg_catalog.gen_random_uuid()')::text, '<missing>')
union all select 'digest_sha256_hex_length', length(encode(extensions.digest('nsi-d0', 'sha256'), 'hex'))::text;
