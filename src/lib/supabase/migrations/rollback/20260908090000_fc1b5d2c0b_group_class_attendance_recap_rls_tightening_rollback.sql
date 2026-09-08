-- FC-1B5D2c-0B rollback -- restores the exact pre-migration live-DEV policy
-- bodies on attendance_records, group_lesson_recaps,
-- group_lesson_recap_recipients, and group_lesson_recap_syllabus_steps,
-- captured verbatim via `pg_policies` against DEV (epdrtzcydvnoidwrepqz)
-- immediately before the forward migration was applied. Also drops the
-- three helper functions the forward migration introduced.
--
-- Portal policies "Linked students can read published group lesson
-- recaps" and "Linked students can read own group lesson recap
-- recipients" were never touched by the forward migration -- nothing to
-- restore for them here.

begin;

-- ============================================================================
-- 1. Drop everything the forward migration created.
-- ============================================================================

drop policy if exists "attendance_records_select" on public.attendance_records;
drop policy if exists "attendance_records_insert" on public.attendance_records;
drop policy if exists "attendance_records_update" on public.attendance_records;
drop policy if exists "attendance_records_delete" on public.attendance_records;

drop policy if exists "group_lesson_recaps_select" on public.group_lesson_recaps;
drop policy if exists "group_lesson_recaps_insert" on public.group_lesson_recaps;
drop policy if exists "group_lesson_recaps_update" on public.group_lesson_recaps;
drop policy if exists "group_lesson_recaps_delete" on public.group_lesson_recaps;

drop policy if exists "group_lesson_recap_recipients_select" on public.group_lesson_recap_recipients;
drop policy if exists "group_lesson_recap_recipients_insert" on public.group_lesson_recap_recipients;
drop policy if exists "group_lesson_recap_recipients_update" on public.group_lesson_recap_recipients;
drop policy if exists "group_lesson_recap_recipients_delete" on public.group_lesson_recap_recipients;

drop policy if exists "group_lesson_recap_syllabus_steps_select" on public.group_lesson_recap_syllabus_steps;
drop policy if exists "group_lesson_recap_syllabus_steps_insert" on public.group_lesson_recap_syllabus_steps;
drop policy if exists "group_lesson_recap_syllabus_steps_update" on public.group_lesson_recap_syllabus_steps;
drop policy if exists "group_lesson_recap_syllabus_steps_delete" on public.group_lesson_recap_syllabus_steps;

-- ============================================================================
-- 2. Restore the exact pre-migration policy bodies (verbatim from the
--    live DEV pg_policies capture taken immediately before this migration
--    was applied).
-- ============================================================================

create policy "attendance_records_staff_select" on public.attendance_records
for select
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.active = true
  )
);

create policy "attendance_records_staff_insert" on public.attendance_records
for insert
to public
with check (
  exists (
    select 1
    from user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.active = true
  )
);

create policy "attendance_records_staff_update" on public.attendance_records
for update
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.active = true
  )
);

create policy "attendance_records_staff_delete" on public.attendance_records
for delete
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.active = true
  )
);

create policy "Studio staff can manage group lesson recaps" on public.group_lesson_recaps
for all
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recaps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recaps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio staff can manage group lesson recap recipients" on public.group_lesson_recap_recipients
for all
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio members can manage group recap syllabus steps" on public.group_lesson_recap_syllabus_steps
for all
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role, 'instructor'::app_role, 'independent_instructor'::app_role])
  )
)
with check (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role, 'instructor'::app_role, 'independent_instructor'::app_role])
  )
);

create policy "Studio members can view group recap syllabus steps" on public.group_lesson_recap_syllabus_steps
for select
to public
using (
  exists (
    select 1
    from user_studio_roles usr
    where usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

-- ============================================================================
-- 3. Drop the helper functions the forward migration introduced (5 total
--    as of the CORRECTED forward migration: the original 3, plus
--    attendance_record_is_event_linked and
--    group_lesson_recap_recipient_is_event_linked added by the post-review
--    correction pass). None of the five depend on each other in a way that
--    constrains drop order except is_own_instructor_for_appointment, which
--    is called by is_own_instructor_for_group_recap -- drop the callers
--    first, then the base helper, for symmetry with the forward migration's
--    own creation order.
-- ============================================================================

drop function if exists public.is_own_instructor_for_group_recap(uuid, uuid);
drop function if exists public.group_lesson_recap_is_event_linked(uuid, uuid);
drop function if exists public.attendance_record_is_event_linked(uuid, uuid);
drop function if exists public.group_lesson_recap_recipient_is_event_linked(uuid, uuid);
drop function if exists public.is_own_instructor_for_appointment(uuid, uuid);

commit;
