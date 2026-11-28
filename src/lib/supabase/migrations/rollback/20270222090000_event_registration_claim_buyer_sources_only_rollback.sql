-- Rollback of 20270222090000_event_registration_claim_buyer_sources_only.sql: restores the 20270221090000 definition (no source allowlist).
-- Rows already claimed keep their user_id. NOTE: after this rollback studio-sold rows become claimable again (the exposure the owner excluded).
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
