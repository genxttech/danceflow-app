-- GC-1.4A: remove 'group_class' from any studio's self-service lesson-type
-- allow-list.
--
-- Group classes were never intended to go through the private-lesson
-- self-service exclusive-slot booking flow -- this migration is a one-time,
-- auditable data cleanup accompanying the application-code removal of
-- 'group_class' from every LESSON_TYPES copy and both self-service UI
-- surfaces (SettingsForm.tsx, SelfServiceBookingPanel.tsx) shipped in this
-- same release.
--
-- A separate migration file from 20260910100000 (schema/RPC/trigger, no
-- data mutation) by design -- this one IS a data mutation, and keeping it
-- separate gives it its own rollback file and its own place in migration
-- history rather than conflating a schema change with a data change.
--
-- Idempotent: WHERE ... @> array['group_class'] means a second run finds
-- zero matching rows. Not hardcoded to any one studio id -- a containment
-- predicate over studio_settings generally, safe in any environment
-- (matches zero rows in DEV today, exactly one in PROD).

begin;

update public.studio_settings
set portal_bookable_lesson_types = array_remove(portal_bookable_lesson_types, 'group_class')
where portal_bookable_lesson_types @> array['group_class']::text[];

commit;
