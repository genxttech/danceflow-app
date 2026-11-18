-- QA-only call counter for public.claim_my_event_registrations() on a DISPOSABLE iso-qa stack. Never applied to a hosted database.
--
-- Why: PostgREST calls left no usable trace in pg_stat_user_functions or statement logging on this stack, so "exactly one call per app
-- run" (case 6) could not be shown. This puts a thin wrapper with the same name, signature, owner and grants in front of the real
-- function. The wrapper writes one row per call (caller = auth.uid()) and then runs the real body unchanged, so the behaviour under test
-- is the migration's own function. A row written inside the call cannot be missed or double counted by log parsing.
begin;

create table if not exists public.qa_claim_calls (
  id bigserial primary key,
  at timestamptz not null default now(),
  caller uuid
);
-- A sequence is NOT rolled back with the transaction: when the function raises, the table row above disappears with the rollback, but the attempt is still counted here (case 9b).
create sequence if not exists public.qa_claim_attempts;
revoke all on sequence public.qa_claim_attempts from public, anon, authenticated, service_role;
-- not reachable by app roles
revoke all on table public.qa_claim_calls from public, anon, authenticated, service_role;
revoke all on sequence public.qa_claim_calls_id_seq from public, anon, authenticated, service_role;

alter function public.claim_my_event_registrations() rename to qa_claim_my_event_registrations_impl;
revoke all on function public.qa_claim_my_event_registrations_impl() from public, anon, authenticated, service_role;

create function public.claim_my_event_registrations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform nextval('public.qa_claim_attempts');
  insert into public.qa_claim_calls (caller) values (auth.uid());
  return public.qa_claim_my_event_registrations_impl();
end;
$$;

alter function public.claim_my_event_registrations() owner to postgres;
revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role;
grant execute on function public.claim_my_event_registrations() to authenticated;

commit;
