-- Rollback for 20260916102500_fix_user_studio_roles_unique_constraint.sql
--
-- Restores the exact original 3-column unique constraint, by name, with
-- the exact original column order. No row/data is modified.

begin;

alter table public.user_studio_roles
  drop constraint user_studio_roles_studio_id_user_id_key;

alter table public.user_studio_roles
  add constraint user_studio_roles_user_id_studio_id_role_key
  unique (user_id, studio_id, role);

commit;
