-- RH00b — same, with SET membership granted (rolled back)
begin;
create role intake_destructive nologin noinherit nobypassrls;
create schema intake_private;
grant usage, create on schema intake_private to intake_destructive;
create function intake_private.probe() returns int language sql as 'select 1';
grant intake_destructive to postgres with set true, inherit false;
alter function intake_private.probe() owner to intake_destructive;
select 'owner_after' k, pg_get_userbyid(proowner) from pg_proc where proname='probe';
rollback;
select 'role_exists_after_rollback' k, count(*) from pg_roles where rolname='intake_destructive';
