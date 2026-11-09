-- Rollback for 20270212090000_instructor_class_roster_names_rpc.sql. Roll the app back first: the app calls this function and would fail closed (503 on the staff
-- API, an error on the web roster panel) if it is missing.
drop function if exists public.get_class_roster_names_for_instructor(uuid);
