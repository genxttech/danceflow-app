-- Rollback for 20261024090000_gc34a_public_group_class_read_model.sql: drops the public read functions and the lineage
-- helpers. No data, table, policy or grant outside these functions was changed by the migration. Roll the application back
-- first (it calls these functions), then run this.
begin;
drop function if exists public.public_group_class_series(uuid);
drop function if exists public.public_group_class_occurrences(text, uuid, uuid, integer);
drop function if exists public._gc34a_series_family(uuid);
drop function if exists public._gc34a_series_root(uuid);
commit;
