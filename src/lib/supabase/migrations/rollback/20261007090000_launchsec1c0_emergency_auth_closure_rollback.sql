-- ROLLBACK for LAUNCH-SEC-1C-0. Manual, owner-approved use only -- never automatic.
--
-- !!! WARNING: running this RE-OPENS CROSS-TENANT PORTAL/ACCOUNT
-- !!! AUTHORIZATION VULNERABILITIES:
-- !!!  - anon and authenticated can again call
-- !!!    link_portal_client_by_email(p_user_id, p_email) and give any account
-- !!!    portal access to any unlinked client with a chosen email;
-- !!!  - client_account_ledger is again readable by anyone whose JWT email
-- !!!    matches clients.email;
-- !!!  - accept_pending_team_invitations is again executable by PUBLIC/anon.
--
-- Restores exactly the reviewed pre-1C-0 grants and the original
-- "Clients can read their own account ledger" policy
-- (20260516000300_client_account_ledger_portal_read_policy.sql).

begin;

grant execute on function public.link_portal_client_by_email(uuid, text) to anon, authenticated;

grant execute on function public.accept_pending_team_invitations(text) to public, anon;

drop policy if exists "Linked portal users can read their account ledger"
  on public.client_account_ledger;

drop policy if exists "Clients can read their own account ledger"
  on public.client_account_ledger;

create policy "Clients can read their own account ledger"
on public.client_account_ledger
for select
to authenticated
using (
  exists (
    select 1
    from public.clients c
    where c.id = client_account_ledger.client_id
      and c.studio_id = client_account_ledger.studio_id
      and lower(c.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

commit;
