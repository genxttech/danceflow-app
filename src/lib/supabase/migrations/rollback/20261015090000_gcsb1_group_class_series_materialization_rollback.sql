-- Rollback for 20261015090000_gcsb1_group_class_series_materialization.sql
--
-- Fails closed: dropping client_request_id would discard the idempotency state
-- of every series created through create_group_class_series, so this aborts
-- if any such series exists. After the application has created real series,
-- roll back the application first and keep the column (and functions) in
-- place, or reconcile the series data deliberately before using this file.
-- Removes only the objects added by this migration; the GC-S1A foundation
-- (group_class_series, the appointment series columns, triggers, RLS) stays.

begin;

do $$
begin
  if exists (select 1 from public.group_class_series where client_request_id is not null limit 1) then
    raise exception 'Cannot roll back GC-S1B B1: series created with a client_request_id exist. Keep the column and functions in place, or reconcile the series data first.';
  end if;
end;
$$;

drop function if exists public.create_group_class_series(uuid, uuid, text, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer, integer[], boolean, boolean, text[], numeric);
drop function if exists public.preview_group_class_series(uuid, text, uuid, uuid, text, integer, smallint[], integer, date, date, integer, time, integer);
drop function if exists public._gcsb1_generate_series_occurrences(text, smallint[], integer, date, date, integer, time, integer);
drop function if exists public._gcsb1_series_dates(smallint[], integer, date, date, integer);

drop index if exists public.uq_group_class_series_client_request;

alter table public.group_class_series
  drop column if exists client_request_id;

commit;
