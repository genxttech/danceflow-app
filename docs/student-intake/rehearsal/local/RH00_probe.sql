-- RH00 — G7 probe: what does ownership transfer require? (rolled back)
begin;
create role intake_destructive nologin noinherit nobypassrls;
select 'auto_membership' k, r.rolname as role, m.rolname as member, am.admin_option, am.inherit_option, am.set_option
from pg_auth_members am join pg_roles r on r.oid=am.roleid join pg_roles m on m.oid=am.member where r.rolname='intake_destructive';
show createrole_self_grant;
create schema intake_private;
grant usage, create on schema intake_private to intake_destructive;
create function intake_private.probe() returns int language sql as 'select 1';
savepoint s1;
alter function intake_private.probe() owner to intake_destructive;
rollback;
