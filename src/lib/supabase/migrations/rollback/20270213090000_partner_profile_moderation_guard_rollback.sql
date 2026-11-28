-- Rollback for 20270213090000_partner_profile_moderation_guard.sql.
-- Order: roll the app back first, then run this. New clients no longer send
-- moderation_status and rely on the trigger to send an edited approved listing back to
-- 'pending'. Rolling back reopens the self-approval defect.

drop trigger if exists trg_dancer_partner_profiles_moderation_guard on public.dancer_partner_profiles;
drop function if exists public._guard_dancer_partner_profile_moderation();
