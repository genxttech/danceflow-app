-- Synthetic fixture for validate_local.sh: a few TW-4-shaped objects on a THROWAWAY local Postgres. Not a migration; never run anywhere else.
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.studios (id uuid primary key);
create table public.profiles (id uuid primary key, platform_role text);
create table public.user_studio_roles (id uuid primary key);
create table public.studio_sms_registrations (id uuid primary key, campaign_sid text);
create table public.studio_sms_onboarding (id uuid primary key default gen_random_uuid(), studio_id uuid);
create table public.studio_sms_credit_ledger (id bigserial primary key, amount int);
create table public.studio_sms_not_in_manifest (id int);
alter table public.studio_sms_onboarding enable row level security;
alter table public.studio_sms_credit_ledger enable row level security; alter table public.studio_sms_credit_ledger force row level security;
revoke all on public.studio_sms_onboarding from public;
insert into public.studio_sms_onboarding (studio_id) values (gen_random_uuid()), (gen_random_uuid());
create function public.studio_sms_guard() returns trigger language plpgsql as $f$ begin return new; end $f$;
create trigger studio_sms_onboarding_10_integrity before insert on public.studio_sms_onboarding for each row execute function public.studio_sms_guard();
create function public.get_studio_sms_status(p uuid) returns jsonb language sql security definer set search_path = public, pg_temp as $f$ select '{}'::jsonb $f$;
grant execute on function public.get_studio_sms_status(uuid) to authenticated;
revoke execute on function public.get_studio_sms_status(uuid) from public;
-- CRLF-stored body: must fingerprint like its LF twin
create function public.tw4_runner_claim(p uuid) returns int language plpgsql security definer set search_path = public, pg_temp as E'begin\r\n  return 1;\r\nend';
revoke execute on function public.tw4_runner_claim(uuid) from public; grant execute on function public.tw4_runner_claim(uuid) to service_role;
create function public.tw4_future_unlisted_fn() returns int language sql as $f$ select 1 $f$;
create function public.other_sms_helper() returns int language sql as $f$ select 2 $f$;
