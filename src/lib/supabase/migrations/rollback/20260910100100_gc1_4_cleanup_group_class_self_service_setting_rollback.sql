-- GC-1.4A rollback -- 20260910100100_gc1_4_cleanup_group_class_self_service_setting.
--
-- Intentionally a no-op. Restoring 'group_class' into any studio's
-- portal_bookable_lesson_types would reintroduce a product setting that,
-- once the Release A application code has shipped, the running
-- application can no longer correctly support (the API validation and both
-- UI surfaces that read this setting are removed in the same release). If
-- group_class self-service is ever deliberately reinstated, that is a new
-- product decision requiring its own review -- not an automatic rollback
-- of this cleanup step. No data-mutating SQL executes here by design.

begin;
select 1;
commit;
