-- Events: the creator of an event is set when the event is created and does not change afterwards.
-- events.created_by is used by row-level policies and functions to grant management access, so it must not be writable like an
-- ordinary column. This adds one trigger. It changes no policy, grant, row or other column, and widens nothing.
--   insert  a signed-in caller may record only itself (or nobody) as creator; server inserts without a user session are unchanged
--   update  any change of created_by is refused for every caller, including the service role. The one maintenance path is a
--           connection that is a database owner member both as logged in and as acting role, has no user session, and also sets
--           app.event_creator_maintenance = 'on' for that transaction. API connections log in as a non-member, so they never qualify.
begin;
set local lock_timeout = '5s';

-- SECURITY INVOKER on purpose: current_user must be the role actually performing the write.
create or replace function public.protect_event_creator()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  owner_role oid;
begin
  if tg_op = 'INSERT' then
    if caller is not null and new.created_by is not null and new.created_by <> caller then
      raise exception 'The event creator must be the signed-in user.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.created_by is distinct from old.created_by then
    select c.relowner into owner_role from pg_class c where c.oid = tg_relid;
    if caller is null
       and coalesce(current_setting('app.event_creator_maintenance', true), '') = 'on'
       and pg_has_role(current_user, owner_role, 'MEMBER')
       and pg_has_role(session_user, owner_role, 'MEMBER') then
      return new;
    end if;
    raise exception 'The event creator cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_event_creator() from public, anon, authenticated;

-- Named to run after the other before-row triggers, so nothing can alter created_by behind it.
drop trigger if exists zz_protect_event_creator on public.events;
create trigger zz_protect_event_creator
before insert or update on public.events
for each row execute function public.protect_event_creator();

commit;
