-- Partner Search moderation guard.
--
-- Defect (confirmed read-only on hosted DEV 2026-11-09): "Dancers can manage their
-- own partner profile" is FOR ALL on the owner's row, authenticated holds UPDATE on
-- every column and the table has no trigger. A signed-in dancer could therefore set
-- moderation_status = 'approved' on their own listing and appear in public Partner
-- Search without review, and could also reset reported_count / last_reported_at /
-- blocked_reason. No application path sets 'approved': moderation is service-side only.
--
-- Rule for anon / authenticated callers (the repo's current_user guard pattern; the
-- service role, postgres and SECURITY DEFINER functions owned by postgres are not
-- affected, so report_partner_profile keeps updating reported_count):
--   INSERT  moderation_status must be 'pending'; reported_count 0; last_reported_at
--           and blocked_reason null.
--   UPDATE  moderation_status may stay as it is or go from 'approved' back to
--           'pending' (what released web and mobile clients send when a dancer
--           republishes). Any other change is refused. reported_count,
--           last_reported_at and blocked_reason cannot change.
--           A content change on an approved listing sends it back to 'pending', so
--           an approval cannot be reused for different content.
--
-- Released clients keep working: on insert they send 'pending'; on save they send the
-- existing value or 'pending'. The only refused client write is moving a 'flagged' or
-- 'hidden' listing to 'pending', which today only a tampered row could hit (nothing
-- sets those values either). New clients stop sending moderation_status.
--
-- Rollback: rollback/20270213090000_partner_profile_moderation_guard_rollback.sql.

create or replace function public._guard_dancer_partner_profile_moderation()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.moderation_status is distinct from 'pending'
       or coalesce(new.reported_count, 0) <> 0
       or new.last_reported_at is not null
       or new.blocked_reason is not null then
      raise exception 'Partner profile moderation fields cannot be set by this role.'
        using errcode = '42501';
    end if;

    return new;
  end if;

  if new.reported_count is distinct from old.reported_count
     or new.last_reported_at is distinct from old.last_reported_at
     or new.blocked_reason is distinct from old.blocked_reason then
    raise exception 'Partner profile moderation fields cannot be changed by this role.'
      using errcode = '42501';
  end if;

  if new.moderation_status is distinct from old.moderation_status
     and not (old.moderation_status = 'approved' and new.moderation_status = 'pending') then
    raise exception 'Partner profile moderation status cannot be changed by this role.'
      using errcode = '42501';
  end if;

  if old.moderation_status = 'approved'
     and (new.display_name is distinct from old.display_name
       or new.headline is distinct from old.headline
       or new.bio is distinct from old.bio
       or new.city is distinct from old.city
       or new.state is distinct from old.state
       or new.photo_url is distinct from old.photo_url
       or new.dance_styles is distinct from old.dance_styles
       or new.goals is distinct from old.goals
       or new.availability_notes is distinct from old.availability_notes
       or new.contact_email is distinct from old.contact_email
       or new.contact_phone is distinct from old.contact_phone
       or new.listing_intent is distinct from old.listing_intent
       or new.lead_follow_role is distinct from old.lead_follow_role
       or new.skill_level is distinct from old.skill_level) then
    new.moderation_status := 'pending';
  end if;

  return new;
end;
$$;

revoke all on function public._guard_dancer_partner_profile_moderation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_dancer_partner_profiles_moderation_guard on public.dancer_partner_profiles;
create trigger trg_dancer_partner_profiles_moderation_guard
before insert or update on public.dancer_partner_profiles
for each row
execute function public._guard_dancer_partner_profile_moderation();
