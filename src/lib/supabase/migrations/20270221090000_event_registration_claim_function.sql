-- Student visibility of a buyer's own event registrations (proposal docs/events/event-registration-student-visibility-proposal.md,
-- Option A, adopted by the owner 2026-11-17).
--
-- Registrations created by the public web cart, studio sell-tickets and similar paths have user_id NULL, so the buyer's own
-- RLS read (event_registrations_self_select: user_id = auth.uid()) never matches them. This function lets a signed-in user
-- claim the unclaimed registrations that carry their OWN verified, bound email.
--
-- Safety properties:
--   * no parameters: the user id is auth.uid() and the email comes only from public.my_verified_email() (LAUNCH-SEC-1C proof:
--     bound, live session, newer than the last email change). No verified email => returns 0 and changes nothing.
--   * writes only event_registrations.user_id, and only where user_id IS NULL (never takes another account's row).
--   * matches only the registration BUYER's attendee_email (never guest attendees' rows in event_registration_attendees).
--   * never touches clients, client_account_links, leads, notifications, marketing, payments or orders.
--   * idempotent; SECURITY DEFINER with a pinned search_path; execute granted to authenticated only.
-- Git-only: do NOT apply to hosted databases without the owner's approval. SQL ships before the app call.

begin;

create or replace function public.claim_my_event_registrations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_claimed integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

  v_email := lower(btrim(coalesce(public.my_verified_email(), '')));
  if v_email = '' then
    return 0;
  end if;

  update public.event_registrations
     set user_id = v_uid
   where user_id is null
     and attendee_email is not null
     and lower(btrim(attendee_email)) = v_email;

  get diagnostics v_claimed = row_count;
  return v_claimed;
end;
$$;

alter function public.claim_my_event_registrations() owner to postgres;
revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role;
grant execute on function public.claim_my_event_registrations() to authenticated;

commit;
