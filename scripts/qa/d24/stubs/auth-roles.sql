-- Reconstructed Supabase auth + role tables needed by the D24 M2-B operator migration (same approach as scripts/qa/d24-m2b-sql.sh).
-- auth.uid()/auth.jwt() are defined the way Supabase defines them: from the request.jwt.claims setting.
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
create table public.profiles (id uuid primary key, platform_role text);
create table public.user_studio_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, studio_id uuid not null, role text not null, active boolean not null default true);
