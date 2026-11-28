-- Owner decision 1 (2026-11-17): studio-sold registrations are NOT claimable until a column-restricted dancer read exists.
-- (docs/events/event-registration-dancer-column-restricted-read-proposal.md)
--
-- Replaces public.claim_my_event_registrations() (20270221090000) with the SAME body plus a FAIL-CLOSED allowlist on
-- event_registrations.registration_source. event_registrations_source_check allows five values; only 'public_event_page' is clearly
-- buyer-originated (public cart checkout and Student app checkout both write it; competition registration RPCs also write it with
-- user_id already set). Every other value, NULL, and any value added in the future does NOT claim:
--   admin             studio-sold (sell-tickets): carries studio-internal notes and a client link  -> excluded (owner rule)
--   import            staff bulk import                                                              -> excluded (studio-originated)
--   organizer_portal  created from the organizer side                                                -> excluded (ambiguous, flagged to the owner)
--   other             unspecified                                                                    -> excluded (ambiguous, flagged to the owner)
-- Unchanged: no parameters, SECURITY DEFINER, search_path pinned, email only from my_verified_email(), updates only user_id where it
-- is null, execute for authenticated only, returns the claimed count, idempotent.
-- Git-only: do NOT apply to hosted databases without the owner's authorization. Apply AFTER 20270221090000 and BEFORE any app deploy.

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
     and registration_source in ('public_event_page')
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
