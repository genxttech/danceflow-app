-- ROLLBACK for 20261008090000_launchsec1ca_verified_email_proof.sql
--
-- WARNING: this permanently deletes every recorded verified-email proof and
-- binding state. Users would have to verify and bind again after re-apply.
-- It does NOT touch LAUNCH-SEC-1C-0 / 1C-0-R objects.
--
-- Fails closed:
--   * if any object other than the 1C-A set references the 1C-A functions or
--     tables (e.g. 1C-B enforcement) -- roll 1C-B back first;
--   * if the 1C-A object set is not exactly the reviewed one.

begin;

do $$
declare
  v_dependents text;
  v_fn_count integer;
begin
  select count(*) into v_fn_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'track_auth_email_change', '_launchsec1ca_live_session_id', '_launchsec1ca_mailbox_auth_at',
      '_launchsec1ca_current_email', '_record_email_proof', 'record_email_proof_web',
      'record_email_proof_mobile', 'my_verified_email', 'email_binding_status', 'complete_email_binding'
    );
  if v_fn_count <> 10
     or to_regclass('public.verified_email_identities') is null
     or to_regclass('public.auth_email_change_markers') is null
     or not exists (
       select 1 from pg_trigger
       where tgrelid = 'auth.users'::regclass and tgname = 'launchsec1ca_track_email_change'
     ) then
    raise exception 'LAUNCH-SEC-1C-A rollback: 1C-A object set is not the reviewed state';
  end if;

  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname) into v_dependents
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and p.proname not in (
      'track_auth_email_change', '_launchsec1ca_live_session_id', '_launchsec1ca_mailbox_auth_at',
      '_launchsec1ca_current_email', '_record_email_proof', 'record_email_proof_web',
      'record_email_proof_mobile', 'my_verified_email', 'email_binding_status', 'complete_email_binding'
    )
    and (
      p.prosrc ilike '%my_verified_email%'
      or p.prosrc ilike '%verified_email_identities%'
      or p.prosrc ilike '%record_email_proof%'
      or p.prosrc ilike '%email_binding_status%'
      or p.prosrc ilike '%complete_email_binding%'
      or p.prosrc ilike '%auth_email_change_markers%'
    );
  if v_dependents is not null then
    raise exception 'LAUNCH-SEC-1C-A rollback: dependent functions exist (%); roll back 1C-B first', v_dependents;
  end if;

  select string_agg(polname || ' on ' || polrelid::regclass::text, ', ') into v_dependents
  from pg_policy
  where pg_get_expr(polqual, polrelid) ilike '%my_verified_email%'
     or pg_get_expr(polwithcheck, polrelid) ilike '%my_verified_email%';
  if v_dependents is not null then
    raise exception 'LAUNCH-SEC-1C-A rollback: dependent policies exist (%); roll back 1C-B first', v_dependents;
  end if;
end $$;

drop trigger launchsec1ca_track_email_change on auth.users;

drop function public.complete_email_binding(uuid, uuid);
drop function public.email_binding_status();
drop function public.my_verified_email();
drop function public.record_email_proof_mobile();
drop function public.record_email_proof_web();
drop function public._record_email_proof(text);
drop function public._launchsec1ca_current_email(uuid);
drop function public._launchsec1ca_mailbox_auth_at(uuid, uuid);
drop function public._launchsec1ca_live_session_id();
drop function public.track_auth_email_change();

drop table public.auth_email_change_markers;
drop table public.verified_email_identities;

commit;
